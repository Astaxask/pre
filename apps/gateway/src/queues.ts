import { Queue } from 'bullmq';
import type { RedisOptions } from 'ioredis';

export type SyncJobData = {
  source: string;
};

export type EmbedJobData = {
  eventId: string;
};

export type InferenceJobData = {
  trigger: 'scheduled' | 'post-sync';
};

export type SnoozeJobData = {
  alertId: string;
  alert: unknown;
};

let syncQueue: Queue<SyncJobData> | null = null;
let embedQueue: Queue<EmbedJobData> | null = null;
let inferenceQueue: Queue<InferenceJobData> | null = null;
let snoozeQueue: Queue<SnoozeJobData> | null = null;

export function initQueues(redisOpts: RedisOptions): {
  syncQueue: Queue<SyncJobData>;
  embedQueue: Queue<EmbedJobData>;
  inferenceQueue: Queue<InferenceJobData>;
  snoozeQueue: Queue<SnoozeJobData>;
} {
  syncQueue = new Queue<SyncJobData>('adapter-sync', {
    connection: redisOpts,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  });

  embedQueue = new Queue<EmbedJobData>('embed-event', {
    connection: redisOpts,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'fixed', delay: 1000 },
      removeOnComplete: 500,
      removeOnFail: 200,
    },
  });

  inferenceQueue = new Queue<InferenceJobData>('run-inference', {
    connection: redisOpts,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'fixed', delay: 10000 },
      removeOnComplete: 50,
      removeOnFail: 100,
    },
  });

  snoozeQueue = new Queue<SnoozeJobData>('snooze-alert', {
    connection: redisOpts,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'fixed', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  });

  return { syncQueue, embedQueue, inferenceQueue, snoozeQueue };
}

export async function enqueueSyncJob(source: string): Promise<void> {
  if (!syncQueue) throw new Error('Queues not initialized');
  await syncQueue.add(`sync-${source}`, { source }, {
    jobId: `sync-${source}-${Date.now()}`,
  });
}

export async function enqueueEmbedJob(eventId: string): Promise<void> {
  if (!embedQueue) throw new Error('Queues not initialized');
  await embedQueue.add(`embed-${eventId}`, { eventId }, {
    jobId: `embed-${eventId}`,
  });
}

export async function enqueueSnoozeJob(alertId: string, alert: unknown, delayMs: number): Promise<void> {
  if (!snoozeQueue) throw new Error('Queues not initialized');
  await snoozeQueue.add(`snooze-${alertId}`, { alertId, alert }, {
    jobId: `snooze-${alertId}-${Date.now()}`,
    delay: delayMs,
  });
}

export async function enqueueInferenceJob(trigger: 'scheduled' | 'post-sync'): Promise<void> {
  if (!inferenceQueue) throw new Error('Queues not initialized');
  await inferenceQueue.add(`inference-${trigger}`, { trigger }, {
    jobId: `inference-${trigger}-${Date.now()}`,
  });
}

export async function closeQueues(): Promise<void> {
  await syncQueue?.close();
  await embedQueue?.close();
  await inferenceQueue?.close();
  await snoozeQueue?.close();
}
