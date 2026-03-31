import { Worker, type Job } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import type { LifeAdapter } from '@pre/integrations';
import { createWriter, integrationSync } from '@pre/memory';
import type { EventBus } from '../event-bus.js';
import { enqueueEmbedJob } from '../queues.js';
import type { SyncJobData } from '../queues.js';

type SyncWorkerDeps = {
  db: Database.Database;
  masterKey: string;
  adapters: Map<string, LifeAdapter>;
  bus: EventBus;
  redisOpts: RedisOptions;
};

export function startSyncWorker(deps: SyncWorkerDeps): Worker<SyncJobData> {
  const { db, masterKey, adapters, bus, redisOpts } = deps;
  const writer = createWriter(db, masterKey);
  const drizzleDb = drizzle(db);

  const worker = new Worker<SyncJobData>(
    'adapter-sync',
    async (job: Job<SyncJobData>) => {
      const { source } = job.data;
      const adapter = adapters.get(source);
      if (!adapter) {
        throw new Error(`Unknown adapter: ${source}`);
      }

      bus.emit('sync-started', { source });

      // Get current cursor from integration_sync table
      const syncState = drizzleDb
        .select()
        .from(integrationSync)
        .where(eq(integrationSync.source, source))
        .get();

      let cursor = syncState?.cursor ?? null;
      let totalInserted = 0;
      let totalSkipped = 0;

      // Update status to 'syncing'
      if (syncState) {
        drizzleDb
          .update(integrationSync)
          .set({ status: 'syncing' })
          .where(eq(integrationSync.source, source))
          .run();
      } else {
        drizzleDb
          .insert(integrationSync)
          .values({ source, status: 'syncing' })
          .run();
      }

      try {
        // Paginate: keep calling sync() while hasMore is true
        let hasMore = true;
        while (hasMore) {
          const result = await adapter.sync(cursor);

          if (result.events.length > 0) {
            const writeResult = await writer.events(result.events);
            totalInserted += writeResult.inserted;
            totalSkipped += writeResult.skipped;

            if (writeResult.errors.length > 0) {
              console.warn(
                `[sync-worker] ${source}: ${writeResult.errors.length} events failed to write`,
                writeResult.errors.map((e) => e.sourceId),
              );
            }

            // Enqueue embedding jobs for newly inserted events
            for (const event of result.events) {
              try {
                await enqueueEmbedJob(event.id);
              } catch {
                // Non-fatal: embed job enqueue failure shouldn't stop sync
              }
            }
          }

          cursor = result.nextCursor;
          hasMore = result.hasMore;
        }

        // Update integration_sync with new cursor and status
        drizzleDb
          .update(integrationSync)
          .set({
            lastSyncAt: Date.now(),
            cursor,
            status: 'idle',
          })
          .where(eq(integrationSync.source, source))
          .run();

        bus.emit('sync-completed', {
          source,
          eventsCount: totalInserted,
        });

        if (totalInserted > 0) {
          bus.emit('events-ingested', {
            source,
            count: totalInserted,
            domains: adapter.domains,
          });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const isAuthError =
          message.includes('INVALID_ACCESS_TOKEN') ||
          message.includes('ITEM_LOGIN_REQUIRED') ||
          message.includes('INVALID_CREDENTIALS') ||
          message.includes('401') ||
          message.includes('invalid_grant');

        if (isAuthError) {
          drizzleDb
            .update(integrationSync)
            .set({ status: 'needs-reauth' })
            .where(eq(integrationSync.source, source))
            .run();

          bus.emit('adapter-needs-reauth', { source, error: message });
          // Do not rethrow — stop retrying for auth failures
          return;
        }

        // Transient failure: update status, rethrow to let BullMQ retry
        drizzleDb
          .update(integrationSync)
          .set({ status: 'error' })
          .where(eq(integrationSync.source, source))
          .run();

        bus.emit('sync-failed', { source, error: message });
        throw e;
      }
    },
    {
      connection: redisOpts,
      concurrency: 2,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(
      `[sync-worker] Job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      err.message,
    );
  });

  return worker;
}
