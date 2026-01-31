/**
 * AEGIS-T2A Runtime Policy Enforcement Layer
 *
 * Real-time policy enforcement during tool execution to prevent parameter
 * mutation attacks that could bypass planning-stage safety checks.
 *
 * Key Components:
 * - RuntimePolicyInterceptor: Middleware wrapping ALL tool executions
 * - Dynamic Risk Re-scoring: Triggers escalation if context changes mid-workflow
 * - Circuit Breaker: Auto-pauses workflow if risk exceeds threshold
 *
 * CRITICAL SAFETY CONSTRAINT:
 * Interceptor operates in FAIL-CLOSED mode. ANY policy evaluation error
 * MUST halt execution and trigger compensation workflow.
 */

import { EventEmitter } from 'events';
import { z } from 'zod';
import { componentLogger } from '../logger.js';
import { generateId } from '../ids.js';
import { hashObject, signObject } from '../crypto.js';
import type { PlanStep, RiskLevel, WorkflowState } from '../types.js';

const logger = componentLogger('runtime-guard');

// =============================================================================
// Constants
// =============================================================================

/**
 * Maximum policy evaluation time (5ms budget)
 */
const MAX_POLICY_EVAL_MS = 5;

/**
 * Default risk threshold for automatic pause
 */
const DEFAULT_RISK_THRESHOLD = 75;

/**
 * Circuit breaker failure threshold
 */
const CIRCUIT_BREAKER_THRESHOLD = 3;

/**
 * Circuit breaker reset timeout (30 seconds)
 */
const CIRCUIT_BREAKER_RESET_MS = 30000;

// =============================================================================
// Types
// =============================================================================

/**
 * Runtime policy evaluation context
 */
export interface RuntimePolicyContext {
  workflowId: string;
  stepId: string;
  planId: string;
  userId: string;
  userRoles: string[];
  environment: 'development' | 'staging' | 'production';
  currentTime: Date;
  originalRiskScore: number;
  toolAdapter: string;
  parameters: Record<string, unknown>;
  targetResource?: string;
  previousStepOutputs: Record<string, unknown>;
}

/**
 * Policy evaluation result
 */
export interface PolicyEvaluationResult {
  evaluationId: string;
  timestamp: string;
  allowed: boolean;
  riskScore: number;
  evaluationTimeMs: number;
  matchedPolicies: PolicyMatch[];
  violations: PolicyViolation[];
  requiresReApproval: boolean;
  escalationRequired: boolean;
  failClosed: boolean;
}

/**
 * Policy match details
 */
export interface PolicyMatch {
  policyId: string;
  policyName: string;
  effect: 'allow' | 'deny' | 'require_approval';
  reason: string;
}

/**
 * Policy violation
 */
export interface PolicyViolation {
  violationId: string;
  policyId: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  remediationAdvice: string;
}

/**
 * Risk escalation event
 */
export interface RiskEscalationEvent {
  eventId: string;
  workflowId: string;
  stepId: string;
  originalRiskScore: number;
  newRiskScore: number;
  escalationReason: EscalationReason;
  requiresReApproval: boolean;
  timestamp: string;
  environmentSnapshot: Record<string, unknown>;
}

/**
 * Escalation reason types
 */
export type EscalationReason =
  | 'RESOURCE_SENSITIVITY_CHANGE'
  | 'POLICY_UPDATE'
  | 'ANOMALOUS_PATTERN'
  | 'PARAMETER_DRIFT'
  | 'ENVIRONMENT_CHANGE'
  | 'RATE_LIMIT_EXCEEDED';

/**
 * Tool execution request
 */
export interface ToolExecutionRequest {
  requestId: string;
  workflowId: string;
  stepId: string;
  planId: string;
  toolAdapter: string;
  parameters: Record<string, unknown>;
  originalParameters: Record<string, unknown>;
  targetResource?: string;
  expectedRiskLevel: RiskLevel;
  userId: string;
  userRoles: string[];
  timestamp: string;
}

/**
 * Interception result
 */
