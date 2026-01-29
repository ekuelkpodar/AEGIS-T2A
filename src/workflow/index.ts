/**
 * AEGIS-T2A Durable Workflow Engine
 *
 * Orchestrates plan execution with checkpointing, retries, and compensation.
 */

import {
  WorkflowState,
  WorkflowStatus,
  PlanManifest,
  PlanStep,
  StepStatus,
  StepExecutionResult,
  CompensationAction,
} from '../core/types.js';
import { generateWorkflowId, generateId } from '../core/ids.js';
import { componentLogger, logWorkflow, logStep } from '../core/logger.js';
import { execute, queryOne, queryAll, transaction } from '../core/database.js';
import { getConfig } from '../core/config.js';
import { hashObject } from '../core/crypto.js';

const logger = componentLogger('workflow');

// =============================================================================
// Types
// =============================================================================

export interface WorkflowOptions {
  skipApproval?: boolean;
  dryRun?: boolean;
  checkpointInterval?: number;
}

export interface ExecutionContext {
  workflowId: string;
  planId: string;
  intentId: string;
  variables: Map<string, unknown>;
  stepOutputs: Map<string, Record<string, unknown>>;
}

export type StepExecutor = (
  step: PlanStep,
  context: ExecutionContext
) => Promise<StepExecutionResult>;

// =============================================================================
// Workflow Engine
// =============================================================================

export class WorkflowEngine {
  private initialized = false;
  private config = getConfig();
  private stepExecutor: StepExecutor | null = null;
  private runningWorkflows = new Map<string, AbortController>();

  /**
   * Initialize the workflow engine
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Recover any interrupted workflows
    await this.recoverInterruptedWorkflows();

    this.initialized = true;
    logger.info('Workflow engine initialized');
  }

  /**
   * Set the step executor function
   */
  setStepExecutor(executor: StepExecutor): void {
    this.stepExecutor = executor;
  }

  /**
   * Create a new workflow from a plan
   */
  async createWorkflow(plan: PlanManifest): Promise<WorkflowState> {
    const workflowId = generateWorkflowId();
    const now = new Date().toISOString();

    const workflow: WorkflowState = {
      workflowId,
      intentId: plan.intentId,
      planId: plan.planId,
      planVersion: plan.version,
      status: plan.approvalRequired ? 'awaiting_approval' : 'pending',
      currentStepId: undefined,
      completedSteps: [],
      failedSteps: [],
      compensationStack: [],
      checkpointData: {},
      approvalRequired: plan.approvalRequired,
      updatedAt: now,
    };

    await this.persistWorkflow(workflow);

    logWorkflow(workflowId, 'created', {
      planId: plan.planId,
      status: workflow.status,
    });

    return workflow;
  }

  /**
   * Start executing a workflow
   */
  async startWorkflow(
    workflowId: string,
    plan: PlanManifest,
    options: WorkflowOptions = {}
  ): Promise<WorkflowState> {
    const workflow = await this.getWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    if (workflow.status === 'awaiting_approval' && !options.skipApproval) {
      throw new Error('Workflow requires approval before execution');
    }

    if (workflow.status === 'running') {
      throw new Error('Workflow is already running');
    }

    if (workflow.status === 'completed') {
      throw new Error('Workflow has already completed');
    }

    // Set up abort controller for cancellation
    const abortController = new AbortController();
    this.runningWorkflows.set(workflowId, abortController);

    try {
      // Update status to running
      workflow.status = 'running';
      workflow.startedAt = new Date().toISOString();
      workflow.updatedAt = workflow.startedAt;
      await this.persistWorkflow(workflow);

      logWorkflow(workflowId, 'started', { planId: plan.planId });

      // Execute the workflow
      await this.executeWorkflow(workflow, plan, abortController.signal, options);

      return await this.getWorkflow(workflowId) ?? workflow;
    } finally {
      this.runningWorkflows.delete(workflowId);
    }
  }

