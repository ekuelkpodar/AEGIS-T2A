/**
 * AEGIS-T2A Intent & Policy Gateway
 *
 * Entry point for intent processing and policy validation.
 */

import { TypedIntent, Result } from '../core/types.js';
import { execute, queryOne, transaction } from '../core/database.js';
import { componentLogger, logIntent } from '../core/logger.js';
import { hashObject } from '../core/crypto.js';
import { parseIntent, parseIntentHeuristic, IntentParseResult } from './intent-parser.js';
import {
  PolicyEngine,
  getPolicyEngine,
  initializePolicyEngine,
  PolicyEvaluationResult,
  PolicyContext,
} from './policy-engine.js';

const logger = componentLogger('gateway');

// =============================================================================
// Types
// =============================================================================

export interface GatewayRequest {
  userId: string;
  text: string;
  context?: Record<string, unknown>;
  environment?: 'development' | 'staging' | 'production';
  userRoles?: string[];
}

export interface GatewayResponse {
  success: boolean;
  intent?: TypedIntent;
  policyResult?: PolicyEvaluationResult;
  error?: string;
  clarificationNeeded?: boolean;
  clarificationQuestions?: string[];
}

// =============================================================================
// Intent Gateway
// =============================================================================

export class IntentGateway {
  private policyEngine: PolicyEngine | null = null;
  private initialized = false;

  /**
   * Initialize the gateway
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.policyEngine = await initializePolicyEngine();
    this.initialized = true;

    logger.info('Intent gateway initialized');
  }

  /**
   * Process a natural language request
   */
  async processRequest(request: GatewayRequest): Promise<GatewayResponse> {
    if (!this.initialized) {
      await this.initialize();
    }

    const startTime = Date.now();
    logIntent('processing', 'request_received', {
      userId: request.userId,
      textLength: request.text.length,
    });

    try {
      // Step 1: Parse the intent
      let parseResult: IntentParseResult;

      try {
        parseResult = await parseIntent(request.userId, request.text, request.context);
      } catch (error) {
        // Fallback to heuristic parsing if LLM fails
        logger.warn({ error }, 'LLM parsing failed, using heuristic fallback');
        parseResult = parseIntentHeuristic(request.userId, request.text);
      }

      // If parsing failed or needs clarification
      if (!parseResult.success || !parseResult.intent) {
        return {
          success: false,
          error: parseResult.error,
          clarificationNeeded: parseResult.clarificationNeeded,
          clarificationQuestions: parseResult.clarificationQuestions,
        };
      }

      const intent = parseResult.intent;

      // Step 2: Evaluate against policies
      const policyContext: PolicyContext = {
        userId: request.userId,
        userRoles: request.userRoles,
        environment: request.environment,
        currentTime: new Date(),
      };

      const policyResult = this.policyEngine!.evaluateIntent(intent, policyContext);

      // Update intent with policy result
      intent.policyStatus = policyResult.allowed
        ? policyResult.requiresApproval
          ? 'pending'
          : 'approved'
        : 'denied';
      intent.approvalRequired = policyResult.requiresApproval;

      // Step 3: Persist the intent
      await this.persistIntent(intent);

      logIntent(intent.intentId, 'processed', {
        userId: request.userId,
        actionType: intent.actionType,
        riskLevel: intent.riskLevel,
        policyStatus: intent.policyStatus,
        processingTimeMs: Date.now() - startTime,
      });

      return {
        success: policyResult.allowed,
        intent,
        policyResult,
        error: policyResult.allowed ? undefined : 'Intent denied by policy',
      };
    } catch (error) {
      logger.error({ error, userId: request.userId }, 'Failed to process request');

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error processing request',
      };
    }
  }

  /**
   * Persist an intent to the database
   */
  private async persistIntent(intent: TypedIntent): Promise<void> {
    execute(
      `INSERT INTO intents
       (intent_id, user_id, nl_text, typed_intent, risk_level, sensitivity, budget, policy_status, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        intent.intentId,
        intent.userId,
        intent.nlText,
        JSON.stringify(intent),
        intent.riskLevel,
        intent.sensitivity,
        JSON.stringify(intent.budget),
        intent.policyStatus,
        intent.confidence,
        intent.timestamp,
        intent.timestamp,
      ]
    );
  }

  /**
   * Get an intent by ID
   */
  async getIntent(intentId: string): Promise<TypedIntent | null> {
    const row = queryOne<{ typed_intent: string }>(
      'SELECT typed_intent FROM intents WHERE intent_id = ?',
      [intentId]
    );

    if (!row) return null;

    return JSON.parse(row.typed_intent) as TypedIntent;
  }

  /**
   * Update intent status
   */
  async updateIntentStatus(
    intentId: string,
    status: 'pending' | 'approved' | 'denied'
  ): Promise<void> {
    execute(
      'UPDATE intents SET policy_status = ?, updated_at = ? WHERE intent_id = ?',
      [status, new Date().toISOString(), intentId]
    );
  }

  /**
   * Validate an intent without persisting
   */
  async validateIntent(
    userId: string,
    text: string,
    context?: Record<string, unknown>
  ): Promise<GatewayResponse> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const parseResult = await parseIntent(userId, text, context);

      if (!parseResult.success || !parseResult.intent) {
        return {
          success: false,
          error: parseResult.error,
          clarificationNeeded: parseResult.clarificationNeeded,
          clarificationQuestions: parseResult.clarificationQuestions,
        };
      }

      const policyContext: PolicyContext = {
        userId,
        currentTime: new Date(),
      };

      const policyResult = this.policyEngine!.evaluateIntent(parseResult.intent, policyContext);

      return {
        success: policyResult.allowed,
        intent: parseResult.intent,
        policyResult,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Validation failed',
      };
    }
  }

  /**
   * Get the policy engine for direct access
   */
  getPolicyEngine(): PolicyEngine {
    if (!this.policyEngine) {
      throw new Error('Gateway not initialized');
    }
    return this.policyEngine;
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let gateway: IntentGateway | null = null;

export function getGateway(): IntentGateway {
  if (!gateway) {
    gateway = new IntentGateway();
  }
  return gateway;
}

export async function initializeGateway(): Promise<IntentGateway> {
  const gw = getGateway();
  await gw.initialize();
  return gw;
}

// Re-exports
export { parseIntent, parseIntentHeuristic } from './intent-parser.js';
export { PolicyEngine, getPolicyEngine, initializePolicyEngine } from './policy-engine.js';
export type { PolicyEvaluationResult, PolicyContext, PolicyViolation } from './policy-engine.js';

// Security Components
export {
  IntentValidationSandbox,
  getIntentSandbox,
  initializeIntentSandbox,
  defaultSandboxConfig,
} from './intent-sandbox.js';
export type {
  SandboxConfig,
  DangerousPattern,
  PatternCategory,
  ValidationResult,
  ValidationCheck,
  ValidationViolation,
  ValidationWarning,
  RiskAssessment,
  SandboxContext,
} from './intent-sandbox.js';

// Confidence-Aware Parsing
export {
  ConfidenceAwareParser,
  getConfidenceAwareParser,
  initializeConfidenceAwareParser,
  defaultConfidenceParserConfig,
} from './confidence-aware-parser.js';
export type {
  InterpretationOption,
  DisambiguationSession,
  ConfidenceAwareParseResult,
  ParsingMetadata,
  AmbiguityFactor,
  DisambiguationAuditRecord,
  ConfidenceParserConfig,
} from './confidence-aware-parser.js';
