/**
 * AEGIS-T2A Compensation Verification Engine
 *
 * Verifies that compensation actions are correctly defined, idempotent,
 * and capable of properly rolling back operations.
 */

import { EventEmitter } from 'events';
import {
  PlanManifest,
  PlanStep,
  CompensationAction,
  RiskLevel,
} from '../core/types.js';
import { componentLogger } from '../core/logger.js';

const logger = componentLogger('compensation-verifier');

// =============================================================================
// Types
// =============================================================================

export interface CompensationVerifierConfig {
  /** Enable strict verification mode */
  strict_mode: boolean;
  /** Require compensation for all steps with side effects */
  require_compensation_for_side_effects: boolean;
  /** Require compensation for high-risk steps */
  require_compensation_for_high_risk: boolean;
  /** Require idempotency keys for all compensations */
  require_idempotency_keys: boolean;
  /** Maximum compensation timeout allowed */
  max_compensation_timeout_ms: number;
  /** Minimum compensation timeout allowed */
  min_compensation_timeout_ms: number;
  /** Verify compensation parameter completeness */
  verify_parameters: boolean;
  /** Verify compensation ordering */
  verify_ordering: boolean;
  /** Custom verification rules */
  custom_rules: CompensationRule[];
}

export interface CompensationRule {
  id: string;
  name: string;
  description: string;
  condition: (step: PlanStep, plan: PlanManifest) => boolean;
  requirement: CompensationRequirement;
  severity: 'warning' | 'error' | 'critical';
}

export interface CompensationRequirement {
  needs_compensation: boolean;
  required_parameters?: string[];
  must_be_idempotent?: boolean;
  max_timeout_ms?: number;
  required_capabilities?: string[];
}

export interface VerificationResult {
  verification_id: string;
  plan_id: string;
  timestamp: string;
  valid: boolean;
  score: number;
  step_results: StepVerificationResult[];
  gaps: CompensationGap[];
  issues: VerificationIssue[];
  recommendations: VerificationRecommendation[];
  coverage: CompensationCoverage;
  risk_assessment: CompensationRiskAssessment;
}

export interface StepVerificationResult {
  step_id: string;
  has_compensation: boolean;
  needs_compensation: boolean;
  compensation_valid: boolean;
  idempotency_valid: boolean;
  timeout_valid: boolean;
  parameters_valid: boolean;
  issues: string[];
}

export interface CompensationGap {
  step_id: string;
  step_action: string;
  risk_level: RiskLevel;
  has_side_effects: boolean;
  reason: string;
  impact: 'low' | 'medium' | 'high' | 'critical';
  suggested_compensation?: SuggestedCompensation;
}

export interface SuggestedCompensation {
  action: string;
  tool_adapter: string;
  parameters: Record<string, string>;
  description: string;
}

export interface VerificationIssue {
  issue_id: string;
  step_id: string;
  severity: 'warning' | 'error' | 'critical';
  category: IssueCategory;
  message: string;
  details?: string;
  fix_suggestion?: string;
}

export type IssueCategory =
  | 'missing_compensation'
  | 'invalid_compensation'
  | 'missing_idempotency'
  | 'timeout_issue'
  | 'parameter_issue'
  | 'ordering_issue'
  | 'capability_mismatch'
  | 'circular_dependency';

export interface VerificationRecommendation {
  priority: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  title: string;
  description: string;
  affected_steps: string[];
}

export interface CompensationCoverage {
  total_steps: number;
  steps_with_side_effects: number;
  steps_with_compensation: number;
  coverage_percentage: number;
  high_risk_coverage: number;
  destructive_coverage: number;
}

export interface CompensationRiskAssessment {
  overall_risk: 'low' | 'medium' | 'high' | 'critical';
  uncompensated_risk_score: number;
  recovery_confidence: number;
  worst_case_scenario: string;
  factors: RiskFactor[];
}

export interface RiskFactor {
  name: string;
  weight: number;
  score: number;
  description: string;
}

// =============================================================================
// Default Configuration
// =============================================================================

