/**
 * AEGIS-T2A Compensation Feasibility Validation Engine
 *
 * Validates that compensating actions will succeed BEFORE primary execution.
 * Operates during PLANNING phase to prevent unrecoverable states.
 */

import { EventEmitter } from 'events';
import {
  PlanManifest,
  PlanStep,
  CompensationAction,
} from '../core/types.js';
import { componentLogger } from '../core/logger.js';
import { hashObject } from '../core/crypto.js';
import { generateId } from '../core/ids.js';

const logger = componentLogger('compensation-feasibility-validator');

// =============================================================================
// Types
// =============================================================================

export interface FeasibilityValidatorConfig {
  /** Enable strict validation mode - fail on any uncertainty */
  strict_mode: boolean;
  /** Timeout for sandbox execution in ms */
  sandbox_timeout_ms: number;
  /** Enable semantic verification */
  verify_semantics: boolean;
  /** Enable permission verification */
  verify_permissions: boolean;
  /** Enable parameter matching */
  verify_parameter_matching: boolean;
  /** Maximum retry attempts for sandbox execution */
  max_sandbox_retries: number;
  /** Custom semantic pairs for action-compensation matching */
  custom_semantic_pairs: Record<string, string[]>;
}

export interface CompensationValidationResult {
  step_id: string;
  action_type: string;
  compensation_action?: string;
  compensation_feasible: boolean;
  failure_reason?: string;
  sandbox_execution_log: string;
  validation_timestamp: string;
  validation_hash: string;
  permissions_verified: boolean;
  semantics_verified: boolean;
  parameters_matched: boolean;
}

export interface CompensationValidationReport {
  workflow_id: string;
  plan_id: string;
  all_compensations_feasible: boolean;
  results: CompensationValidationResult[];
  validation_session_id: string;
  generated_at: string;
  total_steps: number;
  feasible_count: number;
  infeasible_count: number;
  report_hash: string;
}

export interface SimulationContext {
  workflow_id: string;
  plan_id: string;
  user_id: string;
  environment: 'development' | 'staging' | 'production';
  available_permissions: string[];
  available_tools: string[];
}

export interface SimulationResult {
  success: boolean;
  error_summary?: string;
  full_log: string;
  execution_time_ms: number;
  permissions_used: string[];
  resources_accessed: string[];
}

export interface SemanticPair {
  primary_action: string;
  valid_compensations: string[];
}

// =============================================================================
// Default Configuration
// =============================================================================

export const defaultFeasibilityConfig: FeasibilityValidatorConfig = {
  strict_mode: false,
  sandbox_timeout_ms: 30000,
  verify_semantics: true,
  verify_permissions: true,
  verify_parameter_matching: true,
  max_sandbox_retries: 2,
  custom_semantic_pairs: {},
};

// =============================================================================
// Built-in Semantic Pairs
// =============================================================================

const SEMANTIC_PAIRS: Record<string, string[]> = {
  // Create/Insert actions
  'create': ['delete', 'remove', 'destroy'],
  'insert': ['delete', 'remove'],
  'add': ['remove', 'delete'],
  'provision': ['deprovision', 'terminate', 'destroy'],
  'deploy': ['rollback', 'undeploy', 'revert'],
  'launch': ['terminate', 'stop', 'shutdown'],
  'start': ['stop', 'shutdown', 'terminate'],

  // Update/Modify actions
  'update': ['update', 'restore', 'revert'],
  'modify': ['restore', 'revert', 'update'],
  'patch': ['restore', 'revert', 'patch'],
  'set': ['unset', 'reset', 'clear'],
  'enable': ['disable'],
  'activate': ['deactivate'],

  // Permission actions
  'grant': ['revoke'],
  'allow': ['deny', 'revoke'],
  'attach': ['detach'],
  'assign': ['unassign', 'revoke'],

  // Data actions
  'upload': ['delete', 'remove'],
  'put': ['delete', 'remove'],
  'write': ['delete', 'truncate'],
  'publish': ['unpublish', 'retract'],

  // State actions
  'open': ['close'],
  'lock': ['unlock'],
  'encrypt': ['decrypt'],
  'compress': ['decompress'],
};

// =============================================================================
// Critical Identifier Keys
// =============================================================================

const CRITICAL_IDENTIFIER_KEYS = [
  'user_id',
  'resource_id',
  'resource_arn',
  'instance_id',
  'database_name',
  'table_name',
  'bucket',
  'key',
  'service_name',
  'cluster_id',
  'function_name',
  'queue_name',
  'topic_arn',
  'role_name',
  'policy_name',
];

