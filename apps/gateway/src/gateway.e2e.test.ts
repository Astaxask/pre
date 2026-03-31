import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import {
  createWriter,
  createReader,
  integrationSync,
  lifeEvents,
  embeddingSync,
  goals,
} from '@pre/memory';
import { openDatabase } from '@pre/memory';
import { EventBus } from './event-bus.js';
import { startWsServer, stopWsServer } from './ws-server.js';
import { WebSocket } from 'ws';

// We test the sync pipeline end-to-end using a mock Plaid adapter and real
// in-memory SQLite. No live API calls, no Redis, no BullMQ — we drive the
// sync logic directly.

import type { LifeAdapter, AdapterResult, SyncCursor } from '@pre/integrations';
import type { LifeEvent, MoneyPayload } from '@pre/shared';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock modules used by ws-server that need external services
vi.mock('./queues.js', () => ({
  enqueueSyncJob: vi.fn().mockResolvedValue(undefined),
  initQueues: vi.fn().mockReturnValue({
    syncQueue: {},
    embedQueue: {},
    inferenceQueue: {},
  }),
  closeQueues: vi.fn().mockResolvedValue(undefined),
  enqueueInferenceJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pre/engines', () => ({
  runSimulation: vi.fn().mockResolvedValue({
    requestId: 'sim-test',
    simulationMode: 'standard',
    outcomes: [],
    narrative: 'Test narrative',
    decisionType: 'test',
    hasGenericPriors: false,
    genericPriorDomains: [],
  }),
}));

vi.mock('@pre/models', () => ({
  callModel: vi.fn().mockResolvedValue({
    content: 'Today was a productive day with several events across your life domains.',
    model: 'ollama/llama3.1:8b',
    tokensUsed: 50,
    costUsd: 0,
    routedTo: 'ollama',
  }),
  configureRouter: vi.fn(),
}));

const TEST_KEY = 'a'.repeat(64);

/** A fake Plaid adapter that returns fixture data */
class MockPlaidAdapter implements LifeAdapter {
  readonly source = 'plaid' as const;
  readonly domains = ['money' as const];
  private callCount = 0;