export interface InterceptionResult {
  requestId: string;
  allowed: boolean;
  blocked: boolean;
  pauseWorkflow: boolean;
  compensationRequired: boolean;
  evaluation?: PolicyEvaluationResult;
  escalation?: RiskEscalationEvent;
  error?: string;
}

/**
 * Circuit breaker state
 */
export interface CircuitBreakerState {
  status: 'closed' | 'open' | 'half-open';
  failureCount: number;
  lastFailureTime?: string;
  lastSuccessTime?: string;
  openedAt?: string;
  resetAt?: string;
}

/**
 * Runtime guard configuration
 */
export interface RuntimeGuardConfig {
  enabled: boolean;
  failClosed: boolean;
  maxEvaluationTimeMs: number;
  riskThreshold: number;
  reApprovalThresholdDelta: number;
  circuitBreakerEnabled: boolean;
  circuitBreakerThreshold: number;
  circuitBreakerResetMs: number;
  auditAllEvaluations: boolean;
  parameterDriftDetection: boolean;
}

/**
 * Runtime policy definition
 */
export interface RuntimePolicy {
  policyId: string;
  name: string;
  description: string;
  priority: number;
  enabled: boolean;
  conditions: PolicyCondition[];
  effect: 'allow' | 'deny' | 'require_approval';
  riskModifier: number; // -100 to +100
  failureAction: 'block' | 'pause' | 'compensate';
}

/**
 * Policy condition
 */
export interface PolicyCondition {
  field: string;
  operator: 'equals' | 'notEquals' | 'contains' | 'matches' | 'greaterThan' | 'lessThan';
  value: unknown;
}

/**
 * Audit record for runtime evaluations
 */
export interface RuntimeAuditRecord {
  recordId: string;
  timestamp: string;
  workflowId: string;
  stepId: string;
  requestId: string;
  decision: 'allowed' | 'blocked' | 'paused' | 'fail_closed';
  riskScore: number;
  evaluationTimeMs: number;
  matchedPolicies: string[];
  violations: string[];
  signature: string;
  previousRecordHash: string;
}

// =============================================================================
// Zod Schemas
// =============================================================================

export const RuntimeGuardConfigSchema = z.object({
  enabled: z.boolean().default(false),
  failClosed: z.boolean().default(true),
  maxEvaluationTimeMs: z.number().positive().default(MAX_POLICY_EVAL_MS),
  riskThreshold: z.number().min(0).max(100).default(DEFAULT_RISK_THRESHOLD),
  reApprovalThresholdDelta: z.number().min(0).max(100).default(20),
  circuitBreakerEnabled: z.boolean().default(true),
  circuitBreakerThreshold: z.number().int().positive().default(CIRCUIT_BREAKER_THRESHOLD),
  circuitBreakerResetMs: z.number().positive().default(CIRCUIT_BREAKER_RESET_MS),
  auditAllEvaluations: z.boolean().default(true),
  parameterDriftDetection: z.boolean().default(true),
});

// =============================================================================
// Default Configuration
// =============================================================================

export const defaultRuntimeGuardConfig: RuntimeGuardConfig = {
  enabled: false, // Backward compatible - opt-in
  failClosed: true, // CRITICAL: Never set to false in production
  maxEvaluationTimeMs: MAX_POLICY_EVAL_MS,
  riskThreshold: DEFAULT_RISK_THRESHOLD,
  reApprovalThresholdDelta: 20,
  circuitBreakerEnabled: true,
  circuitBreakerThreshold: CIRCUIT_BREAKER_THRESHOLD,
  circuitBreakerResetMs: CIRCUIT_BREAKER_RESET_MS,
  auditAllEvaluations: true,
  parameterDriftDetection: true,
};

// =============================================================================
// Built-in Runtime Policies
// =============================================================================