// =============================================================================
// Compensation Feasibility Validator
// =============================================================================

export class CompensationFeasibilityValidator extends EventEmitter {
  private config: FeasibilityValidatorConfig;
  private semanticPairs: Map<string, string[]> = new Map();
  private initialized = false;

  constructor(config: Partial<FeasibilityValidatorConfig> = {}) {
    super();
    this.config = { ...defaultFeasibilityConfig, ...config };
  }

  /**
   * Initialize the validator
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Build semantic pairs map
    for (const [action, compensations] of Object.entries(SEMANTIC_PAIRS)) {
      this.semanticPairs.set(action, compensations);
    }

    // Add custom semantic pairs
    for (const [action, compensations] of Object.entries(this.config.custom_semantic_pairs)) {
      const existing = this.semanticPairs.get(action) || [];
      this.semanticPairs.set(action, [...existing, ...compensations]);
    }

    this.initialized = true;
    logger.info('Compensation feasibility validator initialized');
  }

  /**
   * Validate workflow plan compensations
   * MUST be called BEFORE policy approval gate
   */
  async validateWorkflowPlan(
    plan: PlanManifest,
    context: SimulationContext
  ): Promise<CompensationValidationReport> {
    const sessionId = generateId();
    const startTime = Date.now();

    logger.info(
      { sessionId, planId: plan.planId, stepCount: plan.steps.length },
      'Starting compensation feasibility validation'
    );

    const results: CompensationValidationResult[] = [];
    let allFeasible = true;
    let feasibleCount = 0;
    let infeasibleCount = 0;

    for (const step of plan.steps) {
      const result = await this.validateStepCompensation(step, plan, context);
      results.push(result);

      if (result.compensation_feasible) {
        feasibleCount++;
      } else {
        infeasibleCount++;
        allFeasible = false;
      }

      // Emit per-step event
      this.emit('step_validated', {
        session_id: sessionId,
        step_id: step.stepId,
        feasible: result.compensation_feasible,
        failure_reason: result.failure_reason,
      });
    }

    // Build report
    const report: CompensationValidationReport = {
      workflow_id: context.workflow_id,
      plan_id: plan.planId,
      all_compensations_feasible: allFeasible,
      results,
      validation_session_id: sessionId,
      generated_at: new Date().toISOString(),
      total_steps: plan.steps.length,
      feasible_count: feasibleCount,
      infeasible_count: infeasibleCount,
      report_hash: '', // Will be set below
    };

    // Hash-chain the report for integrity
    report.report_hash = hashObject({
      workflow_id: report.workflow_id,
      plan_id: report.plan_id,
      all_feasible: report.all_compensations_feasible,
      session_id: report.validation_session_id,
      result_hashes: results.map((r) => r.validation_hash),
    });

    // Emit completion event
    this.emit('validation_complete', {
      session_id: sessionId,
      plan_id: plan.planId,
      all_feasible: allFeasible,
      feasible_count: feasibleCount,
      infeasible_count: infeasibleCount,
      duration_ms: Date.now() - startTime,
    });

    logger.info(
      {
        sessionId,
        planId: plan.planId,
        allFeasible,
        feasibleCount,
        infeasibleCount,
        durationMs: Date.now() - startTime,
      },
      'Compensation feasibility validation completed'
    );

    return report;
  }