  /**
   * Execute workflow steps
   */
  private async executeWorkflow(
    workflow: WorkflowState,
    plan: PlanManifest,
    signal: AbortSignal,
    options: WorkflowOptions
  ): Promise<void> {
    const context: ExecutionContext = {
      workflowId: workflow.workflowId,
      planId: plan.planId,
      intentId: plan.intentId,
      variables: new Map(),
      stepOutputs: new Map(),
    };

    // Load any existing step outputs from checkpoints
    if (workflow.checkpointData) {
      const checkpoint = workflow.checkpointData as { stepOutputs?: Record<string, Record<string, unknown>> };
      if (checkpoint.stepOutputs) {
        for (const [stepId, outputs] of Object.entries(checkpoint.stepOutputs)) {
          context.stepOutputs.set(stepId, outputs);
        }
      }
    }

    // Get execution order
    const executionOrder = this.topologicalSort(plan.steps);
    const completedSet = new Set(workflow.completedSteps);

    for (const step of executionOrder) {
      // Check for cancellation
      if (signal.aborted) {
        workflow.status = 'cancelled';
        workflow.updatedAt = new Date().toISOString();
        await this.persistWorkflow(workflow);
        return;
      }

      // Skip already completed steps
      if (completedSet.has(step.stepId)) {
        continue;
      }

      // Check if step needs approval
      if (step.approvalRequired && !options.skipApproval) {
        workflow.status = 'awaiting_approval';
        workflow.currentStepId = step.stepId;
        workflow.updatedAt = new Date().toISOString();
        await this.persistWorkflow(workflow);

        logStep(step.stepId, workflow.workflowId, 'awaiting_approval', {
          riskLevel: step.riskLevel,
        });

        return;
      }

      // Check dependencies
      const depsReady = step.dependencies.every((depId) => completedSet.has(depId));
      if (!depsReady) {
        workflow.status = 'failed';
        workflow.error = `Dependencies not satisfied for step ${step.stepId}`;
        workflow.failedSteps.push(step.stepId);
        workflow.updatedAt = new Date().toISOString();
        await this.persistWorkflow(workflow);
        return;
      }

      // Execute the step
      workflow.currentStepId = step.stepId;
      workflow.updatedAt = new Date().toISOString();
      await this.persistWorkflow(workflow);

      const result = await this.executeStep(step, context, options);

      // Record step execution
      await this.recordStepExecution(workflow.workflowId, step.stepId, result);

      if (result.status === 'completed') {
        workflow.completedSteps.push(step.stepId);
        completedSet.add(step.stepId);
        context.stepOutputs.set(step.stepId, result.outputs);

        // Add to compensation stack if step has side effects
        if (step.sideEffect && step.compensationAction) {
          workflow.compensationStack.push({
            stepId: step.stepId,
            compensationAction: step.compensationAction,
            executedAt: new Date().toISOString(),
            outputs: result.outputs,
          });
        }

        // Checkpoint
        await this.checkpoint(workflow, context);

        logStep(step.stepId, workflow.workflowId, 'completed', {
          durationMs: result.durationMs,
          cost: result.costIncurred,
        });
      } else {
        // Step failed
        workflow.failedSteps.push(step.stepId);
        workflow.status = 'failed';
        workflow.error = result.error;
        workflow.updatedAt = new Date().toISOString();
        await this.persistWorkflow(workflow);

        logStep(step.stepId, workflow.workflowId, 'failed', {
          error: result.error,
        });

        // Trigger compensation
        await this.compensate(workflow, context, options);
        return;
      }
    }

    // All steps completed
    workflow.status = 'completed';
    workflow.currentStepId = undefined;
    workflow.completedAt = new Date().toISOString();
    workflow.updatedAt = workflow.completedAt;
    await this.persistWorkflow(workflow);

    logWorkflow(workflow.workflowId, 'completed', {
      stepCount: workflow.completedSteps.length,
    });
  }

