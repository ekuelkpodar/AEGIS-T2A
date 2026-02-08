/**
 * Temporal Activities for Plan Execution
 */

import type { PlanStep, StepExecutionResult } from '../../core/types.js';
import type { ExecutionContext } from '../index.js';
import { loadPlanPayload } from './payload-store.js';
import { logger } from '../../core/logger.js';

let stepExecutor: ((step: PlanStep, context: ExecutionContext) => Promise<StepExecutionResult>) | null = null;

export function registerStepExecutor(
  executor: (step: PlanStep, context: ExecutionContext) => Promise<StepExecutionResult>
): void {
  stepExecutor = executor;
}

export interface ExecuteStepRequest {
  step: PlanStep;
  workflowId: string;
  planId: string;
  intentId: string;
  variables: Record<string, unknown>;
  stepOutputs: Record<string, Record<string, unknown>>;
}

export async function executePlanStep(
  request: ExecuteStepRequest
): Promise<StepExecutionResult> {
  const context: ExecutionContext = {
    workflowId: request.workflowId,
    planId: request.planId,
    intentId: request.intentId,
    variables: new Map(Object.entries(request.variables ?? {})),
    stepOutputs: new Map(Object.entries(request.stepOutputs ?? {})),
  };

  if (!stepExecutor) {
    return {
      stepId: request.step.stepId,
      status: 'completed',
      outputs: { mock: true },
      durationMs: 0,
      costIncurred: request.step.estimatedCost,
    };
  }

  return stepExecutor(request.step, context);
}

export async function compensateStep(
  request: ExecuteStepRequest
): Promise<StepExecutionResult> {
  return executePlanStep(request);
}

export async function fetchPlanPayload(payloadId: string) {
  const plan = loadPlanPayload(payloadId);
  if (!plan) {
    logger.warn({ payloadId }, 'Plan payload not found');
  }
  return plan;
}
