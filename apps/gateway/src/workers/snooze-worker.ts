import { Worker, type Job } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import type { SnoozeJobData } from '../queues.js';
import { broadcast } from '../ws-server.js';

type SnoozeWorkerDeps = {
  redisOpts: RedisOptions;
};

export function startSnoozeWorker(deps: SnoozeWorkerDeps): Worker<SnoozeJobData> {
  const { redisOpts } = deps;

  const worker = new Worker<SnoozeJobData>(
    'snooze-alert',
    async (job: Job<SnoozeJobData>) => {
      // Re-broadcast the alert to all connected surfaces after snooze expires
      broadcast({ type: 'alert', payload: job.data.alert });
    },
    { connection: redisOpts },
  );

  worker.on('failed', (job, err) => {
    console.error(`[snooze-worker] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