  /**
   * Validate compensation for a single step
   */
  private async validateStepCompensation(
    step: PlanStep,
    _plan: PlanManifest,
    context: SimulationContext
  ): Promise<CompensationValidationResult> {
    const timestamp = new Date().toISOString();
    const logs: string[] = [];

    // Check if compensation is defined
    if (!step.compensationAction) {
      // Side-effect steps without compensation are critical failures
      if (step.sideEffect) {
        const result = this.createFailureResult(
          step,
          'NO_COMPENSATION_DEFINED',
          'Step has side effects but no compensation action is defined',
          timestamp,
          logs
        );
        return result;
      }

      // Non-side-effect steps without compensation are warnings but allowed
      return this.createSuccessResult(
        step,
        undefined,
        timestamp,
        logs,
        'No compensation needed - step has no side effects'
      );
    }

    const compensation = step.compensationAction;
    logs.push(`Validating compensation: ${compensation.action} for step: ${step.action}`);

    let permissionsVerified = true;
    let semanticsVerified = true;
    let parametersMatched = true;

    // 1. Verify semantic correctness
    if (this.config.verify_semantics) {
      const semanticResult = this.verifySemantics(step.action, compensation.action);
      semanticsVerified = semanticResult.valid;
      logs.push(`Semantic verification: ${semanticResult.valid ? 'PASSED' : 'FAILED'} - ${semanticResult.reason}`);

      if (!semanticResult.valid && this.config.strict_mode) {
        return this.createFailureResult(
          step,
          'SEMANTIC_MISMATCH',
          semanticResult.reason,
          timestamp,
          logs,
          compensation.action
        );
      }
    }

    // 2. Verify parameter matching (identifiers)
    if (this.config.verify_parameter_matching) {
      const paramResult = this.verifyParameterMatching(step.parameters, compensation.parameters);
      parametersMatched = paramResult.valid;
      logs.push(`Parameter matching: ${paramResult.valid ? 'PASSED' : 'FAILED'} - ${paramResult.reason}`);

      if (!paramResult.valid && this.config.strict_mode) {
        return this.createFailureResult(
          step,
          'PARAMETER_MISMATCH',
          paramResult.reason,
          timestamp,
          logs,
          compensation.action
        );
      }
    }

    // 3. Verify permissions
    if (this.config.verify_permissions) {
      const permResult = this.verifyPermissions(compensation, context);
      permissionsVerified = permResult.valid;
      logs.push(`Permission verification: ${permResult.valid ? 'PASSED' : 'FAILED'} - ${permResult.reason}`);

      if (!permResult.valid) {
        return this.createFailureResult(
          step,
          'PERMISSION_DENIED',
          permResult.reason,
          timestamp,
          logs,
          compensation.action
        );
      }
    }

    // 4. Dry-run compensation in sandbox (if available)
    const sandboxResult = await this.dryRunCompensation(step, compensation, context);
    logs.push(`Sandbox dry-run: ${sandboxResult.success ? 'PASSED' : 'FAILED'}`);
    if (sandboxResult.full_log) {
      logs.push(`Sandbox log: ${sandboxResult.full_log.slice(0, 200)}...`);
    }

    if (!sandboxResult.success) {
      return this.createFailureResult(
        step,
        'SANDBOX_EXECUTION_FAILED',
        sandboxResult.error_summary || 'Compensation dry-run failed in sandbox',
        timestamp,
        logs,
        compensation.action
      );
    }

    // All checks passed
    return {
      step_id: step.stepId,
      action_type: step.action,
      compensation_action: compensation.action,
      compensation_feasible: true,
      sandbox_execution_log: logs.join('\n'),
      validation_timestamp: timestamp,
      validation_hash: this.computeResultHash(step.stepId, true, undefined),
      permissions_verified: permissionsVerified,
      semantics_verified: semanticsVerified,
      parameters_matched: parametersMatched,
    };
  }

  /**
   * Verify semantic correctness of compensation
   */
  private verifySemantics(
    primaryAction: string,
    compensationAction: string
  ): { valid: boolean; reason: string } {
    const primaryLower = primaryAction.toLowerCase();
    const compensationLower = compensationAction.toLowerCase();

    // Extract base verb from action (e.g., "create_user" -> "create")
    const primaryVerb = this.extractActionVerb(primaryLower);
    const compensationVerb = this.extractActionVerb(compensationLower);

    // Get valid compensations for primary verb
    const validCompensations = this.semanticPairs.get(primaryVerb);

    if (!validCompensations) {
      // Unknown action type - allow in non-strict mode
      return {
        valid: !this.config.strict_mode,
        reason: `Unknown action type '${primaryVerb}' - no semantic validation available`,
      };
    }

    // Check if compensation verb is valid
    const isValid = validCompensations.some((valid) =>
      compensationVerb.includes(valid) || compensationLower.includes(valid)
    );

    if (isValid) {
      return { valid: true, reason: `'${compensationVerb}' is valid compensation for '${primaryVerb}'` };
    }

    return {
      valid: false,
      reason: `Semantic mismatch: '${compensationAction}' is not a valid compensation for '${primaryAction}'. ` +
              `Expected one of: ${validCompensations.join(', ')}`,
    };
  }

