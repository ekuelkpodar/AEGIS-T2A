/**
 * Intent ↔ Plan alignment verification.
 */

import { TypedIntent, PlanStep } from '../core/types.js';
import { tokenize } from '../knowledge/tokenize.js';

export interface IntentAlignmentResult {
  score: number; // 0..1
  issues: string[];
}

export function verifyIntentAlignment(intent: TypedIntent, steps: PlanStep[]): IntentAlignmentResult {
  const issues: string[] = [];

  const intentTokens = new Set(tokenize(intent.nlText));
  const planTokens = new Set<string>();

  for (const step of steps) {
    tokenize(step.action).forEach((t) => planTokens.add(t));
    tokenize(step.description).forEach((t) => planTokens.add(t));
    tokenize(step.toolAdapter).forEach((t) => planTokens.add(t));
  }

  const overlap = [...intentTokens].filter((t) => planTokens.has(t));
  const unionSize = new Set([...intentTokens, ...planTokens]).size || 1;
  const lexicalScore = overlap.length / unionSize;

  const requiredCapabilities = intent.requiredCapabilities ?? [];
  const capabilityMatches = requiredCapabilities.filter((cap) =>
    steps.some((s) => s.requiredCapabilities.includes(cap))
  );
  const capabilityScore = requiredCapabilities.length > 0
    ? capabilityMatches.length / requiredCapabilities.length
    : 1;

  const score = Math.min(1, (lexicalScore * 0.6) + (capabilityScore * 0.4));

  if (score < 0.5) {
    issues.push('Plan appears weakly aligned with the original intent');
  }
  if (capabilityScore < 0.5) {
    issues.push('Plan does not cover required capabilities from the intent');
  }

  return { score, issues };
}
