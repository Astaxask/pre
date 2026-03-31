import { Worker, type Job } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import type { MemoryReader, MemoryWriter } from '@pre/memory';
import type { InferenceJobData } from '../queues.js';
import {
  runInference,
  getInsights,
  evaluateInsights,
  type InferenceEngineDeps,
  type DetectedPattern,
} from '@pre/engines';
import type { SidecarClient } from '../sidecar-client.js';
import type { EventBus } from '../event-bus.js';

export type InsightWorkerDeps = {
  reader: MemoryReader;
  writer: MemoryWriter;
  sidecarClient: SidecarClient;
  bus: EventBus;
  redisOpts: RedisOptions;
};

export function startInsightWorker(deps: InsightWorkerDeps): Worker<InferenceJobData> {
  const engineDeps: InferenceEngineDeps = {
    reader: deps.reader,
    sidecar: {
      detectPatterns: (events) =>
        deps.sidecarClient.detectPatterns(events) as Promise<DetectedPattern[]>,
      similaritySearch: (embedding, topK) =>
        deps.sidecarClient.similaritySearch(embedding, topK),
      isReady: () => deps.sidecarClient.isReady(),
    },
    bus: {
      emit: (event: string, payload: unknown) => {
        if (event === 'insight-generated') {
          deps.bus.emit('insight-generated', payload as { insightId: string; type: string });
        }
      },
    },
  };

  const worker = new Worker<InferenceJobData>(
    'run-inference',
    async (job: Job<InferenceJobData>) => {
      console.log(`[insight-worker] Running inference (trigger: ${job.data.trigger})`);

      try {
        const result = await runInference(engineDeps);
        console.log(
          `[insight-worker] Inference complete: ${result.insightsGenerated} insights, ` +
          `${result.patternsDetected} patterns in ${result.durationMs}ms`,
        );

        if (result.errors.length > 0) {
          console.warn(`[insight-worker] Inference errors: ${result.errors.join(', ')}`);
        }

        // If insights were generated, run the proactive agent
        if (result.insightsGenerated > 0) {
          try {
            const currentInsights = getInsights();
            const alerts = await evaluateInsights(currentInsights, {
              reader: deps.reader,
              writeTriggerLog: (entry) => deps.writer.writeTriggerLog(entry),
            });

            if (alerts.length > 0) {
              // Check quiet hours (22:00–08:00 local time)
              const hour = new Date().getHours();
              const isQuietHours = hour >= 22 || hour < 8;

              for (const alert of alerts) {
                if (isQuietHours && alert.severity === 'info') {
                  console.log(`[insight-worker] Suppressing info alert during quiet hours: ${alert.ruleName}`);
                  continue;
                }

                deps.bus.emit('alert-fired', {
                  alertId: alert.id,
                  severity: alert.severity,
                  title: alert.title,
                });

                console.log(
                  `[insight-worker] Alert fired: ${alert.ruleName} (${alert.severity})`,
                );
              }
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[insight-worker] Proactive agent error: ${message}`);
          }
        }

        return {
          insightsGenerated: result.insightsGenerated,
          patternsDetected: result.patternsDetected,
          durationMs: result.durationMs,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[insight-worker] Fatal error: ${message}`);
        throw err;
      }
    },
    {
      connection: deps.redisOpts,
      concurrency: 1, // Only one inference run at a time
    },
  );

  worker.on('failed', (job, err) => {
    console.error(
      `[insight-worker] Job ${job?.id ?? 'unknown'} failed: ${err.message}`,
    );
  });

  return worker;
}
