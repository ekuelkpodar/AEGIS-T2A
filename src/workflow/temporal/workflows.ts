/**
 * Temporal Workflows for Plan Execution
 */

import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import type { PlanManifest, PlanStep, WorkflowState } from '../../core/types.js';
import type { WorkflowOptions } from '../index.js';

import type { ExecuteStepRequest } from './activities.js';

const approveSignal = defineSignal<[string]>('approve');
const rejectSignal = defineSignal<[string]>('reject');
const stateQuery = defineQuery<WorkflowState>('getState');

const DEFAULT_ACTIVITY_TIMEOUT = '5 minutes';

const activities = proxyActivities<{
  executePlanStep(request: ExecuteStepRequest): Promise<{ status: string; outputs: Record<string, unknown>; durationMs: number; costIncurred: number; error?: string }>;
  compensateStep(request: ExecuteStepRequest): Promise<{ status: string; outputs: Record<string, unknown>; durationMs: number; costIncurred: number; error?: string }>;
  fetchPlanPayload(payloadId: string): Promise<PlanManifest | null>;
}>({
  startToCloseTimeout: DEFAULT_ACTIVITY_TIMEOUT,
});

export interface PlanWorkflowInput {
  plan?: PlanManifest;
  planRef?: string;
  options?: WorkflowOptions;
}

export async function planWorkflow(input: PlanWorkflowInput): Promise<WorkflowState> {
  const options = input.options ?? {};
  const plan = input.plan ?? (input.planRef ? await activities.fetchPlanPayload(input.planRef) : null);
  if (!plan) {
    throw new Error('Plan payload missing');
  }

  let approved = !plan.approvalRequired;
  let rejectedReason: string | null = null;

  const workflowState: WorkflowState = {
    workflowId: workflowInfo().workflowId,
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
    updatedAt: new Date().toISOString(),
  };

  setHandler(approveSignal, () => {
    approved = true;
  });
  setHandler(rejectSignal, (reason: string) => {
    rejectedReason = reason || 'Rejected';
  });
  setHandler(stateQuery, () => workflowState);

  const waitForApproval = async (timeoutHours?: number): Promise<void> => {
    if (!timeoutHours || timeoutHours <= 0) {
      await condition(() => approved || rejectedReason !== null);
      return;
    }

    const timeoutMs = timeoutHours * 60 * 60 * 1000;
    const winner = await Promise.race([
      condition(() => approved || rejectedReason !== null).then(() => 'signal'),
      sleep(timeoutMs).then(() => 'timeout'),
    ]);

    if (winner === 'timeout' && !approved && rejectedReason === null) {
      rejectedReason = 'Approval timeout';
    }
  };

  if (plan.approvalRequired && !options.skipApproval) {
    await waitForApproval(options.approvalTimeoutHours);
    if (rejectedReason) {
      workflowState.status = 'cancelled';
      workflowState.error = rejectedReason;
      workflowState.updatedAt = new Date().toISOString();
      return workflowState;
    }
  }

  workflowState.status = 'running';
  workflowState.startedAt = new Date().toISOString();
  workflowState.updatedAt = workflowState.startedAt;

  const executionOrder = topologicalSort(plan.steps);
  const completedSet = new Set<string>();
  const stepOutputs: Record<string, Record<string, unknown>> = {};

  for (const step of executionOrder) {
    if (completedSet.has(step.stepId)) continue;

    if (step.approvalRequired && !options.skipApproval) {
      approved = false;
      workflowState.status = 'awaiting_approval';
      workflowState.currentStepId = step.stepId;
      workflowState.updatedAt = new Date().toISOString();
      await waitForApproval(options.approvalTimeoutHours);
      if (rejectedReason) {
        workflowState.status = 'cancelled';
        workflowState.error = rejectedReason;
        workflowState.updatedAt = new Date().toISOString();
        return workflowState;
      }
      workflowState.status = 'running';
    }

    workflowState.currentStepId = step.stepId;
    workflowState.updatedAt = new Date().toISOString();

    const result = await activities.executePlanStep(buildRequest(step, plan, stepOutputs));

    if (result.status === 'completed') {
      workflowState.completedSteps.push(step.stepId);
      completedSet.add(step.stepId);
      stepOutputs[step.stepId] = result.outputs || {};

      if (step.sideEffect && step.compensationAction) {
        workflowState.compensationStack.push({
          stepId: step.stepId,
          compensationAction: step.compensationAction,
          executedAt: new Date().toISOString(),
          outputs: result.outputs,
        });
      }
    } else {
      workflowState.failedSteps.push(step.stepId);
      workflowState.status = 'failed';
      workflowState.error = result.error ?? 'Step failed';
      workflowState.updatedAt = new Date().toISOString();
      await runCompensation(plan, workflowState, stepOutputs);
      return workflowState;
    }
  }

  workflowState.status = 'completed';
  workflowState.currentStepId = undefined;
  workflowState.completedAt = new Date().toISOString();
  workflowState.updatedAt = workflowState.completedAt;
  return workflowState;
}

function buildRequest(
  step: PlanStep,
  plan: PlanManifest,
  stepOutputs: Record<string, Record<string, unknown>>
): ExecuteStepRequest {
  return {
    step,
    workflowId: workflowInfo().workflowId,
    planId: plan.planId,
    intentId: plan.intentId,
    variables: {},
    stepOutputs,
  };
}

async function runCompensation(
  plan: PlanManifest,
  workflowState: WorkflowState,
  stepOutputs: Record<string, Record<string, unknown>>
): Promise<void> {
  if (workflowState.compensationStack.length === 0) return;
  workflowState.status = 'compensating';
  workflowState.updatedAt = new Date().toISOString();

  const compensations = [...workflowState.compensationStack].reverse();
  for (const comp of compensations) {
    const step: PlanStep = {
      stepId: `${comp.stepId}-compensation`,
      planId: plan.planId,
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

    await activities.compensateStep(buildRequest(step, plan, stepOutputs));
  }

  workflowState.status = 'failed';
  workflowState.updatedAt = new Date().toISOString();
}

function topologicalSort(steps: PlanStep[]): PlanStep[] {
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