  /**
   * Execute a single step
   */
  private async executeStep(
    step: PlanStep,
    context: ExecutionContext,
    options: WorkflowOptions
  ): Promise<StepExecutionResult> {
    const startTime = Date.now();

    logStep(step.stepId, context.workflowId, 'started', {
      action: step.action,
      adapter: step.toolAdapter,
    });

    // If dry run, simulate success
    if (options.dryRun) {
      return {
        stepId: step.stepId,
        status: 'completed',
        outputs: { dryRun: true },
        durationMs: Date.now() - startTime,
        costIncurred: 0,
      };
    }

    // If no executor set, return mock result
    if (!this.stepExecutor) {
      logger.warn({ stepId: step.stepId }, 'No step executor configured, using mock');
      return {
        stepId: step.stepId,
        status: 'completed',
        outputs: { mock: true },
        durationMs: Date.now() - startTime,
        costIncurred: step.estimatedCost,
      };
    }

    // Execute with retry logic
    let lastError: string | undefined;
    const maxRetries = step.retryPolicy?.maxRetries ?? 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await Promise.race([
          this.stepExecutor(step, context),
          this.timeout(step.timeout, step.stepId),
        ]);

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error';

        if (attempt < maxRetries) {
          const backoff = (step.retryPolicy?.backoffMs ?? 1000) *
            Math.pow(step.retryPolicy?.backoffMultiplier ?? 2, attempt);

          logger.warn(
            { stepId: step.stepId, attempt, backoff, error: lastError },
            'Step failed, retrying'
          );

          await this.sleep(backoff);
        }
      }
    }

    return {
      stepId: step.stepId,
      status: 'failed',
      outputs: {},
      error: lastError ?? 'Step execution failed',
      durationMs: Date.now() - startTime,
      costIncurred: 0,
    };
  }

  /**
   * Run compensation for failed workflow
   */
  async compensate(
    workflow: WorkflowState,
    context: ExecutionContext,
    options: WorkflowOptions
  ): Promise<void> {
    if (workflow.compensationStack.length === 0) {
      logger.info({ workflowId: workflow.workflowId }, 'No compensation needed');
      return;
    }

    workflow.status = 'compensating';
    workflow.updatedAt = new Date().toISOString();
    await this.persistWorkflow(workflow);

    logWorkflow(workflow.workflowId, 'compensating', {
      stepsToCompensate: workflow.compensationStack.length,
    });

    // Execute compensations in reverse order
    const compensations = [...workflow.compensationStack].reverse();

    for (const comp of compensations) {
      try {
        logStep(comp.stepId, workflow.workflowId, 'compensation_started', {
          action: comp.compensationAction.action,
        });

        // Execute compensation
        if (this.stepExecutor) {
          const compensationStep: PlanStep = {
            stepId: `${comp.stepId}-compensation`,
            planId: workflow.planId,
            sequenceNumber: 0,
            action: comp.compensationAction.action,
            description: `Compensation for ${comp.stepId}`,
            toolAdapter: comp.compensationAction.toolAdapter,
            parameters: {
              ...comp.compensationAction.parameters,
              _originalOutputs: comp.outputs,
            },
            sideEffect: true,
            dependencies: [],
            requiredCapabilities: [],
            idempotencyKey: comp.compensationAction.idempotencyKey,
            estimatedCost: 0,
            estimatedDuration: 30000,
            riskLevel: 'medium',
            approvalRequired: false,
            timeout: comp.compensationAction.timeout ?? 60000,
          };

          await this.stepExecutor(compensationStep, context);
        }

        logStep(comp.stepId, workflow.workflowId, 'compensation_completed', {});
      } catch (error) {
        logger.error(
          { error, stepId: comp.stepId, workflowId: workflow.workflowId },
          'Compensation failed'
        );

        logStep(comp.stepId, workflow.workflowId, 'compensation_failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        // Continue with other compensations even if one fails
      }
    }

    workflow.status = 'failed';
    workflow.updatedAt = new Date().toISOString();
    await this.persistWorkflow(workflow);

    logWorkflow(workflow.workflowId, 'compensation_completed', {});
  }

  /**
   * Approve a workflow or step
   */
  async approveWorkflow(workflowId: string, approverId: string): Promise<void> {
    const workflow = await this.getWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    if (workflow.status !== 'awaiting_approval') {
      throw new Error('Workflow is not awaiting approval');
    }

    workflow.status = 'pending';
    workflow.updatedAt = new Date().toISOString();
    await this.persistWorkflow(workflow);

    logWorkflow(workflowId, 'approved', { approverId });
  }

  /**
   * Reject a workflow
   */
  async rejectWorkflow(workflowId: string, approverId: string, reason: string): Promise<void> {
    const workflow = await this.getWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    workflow.status = 'cancelled';
    workflow.error = `Rejected by ${approverId}: ${reason}`;
    workflow.updatedAt = new Date().toISOString();
    await this.persistWorkflow(workflow);

    logWorkflow(workflowId, 'rejected', { approverId, reason });
  }

  /**
   * Cancel a running workflow
   */
  async cancelWorkflow(workflowId: string): Promise<void> {
    const controller = this.runningWorkflows.get(workflowId);
    if (controller) {
      controller.abort();
    }

    const workflow = await this.getWorkflow(workflowId);
    if (workflow && workflow.status === 'running') {
      workflow.status = 'cancelled';
      workflow.updatedAt = new Date().toISOString();
      await this.persistWorkflow(workflow);
    }

    logWorkflow(workflowId, 'cancelled', {});
  }

  /**
   * Pause a running workflow
   */
  async pauseWorkflow(workflowId: string): Promise<void> {
    const workflow = await this.getWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    if (workflow.status !== 'running') {
      throw new Error('Can only pause running workflows');
    }

    workflow.status = 'paused';
    workflow.updatedAt = new Date().toISOString();
    await this.persistWorkflow(workflow);

    logWorkflow(workflowId, 'paused', {});
  }

  /**
   * Resume a paused workflow
   */
  async resumeWorkflow(
    workflowId: string,
    plan: PlanManifest,
    options: WorkflowOptions = {}
  ): Promise<WorkflowState> {
    const workflow = await this.getWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    if (workflow.status !== 'paused' && workflow.status !== 'pending') {
      throw new Error('Can only resume paused or pending workflows');
    }

    return this.startWorkflow(workflowId, plan, options);
  }

  /**
   * Save checkpoint
   */
  private async checkpoint(
    workflow: WorkflowState,
    context: ExecutionContext
  ): Promise<void> {
    const checkpointData = {
      stepOutputs: Object.fromEntries(context.stepOutputs),
      variables: Object.fromEntries(context.variables),
      timestamp: new Date().toISOString(),
    };

    workflow.checkpointData = checkpointData;
    workflow.updatedAt = new Date().toISOString();

    await this.persistWorkflow(workflow);
  }

  /**
   * Recover interrupted workflows on startup
   */
  private async recoverInterruptedWorkflows(): Promise<void> {
    const interrupted = queryAll<{ workflow_id: string }>(
      "SELECT workflow_id FROM workflows WHERE status = 'running'"
    );

    for (const row of interrupted) {
      logger.warn(
        { workflowId: row.workflow_id },
        'Found interrupted workflow, marking as failed'
      );

      execute(
        "UPDATE workflows SET status = 'failed', error = 'Interrupted by system restart', updated_at = ? WHERE workflow_id = ?",
        [new Date().toISOString(), row.workflow_id]
      );
    }
  }

  /**
   * Topological sort of steps
   */
  private topologicalSort(steps: PlanStep[]): PlanStep[] {
    const result: PlanStep[] = [];
    const visited = new Set<string>();
    const stepMap = new Map(steps.map((s) => [s.stepId, s]));

    const visit = (step: PlanStep) => {
      if (visited.has(step.stepId)) return;
      visited.add(step.stepId);

      for (const depId of step.dependencies) {
        const depStep = stepMap.get(depId);
        if (depStep) visit(depStep);
      }

      result.push(step);
    };

    for (const step of steps) {
      visit(step);
    }

    return result;
  }

  /**
   * Get workflow by ID
   */
  async getWorkflow(workflowId: string): Promise<WorkflowState | null> {
    const row = queryOne<{
      workflow_id: string;
      intent_id: string;
      plan_id: string;
      plan_version: number;
      status: string;
      current_step_id: string | null;
      completed_steps: string;
      failed_steps: string;
      compensation_stack: string;
      checkpoint_data: string | null;
      error: string | null;
      started_at: string | null;
      updated_at: string;
      completed_at: string | null;
    }>('SELECT * FROM workflows WHERE workflow_id = ?', [workflowId]);

    if (!row) return null;

    return {
      workflowId: row.workflow_id,
      intentId: row.intent_id,
      planId: row.plan_id,
      planVersion: row.plan_version,
      status: row.status as WorkflowStatus,
      currentStepId: row.current_step_id ?? undefined,
      completedSteps: JSON.parse(row.completed_steps),
      failedSteps: JSON.parse(row.failed_steps),
      compensationStack: JSON.parse(row.compensation_stack),
      checkpointData: row.checkpoint_data ? JSON.parse(row.checkpoint_data) : undefined,
      approvalRequired: false,
      error: row.error ?? undefined,
      startedAt: row.started_at ?? undefined,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined,
    };
  }

  /**
   * Persist workflow to database
   */
  private async persistWorkflow(workflow: WorkflowState): Promise<void> {
    execute(
      `INSERT OR REPLACE INTO workflows
       (workflow_id, intent_id, plan_id, plan_version, status, current_step_id,
        completed_steps, failed_steps, compensation_stack, checkpoint_data,
        error, started_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        workflow.workflowId,
        workflow.intentId,
        workflow.planId,
        workflow.planVersion,
        workflow.status,
        workflow.currentStepId ?? null,
        JSON.stringify(workflow.completedSteps),
        JSON.stringify(workflow.failedSteps),
        JSON.stringify(workflow.compensationStack),
        workflow.checkpointData ? JSON.stringify(workflow.checkpointData) : null,
        workflow.error ?? null,
        workflow.startedAt ?? null,
        workflow.updatedAt,
        workflow.completedAt ?? null,
      ]
    );
  }

  /**
   * Record step execution
   */
  private async recordStepExecution(
    workflowId: string,
    stepId: string,
    result: StepExecutionResult
  ): Promise<void> {
    const now = new Date().toISOString();
    execute(
      `INSERT INTO step_executions
       (execution_id, workflow_id, step_id, status, inputs, outputs, error,
        started_at, completed_at, duration_ms, cost_incurred)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId(),
        workflowId,
        stepId,
        result.status,
        '{}',
        JSON.stringify(result.outputs),
        result.error ?? null,
        now,
        now,
        result.durationMs,
        result.costIncurred,
      ]
    );
  }

  /**
   * Create a timeout promise
   */
  private timeout(ms: number, stepId: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Step ${stepId} timed out after ${ms}ms`)), ms);
    });
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let engine: WorkflowEngine | null = null;

export function getWorkflowEngine(): WorkflowEngine {
  if (!engine) {
    engine = new WorkflowEngine();
  }
  return engine;
}

export async function initializeWorkflowEngine(): Promise<WorkflowEngine> {
  const e = getWorkflowEngine();
  await e.initialize();
  return e;
}