const BUILT_IN_POLICIES: RuntimePolicy[] = [
  {
    policyId: 'rt-block-production-destructive',
    name: 'Block Destructive Production Actions',
    description: 'Block destructive actions in production without explicit approval',
    priority: 1000,
    enabled: true,
    conditions: [
      { field: 'environment', operator: 'equals', value: 'production' },
      { field: 'expectedRiskLevel', operator: 'equals', value: 'destructive' },
    ],
    effect: 'require_approval',
    riskModifier: 30,
    failureAction: 'pause',
  },
  {
    policyId: 'rt-block-parameter-drift',
    name: 'Block Significant Parameter Drift',
    description: 'Block execution if parameters differ significantly from planned',
    priority: 900,
    enabled: true,
    conditions: [
      { field: '_parameterDrift', operator: 'greaterThan', value: 0.3 },
    ],
    effect: 'deny',
    riskModifier: 25,
    failureAction: 'pause',
  },
  {
    policyId: 'rt-limit-high-risk-rate',
    name: 'Rate Limit High Risk Operations',
    description: 'Limit high-risk operations to prevent runaway execution',
    priority: 800,
    enabled: true,
    conditions: [
      { field: 'expectedRiskLevel', operator: 'matches', value: 'high|destructive' },
      { field: '_recentHighRiskCount', operator: 'greaterThan', value: 5 },
    ],
    effect: 'deny',
    riskModifier: 20,
    failureAction: 'pause',
  },
  {
    policyId: 'rt-block-credential-exposure',
    name: 'Block Credential Exposure',
    description: 'Block operations that may expose credentials',
    priority: 950,
    enabled: true,
    conditions: [
      { field: 'parameters', operator: 'matches', value: '(?:password|secret|key|token)' },
      { field: 'toolAdapter', operator: 'matches', value: 'http|shell|notification' },
    ],
    effect: 'deny',
    riskModifier: 40,
    failureAction: 'block',
  },
];

// =============================================================================
// Circuit Breaker
// =============================================================================

/**
 * Circuit breaker for fault tolerance
 */
export class CircuitBreaker extends EventEmitter {
  private state: CircuitBreakerState = {
    status: 'closed',
    failureCount: 0,
  };
  private config: RuntimeGuardConfig;
  private resetTimer: NodeJS.Timeout | null = null;

  constructor(config: RuntimeGuardConfig) {
    super();
    this.config = config;
  }

  /**
   * Check if circuit allows execution
   */
  canExecute(): boolean {
    if (this.state.status === 'open') {
      // Check if we should move to half-open
      if (this.state.openedAt) {
        const elapsed = Date.now() - new Date(this.state.openedAt).getTime();
        if (elapsed >= this.config.circuitBreakerResetMs) {
          this.halfOpen();
          return true;
        }
      }
      return false;
    }
    return true;
  }

  /**
   * Record successful execution
   */
  recordSuccess(): void {
    this.state.lastSuccessTime = new Date().toISOString();

    if (this.state.status === 'half-open') {
      this.close();
    }

    this.state.failureCount = 0;
  }

  /**
   * Record failed execution
   */
  recordFailure(): void {
    this.state.failureCount++;
    this.state.lastFailureTime = new Date().toISOString();

    if (this.state.failureCount >= this.config.circuitBreakerThreshold) {
      this.open();
    }
  }

  /**
   * Get current state
   */
  getState(): CircuitBreakerState {
    return { ...this.state };
  }

  /**
   * Force reset
   */
  reset(): void {
    this.close();
    this.state.failureCount = 0;
  }

  private open(): void {
    if (this.state.status !== 'open') {
      this.state.status = 'open';
      this.state.openedAt = new Date().toISOString();

      this.emit('circuit_opened', {
        failureCount: this.state.failureCount,
        openedAt: this.state.openedAt,
      });

      logger.warn(
        { failureCount: this.state.failureCount },
        'Circuit breaker opened'
      );
    }
  }

  private halfOpen(): void {
    if (this.state.status !== 'half-open') {
      this.state.status = 'half-open';
      this.state.resetAt = new Date().toISOString();

      this.emit('circuit_half_open', {
        resetAt: this.state.resetAt,
      });

      logger.info('Circuit breaker half-open, testing execution');
    }
  }

  private close(): void {
    if (this.state.status !== 'closed') {
      this.state.status = 'closed';
      this.state.failureCount = 0;
      delete this.state.openedAt;
      delete this.state.resetAt;

      this.emit('circuit_closed', {});

      logger.info('Circuit breaker closed');
    }
  }
}