  /**
   * Verify critical identifiers match between action and compensation
   */
  private verifyParameterMatching(
    primaryParams: Record<string, unknown>,
    compensationParams: Record<string, unknown>
  ): { valid: boolean; reason: string } {
    const mismatches: string[] = [];

    for (const key of CRITICAL_IDENTIFIER_KEYS) {
      const primaryValue = this.getNestedValue(primaryParams, key);
      const compensationValue = this.getNestedValue(compensationParams, key);

      // If identifier exists in primary, it should match in compensation
      if (primaryValue !== undefined && compensationValue !== undefined) {
        // Handle template references (e.g., "{response.id}")
        if (typeof compensationValue === 'string' && compensationValue.startsWith('{')) {
          // Template reference is acceptable
          continue;
        }

        if (primaryValue !== compensationValue) {
          mismatches.push(`${key}: primary='${primaryValue}', compensation='${compensationValue}'`);
        }
      } else if (primaryValue !== undefined && compensationValue === undefined) {
        // Critical identifier missing from compensation
        // Check if it's referenced via template
        const hasTemplateRef = JSON.stringify(compensationParams).includes(`{response.${key}}`);
        if (!hasTemplateRef) {
          mismatches.push(`${key}: missing in compensation parameters`);
        }
      }
    }

    if (mismatches.length > 0) {
      return {
        valid: false,
        reason: `Critical identifier mismatches: ${mismatches.join('; ')}`,
      };
    }

    return { valid: true, reason: 'All critical identifiers match' };
  }

  /**
   * Verify required permissions are available
   */
  private verifyPermissions(
    compensation: CompensationAction,
    context: SimulationContext
  ): { valid: boolean; reason: string } {
    // Extract required permissions from tool adapter
    const adapterParts = compensation.toolAdapter.split(':');
    const service = adapterParts[0];
    const action = adapterParts[1] || compensation.action;

    // Build permission pattern
    const requiredPermission = `${service}:${action}`;

    // Check against available permissions
    const hasPermission = context.available_permissions.some((perm) => {
      // Support wildcard permissions
      if (perm === '*' || perm === `${service}:*`) return true;
      return perm === requiredPermission || perm.includes(requiredPermission);
    });

    if (!hasPermission) {
      return {
        valid: false,
        reason: `Missing permission: ${requiredPermission}. Available: ${context.available_permissions.slice(0, 5).join(', ')}...`,
      };
    }

    // Check if tool is available
    const hasToolAccess = context.available_tools.some(
      (tool) => tool === compensation.toolAdapter || tool.startsWith(service!)
    );

    if (!hasToolAccess) {
      return {
        valid: false,
        reason: `Tool not available: ${compensation.toolAdapter}`,
      };
    }

    return { valid: true, reason: 'All required permissions available' };
  }

  /**
   * Dry-run compensation in sandbox environment
   */
  private async dryRunCompensation(
    _step: PlanStep,
    compensation: CompensationAction,
    context: SimulationContext
  ): Promise<SimulationResult> {
    // Simulated dry-run execution
    // In production, this would integrate with actual sandbox infrastructure

    const logs: string[] = [];
    logs.push(`[SANDBOX] Starting dry-run for compensation: ${compensation.action}`);
    logs.push(`[SANDBOX] Target adapter: ${compensation.toolAdapter}`);
    logs.push(`[SANDBOX] Parameters: ${JSON.stringify(compensation.parameters)}`);
    logs.push(`[SANDBOX] Environment: ${context.environment}`);

    // Simulate sandbox execution
    await this.delay(100); // Simulated execution time

    // Check for known failure patterns
    const toolAdapter = compensation.toolAdapter.toLowerCase();
    const action = compensation.action.toLowerCase();

    // Production environment requires extra scrutiny
    if (context.environment === 'production') {
      // Destructive operations need compensation that can actually restore
      if (action.includes('restore') && !compensation.parameters['backup_id']) {
        return {
          success: false,
          error_summary: 'Restore operation requires backup_id parameter',
          full_log: logs.join('\n'),
          execution_time_ms: 100,
          permissions_used: [],
          resources_accessed: [],
        };
      }
    }

    // Check for missing required parameters
    const requiredParams = this.getRequiredParams(toolAdapter);
    for (const param of requiredParams) {
      if (!(param in compensation.parameters)) {
        // Check if it's a template reference
        const paramStr = JSON.stringify(compensation.parameters);
        if (!paramStr.includes(`{response.`) && !paramStr.includes(`{${param}`)) {
          return {
            success: false,
            error_summary: `Missing required parameter: ${param}`,
            full_log: logs.join('\n'),
            execution_time_ms: 100,
            permissions_used: [],
            resources_accessed: [],
          };
        }
      }
    }

    logs.push('[SANDBOX] Dry-run completed successfully');

    return {
      success: true,
      full_log: logs.join('\n'),
      execution_time_ms: 100,
      permissions_used: [`${toolAdapter}:execute`],
      resources_accessed: [context.workflow_id],
    };
  }