  async sync(cursor: SyncCursor | null): Promise<AdapterResult> {
    this.callCount++;

    const events: LifeEvent[] = [
      {
        id: randomUUID(),
        source: 'plaid',
        sourceId: 'txn_mock_001',
        domain: 'money',
        eventType: 'transaction',
        timestamp: Date.now() - 3600000,
        ingestedAt: Date.now(),
        payload: {
          domain: 'money',
          subtype: 'transaction',
          amount: 25.5,
          currency: 'USD',
          direction: 'debit',
          merchantName: 'Test Coffee Shop',
          accountId: 'acc_test_001',
        } satisfies MoneyPayload,
        embedding: null,
        summary: null,
        privacyLevel: 'private',
        confidence: 1.0,
      },
      {
        id: randomUUID(),
        source: 'plaid',
        sourceId: 'txn_mock_002',
        domain: 'money',
        eventType: 'transaction',
        timestamp: Date.now() - 7200000,
        ingestedAt: Date.now(),
        payload: {
          domain: 'money',
          subtype: 'transaction',
          amount: 120.0,
          currency: 'USD',
          direction: 'debit',
          merchantName: 'Grocery Store',
          accountId: 'acc_test_001',
        } satisfies MoneyPayload,
        embedding: null,
        summary: null,
        privacyLevel: 'private',
        confidence: 1.0,
      },
    ];

    return {
      events,
      nextCursor: `cursor_after_sync_${this.callCount}`,
      hasMore: false,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }

  manifest() {
    return {
      source: 'plaid' as const,
      description: 'Mock Plaid adapter for testing',
      domains: ['money' as const],
      maxPrivacyLevel: 'private' as const,
      defaultSyncIntervalMinutes: 360,
      collectsFields: [],
      refusesFields: [],
    };
  }
}

// Inline the sync logic (same as sync-worker but without BullMQ)
async function runSync(
  adapter: LifeAdapter,
  db: Database.Database,
  masterKey: string,
  bus: EventBus,
): Promise<void> {
  const writer = createWriter(db, masterKey);
  const drizzleDb = drizzle(db);
  const source = adapter.source;

  const syncState = drizzleDb
    .select()
    .from(integrationSync)
    .where(eq(integrationSync.source, source))
    .get();

  let cursor = syncState?.cursor ?? null;

  if (!syncState) {
    drizzleDb
      .insert(integrationSync)
      .values({ source, status: 'syncing' })
      .run();
  } else {
    drizzleDb
      .update(integrationSync)
      .set({ status: 'syncing' })
      .where(eq(integrationSync.source, source))
      .run();
  }

  let hasMore = true;
  while (hasMore) {
    const result = await adapter.sync(cursor);

    if (result.events.length > 0) {
      await writer.events(result.events);
    }

    cursor = result.nextCursor;
    hasMore = result.hasMore;
  }

  drizzleDb
    .update(integrationSync)
    .set({ lastSyncAt: Date.now(), cursor, status: 'idle' })
    .where(eq(integrationSync.source, source))
    .run();

  bus.emit('sync-completed', { source, eventsCount: 2 });
}

describe('Gateway E2E — Plaid sync pipeline', () => {
  let db: Database.Database;
  let bus: EventBus;

  beforeEach(() => {
    db = openDatabase(':memory:');
    bus = new EventBus();
  });

  afterEach(() => {
    db.close();
  });

  it('sync writes LifeEvents into SQLite', async () => {
    const adapter = new MockPlaidAdapter();
    await runSync(adapter, db, TEST_KEY, bus);

    const drizzleDb = drizzle(db);
    const rows = drizzleDb.select().from(lifeEvents).all();

    expect(rows).toHaveLength(2);
    expect(rows[0]!.source).toBe('plaid');
    expect(rows[0]!.domain).toBe('money');
    expect(rows[1]!.source).toBe('plaid');
  });

  it('private events have encrypted payloads in raw database', async () => {
    const adapter = new MockPlaidAdapter();
    await runSync(adapter, db, TEST_KEY, bus);

    // Read raw payload directly — should NOT be parseable JSON
    const rows = db
      .prepare('SELECT payload, privacy_level FROM life_events')
      .all() as Array<{ payload: string; privacy_level: string }>;

    for (const row of rows) {
      expect(row.privacy_level).toBe('private');
      // Encrypted payload should NOT be valid JSON
      expect(() => JSON.parse(row.payload)).toThrow();
    }
  });

  it('events can be read and decrypted via memory.read', async () => {
    const adapter = new MockPlaidAdapter();
    await runSync(adapter, db, TEST_KEY, bus);

    const reader = createReader(db, TEST_KEY);
    const events = await reader.recentByDomain('money', 24);

    expect(events).toHaveLength(2);
    // Payload should be fully decrypted
    const first = events[0]!;
    expect(first.payload.domain).toBe('money');
    if (first.payload.domain === 'money') {
      expect(first.payload.subtype).toBe('transaction');
      expect(typeof first.payload.amount).toBe('number');
    }
  });

  it('deduplication: running sync twice produces no duplicates', async () => {
    const adapter = new MockPlaidAdapter();

    // First sync
    await runSync(adapter, db, TEST_KEY, bus);
    let rows = drizzle(db).select().from(lifeEvents).all();
    expect(rows).toHaveLength(2);

    // Second sync — same sourceIds
    await runSync(adapter, db, TEST_KEY, bus);
    rows = drizzle(db).select().from(lifeEvents).all();
    expect(rows).toHaveLength(2); // No duplicates
  });

  it('integration_sync table is updated after sync', async () => {
    const adapter = new MockPlaidAdapter();
    await runSync(adapter, db, TEST_KEY, bus);

    const drizzleDb = drizzle(db);
    const syncState = drizzleDb
      .select()
      .from(integrationSync)
      .where(eq(integrationSync.source, 'plaid'))
      .get();

    expect(syncState).toBeDefined();
    expect(syncState!.status).toBe('idle');
    expect(syncState!.cursor).toContain('cursor_after_sync');
    expect(syncState!.lastSyncAt).toBeGreaterThan(0);
  });

  it('event bus emits sync-completed', async () => {
    const adapter = new MockPlaidAdapter();
    const handler = vi.fn();
    bus.on('sync-completed', handler);

    await runSync(adapter, db, TEST_KEY, bus);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'plaid' }),
    );
  });
});