// =============================================================================
// Parameter Drift Detector
// =============================================================================

/**
 * Detects drift between planned and actual parameters
 */
export class ParameterDriftDetector {
  /**
   * Calculate drift score between original and current parameters
   * Returns 0.0 (no drift) to 1.0 (completely different)
   */
  calculateDrift(
    original: Record<string, unknown>,
    current: Record<string, unknown>
  ): { score: number; driftedFields: string[] } {
    const driftedFields: string[] = [];
    const allKeys = new Set([...Object.keys(original), ...Object.keys(current)]);

    if (allKeys.size === 0) {
      return { score: 0, driftedFields: [] };
    }

    let driftCount = 0;

    for (const key of allKeys) {
      const origValue = original[key];
      const currValue = current[key];

      if (!this.valuesEqual(origValue, currValue)) {
        driftedFields.push(key);
        driftCount++;
      }
    }

    return {
      score: driftCount / allKeys.size,
      driftedFields,
    };
  }

  /**
   * Check if values are equal (deep comparison)
   */
  private valuesEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === undefined || b === undefined) return false;
    if (a === null || b === null) return a === b;

    const typeA = typeof a;
    const typeB = typeof b;

    if (typeA !== typeB) return false;

    if (typeA === 'object') {
      return JSON.stringify(a) === JSON.stringify(b);
    }

    return a === b;
  }
}

// =============================================================================
// Risk Scorer
// =============================================================================

/**
 * Dynamic risk scorer for runtime evaluation
 */
export class RuntimeRiskScorer {
  private recentHighRiskOps = new Map<string, number>(); // workflowId -> count

  /**
   * Calculate current risk score
   */
  calculateRisk(context: RuntimePolicyContext): {
    score: number;
    factors: Array<{ factor: string; impact: number }>;
  } {
    const factors: Array<{ factor: string; impact: number }> = [];
    let baseScore = context.originalRiskScore;

    // Environment factor
    if (context.environment === 'production') {
      factors.push({ factor: 'production_environment', impact: 15 });
      baseScore += 15;
    } else if (context.environment === 'staging') {
      factors.push({ factor: 'staging_environment', impact: 5 });
      baseScore += 5;
    }

    // Tool adapter risk
    const highRiskAdapters = ['shell', 'database:write', 'aws:iam', 'aws:kms'];
    if (highRiskAdapters.some((a) => context.toolAdapter.includes(a))) {
      factors.push({ factor: 'high_risk_adapter', impact: 10 });
      baseScore += 10;
    }

    // Recent high-risk operations
    const recentCount = this.recentHighRiskOps.get(context.workflowId) ?? 0;
    if (recentCount > 3) {
      factors.push({ factor: 'high_risk_velocity', impact: 10 });
      baseScore += 10;
    }

    // Parameter complexity
    const paramCount = Object.keys(context.parameters).length;
    if (paramCount > 10) {
      factors.push({ factor: 'complex_parameters', impact: 5 });
      baseScore += 5;
    }

    // Time-based risk (off-hours)
    const hour = context.currentTime.getHours();
    if (hour < 6 || hour > 22) {
      factors.push({ factor: 'off_hours_operation', impact: 5 });
      baseScore += 5;
    }

    return {
      score: Math.min(100, Math.max(0, baseScore)),
      factors,
    };
  }

  /**
   * Track high-risk operation
   */
  trackHighRiskOperation(workflowId: string): void {
    const count = this.recentHighRiskOps.get(workflowId) ?? 0;
    this.recentHighRiskOps.set(workflowId, count + 1);
  }

  /**
   * Reset tracking for workflow
   */
  resetWorkflow(workflowId: string): void {
    this.recentHighRiskOps.delete(workflowId);
  }
}

// =============================================================================
// Runtime Policy Interceptor
// =============================================================================

/**
 * Main interceptor for runtime policy enforcement
 *
 * CRITICAL: This class operates in FAIL-CLOSED mode by default.
 * Any error during policy evaluation MUST halt execution.
 */
