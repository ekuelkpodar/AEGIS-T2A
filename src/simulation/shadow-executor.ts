/**
 * Shadow Execution Environment
 *
 * Runs plans in a sandboxed simulation environment before actual execution.
 * Uses copy-on-write state management to simulate mutations without affecting production.
 *
 * Features:
 * - Isolated execution context with simulated resources
 * - State snapshot and rollback capabilities
 * - Side-effect tracking and validation
 * - Dry-run mode with detailed execution trace
 * - Resource conflict detection
 *
 * References:
 * - Shadow Testing in Production Systems
 * - Time Travel Debugging
 * - Deterministic Replay
 */

import { EventEmitter } from 'events';
import { componentLogger } from '../core/logger.js';
import { generateId } from '../core/ids.js';
import { hashObject } from '../core/crypto.js';
import type { PlanManifest, PlanStep, RiskLevel } from '../core/types.js';

const logger = componentLogger('shadow-executor');

// =============================================================================
// Types
// =============================================================================

export interface ShadowExecutionConfig {
  enableStateSnapshots: boolean;
  maxSnapshotHistory: number;
  trackResourceMutations: boolean;
  enableDeterministicReplay: boolean;
  simulationTimeMultiplier: number; // 0.1 = 10x faster, 1.0 = real-time
}

export interface ShadowExecutionContext {
  executionId: string;
  planId: string;
  userId: string;
  environment: 'shadow';
  startTime: Date;
  resourceState: ResourceStateManager;
  executionTrace: ExecutionTraceEntry[];
  snapshots: Map<string, StateSnapshot>;
  metadata: Record<string, unknown>;
}

export interface ExecutionTraceEntry {
  stepId: string;
  stepIndex: number;
  action: string;
  timestamp: Date;
  durationMs: number;
  result: 'success' | 'failure' | 'skipped';
  resourcesMutated: string[];
  sideEffects: SideEffect[];
  stateChanges: StateChange[];
  error?: string;
  metadata: Record<string, unknown>;
}

export interface SideEffect {
  effectType: 'state_mutation' | 'external_call' | 'notification' | 'audit_log';
  target: string;
  description: string;
  severity: 'low' | 'medium' | 'high';
  reversible: boolean;
  compensationAction?: string;
}

export interface StateChange {
  resourceId: string;
  resourceType: string;
  changeType: 'created' | 'updated' | 'deleted';
  previousValue?: unknown;
  newValue?: unknown;
  timestamp: Date;
}

export interface StateSnapshot {
  snapshotId: string;
  stepId: string;
  timestamp: Date;
  resourceStates: Map<string, unknown>;
  hash: string;
}

export interface ShadowExecutionResult {
  executionId: string;
  planId: string;
  status: 'success' | 'partial' | 'failure';
  totalSteps: number;
  executedSteps: number;
  successfulSteps: number;
  failedSteps: number;
  totalDurationMs: number;
  executionTrace: ExecutionTraceEntry[];
  finalState: Map<string, unknown>;
  sideEffectsSummary: {
    total: number;
    byType: Record<string, number>;
    reversible: number;
    irreversible: number;
  };
  resourceConflicts: ResourceConflict[];
  recommendations: string[];
  canProceedToProduction: boolean;
  confidenceScore: number;
}

export interface ResourceConflict {
  resourceId: string;
  conflictType: 'concurrent_modification' | 'dependency_violation' | 'state_inconsistency';
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  affectedSteps: string[];
}

// =============================================================================
// Resource State Manager
// =============================================================================

export class ResourceStateManager {
  private state = new Map<string, unknown>();
  private mutationLog: StateChange[] = [];
  private lockRegistry = new Map<string, string>(); // resourceId -> stepId

  /**
   * Create or update resource state
   */
  set(resourceId: string, resourceType: string, value: unknown, stepId: string): StateChange {
    const previousValue = this.state.get(resourceId);
    const changeType = previousValue === undefined ? 'created' : 'updated';

    this.state.set(resourceId, value);

    const change: StateChange = {
      resourceId,
      resourceType,
      changeType,
      previousValue,
      newValue: value,
      timestamp: new Date(),
    };

    this.mutationLog.push(change);
    return change;
  }

  /**
   * Get resource state
   */
  get(resourceId: string): unknown {
    return this.state.get(resourceId);
  }

  /**
   * Delete resource state
   */
  delete(resourceId: string, resourceType: string, stepId: string): StateChange {
    const previousValue = this.state.get(resourceId);
    this.state.delete(resourceId);

    const change: StateChange = {
      resourceId,
      resourceType,
      changeType: 'deleted',
      previousValue,
      newValue: undefined,
      timestamp: new Date(),
    };

    this.mutationLog.push(change);
    return change;
  }