describe('Gateway E2E — Embedding pipeline', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('embedding_sync row can be written for an ingested event', async () => {
    const bus = new EventBus();
    const adapter = new MockPlaidAdapter();
    await runSync(adapter, db, TEST_KEY, bus);

    const drizzleDb = drizzle(db);
    const events = drizzleDb.select().from(lifeEvents).all();
    expect(events.length).toBeGreaterThan(0);

    const eventId = events[0]!.id;

    // Simulate what the embed worker does: write to embedding_sync
    drizzleDb
      .insert(embeddingSync)
      .values({
        eventId,
        embeddedAt: Date.now(),
        model: 'nomic-embed-text',
      })
      .run();

    const syncRow = drizzleDb
      .select()
      .from(embeddingSync)
      .where(eq(embeddingSync.eventId, eventId))
      .get();

    expect(syncRow).toBeDefined();
    expect(syncRow!.model).toBe('nomic-embed-text');
    expect(syncRow!.embeddedAt).toBeGreaterThan(0);
  });

  it('summary can be written back to life_events', async () => {
    const bus = new EventBus();
    const adapter = new MockPlaidAdapter();
    await runSync(adapter, db, TEST_KEY, bus);

    const drizzleDb = drizzle(db);
    const events = drizzleDb.select().from(lifeEvents).all();
    const eventId = events[0]!.id;

    // Simulate what the embed worker does: write summary
    const summary = 'A debit transaction in the money domain';
    drizzleDb
      .update(lifeEvents)
      .set({ summary })
      .where(eq(lifeEvents.id, eventId))
      .run();

    const updated = drizzleDb
      .select()
      .from(lifeEvents)
      .where(eq(lifeEvents.id, eventId))
      .get();

    expect(updated!.summary).toBe(summary);
  });

  it('embedding_sync tracks all ingested events when populated', async () => {
    const bus = new EventBus();
    const adapter = new MockPlaidAdapter();
    await runSync(adapter, db, TEST_KEY, bus);

    const drizzleDb = drizzle(db);
    const events = drizzleDb.select().from(lifeEvents).all();

    // Simulate embedding all events
    for (const event of events) {
      drizzleDb
        .insert(embeddingSync)
        .values({
          eventId: event.id,
          embeddedAt: Date.now(),
          model: 'nomic-embed-text',
        })
        .run();
    }

    const syncRows = drizzleDb.select().from(embeddingSync).all();
    expect(syncRows).toHaveLength(events.length);
  });
});

// ---------------------------------------------------------------------------
// WebSocket handler E2E tests
// ---------------------------------------------------------------------------

function sendAndReceive(ws: WebSocket, msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WS response timeout')), 5000);
    ws.once('message', (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(String(data)) as Record<string, unknown>);
    });
    ws.send(JSON.stringify(msg));
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
    } else {
      ws.once('open', () => resolve());
    }
  });
}