export class RuntimePolicyInterceptor extends EventEmitter {
  private config: RuntimeGuardConfig;
  private policies: RuntimePolicy[] = [];
  private circuitBreaker: CircuitBreaker;
  private driftDetector: ParameterDriftDetector;
  private riskScorer: RuntimeRiskScorer;
  private auditChain: RuntimeAuditRecord[] = [];
  private lastAuditHash = 'genesis';
  private initialized = false;

  constructor(config: Partial<RuntimeGuardConfig> = {}) {
    super();
    this.config = { ...defaultRuntimeGuardConfig, ...config };
    this.circuitBreaker = new CircuitBreaker(this.config);
    this.driftDetector = new ParameterDriftDetector();
    this.riskScorer = new RuntimeRiskScorer();

    // Load built-in policies
    this.policies = [...BUILT_IN_POLICIES];
  }

  /**
   * Initialize the interceptor
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!this.config.enabled) {
      logger.info('Runtime policy enforcement is disabled');
      this.initialized = true;
      return;
    }

    // Validate fail-closed is enabled
    if (!this.config.failClosed) {
      logger.error('CRITICAL: failClosed=false is forbidden in production');
      throw new Error('Runtime guard must operate in fail-closed mode');
    }

    this.initialized = true;
    logger.info('Runtime policy interceptor initialized');
  }

  /**
   * Intercept tool execution request
   *
   * This method MUST be called before every tool execution.
   * Returns InterceptionResult with decision.
   */
  async intercept(request: ToolExecutionRequest): Promise<InterceptionResult> {
    if (!this.config.enabled) {
      return {
        requestId: request.requestId,
        allowed: true,
        blocked: false,
        pauseWorkflow: false,
        compensationRequired: false,
      };
    }

    const startTime = Date.now();

    try {
      // Check circuit breaker
      if (this.config.circuitBreakerEnabled && !this.circuitBreaker.canExecute()) {
        return this.handleCircuitOpen(request);
      }

      // Build evaluation context
      const context = this.buildContext(request);

      // Evaluate policies with timeout
      const evaluation = await this.evaluateWithTimeout(context);

      // Check for parameter drift
      if (this.config.parameterDriftDetection) {
        const drift = this.driftDetector.calculateDrift(
          request.originalParameters,
          request.parameters
        );

        if (drift.score > 0.3) {
          evaluation.violations.push({
            violationId: generateId(),
            policyId: 'rt-block-parameter-drift',
            severity: 'high',
            description: `Parameter drift detected: ${drift.score.toFixed(2)} (fields: ${drift.driftedFields.join(', ')})`,
            remediationAdvice: 'Verify parameters match original plan',
          });
          evaluation.allowed = false;
        }
      }

      // Check for risk escalation
      let escalation: RiskEscalationEvent | undefined;
      if (evaluation.riskScore > context.originalRiskScore + this.config.reApprovalThresholdDelta) {
        escalation = this.createEscalationEvent(request, context.originalRiskScore, evaluation.riskScore);
        evaluation.requiresReApproval = true;
        evaluation.escalationRequired = true;
      }

      // Determine action
      const result = this.determineAction(request, evaluation, escalation);

      // Update circuit breaker
      if (result.allowed) {
        this.circuitBreaker.recordSuccess();
      } else if (result.blocked) {
        this.circuitBreaker.recordFailure();
      }

      // Record audit
      await this.recordAudit(request, evaluation, result);

      // Track high-risk operations
      if (evaluation.riskScore >= this.config.riskThreshold) {
        this.riskScorer.trackHighRiskOperation(request.workflowId);
      }

      return result;
    } catch (error) {
      // FAIL-CLOSED: Any error during evaluation halts execution
      if (this.config.failClosed) {
        logger.error(
          { error, requestId: request.requestId },
          'FAIL-CLOSED: Policy evaluation error'
        );

        this.circuitBreaker.recordFailure();

        return {
          requestId: request.requestId,
          allowed: false,
          blocked: true,
          pauseWorkflow: true,
          compensationRequired: true,
          error: `FAIL-CLOSED: ${error instanceof Error ? error.message : 'Unknown error'}`,
          evaluation: {
            evaluationId: generateId(),
            timestamp: new Date().toISOString(),
            allowed: false,
            riskScore: 100,
            evaluationTimeMs: Date.now() - startTime,
            matchedPolicies: [],
            violations: [],
            requiresReApproval: false,
            escalationRequired: false,
            failClosed: true,
          },
        };
      }

      throw error;
    }
  }

