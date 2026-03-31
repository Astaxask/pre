import { Worker, type Job } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { lifeEvents, embeddingSync } from '@pre/memory';
import { callModel, summarizeEvent } from '@pre/models';
import type { LifeDomain } from '@pre/shared';
import type { SidecarClient } from '../sidecar-client.js';
import type { EmbedJobData } from '../queues.js';

type EmbedWorkerDeps = {
  db: Database.Database;
  sidecarClient: SidecarClient;
  redisOpts: RedisOptions;
};

export function startEmbedWorker(deps: EmbedWorkerDeps): Worker<EmbedJobData> {
  const { db, sidecarClient, redisOpts } = deps;
  const drizzleDb = drizzle(db);

  const worker = new Worker<EmbedJobData>(
    'embed-event',
    async (job: Job<EmbedJobData>) => {
      const { eventId } = job.data;

      // 1. Load the LifeEvent from SQLite
      const row = drizzleDb
        .select()
        .from(lifeEvents)
        .where(eq(lifeEvents.id, eventId))
        .get();

      if (!row) {
        console.warn(`[embed-worker] Event ${eventId} not found in SQLite, skipping`);
        return;
      }

      // 2. Generate a summary using callModel (private, local only)
      //    We pass domain and eventType as context — never the raw payload
      let summary = row.summary;
      if (!summary) {
        try {
          const messages = summarizeEvent({
            domain: row.domain as LifeDomain,
            eventType: row.eventType,
            timestamp: row.timestamp,
          });

          const response = await callModel({
            task: 'summarize-event',
            privacyLevel: 'private',
            messages,
          });

          summary = response.content;

          // Write summary back to life_events
          drizzleDb
            .update(lifeEvents)
            .set({ summary })
            .where(eq(lifeEvents.id, eventId))
            .run();
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.warn(
            `[embed-worker] Summary generation failed for ${eventId}: ${message}`,
          );
          // Use a fallback summary from domain + eventType
          summary = `${row.domain} ${row.eventType} event`;
        }
      }

      // 3. Call sidecar to embed the summary
      const embedding = await sidecarClient.embed(summary);

      // 4. Write vector to LanceDB via sidecar
      await sidecarClient.upsertVector(eventId, embedding, {
        domain: row.domain,
        eventType: row.eventType,
        timestamp: row.timestamp,
        summary,
      });

      // 5. Update embedding_sync table
      const existing = drizzleDb
        .select()
        .from(embeddingSync)
        .where(eq(embeddingSync.eventId, eventId))
        .get();

      if (existing) {
        drizzleDb
          .update(embeddingSync)
          .set({
            embeddedAt: Date.now(),
            model: 'nomic-embed-text',
          })
          .where(eq(embeddingSync.eventId, eventId))
          .run();
      } else {
        drizzleDb
          .insert(embeddingSync)
          .values({
            eventId,
            embeddedAt: Date.now(),
            model: 'nomic-embed-text',
          })
          .run();
      }

      console.log(`[embed-worker] Embedded event ${eventId}`);
    },
    {
      connection: redisOpts,
      concurrency: 5,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(
      `[embed-worker] Job ${job?.id} failed:`,
      err.message,
    );
  });

  return worker;
}
