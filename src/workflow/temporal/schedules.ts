/**
 * Temporal schedule helpers for proactive workflows.
 */

import { getTemporalClient } from './client.js';

export interface ScheduleSpec {
  scheduleId: string;
  workflowType: string;
  taskQueue: string;
  everyMinutes: number;
  args?: unknown[];
}

export async function ensureSchedule(spec: ScheduleSpec): Promise<void> {
  const client = await getTemporalClient();
  const scheduleClient = client.schedule;

  await scheduleClient.create({
    scheduleId: spec.scheduleId,
    spec: {
      intervals: [{ every: `${spec.everyMinutes}m` }],
    },
    action: {
      type: 'startWorkflow',
      workflowType: spec.workflowType,
      taskQueue: spec.taskQueue,
      args: spec.args ?? [],
    },
  });
}