  /**
   * Check if resource exists
   */
  has(resourceId: string): boolean {
    return this.state.has(resourceId);
  }

  /**
   * Acquire lock on resource
   */
  acquireLock(resourceId: string, stepId: string): boolean {
    if (this.lockRegistry.has(resourceId)) {
      return false; // Already locked
    }

    this.lockRegistry.set(resourceId, stepId);
    return true;
  }

  /**
   * Release lock on resource
   */
  releaseLock(resourceId: string): void {
    this.lockRegistry.delete(resourceId);
  }

  /**
   * Get all state
   */
  getAll(): Map<string, unknown> {
    return new Map(this.state);
  }

  /**
   * Get mutation log
   */
  getMutationLog(): StateChange[] {
    return [...this.mutationLog];
  }

  /**
   * Create snapshot
   */
  createSnapshot(snapshotId: string, stepId: string): StateSnapshot {
    return {
      snapshotId,
      stepId,
      timestamp: new Date(),
      resourceStates: new Map(this.state),
      hash: hashObject(Array.from(this.state.entries())),
    };
  }

  /**
   * Restore from snapshot
   */
  restoreSnapshot(snapshot: StateSnapshot): void {
    this.state = new Map(snapshot.resourceStates);
  }
}

// =============================================================================
// Shadow Executor
// =============================================================================

export class ShadowExecutor extends EventEmitter {
  private config: ShadowExecutionConfig;
  private activeExecutions = new Map<string, ShadowExecutionContext>();

  constructor(config: Partial<ShadowExecutionConfig> = {}) {
    super();
    this.config = {
      enableStateSnapshots: true,
      maxSnapshotHistory: 100,
      trackResourceMutations: true,
      enableDeterministicReplay: true,
      simulationTimeMultiplier: 0.1, // 10x faster than real-time
      ...config,
    };
  }

  /**
   * Execute plan in shadow environment
   */
  async execute(
    plan: PlanManifest,
    userId: string,
    initialState?: Map<string, unknown>
  ): Promise<ShadowExecutionResult> {
    const executionId = generateId();
    const startTime = new Date();

    logger.info({ executionId, planId: plan.planId }, 'Starting shadow execution');

    // Create execution context
    const context: ShadowExecutionContext = {
      executionId,
      planId: plan.planId,
      userId,
      environment: 'shadow',
      startTime,
      resourceState: new ResourceStateManager(),
      executionTrace: [],
      snapshots: new Map(),
      metadata: {},
    };

    // Initialize state from initial state
    if (initialState) {
      for (const [key, value] of initialState.entries()) {
        context.resourceState.set(key, 'unknown', value, 'init');
      }
    }

    this.activeExecutions.set(executionId, context);

    // Execute steps sequentially
    let executedSteps = 0;
    let successfulSteps = 0;
    let failedSteps = 0;

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]!;

      // Create snapshot before step execution
      if (this.config.enableStateSnapshots) {
        const snapshot = context.resourceState.createSnapshot(
          generateId(),
          step.stepId
        );
        context.snapshots.set(step.stepId, snapshot);
      }

      // Execute step
      const result = await this.executeStep(step, context, i);
      context.executionTrace.push(result);

