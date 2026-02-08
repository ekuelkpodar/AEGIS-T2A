/**
 * AEGIS-T2A Intent & Policy Gateway
 *
 * Entry point for intent processing and policy validation.
 */

import { TypedIntent } from '../core/types.js';
import { execute, queryOne } from '../core/database.js';
import { componentLogger, logIntent } from '../core/logger.js';
import { parseIntent, parseIntentHeuristic, IntentParseResult } from './intent-parser.js';
import {
  PolicyEngine,
  initializePolicyEngine,
  PolicyEvaluationResult,
  PolicyContext,
} from './policy-engine.js';
import { getPromptInjectionDetector, ThreatLevel } from '../security/prompt-injection-detector.js';
import { getLLMGuardrails } from '../security/llm-guardrails.js';
import { withSpan, setSpanAttributes } from '../observability/index.js';
import { getMetricsRegistry } from '../observability/metrics.js';

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
    const metrics = getMetricsRegistry();
    metrics.inc('aegis_intents_total', 1);

    return withSpan('aegis.intent.process', {
      'aegis.user.id': request.userId,
      'aegis.environment': request.environment ?? 'unspecified',
      'aegis.request.text_length': request.text.length,
      'gen_ai.operation.name': 'intent_parse',
    }, async (span) => {
      // Step 0: Security checks - Prompt injection detection
      const injectionDetector = getPromptInjectionDetector();
      const injectionResult = await injectionDetector.analyzePrompt(request.text, {
        userId: request.userId,
      });

      if (injectionResult.blocked) {
        logger.warn('Request blocked by prompt injection detector', {
          userId: request.userId,
          threatLevel: injectionResult.threatLevel,
          confidence: injectionResult.confidence,
          patterns: injectionResult.detectedPatterns.length,
        });
        metrics.inc('aegis_intents_blocked_total', 1);

        setSpanAttributes(span, {
          'aegis.security.prompt_injection.blocked': true,
          'aegis.security.prompt_injection.threat_level': injectionResult.threatLevel,
          'aegis.security.prompt_injection.confidence': injectionResult.confidence,
        });

        return {
          success: false,
          error: injectionResult.reason || 'Request blocked due to security concerns',
        };
      }

      if (injectionResult.threatLevel !== ThreatLevel.SAFE) {
        logger.info('Suspicious prompt detected but allowed', {
          userId: request.userId,
          threatLevel: injectionResult.threatLevel,
          confidence: injectionResult.confidence,
        });
      }

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
        metrics.inc('aegis_intents_failed_total', 1);
        setSpanAttributes(span, {
          'aegis.intent.parsed': false,
          'aegis.intent.clarification_needed': parseResult.clarificationNeeded ?? false,
        });
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
      metrics.inc('aegis_policy_evaluations_total', 1);

      // Update intent with policy result
      intent.policyStatus = policyResult.allowed
        ? policyResult.requiresApproval
          ? 'pending'
          : 'approved'
        : 'denied';
      intent.approvalRequired = policyResult.requiresApproval;

      // Step 3: Persist the intent
      await this.persistIntent(intent);

      setSpanAttributes(span, {
        'aegis.intent.id': intent.intentId,
        'aegis.intent.action_type': intent.actionType,
        'aegis.intent.risk_level': intent.riskLevel,
        'aegis.intent.policy_status': intent.policyStatus,
        'aegis.intent.approval_required': intent.approvalRequired,
        'aegis.intent.confidence': intent.confidence,
        'aegis.intent.processing_ms': Date.now() - startTime,
        'aegis.policy.allowed': policyResult.allowed,
        'aegis.policy.requires_approval': policyResult.requiresApproval,
        'aegis.policy.matched_rules': policyResult.matchedRules.length,
      });

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
    }).catch((error) => {
      metrics.inc('aegis_intents_failed_total', 1);
      logger.error({ error, userId: request.userId }, 'Failed to process request');

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error processing request',
      };
    });
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

// =============================================================================
// Phase 3: Advanced Policy Engine & Governance
// =============================================================================

// Policy Versioning & History
export {
  PolicyVersioningManager,
  getPolicyVersioningManager,
} from './policy-versioning.js';
export type {
  PolicyVersion,
  PolicyDiff,
  PolicyVersionHistory,
  RollbackRequest,
  PolicyApproval,
} from './policy-versioning.js';

// Policy Templates Library
export {
  PolicyTemplateManager,
  getPolicyTemplateManager,
  POLICY_TEMPLATES,
} from './policy-templates.js';
export type {
  PolicyTemplate,
  PolicyCategory,
  ComplianceFramework,
  TemplateParameter,
  TemplateInstantiation,
} from './policy-templates.js';

// Policy Testing Framework
export {
  PolicyTestingFramework,
  getPolicyTestingFramework,
} from './policy-testing.js';
export type {
  PolicyTestCase,
  PolicyTestResult,
  TestFailure,
  PolicyTestSuite,
  TestSuiteResult,
  PolicyCoverage,
} from './policy-testing.js';

// Policy Conflict Detection
export {
  PolicyConflictDetector,
  getPolicyConflictDetector,
} from './policy-conflict-detector.js';
export type {
  PolicyConflict,
  ConflictType,
  ConflictAnalysisResult,
  ConflictResolution,
} from './policy-conflict-detector.js';

// Policy RBAC Integration with SPIFFE
export {
  PolicyRBACManager,
  getPolicyRBACManager,
} from './policy-rbac.js';
export type {
  Role,
  Permission,
  RoleBinding,
  PolicyRBACContext,
  RBACEvaluationResult,
} from './policy-rbac.js';

// Policy Impact Analysis
export {
  PolicyImpactAnalyzer,
  getPolicyImpactAnalyzer,
} from './policy-impact-analyzer.js';
export type {
  PolicyChange,
  ImpactAnalysisRequest,
  ImpactAnalysisResult,
  AffectedRequest,
} from './policy-impact-analyzer.js';

// Policy Compliance Mapper
export {
  PolicyComplianceMapper,
  getPolicyComplianceMapper,
  COMPLIANCE_CONTROLS,
} from './policy-compliance-mapper.js';
export type {
  ComplianceControl,
  PolicyComplianceMapping,
  ComplianceReport,
  ComplianceGap,
} from './policy-compliance-mapper.js';

// Policy Analytics Engine
export {
  PolicyAnalyticsEngine,
  getPolicyAnalyticsEngine,
} from './policy-analytics.js';
export type {
  PolicyMetric,
  PolicyAnalytics,
} from './policy-analytics.js';

// Policy Exception Management
export {
  PolicyExceptionManager,
  getPolicyExceptionManager,
} from './policy-exception-manager.js';
export type {
  PolicyException,
} from './policy-exception-manager.js';

// Policy Inheritance
export {
  PolicyInheritanceManager,
  getPolicyInheritanceManager,
} from './policy-inheritance.js';
export type {
  PolicyScope,
} from './policy-inheritance.js';
