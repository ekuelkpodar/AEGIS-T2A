/**
 * Basic evaluation runner for golden intent parsing and RAG results.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIntentHeuristic } from '../../src/gateway/intent-parser.js';
import { RAGService } from '../../src/knowledge/rag.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface GoldenIntent {
  id: string;
  input: string;
  expected: {
    actionType: string;
    riskLevel: string;
    hasSideEffects: boolean;
    requiredCapabilities: string[];
  };
}

interface EvaluationResult {
  id: string;
  passed: boolean;
  details: Record<string, unknown>;
}

async function loadGoldenIntents(): Promise<GoldenIntent[]> {
  const filePath = path.join(__dirname, 'golden-intents.json');
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as GoldenIntent[];
}

function evaluateIntent(intent: GoldenIntent): EvaluationResult {
  const parsed = parseIntentHeuristic('eval-user', intent.input);
  if (!parsed.success || !parsed.intent) {
    return { id: intent.id, passed: false, details: { error: parsed.error } };
  }

  const expected = intent.expected;
  const actual = parsed.intent;

  const checks = {
    actionType: actual.actionType === expected.actionType,
    riskLevel: actual.riskLevel === expected.riskLevel,
    hasSideEffects: actual.sideEffect === expected.hasSideEffects,
    requiredCapabilities: expected.requiredCapabilities.every((cap) =>
      actual.requiredCapabilities.includes(cap)
    ),
  };

  const passed = Object.values(checks).every(Boolean);

  return {
    id: intent.id,
    passed,
    details: {
      checks,
      actual: {
        actionType: actual.actionType,
        riskLevel: actual.riskLevel,
        hasSideEffects: actual.sideEffect,
        requiredCapabilities: actual.requiredCapabilities,
      },
    },
  };
}

function evaluateRagSmoke(): EvaluationResult {
  const rag = new RAGService();
  const docId = rag.ingestDocument('S3 buckets store objects. Deleting a bucket removes all objects.', {
    title: 'AWS S3',
    source: 'eval',
  });
  const results = rag.search('delete s3 bucket', 3);
  return {
    id: `rag-${docId}`,
    passed: results.length > 0,
    details: { resultCount: results.length },
  };
}

async function main(): Promise<void> {
  const intents = await loadGoldenIntents();
  const results: EvaluationResult[] = [];

  for (const intent of intents) {
    results.push(evaluateIntent(intent));
  }

  results.push(evaluateRagSmoke());

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  console.log(JSON.stringify({ passed, failed, results }, null, 2));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
