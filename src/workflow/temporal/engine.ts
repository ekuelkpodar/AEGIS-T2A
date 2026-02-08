/**
 * Temporal Workflow Engine Adapter
 */

import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type {
  PlanManifest,
  WorkflowState,
  WorkflowStatus,
  StepExecutionResult,
  PlanStep,
} from '../../core/types.js';
import { generateWorkflowId } from '../../core/ids.js';
import { execute, queryOne } from '../../core/database.js';
import { getConfig } from '../../core/config.js';
import { componentLogger } from '../../core/logger.js';
import { savePlanPayload } from './payload-store.js';
import { getTemporalClient } from './client.js';
import { registerStepExecutor } from './activities.js';
import { ensureSchedule } from './schedules.js';

const logger = componentLogger('temporal-workflow');

export interface WorkflowOptions {
  skipApproval?: boolean;
  dryRun?: boolean;
  checkpointInterval?: number;
  approvalTimeoutHours?: number;
}

export interface ExecutionContext {
  workflowId: string;
  planId: string;
  intentId: string;
  variables: Map<string, unknown>;
  stepOutputs: Map<string, Record<string, unknown>>;
}

export type StepExecutor = (step: PlanStep, context: ExecutionContext) => Promise<StepExecutionResult>;

export class TemporalWorkflowEngine {
  private initialized = false;
  private config = getConfig();

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await getTemporalClient();
    try {
      await ensureSchedule({
        scheduleId: 'aegis-daily-compliance',
        workflowType: 'planWorkflow',
        taskQueue: this.config.temporalTaskQueue,
        everyMinutes: 1440,
        args: [],
      });
    } catch (error) {
      logger.warn({ error }, 'Failed to ensure Temporal schedules');
    }
    this.initialized = true;
    logger.info('Temporal workflow engine initialized');
  }

  setStepExecutor(executor: StepExecutor): void {
    registerStepExecutor(executor);
  }

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

    this.persistWorkflow(workflow);

    // Start Temporal workflow immediately (will wait for approval if required)
    await this.startTemporalWorkflow(workflowId, plan, {});

    return workflow;
  }

  async startWorkflow(
    workflowId: string,
    plan: PlanManifest,
    options: WorkflowOptions = {}
  ): Promise<WorkflowState> {
    const workflow = await this.getWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    await this.startTemporalWorkflow(workflowId, plan, options);
    workflow.status = 'running';
    workflow.startedAt = workflow.startedAt ?? new Date().toISOString();
    workflow.updatedAt = new Date().toISOString();
    this.persistWorkflow(workflow);
    return workflow;
  }

  async approveWorkflow(workflowId: string, _approverId: string): Promise<void> {
    const client = await getTemporalClient();
    const handle = client.getHandle(workflowId);
    await handle.signal('approve', _approverId);
  }

  async rejectWorkflow(workflowId: string, _approverId: string, reason: string): Promise<void> {
    const client = await getTemporalClient();
    const handle = client.getHandle(workflowId);
    await handle.signal('reject', reason);
  }

  async cancelWorkflow(workflowId: string): Promise<void> {
    const client = await getTemporalClient();
    const handle = client.getHandle(workflowId);
    await handle.cancel();
  }

  async getWorkflow(workflowId: string): Promise<WorkflowState | null> {
    const client = await getTemporalClient();
    try {
      const handle = client.getHandle(workflowId);
      const state = await handle.query<WorkflowState>('getState');
      if (state) return state;
    } catch (error) {
      logger.debug({ workflowId, error }, 'Temporal query failed, falling back to local state');
    }

    return this.loadWorkflow(workflowId);
  }

  private async startTemporalWorkflow(
    workflowId: string,
    plan: PlanManifest,
    options: WorkflowOptions
  ): Promise<void> {
    const client = await getTemporalClient();
    const payloadJson = JSON.stringify(plan);
    const payloadSize = Buffer.byteLength(payloadJson, 'utf8');

    const input =
      payloadSize > this.config.temporalPayloadThresholdBytes
        ? { planRef: savePlanPayload(plan), options: this.withDefaults(options) }
        : { plan, options: this.withDefaults(options) };

    try {
      await client.workflow.start('planWorkflow', {
        taskQueue: this.config.temporalTaskQueue,
        workflowId,
        args: [input],
        searchAttributes: {
          intent_id: [plan.intentId],
          plan_id: [plan.planId],
          risk_level: [plan.riskLevel],
          tenant_id: [plan.intentId.split('-')[0]],
          cost_estimate: [String(plan.totalEstimatedCost)],
        },
      });
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        return;
      }
      logger.warn({ workflowId, error }, 'Failed to start Temporal workflow');
      throw error;
    }
  }

  private withDefaults(options: WorkflowOptions): WorkflowOptions {
    return {
      approvalTimeoutHours: options.approvalTimeoutHours ?? this.config.temporalApprovalTimeoutHours,
      ...options,
    };
  }

  private persistWorkflow(workflow: WorkflowState): void {
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

  private loadWorkflow(workflowId: string): WorkflowState | null {
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
}
