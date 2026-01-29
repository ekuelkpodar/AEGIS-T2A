/**
 * AEGIS-T2A Intent Parser
 *
 * Converts natural language input into typed intents using LLM.
 */

import { z } from 'zod';
import {
  TypedIntent,
  TypedIntentSchema,
  RiskLevel,
  Sensitivity,
  Budget,
} from '../core/types.js';
import { generateIntentId, generateIdempotencyKey } from '../core/ids.js';
import { componentLogger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import Anthropic from '@anthropic-ai/sdk';

const logger = componentLogger('intent-parser');

// =============================================================================
// Types
// =============================================================================

export interface ParsedIntent {
  actionType: string;
  description: string;
  targetResources: string[];
  requiredCapabilities: string[];
  parameters: Record<string, unknown>;
  hasSideEffects: boolean;
  estimatedRisk: RiskLevel;
  estimatedCost: number;
  confidence: number;
}

export interface IntentParseResult {
  success: boolean;
  intent?: TypedIntent;
  error?: string;
  clarificationNeeded?: boolean;
  clarificationQuestions?: string[];
}

// =============================================================================
// LLM Client
// =============================================================================

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    const config = getConfig();
    if (!config.anthropicApiKey) {
      throw new Error('Anthropic API key not configured');
    }
    anthropicClient = new Anthropic({
      apiKey: config.anthropicApiKey,
    });
  }
  return anthropicClient;
}

// =============================================================================
// Intent Parsing
// =============================================================================

const INTENT_PARSE_PROMPT = `You are an intent parser for AEGIS-T2A, a secure automation platform.
Your task is to analyze natural language requests and extract structured intent information.

Analyze the following user request and extract:
1. actionType: The type of action (e.g., "create", "update", "delete", "query", "deploy", "configure")
2. description: A brief description of what the user wants to accomplish
3. targetResources: List of resources that will be affected
4. requiredCapabilities: List of capabilities needed (e.g., "aws:ec2", "github:repo", "database:write")
5. parameters: Key parameters extracted from the request
6. hasSideEffects: Whether this action modifies external state (true/false)
7. estimatedRisk: Risk level ("low", "medium", "high", "destructive")
8. estimatedCost: Estimated cost in USD (0 for free operations)
9. confidence: Your confidence in this interpretation (0.0 to 1.0)

Risk level guidelines:
- low: Read-only operations, status checks, non-sensitive queries
- medium: Configuration changes, non-production updates
- high: Production data modifications, infrastructure changes
- destructive: Deletions, irreversible operations

Respond ONLY with a valid JSON object matching this structure:
{
  "actionType": "string",
  "description": "string",
  "targetResources": ["string"],
  "requiredCapabilities": ["string"],
  "parameters": {},
  "hasSideEffects": boolean,
  "estimatedRisk": "low|medium|high|destructive",
  "estimatedCost": number,
  "confidence": number
}

If the request is ambiguous or needs clarification, set confidence below 0.7 and include a "clarificationNeeded" field with suggested questions.`;

const ParsedIntentResponseSchema = z.object({
  actionType: z.string(),
  description: z.string(),
  targetResources: z.array(z.string()),
  requiredCapabilities: z.array(z.string()),
  parameters: z.record(z.unknown()),
  hasSideEffects: z.boolean(),
  estimatedRisk: z.enum(['low', 'medium', 'high', 'destructive']),
  estimatedCost: z.number().min(0),
  confidence: z.number().min(0).max(1),
  clarificationNeeded: z.boolean().optional(),
  clarificationQuestions: z.array(z.string()).optional(),
});

/**
 * Parse natural language into a typed intent using LLM
 */
