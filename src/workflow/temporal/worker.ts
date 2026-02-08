/**
 * Temporal Worker
 */

import { Worker } from '@temporalio/worker';
import { getConfig } from '../../core/config.js';
import { Executor } from '../../executor/index.js';
import { registerStepExecutor } from './activities.js';

async function run(): Promise<void> {
  const config = getConfig();
  const executor = new Executor();
  await executor.initialize();
  registerStepExecutor((step, ctx) => executor.executeStep(step, ctx));

  const worker = await Worker.create({
    workflowsPath: require.resolve('./workflows.js'),
    activities: await import('./activities.js'),
    taskQueue: config.temporalTaskQueue,
  });

  await worker.run();
}

if (require.main === module) {
  run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Temporal worker failed', err);
    process.exit(1);
  });
}

export { run as runTemporalWorker };