export const defaultVerifierConfig: CompensationVerifierConfig = {
  strict_mode: false,
  require_compensation_for_side_effects: true,
  require_compensation_for_high_risk: true,
  require_idempotency_keys: true,
  max_compensation_timeout_ms: 300000, // 5 minutes
  min_compensation_timeout_ms: 1000,   // 1 second
  verify_parameters: true,
  verify_ordering: true,
  custom_rules: [],
};

// =============================================================================
// Compensation Templates
// =============================================================================

const COMPENSATION_TEMPLATES: Record<string, SuggestedCompensation> = {
  'http:post': {
    action: 'rollback_post',
    tool_adapter: 'http:delete',
    parameters: { url: '{original_url}', id: '{response.id}' },
    description: 'Delete the created resource',
  },
  'http:put': {
    action: 'restore_previous',
    tool_adapter: 'http:put',
    parameters: { url: '{original_url}', body: '{original_state}' },
    description: 'Restore the previous state',
  },
  'http:delete': {
    action: 'restore_deleted',
    tool_adapter: 'http:post',
    parameters: { url: '{original_url}', body: '{deleted_data}' },
    description: 'Recreate the deleted resource',
  },
  'aws:ec2:run_instances': {
    action: 'terminate_instances',
    tool_adapter: 'aws:ec2:terminate_instances',
    parameters: { instance_ids: '{response.instance_ids}' },
    description: 'Terminate created EC2 instances',
  },
  'aws:ec2:terminate_instances': {
    action: 'restore_from_ami',
    tool_adapter: 'aws:ec2:run_instances',
    parameters: { ami_id: '{backup_ami_id}', config: '{instance_config}' },
    description: 'Restore instances from AMI backup',
  },
  'aws:s3:put_object': {
    action: 'delete_object',
    tool_adapter: 'aws:s3:delete_object',
    parameters: { bucket: '{bucket}', key: '{key}' },
    description: 'Delete the uploaded object',
  },
  'aws:s3:delete_object': {
    action: 'restore_object',
    tool_adapter: 'aws:s3:put_object',
    parameters: { bucket: '{bucket}', key: '{key}', body: '{backup_data}' },
    description: 'Restore the deleted object',
  },
  'database:insert': {
    action: 'delete_record',
    tool_adapter: 'database:delete',
    parameters: { table: '{table}', id: '{response.id}' },
    description: 'Delete the inserted record',
  },
  'database:update': {
    action: 'restore_record',
    tool_adapter: 'database:update',
    parameters: { table: '{table}', id: '{id}', data: '{original_data}' },
    description: 'Restore the original record state',
  },
  'database:delete': {
    action: 'restore_record',
    tool_adapter: 'database:insert',
    parameters: { table: '{table}', data: '{deleted_data}' },
    description: 'Restore the deleted record',
  },
  'file:write': {
    action: 'delete_file',
    tool_adapter: 'file:delete',
    parameters: { path: '{path}' },
    description: 'Delete the created file',
  },
  'file:delete': {
    action: 'restore_file',
    tool_adapter: 'file:write',
    parameters: { path: '{path}', content: '{backup_content}' },
    description: 'Restore the deleted file',
  },
  'github:create_branch': {
    action: 'delete_branch',
    tool_adapter: 'github:delete_branch',
    parameters: { repo: '{repo}', branch: '{branch_name}' },
    description: 'Delete the created branch',
  },
  'github:merge_pr': {
    action: 'revert_merge',
    tool_adapter: 'github:revert_commit',
    parameters: { repo: '{repo}', commit: '{merge_commit_sha}' },
    description: 'Revert the merge commit',
  },
};

// =============================================================================
// Compensation Verifier
// =============================================================================

export class CompensationVerifier extends EventEmitter {
  private config: CompensationVerifierConfig;
  private initialized = false;
  private verificationCount = 0;

  constructor(config: Partial<CompensationVerifierConfig> = {}) {
    super();
    this.config = { ...defaultVerifierConfig, ...config };
  }

