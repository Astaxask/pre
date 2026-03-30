import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, and, gte, lte, inArray } from 'drizzle-orm';
import type { LifeDomain, LifeEvent, DomainPayload } from '@pre/shared';
import { lifeEvents, goals, triggerLog } from './schema.js';
import { decryptPayload } from './encrypt.js';

export type Goal = {
  id: string;
  title: string;
  domain: string;
  targetDate: number | null;
  status: string;
  createdAt: number;
  updatedAt: number;
};

export type TriggerLogEntry = {
  id: string;
  ruleId: string;
  firedAt: number;
  severity: string;
  dismissedAt: number | null;
};

export type MemoryReader = {
  recentByDomain(domain: LifeDomain, hours: number): Promise<LifeEvent[]>;
  byTimeRange(
    start: number,
    end: number,
    domains?: LifeDomain[],
  ): Promise<LifeEvent[]>;
  goals(status?: string): Promise<Goal[]>;
  triggerLog(ruleId: string, since: number): Promise<TriggerLogEntry[]>;
};

async function hydrateRow(
  row: typeof lifeEvents.$inferSelect,
  masterKey: string,
): Promise<LifeEvent> {
  let payload: DomainPayload;
  if (row.privacyLevel === 'private') {
    payload = await decryptPayload(
      row.payload,
      row.domain as LifeDomain,
      masterKey,
    );
  } else {
    payload = JSON.parse(row.payload) as DomainPayload;
  }

  return {
    id: row.id,
    source: row.source as LifeEvent['source'],
    sourceId: row.sourceId,
    domain: row.domain as LifeDomain,
    eventType: row.eventType,
    timestamp: row.timestamp,
    ingestedAt: row.ingestedAt,
    payload,
    embedding: null,
    summary: row.summary ?? null,
    privacyLevel: row.privacyLevel as LifeEvent['privacyLevel'],
    confidence: row.confidence,
  };
}

export function createReader(
  db: Database.Database,
  masterKey: string,
): MemoryReader {
  const drizzleDb = drizzle(db);

  return {
    async recentByDomain(
      domain: LifeDomain,
      hours: number,
    ): Promise<LifeEvent[]> {
      const cutoff = Date.now() - hours * 3600000;
      const rows = drizzleDb
        .select()
        .from(lifeEvents)
        .where(
          and(
            eq(lifeEvents.domain, domain),
            gte(lifeEvents.timestamp, cutoff),
          ),
        )
        .all();

      return Promise.all(rows.map((row) => hydrateRow(row, masterKey)));
    },

    async byTimeRange(
      start: number,
      end: number,
      domains?: LifeDomain[],
    ): Promise<LifeEvent[]> {
      const conditions = [
        gte(lifeEvents.timestamp, start),
        lte(lifeEvents.timestamp, end),
      ];

      if (domains && domains.length > 0) {
        conditions.push(inArray(lifeEvents.domain, domains));
      }

      const rows = drizzleDb
        .select()
        .from(lifeEvents)
        .where(and(...conditions))
        .all();

      return Promise.all(rows.map((row) => hydrateRow(row, masterKey)));
    },

    async goals(status?: string): Promise<Goal[]> {
      if (status) {
        return drizzleDb
          .select()
          .from(goals)
          .where(eq(goals.status, status))
          .all();
      }
      return drizzleDb.select().from(goals).all();
    },

    async triggerLog(
      ruleId: string,
      since: number,
    ): Promise<TriggerLogEntry[]> {
      return drizzleDb
        .select()
        .from(triggerLog)
        .where(
          and(eq(triggerLog.ruleId, ruleId), gte(triggerLog.firedAt, since)),
        )
        .all();
    },
  };
}