  /**
   * Get required parameters for a tool adapter
   */
  private getRequiredParams(toolAdapter: string): string[] {
    const adapterRequirements: Record<string, string[]> = {
      'http:delete': ['url'],
      'http:put': ['url'],
      'http:post': ['url'],
      'aws:ec2': ['instance_id'],
      'aws:s3': ['bucket', 'key'],
      'aws:lambda': ['function_name'],
      'aws:rds': ['db_instance_identifier'],
      'database:delete': ['table'],
      'database:insert': ['table'],
      'database:update': ['table'],
      'file:delete': ['path'],
      'file:write': ['path'],
      'github:api': ['endpoint'],
    };

    // Find matching adapter pattern
    for (const [pattern, params] of Object.entries(adapterRequirements)) {
      if (toolAdapter.startsWith(pattern)) {
        return params;
      }
    }

    return [];
  }

  /**
   * Extract action verb from full action name
   */
  private extractActionVerb(action: string): string {
    // Remove common suffixes/prefixes
    const cleaned = action
      .replace(/_/g, ' ')
      .replace(/-/g, ' ')
      .split(' ')[0] || action;

    return cleaned.toLowerCase();
  }

  /**
   * Get nested value from object
   */
  private getNestedValue(obj: Record<string, unknown>, key: string): unknown {
    if (key in obj) return obj[key];

    // Check nested paths
    for (const [_k, v] of Object.entries(obj)) {
      if (typeof v === 'object' && v !== null) {
        const nested = this.getNestedValue(v as Record<string, unknown>, key);
        if (nested !== undefined) return nested;
      }
    }

    return undefined;
  }

  /**
   * Create failure result
   */
  private createFailureResult(
    step: PlanStep,
    failureCode: string,
    failureReason: string,
    timestamp: string,
    logs: string[],
    compensationAction?: string
  ): CompensationValidationResult {
    logs.push(`FAILURE: ${failureCode} - ${failureReason}`);

    return {
      step_id: step.stepId,
      action_type: step.action,
      compensation_action: compensationAction,
      compensation_feasible: false,
      failure_reason: `${failureCode}: ${failureReason}`,
      sandbox_execution_log: logs.join('\n'),
      validation_timestamp: timestamp,
      validation_hash: this.computeResultHash(step.stepId, false, failureReason),
      permissions_verified: false,
      semantics_verified: false,
      parameters_matched: false,
    };
  }

  /**
   * Create success result
   */
  private createSuccessResult(
    step: PlanStep,
    compensationAction: string | undefined,
    timestamp: string,
    logs: string[],
    note?: string
  ): CompensationValidationResult {
    if (note) logs.push(`NOTE: ${note}`);

    return {
      step_id: step.stepId,
      action_type: step.action,
      compensation_action: compensationAction,
      compensation_feasible: true,
      sandbox_execution_log: logs.join('\n'),
      validation_timestamp: timestamp,
      validation_hash: this.computeResultHash(step.stepId, true, undefined),
      permissions_verified: true,
      semantics_verified: true,
      parameters_matched: true,
    };
  }

  /**
   * Compute cryptographic hash for result
   */
  private computeResultHash(stepId: string, feasible: boolean, failureReason?: string): string {
    return hashObject({
      step_id: stepId,
      feasible,
      failure_reason: failureReason,
      timestamp: Date.now(),
    });
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Add custom semantic pair
   */
  addSemanticPair(primaryAction: string, validCompensations: string[]): void {
    const existing = this.semanticPairs.get(primaryAction) || [];
    this.semanticPairs.set(primaryAction, [...existing, ...validCompensations]);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<FeasibilityValidatorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get configuration
   */
  getConfig(): FeasibilityValidatorConfig {
    return { ...this.config };
  }
}

// =============================================================================
// Error Class for Unrecoverable Plans
// =============================================================================

export class UnrecoverablePlanError extends Error {
  public readonly validation_report: CompensationValidationReport;

  constructor(message: string, report: CompensationValidationReport) {
    super(message);
    this.name = 'UnrecoverablePlanError';
    this.validation_report = report;
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let validator: CompensationFeasibilityValidator | null = null;

export function getCompensationFeasibilityValidator(): CompensationFeasibilityValidator {
  if (!validator) {
    validator = new CompensationFeasibilityValidator();
  }
  return validator;
}

export async function initializeCompensationFeasibilityValidator(
  config?: Partial<FeasibilityValidatorConfig>
): Promise<CompensationFeasibilityValidator> {
  const v = config ? new CompensationFeasibilityValidator(config) : getCompensationFeasibilityValidator();
  await v.initialize();
  validator = v;
  return v;
}
