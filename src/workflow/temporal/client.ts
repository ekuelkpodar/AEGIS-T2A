/**
 * Temporal Client
 */

import { Connection, WorkflowClient } from '@temporalio/client';
import { getConfig } from '../../core/config.js';

let client: WorkflowClient | null = null;

export async function getTemporalClient(): Promise<WorkflowClient> {
  if (client) return client;
  const config = getConfig();
  const connection = await Connection.connect({ address: config.temporalAddress });
  client = new WorkflowClient({ connection, namespace: config.temporalNamespace });
  return client;
}