describe('Gateway E2E — WebSocket handlers', () => {
  let db: Database.Database;
  let ws: WebSocket;
  let tmpConfigDir: string;
  let configPath: string;
  const WS_PORT = 19876; // Use a non-standard port to avoid conflicts

  beforeEach(async () => {
    db = openDatabase(':memory:');

    // Create a temp config file
    tmpConfigDir = join(tmpdir(), `pre-test-${randomUUID()}`);
    mkdirSync(tmpConfigDir, { recursive: true });
    configPath = join(tmpConfigDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ adapters: {} }), 'utf-8');

    const reader = createReader(db, TEST_KEY);
    const writer = createWriter(db, TEST_KEY);

    startWsServer({
      port: WS_PORT,
      reader,
      writer,
      db,
      encryptionKey: TEST_KEY,
      configPath,
    });

    ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    await waitForOpen(ws);
  });

  afterEach(async () => {
    ws.close();
    await stopWsServer();
    db.close();
    try {
      rmSync(tmpConfigDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('delete-source-data removes events and returns sync-status', async () => {
    // Insert an event first
    const writer = createWriter(db, TEST_KEY);
    await writer.event({
      id: randomUUID(),
      source: 'plaid',
      sourceId: 'txn_del_001',
      domain: 'money',
      eventType: 'transaction',
      timestamp: Date.now(),
      ingestedAt: Date.now(),
      payload: {
        domain: 'money',
        subtype: 'transaction',
        amount: 10,
        currency: 'USD',
        direction: 'debit',
      } as MoneyPayload,
      embedding: null,
      summary: null,
      privacyLevel: 'private',
      confidence: 1,
    });

    // Verify it's there
    const rows = drizzle(db).select().from(lifeEvents).all();
    expect(rows).toHaveLength(1);

    const response = await sendAndReceive(ws, {
      type: 'delete-source-data',
      source: 'plaid',
    });

    expect(response.type).toBe('sync-status');
    const payload = response.payload as { source: string; status: string };
    expect(payload.source).toBe('plaid');
    expect(payload.status).toBe('deleted');

    // Verify data is gone
    const remaining = drizzle(db).select().from(lifeEvents).all();
    expect(remaining).toHaveLength(0);
  });

  it('create-goal inserts a goal and returns updated list', async () => {
    const response = await sendAndReceive(ws, {
      type: 'create-goal',
      payload: {
        title: 'Run a marathon',
        domain: 'body',
        targetDate: Date.now() + 86400000 * 90,
      },
    });

    expect(response.type).toBe('query-result');
    const payload = response.payload as Array<{ title: string }>;
    expect(payload).toHaveLength(1);
    expect(payload[0]!.title).toBe('Run a marathon');

    // Verify in DB
    const dbGoals = drizzle(db).select().from(goals).all();
    expect(dbGoals).toHaveLength(1);
    expect(dbGoals[0]!.domain).toBe('body');
  });

  it('log-event writes and returns sync-status', async () => {
    const eventId = randomUUID();
    const response = await sendAndReceive(ws, {
      type: 'log-event',
      payload: {
        id: eventId,
        source: 'manual',
        sourceId: `manual_${eventId}`,
        domain: 'mind',
        eventType: 'note',
        timestamp: Date.now(),
        ingestedAt: Date.now(),
        payload: {
          domain: 'mind',
          subtype: 'mood-log',
        },
        embedding: null,
        summary: 'Feeling good today',
        privacyLevel: 'summarizable',
        confidence: 1,
      },
    });

    expect(response.type).toBe('sync-status');
    const payload = response.payload as { source: string; status: string };
    expect(payload.source).toBe('manual');
    expect(payload.status).toBe('logged');

    // Verify in DB
    const rows = drizzle(db).select().from(lifeEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe('Feeling good today');
  });

  it('update-config merges and writes config file', async () => {
    const response = await sendAndReceive(ws, {
      type: 'update-config',
      payload: {
        models: { localModel: 'llama3.2:1b', cloudEnabled: true },
      },
    });

    expect(response.type).toBe('sync-status');
    const payload = response.payload as { source: string; status: string };
    expect(payload.source).toBe('config');
    expect(payload.status).toBe('updated');

    // Read back the config file
    const saved = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const models = saved.models as { localModel: string; cloudEnabled: boolean };
    expect(models.localModel).toBe('llama3.2:1b');
    expect(models.cloudEnabled).toBe(true);
    // Original key should still be there (merge)
    expect(saved.adapters).toBeDefined();
  });

  it('export-data returns base64-encoded data', async () => {
    // Insert some events first
    const writer = createWriter(db, TEST_KEY);
    await writer.event({
      id: randomUUID(),
      source: 'manual',
      sourceId: 'export_test_001',
      domain: 'body',
      eventType: 'metric',
      timestamp: Date.now(),
      ingestedAt: Date.now(),
      payload: { domain: 'body', subtype: 'sleep' },
      embedding: null,
      summary: 'Sleep test',
      privacyLevel: 'cloud-safe',
      confidence: 1,
    });

    const requestId = randomUUID();
    const response = await sendAndReceive(ws, {
      type: 'export-data',
      requestId,
    });

    expect(response.type).toBe('query-result');
    expect(response.requestId).toBe(requestId);
    const payload = response.payload as { export: string; chunkIndex: number; totalChunks: number };
    expect(payload.chunkIndex).toBe(0);
    expect(payload.totalChunks).toBe(1);

    // Decode and verify
    const decoded = JSON.parse(Buffer.from(payload.export, 'base64').toString('utf-8')) as {
      events: unknown[];
      goals: unknown[];
    };
    expect(decoded.events).toHaveLength(1);
    expect(decoded.goals).toHaveLength(0);
  });

  it('query daily-summary returns a summary', async () => {
    const requestId = randomUUID();
    const response = await sendAndReceive(ws, {
      type: 'query',
      requestId,
      payload: { method: 'daily-summary' },
    });

    expect(response.type).toBe('query-result');
    expect(response.requestId).toBe(requestId);
    const payload = response.payload as { summary: string; date: string };
    expect(typeof payload.summary).toBe('string');
    expect(payload.summary.length).toBeGreaterThan(0);
    // Date should be YYYY-MM-DD format
    expect(payload.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('query stats returns event counts and db size', async () => {
    const requestId = randomUUID();
    const response = await sendAndReceive(ws, {
      type: 'query',
      requestId,
      payload: { method: 'stats' },
    });

    expect(response.type).toBe('query-result');
    const payload = response.payload as { totalEvents: number; dbSize: number };
    expect(typeof payload.totalEvents).toBe('number');
    expect(typeof payload.dbSize).toBe('number');
  });

  it('invalid message returns error', async () => {
    const response = await sendAndReceive(ws, {
      type: 'nonexistent-handler',
    });

    expect(response.type).toBe('error');
    expect(typeof response.error).toBe('string');
  });
});