export async function parseIntent(
  userId: string,
  nlText: string,
  context?: Record<string, unknown>
): Promise<IntentParseResult> {
  const startTime = Date.now();

  logger.info({ userId, textLength: nlText.length }, 'Parsing intent');

  try {
    const client = getAnthropicClient();

    const contextStr = context
      ? `\n\nAdditional context:\n${JSON.stringify(context, null, 2)}`
      : '';

    const response = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `${INTENT_PARSE_PROMPT}${contextStr}\n\nUser request: "${nlText}"`,
        },
      ],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from LLM');
    }

    // Parse JSON from response
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No valid JSON found in LLM response');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const validated = ParsedIntentResponseSchema.parse(parsed);

    // Check if clarification is needed
    if (validated.confidence < 0.7 || validated.clarificationNeeded) {
      logger.info(
        { userId, confidence: validated.confidence },
        'Intent requires clarification'
      );

      return {
        success: false,
        clarificationNeeded: true,
        clarificationQuestions: validated.clarificationQuestions ?? [
          'Could you provide more details about what you want to accomplish?',
          'Which specific resources should be affected?',
        ],
      };
    }

    // Build the TypedIntent
    const intentId = generateIntentId();
    const now = new Date().toISOString();

    const budget: Budget = {
      currency: 'USD',
      limit: Math.max(validated.estimatedCost * 2, 10), // 2x estimate or minimum $10
      spent: 0,
    };

    const typedIntent: TypedIntent = {
      intentId,
      userId,
      timestamp: now,
      nlText,
      actionType: validated.actionType,
      riskLevel: validated.estimatedRisk,
      sensitivity: determineSensitivity(validated),
      budget,
      requiredCapabilities: validated.requiredCapabilities,
      sideEffect: validated.hasSideEffects,
      idempotencyKey: generateIdempotencyKey('intent', userId, nlText),
      policyStatus: 'pending',
      approvalRequired: shouldRequireApproval(validated.estimatedRisk),
      confidence: validated.confidence,
      metadata: {
        description: validated.description,
        targetResources: validated.targetResources,
        parameters: validated.parameters,
        parseTimeMs: Date.now() - startTime,
      },
    };

    // Validate against schema
    TypedIntentSchema.parse(typedIntent);

    logger.info(
      {
        intentId,
        actionType: validated.actionType,
        riskLevel: validated.estimatedRisk,
        confidence: validated.confidence,
        parseTimeMs: Date.now() - startTime,
      },
      'Intent parsed successfully'
    );

    return {
      success: true,
      intent: typedIntent,
    };
  } catch (error) {
    logger.error({ error, userId }, 'Failed to parse intent');

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown parsing error',
    };
  }
}

/**
 * Determine sensitivity level based on parsed intent
 */
function determineSensitivity(parsed: z.infer<typeof ParsedIntentResponseSchema>): Sensitivity {
  const sensitiveCapabilities = [
    'database:write',
    'secrets',
    'credentials',
    'pii',
    'financial',
    'payment',
  ];

  const hasSensitiveCapability = parsed.requiredCapabilities.some((cap) =>
    sensitiveCapabilities.some((s) => cap.toLowerCase().includes(s))
  );

  if (hasSensitiveCapability || parsed.estimatedRisk === 'destructive') {
    return Sensitivity.RESTRICTED;
  }

  if (parsed.hasSideEffects || parsed.estimatedRisk === 'high') {
    return Sensitivity.CONFIDENTIAL;
  }

  return Sensitivity.PUBLIC;
}

/**
 * Determine if approval is required based on risk level
 */
function shouldRequireApproval(riskLevel: RiskLevel): boolean {
  return riskLevel === 'medium' || riskLevel === 'high' || riskLevel === 'destructive';
}

/**
 * Simple heuristic-based parser for when LLM is unavailable
 */
export function parseIntentHeuristic(
  userId: string,
  nlText: string
): IntentParseResult {
  const lowerText = nlText.toLowerCase();

  // Simple keyword matching
  let actionType = 'unknown';
  let riskLevel: RiskLevel = 'low';
  let hasSideEffects = false;

  if (lowerText.includes('delete') || lowerText.includes('remove') || lowerText.includes('destroy')) {
    actionType = 'delete';
    riskLevel = 'destructive';
    hasSideEffects = true;
  } else if (lowerText.includes('create') || lowerText.includes('add') || lowerText.includes('new')) {
    actionType = 'create';
    riskLevel = 'medium';
    hasSideEffects = true;
  } else if (lowerText.includes('update') || lowerText.includes('modify') || lowerText.includes('change')) {
    actionType = 'update';
    riskLevel = 'medium';
    hasSideEffects = true;
  } else if (lowerText.includes('get') || lowerText.includes('list') || lowerText.includes('show') || lowerText.includes('query')) {
    actionType = 'query';
    riskLevel = 'low';
    hasSideEffects = false;
  } else if (lowerText.includes('deploy')) {
    actionType = 'deploy';
    riskLevel = 'high';
    hasSideEffects = true;
  }

  const intentId = generateIntentId();
  const now = new Date().toISOString();

  const typedIntent: TypedIntent = {
    intentId,
    userId,
    timestamp: now,
    nlText,
    actionType,
    riskLevel,
    sensitivity: Sensitivity.PUBLIC,
    budget: { currency: 'USD', limit: 10, spent: 0 },
    requiredCapabilities: [],
    sideEffect: hasSideEffects,
    idempotencyKey: generateIdempotencyKey('intent', userId, nlText),
    policyStatus: 'pending',
    approvalRequired: shouldRequireApproval(riskLevel),
    confidence: 0.5, // Low confidence for heuristic parsing
    metadata: {
      parsingMethod: 'heuristic',
    },
  };

  return {
    success: true,
    intent: typedIntent,
    clarificationNeeded: true,
    clarificationQuestions: [
      'This request was parsed using basic heuristics. Please confirm the action type and provide more details.',
    ],
  };
}