  /**
   * Add custom runtime policy
   */
  addPolicy(policy: RuntimePolicy): void {
    this.policies.push(policy);
    this.policies.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Remove policy by ID
   */
  removePolicy(policyId: string): boolean {
    const idx = this.policies.findIndex((p) => p.policyId === policyId);
    if (idx !== -1) {
      this.policies.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * Get circuit breaker state
   */
  getCircuitBreakerState(): CircuitBreakerState {
    return this.circuitBreaker.getState();
  }

  /**
   * Reset circuit breaker
   */
  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }

  /**
   * Get audit trail
   */
  getAuditTrail(workflowId?: string): RuntimeAuditRecord[] {
    if (workflowId) {
      return this.auditChain.filter((r) => r.workflowId === workflowId);
    }
    return [...this.auditChain];
  }

  /**
   * Verify audit chain integrity
   */
  verifyAuditChainIntegrity(): { valid: boolean; brokenAt?: number } {
    if (this.auditChain.length === 0) {
      return { valid: true };
    }

    let expectedPreviousHash = 'genesis';

    for (let i = 0; i < this.auditChain.length; i++) {
      const record = this.auditChain[i];

      if (record.previousRecordHash !== expectedPreviousHash) {
        return { valid: false, brokenAt: i };
      }

      expectedPreviousHash = record.signature;
    }

    return { valid: true };
  }

  /**
   * Reset workflow tracking
   */
  resetWorkflow(workflowId: string): void {
    this.riskScorer.resetWorkflow(workflowId);
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Build evaluation context
   */
  private buildContext(request: ToolExecutionRequest): RuntimePolicyContext {
    return {
      workflowId: request.workflowId,
      stepId: request.stepId,
      planId: request.planId,
      userId: request.userId,
      userRoles: request.userRoles,
      environment: this.getEnvironment(),
      currentTime: new Date(),
      originalRiskScore: this.getRiskScore(request.expectedRiskLevel),
      toolAdapter: request.toolAdapter,
      parameters: request.parameters,
      targetResource: request.targetResource,
      previousStepOutputs: {},
    };
  }

  /**
   * Get current environment
   */
  private getEnvironment(): 'development' | 'staging' | 'production' {
    const env = process.env['NODE_ENV'] ?? 'development';
    if (env === 'production') return 'production';
    if (env === 'staging') return 'staging';
    return 'development';
  }

  /**
   * Convert risk level to numeric score
   */
  private getRiskScore(level: RiskLevel): number {
    switch (level) {
      case 'low':
        return 20;
      case 'medium':
        return 40;
      case 'high':
        return 60;
      case 'destructive':
        return 80;
      default:
        return 50;
    }
  }

  /**
   * Evaluate policies with timeout
   */
  private async evaluateWithTimeout(
    context: RuntimePolicyContext
  ): Promise<PolicyEvaluationResult> {
    const startTime = Date.now();
    const evaluationId = generateId();

    const timeoutPromise = new Promise<PolicyEvaluationResult>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Policy evaluation timeout (>${this.config.maxEvaluationTimeMs}ms)`));
      }, this.config.maxEvaluationTimeMs * 10); // Allow 10x for complex evaluations
    });

    const evaluationPromise = this.evaluate(context);

    const result = await Promise.race([evaluationPromise, timeoutPromise]);

    result.evaluationTimeMs = Date.now() - startTime;

    if (result.evaluationTimeMs > this.config.maxEvaluationTimeMs) {
      logger.warn(
        {
          evaluationTimeMs: result.evaluationTimeMs,
          target: this.config.maxEvaluationTimeMs,
        },
        'Policy evaluation exceeded target latency'
      );
    }

    return result;
  }

  /**
   * Evaluate policies
   */
  private async evaluate(context: RuntimePolicyContext): Promise<PolicyEvaluationResult> {
    const evaluationId = generateId();
    const matchedPolicies: PolicyMatch[] = [];
    const violations: PolicyViolation[] = [];

    let riskScore = context.originalRiskScore;
    let allowed = true;
    let requiresReApproval = false;

    // Calculate dynamic risk
    const riskResult = this.riskScorer.calculateRisk(context);
    riskScore = riskResult.score;

    // Evaluate each policy
    for (const policy of this.policies) {
      if (!policy.enabled) continue;

      const matches = this.policyMatches(policy, context, riskScore);

      if (matches) {
        matchedPolicies.push({
          policyId: policy.policyId,
          policyName: policy.name,
          effect: policy.effect,
          reason: policy.description,
        });

        riskScore += policy.riskModifier;

        if (policy.effect === 'deny') {
          allowed = false;
          violations.push({
            violationId: generateId(),
            policyId: policy.policyId,
            severity: 'high',
            description: `Policy ${policy.name} denied execution`,
            remediationAdvice: policy.description,
          });
        } else if (policy.effect === 'require_approval') {
          requiresReApproval = true;
        }
      }
    }

    // Clamp risk score
    riskScore = Math.min(100, Math.max(0, riskScore));

    // Check risk threshold
    if (riskScore >= this.config.riskThreshold && allowed) {
      requiresReApproval = true;
    }

    return {
      evaluationId,
      timestamp: new Date().toISOString(),
      allowed: allowed && !requiresReApproval,
      riskScore,
      evaluationTimeMs: 0, // Will be set by caller
      matchedPolicies,
      violations,
      requiresReApproval,
      escalationRequired: false,
      failClosed: false,
    };
  }

  /**
   * Check if policy matches context
   */
  private policyMatches(
    policy: RuntimePolicy,
    context: RuntimePolicyContext,
    currentRisk: number
  ): boolean {
    for (const condition of policy.conditions) {
      if (!this.conditionMatches(condition, context, currentRisk)) {
        return false;
      }
    }
    return policy.conditions.length > 0; // Only match if has conditions
  }

  /**
   * Check if condition matches
   */
  private conditionMatches(
    condition: PolicyCondition,
    context: RuntimePolicyContext,
    currentRisk: number
  ): boolean {
    let fieldValue: unknown;

    // Handle special fields
    if (condition.field === '_parameterDrift') {
      // This is handled separately
      return false;
    }
    if (condition.field === '_recentHighRiskCount') {
      fieldValue = 0; // Handled by risk scorer
    } else {
      fieldValue = (context as Record<string, unknown>)[condition.field];
    }

    switch (condition.operator) {
      case 'equals':
        return fieldValue === condition.value;
      case 'notEquals':
        return fieldValue !== condition.value;
      case 'contains':
        return String(fieldValue).includes(String(condition.value));
      case 'matches':
        return new RegExp(String(condition.value)).test(String(fieldValue));
      case 'greaterThan':
        return Number(fieldValue) > Number(condition.value);
      case 'lessThan':
        return Number(fieldValue) < Number(condition.value);
      default:
        return false;
    }
  }

  /**
   * Create risk escalation event
   */
  private createEscalationEvent(
    request: ToolExecutionRequest,
    originalRisk: number,
    newRisk: number
  ): RiskEscalationEvent {
    const delta = newRisk - originalRisk;

    let reason: EscalationReason = 'ANOMALOUS_PATTERN';
    if (delta > 30) {
      reason = 'RESOURCE_SENSITIVITY_CHANGE';
    } else if (this.getEnvironment() === 'production') {
      reason = 'ENVIRONMENT_CHANGE';
    }

    const event: RiskEscalationEvent = {
      eventId: generateId(),
      workflowId: request.workflowId,
      stepId: request.stepId,
      originalRiskScore: originalRisk,
      newRiskScore: newRisk,
      escalationReason: reason,
      requiresReApproval: true,
      timestamp: new Date().toISOString(),
      environmentSnapshot: {
        environment: this.getEnvironment(),
        toolAdapter: request.toolAdapter,
        parameterCount: Object.keys(request.parameters).length,
      },
    };

    this.emit('risk_escalation', event);

    logger.warn(
      {
        workflowId: request.workflowId,
        stepId: request.stepId,
        originalRisk,
        newRisk,
        reason,
      },
      'Risk escalation triggered'
    );

    return event;
  }

  /**
   * Determine action based on evaluation
   */
  private determineAction(
    request: ToolExecutionRequest,
    evaluation: PolicyEvaluationResult,
    escalation?: RiskEscalationEvent
  ): InterceptionResult {
    if (evaluation.failClosed) {
      return {
        requestId: request.requestId,
        allowed: false,
        blocked: true,
        pauseWorkflow: true,
        compensationRequired: true,
        evaluation,
      };
    }

    if (!evaluation.allowed && evaluation.violations.length > 0) {
      // Check if any violation requires compensation
      const compensationRequired = evaluation.violations.some(
        (v) => v.severity === 'critical'
      );

      return {
        requestId: request.requestId,
        allowed: false,
        blocked: true,
        pauseWorkflow: true,
        compensationRequired,
        evaluation,
        escalation,
      };
    }

    if (evaluation.requiresReApproval || evaluation.escalationRequired) {
      return {
        requestId: request.requestId,
        allowed: false,
        blocked: false,
        pauseWorkflow: true,
        compensationRequired: false,
        evaluation,
        escalation,
      };
    }

    return {
      requestId: request.requestId,
      allowed: true,
      blocked: false,
      pauseWorkflow: false,
      compensationRequired: false,
      evaluation,
    };
  }

  /**
   * Handle circuit breaker open state
   */
  private handleCircuitOpen(request: ToolExecutionRequest): InterceptionResult {
    const state = this.circuitBreaker.getState();

    this.emit('circuit_blocked', {
      requestId: request.requestId,
      workflowId: request.workflowId,
      state,
    });

    return {
      requestId: request.requestId,
      allowed: false,
      blocked: true,
      pauseWorkflow: true,
      compensationRequired: false,
      error: `Circuit breaker open since ${state.openedAt}`,
    };
  }

  /**
   * Record audit event
   */
  private async recordAudit(
    request: ToolExecutionRequest,
    evaluation: PolicyEvaluationResult,
    result: InterceptionResult
  ): Promise<void> {
    if (!this.config.auditAllEvaluations && result.allowed) {
      return;
    }

    let decision: RuntimeAuditRecord['decision'] = 'allowed';
    if (result.blocked) decision = 'blocked';
    else if (result.pauseWorkflow) decision = 'paused';
    else if (evaluation.failClosed) decision = 'fail_closed';

    const record: RuntimeAuditRecord = {
      recordId: generateId(),
      timestamp: new Date().toISOString(),
      workflowId: request.workflowId,
      stepId: request.stepId,
      requestId: request.requestId,
      decision,
      riskScore: evaluation.riskScore,
      evaluationTimeMs: evaluation.evaluationTimeMs,
      matchedPolicies: evaluation.matchedPolicies.map((p) => p.policyId),
      violations: evaluation.violations.map((v) => v.violationId),
      previousRecordHash: this.lastAuditHash,
      signature: '', // Will be set after hashing
    };

    record.signature = hashObject({
      ...record,
      signature: undefined,
    });

    this.lastAuditHash = record.signature;
    this.auditChain.push(record);

    this.emit('audit_recorded', {
      recordId: record.recordId,
      decision,
    });
  }
}

// =============================================================================
// Singleton
// =============================================================================

let runtimeGuard: RuntimePolicyInterceptor | null = null;

export function getRuntimePolicyInterceptor(): RuntimePolicyInterceptor {
  if (!runtimeGuard) {
    runtimeGuard = new RuntimePolicyInterceptor();
  }
  return runtimeGuard;
}

export async function initializeRuntimePolicyInterceptor(
  config?: Partial<RuntimeGuardConfig>
): Promise<RuntimePolicyInterceptor> {
  if (!runtimeGuard) {
    runtimeGuard = new RuntimePolicyInterceptor(config);
  }
  await runtimeGuard.initialize();
  return runtimeGuard;
}
