import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { LifeEvent } from '@pre/shared';
import { lifeEventSchema, ok, err, type Result } from '@pre/shared';
import { lifeEvents } from './schema.js';
import { encryptPayload } from './encrypt.js';

export type BatchWriteResult = {
  inserted: number;
  skipped: number;
  errors: Array<{ sourceId: string; error: string }>;
};

export type MemoryWriter = {
  event(event: LifeEvent): Promise<Result<void, string>>;
  events(events: LifeEvent[]): Promise<BatchWriteResult>;
};

export function createWriter(
  db: Database.Database,
  masterKey: string,
): MemoryWriter {
  const drizzleDb = drizzle(db);

  async function writeEvent(event: LifeEvent): Promise<Result<void, string>> {
    const parsed = lifeEventSchema.safeParse(event);
    if (!parsed.success) {
      return err(`Validation failed: ${parsed.error.message}`);
    }

    let payloadStr: string;
    if (event.privacyLevel === 'private') {
      payloadStr = await encryptPayload(
        event.payload,
        event.domain,
        masterKey,
      );
    } else {
      payloadStr = JSON.stringify(event.payload);
    }

    const result = drizzleDb
      .insert(lifeEvents)
      .values({
        id: event.id,
        source: event.source,
        sourceId: event.sourceId,
        domain: event.domain,
        eventType: event.eventType,
        timestamp: event.timestamp,
        ingestedAt: event.ingestedAt,
        payload: payloadStr,
        summary: event.summary,
        privacyLevel: event.privacyLevel,
        confidence: event.confidence,
      })
      .onConflictDoNothing()
      .run();

    if (result.changes === 0) {
      return err('duplicate');
    }

    return ok(undefined);
  }

  async function writeEvents(events: LifeEvent[]): Promise<BatchWriteResult> {
    let inserted = 0;
    let skipped = 0;
    const errors: Array<{ sourceId: string; error: string }> = [];

    // Prepare all payloads (async encryption) before running the synchronous transaction
    const prepared: Array<{
      event: LifeEvent;
      payloadStr: string;
    }> = [];

    for (const event of events) {
      try {
        const parsed = lifeEventSchema.safeParse(event);
        if (!parsed.success) {
          errors.push({
            sourceId: event.sourceId,
            error: `Validation failed: ${parsed.error.message}`,
          });
          continue;
        }

        let payloadStr: string;
        if (event.privacyLevel === 'private') {
          payloadStr = await encryptPayload(
            event.payload,
            event.domain,
            masterKey,
          );
        } else {
          payloadStr = JSON.stringify(event.payload);
        }

        prepared.push({ event, payloadStr });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ sourceId: event.sourceId, error: message });
      }
    }

    // Run all inserts in a single synchronous transaction
    const insertAll = db.transaction(() => {
      for (const { event, payloadStr } of prepared) {
        const result = drizzleDb
          .insert(lifeEvents)
          .values({
            id: event.id,
            source: event.source,
            sourceId: event.sourceId,
            domain: event.domain,
            eventType: event.eventType,
            timestamp: event.timestamp,
            ingestedAt: event.ingestedAt,
            payload: payloadStr,
            summary: event.summary,
            privacyLevel: event.privacyLevel,
            confidence: event.confidence,
          })
          .onConflictDoNothing()
          .run();

        if (result.changes === 0) {
          skipped++;
        } else {
          inserted++;
        }
      }
    });

    insertAll();

    return { inserted, skipped, errors };
  }

  return {
    event: writeEvent,
    events: writeEvents,
  };
}
