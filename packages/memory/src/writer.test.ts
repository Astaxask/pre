import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import type { LifeEvent } from '@pre/shared';
import { createWriter } from './writer.js';
import * as schema from './schema.js';

const TEST_KEY = 'a'.repeat(64);

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE life_events (
      id           TEXT PRIMARY KEY,
      source       TEXT NOT NULL,
      source_id    TEXT NOT NULL,
      domain       TEXT NOT NULL,
      event_type   TEXT NOT NULL,
      timestamp    INTEGER NOT NULL,
      ingested_at  INTEGER NOT NULL,
      payload      TEXT NOT NULL,
      summary      TEXT,
      privacy_level TEXT NOT NULL DEFAULT 'private',
      confidence   REAL NOT NULL DEFAULT 1.0,
      UNIQUE(source, source_id)
    );
    CREATE INDEX idx_events_domain    ON life_events(domain);
    CREATE INDEX idx_events_timestamp ON life_events(timestamp);
    CREATE INDEX idx_events_source    ON life_events(source);
  `);
  return db;
}

function makeEvent(overrides: Partial<LifeEvent> = {}): LifeEvent {
  return {
    id: 'evt-001',
    source: 'plaid',
    sourceId: 'txn-abc-123',
    domain: 'money',
    eventType: 'transaction',
    timestamp: 1700000000000,
    ingestedAt: 1700000001000,
    payload: {
      domain: 'money',
      subtype: 'transaction',
      amount: 42.5,
      currency: 'USD',
      direction: 'debit',
      merchantName: 'Coffee Shop',
    },
    embedding: null,
    summary: null,
    privacyLevel: 'private',
    confidence: 1.0,
    ...overrides,
  };
}

describe('createWriter', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  describe('event()', () => {
    it('inserts a single event', async () => {
      const writer = createWriter(db, TEST_KEY);
      const result = await writer.event(makeEvent());
      expect(result._tag).toBe('ok');

      const drizzleDb = drizzle(db);
      const rows = drizzleDb.select().from(schema.lifeEvents).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source).toBe('plaid');
    });

    it('deduplicates on (source, sourceId)', async () => {
      const writer = createWriter(db, TEST_KEY);
      const evt = makeEvent();

      const r1 = await writer.event(evt);
      expect(r1._tag).toBe('ok');

      const r2 = await writer.event({ ...evt, id: 'evt-002' });
      expect(r2._tag).toBe('err');
      if (r2._tag === 'err') {
        expect(r2.error).toBe('duplicate');
      }

      const drizzleDb = drizzle(db);
      const rows = drizzleDb.select().from(schema.lifeEvents).all();
      expect(rows).toHaveLength(1);
    });

    it('encrypts private payloads', async () => {
      const writer = createWriter(db, TEST_KEY);
      await writer.event(makeEvent({ privacyLevel: 'private' }));

      const row = db
        .prepare('SELECT payload FROM life_events WHERE id = ?')
        .get('evt-001') as { payload: string } | undefined;
      expect(row).toBeDefined();
      // Encrypted payload should NOT be valid JSON
      expect(() => JSON.parse(row!.payload)).toThrow();
    });

    it('stores cloud-safe payloads as plain JSON', async () => {
      const writer = createWriter(db, TEST_KEY);
      await writer.event(
        makeEvent({
          privacyLevel: 'cloud-safe',
          payload: {
            domain: 'money',
            subtype: 'transaction',
            amount: 10,
          },
        }),
      );

      const row = db
        .prepare('SELECT payload FROM life_events WHERE id = ?')
        .get('evt-001') as { payload: string } | undefined;
      expect(row).toBeDefined();
      const parsed = JSON.parse(row!.payload);
      expect(parsed.domain).toBe('money');
      expect(parsed.amount).toBe(10);
    });
  });

  describe('events()', () => {
    it('batch writes multiple events', async () => {
      const writer = createWriter(db, TEST_KEY);
      const events = [
        makeEvent({ id: 'evt-1', sourceId: 'txn-1' }),
        makeEvent({ id: 'evt-2', sourceId: 'txn-2' }),
        makeEvent({ id: 'evt-3', sourceId: 'txn-3' }),
      ];

      const result = await writer.events(events);
      expect(result.inserted).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('reports skipped duplicates in batch', async () => {
      const writer = createWriter(db, TEST_KEY);
      // Insert first
      await writer.event(makeEvent({ id: 'evt-1', sourceId: 'txn-1' }));

      const events = [
        makeEvent({ id: 'evt-dup', sourceId: 'txn-1' }), // duplicate
        makeEvent({ id: 'evt-2', sourceId: 'txn-2' }), // new
      ];

      const result = await writer.events(events);
      expect(result.inserted).toBe(1);
      expect(result.skipped).toBe(1);
    });
  });
});