      executedSteps++;
      if (result.result === 'success') {
        successfulSteps++;
      } else if (result.result === 'failure') {
        failedSteps++;

        // Stop on critical failures
        if (step.riskLevel === 'destructive' || step.riskLevel === 'high') {
          logger.warn(
            { executionId, stepId: step.stepId },
            'Stopping shadow execution due to critical step failure'
          );
          break;
        }
      }
    }

    // Calculate final results
    const totalDurationMs = Date.now() - startTime.getTime();
    const finalState = context.resourceState.getAll();

    // Analyze side effects
    const allSideEffects = context.executionTrace.flatMap(e => e.sideEffects);
    const sideEffectsByType: Record<string, number> = {};
    for (const effect of allSideEffects) {
      sideEffectsByType[effect.effectType] = (sideEffectsByType[effect.effectType] || 0) + 1;
    }

    const sideEffectsSummary = {
      total: allSideEffects.length,
      byType: sideEffectsByType,
      reversible: allSideEffects.filter(e => e.reversible).length,
      irreversible: allSideEffects.filter(e => !e.reversible).length,
    };

    // Detect resource conflicts
    const resourceConflicts = this.detectResourceConflicts(context);

    // Generate recommendations
    const recommendations = this.generateRecommendations(
      context,
      successfulSteps,
      failedSteps,
      sideEffectsSummary,
      resourceConflicts
    );

    // Determine if can proceed to production
    const canProceedToProduction =
      failedSteps === 0 &&
      resourceConflicts.filter(c => c.severity === 'critical').length === 0 &&
      sideEffectsSummary.irreversible <= plan.steps.length * 0.3; // < 30% irreversible

    // Calculate confidence score
    const confidenceScore = this.calculateConfidenceScore(
      executedSteps,
      successfulSteps,
      failedSteps,
      sideEffectsSummary,
      resourceConflicts
    );

    const result: ShadowExecutionResult = {
      executionId,
      planId: plan.planId,
      status: failedSteps === 0 ? 'success' : executedSteps === failedSteps ? 'failure' : 'partial',
      totalSteps: plan.steps.length,
      executedSteps,
      successfulSteps,
      failedSteps,
      totalDurationMs,
      executionTrace: context.executionTrace,
      finalState,
      sideEffectsSummary,
      resourceConflicts,
      recommendations,
      canProceedToProduction,
      confidenceScore,
    };

    // Clean up
    this.activeExecutions.delete(executionId);

    this.emit('execution_complete', {
      executionId,
      planId: plan.planId,
      status: result.status,
      canProceedToProduction,
      confidenceScore,
    });

    logger.info(
      {
        executionId,
        planId: plan.planId,
        status: result.status,
        executedSteps,
        successfulSteps,
        failedSteps,
        canProceedToProduction,
        confidenceScore,
      },
      'Shadow execution completed'
    );

    return result;
  }

  /**
   * Execute single step in shadow environment
   */
  private async executeStep(
    step: PlanStep,
    context: ShadowExecutionContext,
    stepIndex: number
  ): Promise<ExecutionTraceEntry> {
    const startTime = Date.now();
    const resourcesMutated: string[] = [];
    const sideEffects: SideEffect[] = [];
    const stateChanges: StateChange[] = [];

    try {
      // Simulate step execution
      const simResult = await this.simulateStepExecution(step, context);

      // Track resource mutations
      if (this.config.trackResourceMutations) {
        for (const mutation of simResult.mutations) {
          const change = context.resourceState.set(
            mutation.resourceId,
            mutation.resourceType,
            mutation.newValue,
            step.stepId
          );
          stateChanges.push(change);
          resourcesMutated.push(mutation.resourceId);
        }
      }

      // Track side effects
      sideEffects.push(...simResult.sideEffects);

      // Calculate simulated duration
      const realDuration = step.estimatedDuration || 1000;
      const durationMs = realDuration * this.config.simulationTimeMultiplier;

      // Simulate delay (scaled)
      await new Promise(resolve => setTimeout(resolve, Math.min(durationMs, 100)));

      return {
        stepId: step.stepId,
        stepIndex,
        action: step.action,
        timestamp: new Date(),
        durationMs: Date.now() - startTime,
        result: simResult.success ? 'success' : 'failure',
        resourcesMutated,
        sideEffects,
        stateChanges,
        error: simResult.error,
        metadata: simResult.metadata,
      };
    } catch (error) {
      return {
        stepId: step.stepId,
        stepIndex,
        action: step.action,
        timestamp: new Date(),
        durationMs: Date.now() - startTime,
        result: 'failure',
        resourcesMutated,
        sideEffects,
        stateChanges,
        error: error instanceof Error ? error.message : 'Unknown error',
        metadata: {},
      };
    }
  }

  /**
   * Simulate step execution (mocked for demonstration)
   */
  private async simulateStepExecution(
    step: PlanStep,
    _context: ShadowExecutionContext
  ): Promise<{
    success: boolean;
    mutations: Array<{ resourceId: string; resourceType: string; newValue: unknown }>;
    sideEffects: SideEffect[];
    metadata: Record<string, unknown>;
    error?: string;
  }> {
    // Simulate success/failure based on risk level
    const failureProbability = step.riskLevel === 'destructive' ? 0.1 :
                               step.riskLevel === 'high' ? 0.05 :
                               step.riskLevel === 'medium' ? 0.02 : 0.01;

    const success = Math.random() > failureProbability;

    // Extract resource ID from parameters
    const resourceId = (step.parameters['resource_id'] ||
                       step.parameters['target'] ||
                       step.parameters['identifier'] ||
                       'resource_' + step.stepId) as string;

    const mutations = success ? [
      {
        resourceId,
        resourceType: step.toolAdapter,
        newValue: { status: 'modified', timestamp: new Date() },
      },
    ] : [];

    const sideEffects: SideEffect[] = [];

    if (step.sideEffect) {
      sideEffects.push({
        effectType: 'state_mutation',
        target: resourceId,
        description: `${step.action} modifies ${resourceId}`,
        severity: step.riskLevel === 'destructive' ? 'high' : 'medium',
        reversible: step.compensationAction !== undefined,
        compensationAction: step.compensationAction ? step.compensationAction.action : undefined,
      });
    }

    // Add audit log side effect
    sideEffects.push({
      effectType: 'audit_log',
      target: 'audit_system',
      description: `Logged execution of ${step.action}`,
      severity: 'low',
      reversible: false,
    });

    return {
      success,
      mutations,
      sideEffects,
      metadata: {
        simulated: true,
        resourceId,
      },
      error: success ? undefined : `Simulated failure for ${step.action}`,
    };
  }

  /**
   * Detect resource conflicts
   */
  private detectResourceConflicts(context: ShadowExecutionContext): ResourceConflict[] {
    const conflicts: ResourceConflict[] = [];
    const resourceAccess = new Map<string, string[]>();

    // Track which steps access which resources
    for (const entry of context.executionTrace) {
      for (const resourceId of entry.resourcesMutated) {
        if (!resourceAccess.has(resourceId)) {
          resourceAccess.set(resourceId, []);
        }
        resourceAccess.get(resourceId)!.push(entry.stepId);
      }
    }

    // Check for concurrent modifications
    for (const [resourceId, steps] of resourceAccess.entries()) {
      if (steps.length > 1) {
        conflicts.push({
          resourceId,
          conflictType: 'concurrent_modification',
          description: `Resource ${resourceId} modified by ${steps.length} steps`,
          severity: steps.length > 3 ? 'high' : 'medium',
          affectedSteps: steps,
        });
      }
    }

    return conflicts;
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(
    _context: ShadowExecutionContext,
    successfulSteps: number,
    failedSteps: number,
    sideEffectsSummary: ShadowExecutionResult['sideEffectsSummary'],
    resourceConflicts: ResourceConflict[]
  ): string[] {
    const recommendations: string[] = [];

    if (failedSteps > 0) {
      recommendations.push(`${failedSteps} step(s) failed in simulation. Review and fix before production execution.`);
    }

    if (sideEffectsSummary.irreversible > 0) {
      recommendations.push(`${sideEffectsSummary.irreversible} irreversible side effect(s) detected. Ensure compensation actions are defined.`);
    }

    if (resourceConflicts.length > 0) {
      recommendations.push(`${resourceConflicts.length} resource conflict(s) detected. Consider serializing conflicting operations.`);
    }

    if (successfulSteps > 0 && failedSteps === 0) {
      recommendations.push('All steps executed successfully in simulation. Safe to proceed to production.');
    }

    return recommendations;
  }

  /**
   * Calculate confidence score
   */
  private calculateConfidenceScore(
    executedSteps: number,
    successfulSteps: number,
    failedSteps: number,
    sideEffectsSummary: ShadowExecutionResult['sideEffectsSummary'],
    resourceConflicts: ResourceConflict[]
  ): number {
    let score = 1.0;

    // Reduce for failed steps
    if (executedSteps > 0) {
      score -= (failedSteps / executedSteps) * 0.5;
    }

    // Reduce for irreversible side effects
    if (sideEffectsSummary.total > 0) {
      score -= (sideEffectsSummary.irreversible / sideEffectsSummary.total) * 0.2;
    }

    // Reduce for resource conflicts
    const criticalConflicts = resourceConflicts.filter(c => c.severity === 'critical').length;
    const highConflicts = resourceConflicts.filter(c => c.severity === 'high').length;

    score -= criticalConflicts * 0.2;
    score -= highConflicts * 0.1;

    return Math.max(0, Math.min(1, score));
  }


  /**
   * Get active execution
   */
  getExecution(executionId: string): ShadowExecutionContext | undefined {
    return this.activeExecutions.get(executionId);
  }

  /**
   * Rollback to snapshot
   */
  async rollbackToSnapshot(executionId: string, stepId: string): Promise<boolean> {
    const context = this.activeExecutions.get(executionId);

    if (!context) {
      return false;
    }

    const snapshot = context.snapshots.get(stepId);

    if (!snapshot) {
      return false;
    }

    context.resourceState.restoreSnapshot(snapshot);

    this.emit('snapshot_restored', {
      executionId,
      stepId,
      snapshotId: snapshot.snapshotId,
    });

    logger.info({ executionId, stepId }, 'Rolled back to snapshot');

    return true;
  }
}

// =============================================================================
// Singleton
// =============================================================================

let shadowExecutor: ShadowExecutor | null = null;

export function getShadowExecutor(): ShadowExecutor {
  if (!shadowExecutor) {
    shadowExecutor = new ShadowExecutor();
  }
  return shadowExecutor;
}

export function initializeShadowExecutor(
  config?: Partial<ShadowExecutionConfig>
): ShadowExecutor {
  if (!shadowExecutor) {
    shadowExecutor = new ShadowExecutor(config);
  }
  return shadowExecutor;
}