  /**
   * Initialize the verifier
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    logger.info('Compensation verifier initialized');
  }

  /**
   * Verify compensation coverage for a plan
   */
  async verify(plan: PlanManifest): Promise<VerificationResult> {
    const startTime = Date.now();
    const verificationId = `ver_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    this.verificationCount++;

    logger.info({ verificationId, planId: plan.planId }, 'Starting compensation verification');

    const stepResults: StepVerificationResult[] = [];
    const gaps: CompensationGap[] = [];
    const issues: VerificationIssue[] = [];

    // Verify each step
    for (const step of plan.steps) {
      const result = await this.verifyStep(step, plan, issues);
      stepResults.push(result);

      // Check for gaps
      if (result.needs_compensation && !result.has_compensation) {
        gaps.push(this.createGap(step));
      }
    }

    // Verify compensation ordering
    if (this.config.verify_ordering) {
      this.verifyOrdering(plan, issues);
    }

    // Check for circular dependencies in compensations
    this.checkCircularDependencies(plan, issues);

    // Calculate coverage
    const coverage = this.calculateCoverage(plan, stepResults);

    // Assess risk
    const riskAssessment = this.assessRisk(plan, stepResults, gaps, coverage);

    // Generate recommendations
    const recommendations = this.generateRecommendations(stepResults, gaps, issues, coverage);

    // Calculate overall validity and score
    const criticalIssues = issues.filter((i) => i.severity === 'critical');
    const errorIssues = issues.filter((i) => i.severity === 'error');

    let valid = true;
    if (this.config.strict_mode) {
      valid = issues.length === 0;
    } else {
      valid = criticalIssues.length === 0 && errorIssues.length === 0;
    }

    const score = this.calculateScore(stepResults, gaps, issues, coverage);

    const result: VerificationResult = {
      verification_id: verificationId,
      plan_id: plan.planId,
      timestamp: new Date().toISOString(),
      valid,
      score,
      step_results: stepResults,
      gaps,
      issues,
      recommendations,
      coverage,
      risk_assessment: riskAssessment,
    };

    // Emit events
    this.emit('verification_complete', {
      verification_id: verificationId,
      plan_id: plan.planId,
      valid,
      score,
      gaps: gaps.length,
      issues: issues.length,
    });

    if (!valid) {
      this.emit('verification_failed', {
        verification_id: verificationId,
        plan_id: plan.planId,
        critical_issues: criticalIssues.length,
        error_issues: errorIssues.length,
      });
    }

    logger.info(
      {
        verificationId,
        planId: plan.planId,
        valid,
        score,
        gaps: gaps.length,
        issues: issues.length,
        durationMs: Date.now() - startTime,
      },
      'Compensation verification completed'
    );

    return result;
  }

  /**
   * Verify a single step
   */
  private async verifyStep(
    step: PlanStep,
    plan: PlanManifest,
    issues: VerificationIssue[]
  ): Promise<StepVerificationResult> {
    const stepIssues: string[] = [];

    // Determine if step needs compensation
    const needsCompensation = this.stepNeedsCompensation(step);

    // Check if compensation exists
    const hasCompensation = !!step.compensationAction;

    let compensationValid = true;
    let idempotencyValid = true;
    let timeoutValid = true;
    let parametersValid = true;

    if (hasCompensation && step.compensationAction) {
      // Validate compensation action
      const compAction = step.compensationAction;

      // Check idempotency key
      if (this.config.require_idempotency_keys && !compAction.idempotencyKey) {
        idempotencyValid = false;
        stepIssues.push('Missing idempotency key for compensation');
        issues.push({
          issue_id: `issue_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          step_id: step.stepId,
          severity: 'error',
          category: 'missing_idempotency',
          message: 'Compensation action missing idempotency key',
          details: 'Without an idempotency key, repeated compensation attempts may cause inconsistent state',
          fix_suggestion: 'Add an idempotencyKey to the compensationAction',
        });
      }

      // Check timeout
      const timeout = compAction.timeout ?? 60000;
      if (timeout > this.config.max_compensation_timeout_ms) {
        timeoutValid = false;
        stepIssues.push(`Compensation timeout ${timeout}ms exceeds max ${this.config.max_compensation_timeout_ms}ms`);
        issues.push({
          issue_id: `issue_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          step_id: step.stepId,
          severity: 'warning',
          category: 'timeout_issue',
          message: `Compensation timeout (${timeout}ms) exceeds maximum allowed`,
          fix_suggestion: `Reduce timeout to ${this.config.max_compensation_timeout_ms}ms or less`,
        });
      }

      if (timeout < this.config.min_compensation_timeout_ms) {
        timeoutValid = false;
        stepIssues.push(`Compensation timeout ${timeout}ms below min ${this.config.min_compensation_timeout_ms}ms`);
        issues.push({
          issue_id: `issue_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          step_id: step.stepId,
          severity: 'warning',
          category: 'timeout_issue',
          message: `Compensation timeout (${timeout}ms) below minimum recommended`,
          fix_suggestion: `Increase timeout to at least ${this.config.min_compensation_timeout_ms}ms`,
        });
      }

      // Validate parameters
      if (this.config.verify_parameters) {
        const paramValidation = this.validateCompensationParameters(step, compAction);
        if (!paramValidation.valid) {
          parametersValid = false;
          stepIssues.push(...paramValidation.issues);
          for (const issue of paramValidation.issues) {
            issues.push({
              issue_id: `issue_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              step_id: step.stepId,
              severity: 'warning',
              category: 'parameter_issue',
              message: issue,
              fix_suggestion: 'Ensure compensation parameters reference valid step outputs',
            });
          }
        }
      }

      // Check if compensation can actually undo the action
      const canUndo = this.canCompensationUndo(step, compAction);
      if (!canUndo.valid) {
        compensationValid = false;
        stepIssues.push(canUndo.reason);
        issues.push({
          issue_id: `issue_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          step_id: step.stepId,
          severity: 'error',
          category: 'invalid_compensation',
          message: 'Compensation action may not properly undo the step',
          details: canUndo.reason,
          fix_suggestion: canUndo.suggestion,
        });
      }
    } else if (needsCompensation) {
      // Step needs compensation but doesn't have it
      const severity = this.getSeverityForMissingCompensation(step);
      issues.push({
        issue_id: `issue_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        step_id: step.stepId,
        severity,
        category: 'missing_compensation',
        message: `Step has side effects but no compensation action defined`,
        details: `Action: ${step.action}, Risk Level: ${step.riskLevel}`,
        fix_suggestion: this.getSuggestedCompensation(step)?.description,
      });
    }

    // Apply custom rules
    for (const rule of this.config.custom_rules) {
      if (rule.condition(step, plan)) {
        if (rule.requirement.needs_compensation && !hasCompensation) {
          issues.push({
            issue_id: `issue_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            step_id: step.stepId,
            severity: rule.severity,
            category: 'missing_compensation',
            message: `Custom rule "${rule.name}": ${rule.description}`,
          });
        }
      }
    }

    return {
      step_id: step.stepId,
      has_compensation: hasCompensation,
      needs_compensation: needsCompensation,
      compensation_valid: compensationValid,
      idempotency_valid: idempotencyValid,
      timeout_valid: timeoutValid,
      parameters_valid: parametersValid,
      issues: stepIssues,
    };
  }

  /**
   * Determine if a step needs compensation
   */
  private stepNeedsCompensation(step: PlanStep): boolean {
    // Always need compensation for side effects
    if (step.sideEffect && this.config.require_compensation_for_side_effects) {
      return true;
    }

    // Need compensation for high-risk operations
    if (
      this.config.require_compensation_for_high_risk &&
      (step.riskLevel === 'high' || step.riskLevel === 'destructive')
    ) {
      return true;
    }

    // Check action type
    const destructiveActions = ['delete', 'remove', 'destroy', 'terminate', 'drop', 'truncate'];
    if (destructiveActions.some((a) => step.action.toLowerCase().includes(a))) {
      return true;
    }

    // Check mutating adapters
    const mutatingAdapters = ['database:insert', 'database:update', 'database:delete', 'file:write', 'file:delete'];
    if (mutatingAdapters.some((a) => step.toolAdapter.includes(a))) {
      return true;
    }

    return false;
  }

  /**
   * Validate compensation parameters
   */
  private validateCompensationParameters(
    step: PlanStep,
    compensation: CompensationAction
  ): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    // Check for required parameters based on action type
    const requiredParams = this.getRequiredCompensationParams(compensation.toolAdapter);

    for (const param of requiredParams) {
      if (!(param in compensation.parameters)) {
        issues.push(`Missing required parameter: ${param}`);
      }
    }

    // Check for parameter references to step outputs
    const paramStr = JSON.stringify(compensation.parameters);
    const outputRefs = paramStr.match(/\{response\.[^}]+\}/g) || [];

    for (const ref of outputRefs) {
      // Note: We can't fully validate output references without runtime info
      // This is a structural check
      if (!ref.match(/\{response\.\w+\}/)) {
        issues.push(`Invalid output reference format: ${ref}`);
      }
    }

    return { valid: issues.length === 0, issues };
  }

  /**
   * Get required parameters for compensation adapter
   */
  private getRequiredCompensationParams(adapter: string): string[] {
    const adapterRequirements: Record<string, string[]> = {
      'http:delete': ['url'],
      'http:put': ['url', 'body'],
      'http:post': ['url', 'body'],
      'aws:ec2:terminate_instances': ['instance_ids'],
      'aws:s3:delete_object': ['bucket', 'key'],
      'aws:s3:put_object': ['bucket', 'key', 'body'],
      'database:delete': ['table', 'id'],
      'database:insert': ['table', 'data'],
      'database:update': ['table', 'id', 'data'],
      'file:delete': ['path'],
      'file:write': ['path', 'content'],
    };

    return adapterRequirements[adapter] || [];
  }

  /**
   * Check if compensation can actually undo the action
   */
  private canCompensationUndo(
    step: PlanStep,
    compensation: CompensationAction
  ): { valid: boolean; reason: string; suggestion?: string } {
    // Check for matching undo operations
    const undoMappings: Record<string, string[]> = {
      'create': ['delete', 'remove', 'destroy'],
      'insert': ['delete', 'remove'],
      'update': ['update', 'restore'],
      'delete': ['create', 'insert', 'restore'],
      'put': ['delete', 'put'],
      'post': ['delete'],
      'start': ['stop', 'terminate'],
      'stop': ['start'],
      'enable': ['disable'],
      'disable': ['enable'],
    };

    const stepActionLower = step.action.toLowerCase();
    const compActionLower = compensation.action.toLowerCase();

    // Find matching base action
    for (const [action, validUndos] of Object.entries(undoMappings)) {
      if (stepActionLower.includes(action)) {
        if (!validUndos.some((undo) => compActionLower.includes(undo))) {
          return {
            valid: false,
            reason: `Action "${step.action}" typically requires compensation with ${validUndos.join(' or ')}, but got "${compensation.action}"`,
            suggestion: `Consider using a compensation action containing: ${validUndos.join(', ')}`,
          };
        }
        break;
      }
    }

    // Check for incompatible adapter types
    const stepAdapterBase = step.toolAdapter.split(':')[0];
    const compAdapterBase = compensation.toolAdapter.split(':')[0];

    if (stepAdapterBase !== compAdapterBase) {
      // Different adapter bases are usually fine (e.g., aws:ec2 -> aws:ec2)
      // but warn about completely different systems
      const incompatible = [
        ['aws', 'github'],
        ['database', 'http'],
        ['file', 'aws'],
      ];

      for (const [a, b] of incompatible) {
        if (
          (stepAdapterBase === a && compAdapterBase === b) ||
          (stepAdapterBase === b && compAdapterBase === a)
        ) {
          return {
            valid: false,
            reason: `Compensation adapter (${compAdapterBase}) may not be compatible with step adapter (${stepAdapterBase})`,
            suggestion: `Use a compensation adapter from the same system as the original step`,
          };
        }
      }
    }

    return { valid: true, reason: '' };
  }

  /**
   * Get severity for missing compensation
   */
  private getSeverityForMissingCompensation(step: PlanStep): 'warning' | 'error' | 'critical' {
    if (step.riskLevel === 'destructive') return 'critical';
    if (step.riskLevel === 'high') return 'error';
    if (step.sideEffect) return 'warning';
    return 'warning';
  }

  /**
   * Create a compensation gap entry
   */
  private createGap(step: PlanStep): CompensationGap {
    const suggested = this.getSuggestedCompensation(step);

    let impact: 'low' | 'medium' | 'high' | 'critical';
    switch (step.riskLevel) {
      case 'destructive':
        impact = 'critical';
        break;
      case 'high':
        impact = 'high';
        break;
      case 'medium':
        impact = 'medium';
        break;
      default:
        impact = 'low';
    }

    return {
      step_id: step.stepId,
      step_action: step.action,
      risk_level: step.riskLevel,
      has_side_effects: step.sideEffect,
      reason: `No compensation action defined for ${step.sideEffect ? 'step with side effects' : 'high-risk step'}`,
      impact,
      suggested_compensation: suggested,
    };
  }

  /**
   * Get suggested compensation for a step
   */
  private getSuggestedCompensation(step: PlanStep): SuggestedCompensation | undefined {
    // Try exact adapter match
    let template = COMPENSATION_TEMPLATES[step.toolAdapter];

    // Try base adapter match
    if (!template) {
      const parts = step.toolAdapter.split(':');
      for (let i = parts.length; i > 0; i--) {
        const key = parts.slice(0, i).join(':');
        template = COMPENSATION_TEMPLATES[key];
        if (template) break;
      }
    }

    // Try action-based match
    if (!template) {
      const actionLower = step.action.toLowerCase();
      if (actionLower.includes('create') || actionLower.includes('insert')) {
        template = {
          action: 'delete',
          tool_adapter: step.toolAdapter.replace('create', 'delete').replace('insert', 'delete'),
          parameters: { id: '{response.id}' },
          description: 'Delete the created resource',
        };
      } else if (actionLower.includes('update')) {
        template = {
          action: 'restore',
          tool_adapter: step.toolAdapter,
          parameters: { id: '{id}', data: '{original_data}' },
          description: 'Restore to previous state',
        };
      } else if (actionLower.includes('delete')) {
        template = {
          action: 'restore',
          tool_adapter: step.toolAdapter.replace('delete', 'create'),
          parameters: { data: '{deleted_data}' },
          description: 'Restore the deleted resource',
        };
      }
    }

    return template;
  }

  /**
   * Verify compensation ordering
   */
  private verifyOrdering(plan: PlanManifest, issues: VerificationIssue[]): void {
    // Build dependency graph
    const dependents = new Map<string, string[]>();

    for (const step of plan.steps) {
      for (const dep of step.dependencies) {
        const deps = dependents.get(dep) || [];
        deps.push(step.stepId);
        dependents.set(dep, deps);
      }
    }

    // Compensations should run in reverse order of execution
    // Check for any that might run out of order

    for (const step of plan.steps) {
      if (!step.compensationAction) continue;

      const stepDependents = dependents.get(step.stepId) || [];

      for (const depId of stepDependents) {
        const depStep = plan.steps.find((s) => s.stepId === depId);
        if (depStep?.compensationAction) {
          // Dependent step also has compensation
          // In compensation, parent should run AFTER child
          // This is typically handled by the workflow engine, but flag if explicit ordering issues
        }
      }
    }
  }

  /**
   * Check for circular dependencies in compensations
   */
  private checkCircularDependencies(plan: PlanManifest, issues: VerificationIssue[]): void {
    // Check if any compensation creates a circular dependency
    // This would happen if compensation A depends on a resource created by B
    // and compensation B depends on a resource created by A

    const stepsWithComp = plan.steps.filter((s) => s.compensationAction);

    for (const stepA of stepsWithComp) {
      for (const stepB of stepsWithComp) {
        if (stepA.stepId === stepB.stepId) continue;

        // Check if A's compensation references B's outputs and vice versa
        const aCompParams = JSON.stringify(stepA.compensationAction!.parameters);
        const bCompParams = JSON.stringify(stepB.compensationAction!.parameters);

        const aRefsB = aCompParams.includes(`{${stepB.stepId}`) || aCompParams.includes(`{response.`);
        const bRefsA = bCompParams.includes(`{${stepA.stepId}`) || bCompParams.includes(`{response.`);

        if (aRefsB && bRefsA) {
          issues.push({
            issue_id: `issue_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            step_id: stepA.stepId,
            severity: 'error',
            category: 'circular_dependency',
            message: `Potential circular dependency between compensations of ${stepA.stepId} and ${stepB.stepId}`,
            details: 'Both compensation actions may reference each other\'s outputs',
            fix_suggestion: 'Restructure compensations to remove circular references',
          });
        }
      }
    }
  }

  /**
   * Calculate coverage metrics
   */
  private calculateCoverage(
    plan: PlanManifest,
    stepResults: StepVerificationResult[]
  ): CompensationCoverage {
    const total = plan.steps.length;
    const withSideEffects = plan.steps.filter((s) => s.sideEffect).length;
    const withCompensation = stepResults.filter((r) => r.has_compensation).length;

    const highRiskSteps = plan.steps.filter(
      (s) => s.riskLevel === 'high' || s.riskLevel === 'destructive'
    );
    const highRiskWithComp = highRiskSteps.filter((s) => s.compensationAction).length;

    const destructiveSteps = plan.steps.filter((s) => s.riskLevel === 'destructive');
    const destructiveWithComp = destructiveSteps.filter((s) => s.compensationAction).length;

    return {
      total_steps: total,
      steps_with_side_effects: withSideEffects,
      steps_with_compensation: withCompensation,
      coverage_percentage: withSideEffects > 0
        ? (plan.steps.filter((s) => s.sideEffect && s.compensationAction).length / withSideEffects) * 100
        : 100,
      high_risk_coverage: highRiskSteps.length > 0
        ? (highRiskWithComp / highRiskSteps.length) * 100
        : 100,
      destructive_coverage: destructiveSteps.length > 0
        ? (destructiveWithComp / destructiveSteps.length) * 100
        : 100,
    };
  }

  /**
   * Assess risk from compensation gaps
   */
  private assessRisk(
    plan: PlanManifest,
    stepResults: StepVerificationResult[],
    gaps: CompensationGap[],
    coverage: CompensationCoverage
  ): CompensationRiskAssessment {
    const factors: RiskFactor[] = [];

    // Factor: Coverage percentage
    const coverageScore = (100 - coverage.coverage_percentage) / 100 * 100;
    factors.push({
      name: 'Coverage Gap',
      weight: 0.25,
      score: coverageScore,
      description: `${coverage.coverage_percentage.toFixed(1)}% of side-effect steps have compensation`,
    });

    // Factor: High-risk coverage
    const highRiskScore = (100 - coverage.high_risk_coverage) / 100 * 100;
    factors.push({
      name: 'High-Risk Coverage',
      weight: 0.30,
      score: highRiskScore,
      description: `${coverage.high_risk_coverage.toFixed(1)}% of high-risk steps have compensation`,
    });

    // Factor: Destructive coverage
    const destructiveScore = (100 - coverage.destructive_coverage) / 100 * 100;
    factors.push({
      name: 'Destructive Coverage',
      weight: 0.30,
      score: destructiveScore,
      description: `${coverage.destructive_coverage.toFixed(1)}% of destructive steps have compensation`,
    });

    // Factor: Compensation quality
    const validCompensations = stepResults.filter(
      (r) => r.has_compensation && r.compensation_valid && r.idempotency_valid
    ).length;
    const totalCompensations = stepResults.filter((r) => r.has_compensation).length;
    const qualityScore = totalCompensations > 0
      ? ((totalCompensations - validCompensations) / totalCompensations) * 100
      : 0;
    factors.push({
      name: 'Compensation Quality',
      weight: 0.15,
      score: qualityScore,
      description: `${validCompensations}/${totalCompensations} compensations are fully valid`,
    });

    // Calculate weighted score
    let totalScore = 0;
    for (const factor of factors) {
      totalScore += factor.score * factor.weight;
    }

    // Determine overall risk level
    let overallRisk: 'low' | 'medium' | 'high' | 'critical';
    if (totalScore >= 60 || coverage.destructive_coverage < 100) {
      overallRisk = 'critical';
    } else if (totalScore >= 40 || coverage.high_risk_coverage < 100) {
      overallRisk = 'high';
    } else if (totalScore >= 20) {
      overallRisk = 'medium';
    } else {
      overallRisk = 'low';
    }

    // Calculate recovery confidence
    const recoveryConfidence = Math.max(0, 100 - totalScore) / 100;

    // Determine worst case scenario
    let worstCase = 'Minor inconsistency in non-critical data';
    if (gaps.some((g) => g.impact === 'critical')) {
      worstCase = 'Unrecoverable data loss or system damage';
    } else if (gaps.some((g) => g.impact === 'high')) {
      worstCase = 'Significant data corruption requiring manual intervention';
    } else if (gaps.some((g) => g.impact === 'medium')) {
      worstCase = 'Moderate data inconsistency requiring cleanup';
    }

    return {
      overall_risk: overallRisk,
      uncompensated_risk_score: totalScore,
      recovery_confidence: recoveryConfidence,
      worst_case_scenario: worstCase,
      factors,
    };
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(
    stepResults: StepVerificationResult[],
    gaps: CompensationGap[],
    issues: VerificationIssue[],
    coverage: CompensationCoverage
  ): VerificationRecommendation[] {
    const recommendations: VerificationRecommendation[] = [];

    // Recommend adding compensations for critical gaps
    const criticalGaps = gaps.filter((g) => g.impact === 'critical' || g.impact === 'high');
    if (criticalGaps.length > 0) {
      recommendations.push({
        priority: 'critical',
        category: 'compensation',
        title: 'Add Compensation for High-Impact Steps',
        description: `${criticalGaps.length} high-impact steps lack compensation actions. These steps can cause unrecoverable damage if they fail.`,
        affected_steps: criticalGaps.map((g) => g.step_id),
      });
    }

    // Recommend fixing idempotency issues
    const nonIdempotent = stepResults.filter((r) => r.has_compensation && !r.idempotency_valid);
    if (nonIdempotent.length > 0) {
      recommendations.push({
        priority: 'high',
        category: 'idempotency',
        title: 'Add Idempotency Keys',
        description: `${nonIdempotent.length} compensations lack idempotency keys. This can cause duplicate compensations if retried.`,
        affected_steps: nonIdempotent.map((r) => r.step_id),
      });
    }

    // Recommend improving coverage
    if (coverage.coverage_percentage < 80) {
      recommendations.push({
        priority: 'medium',
        category: 'coverage',
        title: 'Improve Compensation Coverage',
        description: `Only ${coverage.coverage_percentage.toFixed(1)}% of steps with side effects have compensation. Target at least 80% coverage.`,
        affected_steps: gaps.map((g) => g.step_id),
      });
    }

    // Recommend fixing parameter issues
    const paramIssues = stepResults.filter((r) => !r.parameters_valid);
    if (paramIssues.length > 0) {
      recommendations.push({
        priority: 'medium',
        category: 'parameters',
        title: 'Fix Compensation Parameters',
        description: `${paramIssues.length} compensations have invalid or missing parameters.`,
        affected_steps: paramIssues.map((r) => r.step_id),
      });
    }

    return recommendations.sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  /**
   * Calculate overall verification score
   */
  private calculateScore(
    stepResults: StepVerificationResult[],
    gaps: CompensationGap[],
    issues: VerificationIssue[],
    coverage: CompensationCoverage
  ): number {
    let score = 100;

    // Deduct for gaps
    for (const gap of gaps) {
      switch (gap.impact) {
        case 'critical':
          score -= 20;
          break;
        case 'high':
          score -= 10;
          break;
        case 'medium':
          score -= 5;
          break;
        case 'low':
          score -= 2;
          break;
      }
    }

    // Deduct for issues
    for (const issue of issues) {
      switch (issue.severity) {
        case 'critical':
          score -= 15;
          break;
        case 'error':
          score -= 8;
          break;
        case 'warning':
          score -= 3;
          break;
      }
    }

    // Bonus for good coverage
    if (coverage.coverage_percentage >= 90) {
      score += 5;
    }
    if (coverage.high_risk_coverage >= 100) {
      score += 5;
    }
    if (coverage.destructive_coverage >= 100) {
      score += 5;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Add custom verification rule
   */
  addRule(rule: CompensationRule): void {
    this.config.custom_rules.push(rule);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<CompensationVerifierConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get statistics
   */
  getStats(): { verifications: number } {
    return { verifications: this.verificationCount };
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let verifier: CompensationVerifier | null = null;

export function getCompensationVerifier(): CompensationVerifier {
  if (!verifier) {
    verifier = new CompensationVerifier();
  }
  return verifier;
}

export async function initializeCompensationVerifier(
  config?: Partial<CompensationVerifierConfig>
): Promise<CompensationVerifier> {
  const v = config ? new CompensationVerifier(config) : getCompensationVerifier();
  await v.initialize();
  verifier = v;
  return v;
}
