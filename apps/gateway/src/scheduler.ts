import cron from 'node-cron';
import type { Config } from './config.js';
import { enqueueSyncJob, enqueueInferenceJob } from './queues.js';

type ScheduledTask = {
  source: string;
  task: cron.ScheduledTask;
};

let tasks: ScheduledTask[] = [];

function minutesToCron(minutes: number): string {
  if (minutes < 60) {
    return `*/${minutes} * * * *`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) {
    return `0 */${hours} * * *`;
  }
  return `${remainingMinutes} */${hours} * * *`;
}

export function start(config: Config): void {
  stop(); // Clear any existing tasks

  const adapterEntries = Object.entries(config.adapters) as Array<
    [string, { enabled: boolean; syncIntervalMinutes: number }]
  >;

  for (const [source, adapterConfig] of adapterEntries) {
    if (!adapterConfig.enabled) {
      continue;
    }

    const cronExpr = minutesToCron(adapterConfig.syncIntervalMinutes);

    const task = cron.schedule(cronExpr, () => {
      enqueueSyncJob(source).catch((err) => {
        console.error(
          `[scheduler] Failed to enqueue sync job for ${source}:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    });

    tasks.push({ source, task });
    console.log(
      `[scheduler] Registered ${source} sync every ${adapterConfig.syncIntervalMinutes}m (${cronExpr})`,
    );
  }

  // Inference engine: every 15 minutes
  const inferenceTask = cron.schedule('*/15 * * * *', () => {
    enqueueInferenceJob('scheduled').catch((err) => {
      console.error(
        '[scheduler] Failed to enqueue inference job:',
        err instanceof Error ? err.message : String(err),
      );
    });
  });

  tasks.push({ source: 'inference-engine', task: inferenceTask });
  console.log('[scheduler] Registered inference engine every 15m');

  console.log(
    `[scheduler] Started with ${tasks.length} schedule(s)`,
  );
}

export function stop(): void {
  for (const { task } of tasks) {
    task.stop();
  }
  tasks = [];
}

export function getActiveSchedules(): string[] {
  return tasks.map((t) => t.source);
}
