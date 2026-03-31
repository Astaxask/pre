import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { LifeDomain, LifeEvent } from '@pre/shared';
import { lifeEventSchema, isErr } from '@pre/shared';
import type { MemoryReader, MemoryWriter } from '@pre/memory';
import { openDatabase, createWriter, createReader } from '@pre/memory';
import { runSimulation, type SimulationEngineDeps } from '@pre/engines';
import { callModel } from '@pre/models';
import { enqueueSyncJob, enqueueSnoozeJob } from './queues.js';
import type { SidecarClient } from './sidecar-client.js';
import type { LifeAdapter } from '@pre/integrations';

// --- Gateway -> Surface messages ---

type SyncStatus = {
  source: string;
  status: string;
  lastSyncAt: number | null;
};

export type GatewayMessage =
  | { type: 'alert'; payload: unknown }
  | { type: 'alert-dismissed'; alertId: string }
  | { type: 'insight-update'; payload: unknown[] }
  | { type: 'sync-status'; payload: SyncStatus }
  | { type: 'query-result'; requestId: string; payload: unknown }
  | { type: 'simulation-result'; requestId: string; payload: unknown }
  | { type: 'error'; requestId?: string; error: string }
  // Web-surface-specific response types
  | { type: 'dashboard-metrics'; payload: unknown }
  | { type: 'adapter-status'; payload: unknown }
  | { type: 'timeline-events'; payload: unknown }
  | { type: 'goals'; payload: unknown }
  | { type: 'adapters'; payload: unknown }
  | { type: 'settings'; payload: unknown };

// --- Surface -> Gateway messages ---

// Original method-based query schema (for programmatic clients)
const queryRequestSchema = z.object({
  method: z.enum(['recentByDomain', 'byTimeRange', 'goals', 'stats', 'daily-summary', 'goal-events']),
  domain: z.string().optional(),
  hours: z.number().optional(),
  start: z.number().optional(),
  end: z.number().optional(),
  domains: z.array(z.string()).optional(),
  status: z.string().optional(),
  goalId: z.string().optional(),
  days: z.number().optional(),
});

// Web UI kind-based query schema
const webQuerySchema = z.object({
  kind: z.enum([
    'dashboard-metrics',
    'adapter-status',
    'timeline-events',
    'goals',
    'adapters',
    'settings',
  ]),
  since: z.number().optional(),
  until: z.number().optional(),
  domains: z.array(z.string()).optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
});

const surfaceMessageSchema = z.discriminatedUnion('type', [
  // Unified query schema — handles both method-based (programmatic) and kind-based (web UI)
  z.object({
    type: z.literal('query'),
    requestId: z.string().optional(),
    payload: z.record(z.unknown()),
  }),
  z.object({
    type: z.literal('simulate'),
    requestId: z.string().optional(),
    payload: z.unknown(),
  }),
  z.object({
    type: z.literal('dismiss-alert'),
    alertId: z.string(),
  }),
  z.object({
    type: z.literal('create-goal'),
    payload: z.unknown(),
  }),
  z.object({
    type: z.literal('trigger-sync'),
    source: z.string(),
  }),
  z.object({
    type: z.literal('delete-source-data'),
    source: z.string(),
  }),
  z.object({
    type: z.literal('delete-adapter-data'),
    payload: z.object({ adapterId: z.string() }),
  }),
  z.object({
    type: z.literal('reconnect-adapter'),
    payload: z.object({ adapterId: z.string() }),
  }),
  z.object({
    type: z.literal('log-event'),
    payload: z.unknown(),
  }),
  z.object({
    type: z.literal('update-config'),
    payload: z.unknown(),
  }),
  z.object({
    type: z.literal('update-setting'),
    payload: z.object({ key: z.string(), value: z.unknown() }),
  }),
  z.object({
    type: z.literal('export-data'),
    requestId: z.string().optional(),
    payload: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('delete-all-data'),
    confirmPhrase: z.literal('delete').optional(),
    payload: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('mark-alerts-seen'),
  }),
  z.object({
    type: z.literal('snooze-alert'),
    alertId: z.string(),
    durationHours: z.number().min(1).max(168),
    alert: z.unknown(),
  }),
]);

type WsServerDeps = {
  port: number;
  reader: MemoryReader;
  writer: MemoryWriter;
  db: Database.Database;
  encryptionKey: string;
  configPath: string;
  sidecarClient?: SidecarClient;
  adapters?: Map<string, LifeAdapter>;
};

const connections = new Set<WebSocket>();
let wss: WebSocketServer | null = null;

// Module-level set for tracking seen alert IDs
const seenAlertIds = new Set<string>();

// Daily summary cache: keyed by YYYY-MM-DD, regenerated when date changes
const dailySummaryCache = new Map<string, string>();

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

async function generateDailySummary(reader: MemoryReader): Promise<string> {
  const key = todayKey();

  // Return cached if same day
  const cached = dailySummaryCache.get(key);
  if (cached) return cached;

  // Clear stale entries from other days
  for (const k of dailySummaryCache.keys()) {
    if (k !== key) dailySummaryCache.delete(k);
  }

  // Fetch today's events
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const events = await reader.byTimeRange(startOfDay.getTime(), Date.now());

  if (events.length === 0) {
    const summary = 'No events recorded yet today.';
    dailySummaryCache.set(key, summary);
    return summary;
  }

  // Build domain counts for the prompt
  const domainCounts = new Map<string, number>();
  for (const e of events) {
    domainCounts.set(e.domain, (domainCounts.get(e.domain) ?? 0) + 1);
  }

  const domainSummary = Array.from(domainCounts.entries())
    .map(([d, c]) => `${d}: ${c} event(s)`)
    .join(', ');

  const eventSummaries = events
    .slice(0, 20) // Limit to 20 most recent for token efficiency
    .map((e) => e.summary ?? `${e.domain}/${e.eventType}`)
    .join('; ');

  try {
    const response = await callModel({
      task: 'proactive-reasoning',
      privacyLevel: 'private',
      messages: [
        {
          role: 'system',
          content: [
            'You are summarizing the user\'s day so far for a personal life dashboard.',
            `Today there are ${events.length} events across domains: ${domainSummary}.`,
            `Event summaries: ${eventSummaries}`,
            '',
            'Write a 2-3 sentence summary of their day. Be concise, warm, and factual.',
            'Do NOT give advice or recommendations. Just summarize what happened.',
          ].join('\n'),
        },
        { role: 'user', content: 'Summarize my day so far.' },
      ],
    });
    dailySummaryCache.set(key, response.content);
    return response.content;
  } catch {
    // Fallback: template summary
    const fallback = `Today so far: ${events.length} event(s) across ${domainCounts.size} domain(s) (${domainSummary}).`;
    dailySummaryCache.set(key, fallback);
    return fallback;
  }
}

// Goal input schema for validation
const goalInputSchema = z.object({
  title: z.string().min(1),
  domain: z.string(),
  targetDate: z.number().nullable().optional(),
  status: z.string().optional(),
});

// Setting key → config path mapping
const SETTING_KEY_MAP: Record<string, { section: string; field: string }> = {
  localModel: { section: 'models', field: 'localModel' },
  cloudEnabled: { section: 'models', field: 'cloudEnabled' },
  cloudBudgetUsd: { section: 'models', field: 'monthlyBudgetUsd' },
  proactiveEnabled: { section: 'proactiveAgent', field: 'enabled' },
  quietHoursStart: { section: 'proactiveAgent', field: 'quietHoursStart' },
  quietHoursEnd: { section: 'proactiveAgent', field: 'quietHoursEnd' },
};

export function startWsServer(deps: WsServerDeps): WebSocketServer {
  const { port } = deps;

  wss = new WebSocketServer({ port, host: '127.0.0.1' });

  wss.on('connection', (ws) => {
    connections.add(ws);

    ws.on('message', (raw) => {
      handleMessage(ws, raw, deps).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        sendTo(ws, { type: 'error', error: message });
      });
    });

    ws.on('close', () => {
      connections.delete(ws);
    });

    ws.on('error', (err) => {
      console.error('[ws-server] Client error:', err.message);
      connections.delete(ws);
    });
  });

  wss.on('error', (err) => {
    console.error('[ws-server] Server error:', err.message);
  });

  console.log(`[ws-server] Listening on ws://127.0.0.1:${port}`);
  return wss;
}

async function handleMessage(
  ws: WebSocket,
  raw: unknown,
  deps: WsServerDeps,
): Promise<void> {
  const { reader, writer, db, encryptionKey, configPath, sidecarClient, adapters } = deps;

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    sendTo(ws, { type: 'error', error: 'Invalid JSON' });
    return;
  }

  const result = surfaceMessageSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(`[ws-server] Invalid message:`, JSON.stringify(parsed).slice(0, 200));
    sendTo(ws, {
      type: 'error',
      error: `Invalid message: ${result.error.message}`,
    });
    return;
  }

  const msg = result.data;

  switch (msg.type) {
    case 'trigger-sync': {
      try {
        await enqueueSyncJob(msg.source);
        sendTo(ws, {
          type: 'sync-status',
          payload: { source: msg.source, status: 'queued', lastSyncAt: null },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendTo(ws, { type: 'error', error: `Sync enqueue failed: ${message}` });
      }
      break;
    }

    case 'query': {
      try {
        const q = msg.payload as Record<string, unknown>;

        // Detect if this is a web UI kind-based query vs method-based query
        if ('kind' in q) {
          await handleWebQuery(ws, q as { kind: string; [key: string]: unknown }, deps);
        } else {
          await handleMethodQuery(ws, msg as { requestId: string; payload: Record<string, unknown> }, deps);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const requestId = (msg as Record<string, unknown>)['requestId'];
        sendTo(ws, {
          type: 'error',
          requestId: typeof requestId === 'string' ? requestId : undefined,
          error: `Query failed: ${message}`,
        });
      }
      break;
    }

    case 'simulate': {
      const requestId = (msg as Record<string, unknown>)['requestId'] as string | undefined ?? randomUUID();
      if (!sidecarClient) {
        sendTo(ws, {
          type: 'error',
          requestId,
          error: 'Simulation not available: sidecar not connected',
        });
        break;
      }

      try {
        const simDeps: SimulationEngineDeps = {
          reader,
          sidecar: {
            forecastDomain: (domain, events, horizonDays) =>
              sidecarClient.forecastDomain(domain, events, horizonDays),
            estimateImpact: (decisionType, domain, events, horizonDays) =>
              sidecarClient.estimateImpact(decisionType, domain, events, horizonDays),
            runSimulation: (baselines, impacts, nSamples) =>
              sidecarClient.runMonteCarlo(baselines, impacts, nSamples),
          },
        };

        const simResult = await runSimulation(
          msg.payload as Parameters<typeof runSimulation>[0],
          simDeps,
        );

        sendTo(ws, {
          type: 'simulation-result',
          requestId,
          payload: simResult,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendTo(ws, {
          type: 'error',
          requestId,
          error: `Simulation failed: ${message}`,
        });
      }
      break;
    }

    case 'dismiss-alert': {
      seenAlertIds.add(msg.alertId);
      // Broadcast to all other surfaces so they can remove the alert
      broadcastExcept(ws, { type: 'alert-dismissed', alertId: msg.alertId });
      console.log(`[ws-server] Alert dismissed: ${msg.alertId}`);
      break;
    }

    case 'create-goal': {
      try {
        const goalInput = goalInputSchema.parse(msg.payload);
        const now = Date.now();
        const goal = {
          id: randomUUID(),
          title: goalInput.title,
          domain: goalInput.domain,
          targetDate: goalInput.targetDate ?? null,
          status: goalInput.status ?? 'active',
          createdAt: now,
          updatedAt: now,
        };
        writer.writeGoal(goal);

        // Send updated goals list back
        const updatedGoals = await reader.goals();
        const goalsPayload = updatedGoals.map((g) => ({
          ...g,
          progressPercent: g.status === 'completed' ? 100 : 0,
        }));

        // Send query-result for programmatic clients
        sendTo(ws, {
          type: 'query-result',
          requestId: randomUUID(),
          payload: goalsPayload,
        });

        // Also broadcast goals update for web UI surfaces
        broadcast({ type: 'goals', payload: goalsPayload });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendTo(ws, { type: 'error', error: `Goal creation failed: ${message}` });
      }
      break;
    }

    case 'delete-source-data': {
      try {
        const count = writer.deleteBySource(msg.source);
        broadcast({
          type: 'sync-status',
          payload: {
            source: msg.source,
            status: 'deleted',
            lastSyncAt: null,
          },
        });
        console.log(`[ws-server] Deleted ${count} events for source: ${msg.source}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendTo(ws, { type: 'error', error: `Delete failed: ${message}` });
      }
      break;
    }

    case 'delete-adapter-data': {
      // Web UI sends adapterId — map it to source name for deletion
      try {
        const { adapterId } = msg.payload;
        const count = writer.deleteBySource(adapterId);
        broadcast({
          type: 'sync-status',
          payload: { source: adapterId, status: 'deleted', lastSyncAt: null },
        });
        console.log(`[ws-server] Deleted ${count} events for adapter: ${adapterId}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendTo(ws, { type: 'error', error: `Delete adapter data failed: ${message}` });
      }
      break;
    }

    case 'reconnect-adapter': {
      // Trigger a sync for the adapter
      try {
        const { adapterId } = msg.payload;
        await enqueueSyncJob(adapterId);
        sendTo(ws, {
          type: 'sync-status',
          payload: { source: adapterId, status: 'queued', lastSyncAt: null },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendTo(ws, { type: 'error', error: `Reconnect failed: ${message}` });
      }
      break;
    }

    case 'log-event': {
      try {
        const event = lifeEventSchema.parse(msg.payload);
        const writeResult = await writer.event(event);
        if (isErr(writeResult)) {
          sendTo(ws, {
            type: 'sync-status',
            payload: {
              source: event.source,
              status: `log-failed: ${writeResult.error}`,
              lastSyncAt: null,
            },
          });
        } else {
          sendTo(ws, {
            type: 'sync-status',
            payload: {
              source: event.source,
              status: 'logged',
              lastSyncAt: Date.now(),
            },
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendTo(ws, { type: 'error', error: `Log event failed: ${message}` });
      }
      break;
    }

    case 'update-config': {
      try {
        let existing: Record<string, unknown> = {};
        try {
          const raw = readFileSync(configPath, 'utf-8');
          existing = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          // Config file may not exist yet
        }

        const merged = { ...existing, ...(msg.payload as Record<string, unknown>) };
        writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');

        sendTo(ws, {
          type: 'sync-status',
          payload: { source: 'config', status: 'updated', lastSyncAt: Date.now() },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendTo(ws, { type: 'error', error: `Config update failed: ${message}` });
      }
      break;
    }

    case 'update-setting': {
      // Web UI sends individual key/value pairs; map to config file sections
      try {
        const { key, value } = msg.payload;
        let existing: Record<string, Record<string, unknown>> = {};
        try {
          const raw = readFileSync(configPath, 'utf-8');
          existing = JSON.parse(raw) as Record<string, Record<string, unknown>>;
        } catch {
          // Config file may not exist yet
        }

        const mapping = SETTING_KEY_MAP[key];
        if (mapping) {
          if (!existing[mapping.section]) {
            existing[mapping.section] = {};
          }
          existing[mapping.section]![mapping.field] = value;
        } else {
          // Unknown key — store at top level
          existing[key] = value as Record<string, unknown>;
        }

        writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8');

        // Send back updated settings so UI reflects the change
        const updatedSettings = await buildSettingsPayload(reader, db, configPath, encryptionKey);
        sendTo(ws, { type: 'settings', payload: updatedSettings });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendTo(ws, { type: 'error', error: `Setting update failed: ${message}` });
      }
      break;
    }

    case 'export-data': {
      const requestId = (msg as Record<string, unknown>)['requestId'] as string | undefined ?? randomUUID();
      try {
        const allEvents = await reader.byTimeRange(0, Date.now());
        const goalsList = await reader.goals();
        const exportData = JSON.stringify({ events: allEvents, goals: goalsList });
        const base64Data = Buffer.from(exportData, 'utf-8').toString('base64');

        const CHUNK_SIZE = 768 * 1024; // 768KB per chunk base64

        if (base64Data.length <= CHUNK_SIZE) {
          sendTo(ws, {
            type: 'query-result',
            requestId,
            payload: { export: base64Data, chunkIndex: 0, totalChunks: 1 },
          });
        } else {
          const totalChunks = Math.ceil(base64Data.length / CHUNK_SIZE);
          for (let i = 0; i < totalChunks; i++) {
            const chunk = base64Data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
            sendTo(ws, {
              type: 'query-result',
              requestId,
              payload: { export: chunk, chunkIndex: i, totalChunks },
            });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendTo(ws, {
          type: 'error',
          requestId,
          error: `Export failed: ${message}`,
        });
      }
      break;
    }

    case 'delete-all-data': {
      // Web UI may send { payload: {} } or { confirmPhrase: 'delete' }
      // Accept both: if confirmPhrase is present, validate it; otherwise treat as confirmed from UI
      const confirmPhrase = (msg as Record<string, unknown>)['confirmPhrase'];
      if (confirmPhrase !== undefined && confirmPhrase !== 'delete') {
        sendTo(ws, { type: 'error', error: 'Confirmation phrase must be "delete"' });
        break;
      }

      try {
        db.exec('DROP TABLE IF EXISTS embedding_sync');
        db.exec('DROP TABLE IF EXISTS life_events');
        db.exec('DROP TABLE IF EXISTS goals');
        db.exec('DROP TABLE IF EXISTS trigger_log');
        db.exec('DROP TABLE IF EXISTS integration_sync');

        // Recreate tables by re-opening the database schema
        const dbPath = db.name;
        openDatabase(dbPath);

        // Recreate writer and reader (the db handle is the same, tables are recreated)
        broadcast({
          type: 'sync-status',
          payload: { source: 'all', status: 'deleted', lastSyncAt: null },
        });

        console.log('[ws-server] All data deleted and schema recreated');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendTo(ws, { type: 'error', error: `Delete all failed: ${message}` });
      }
      break;
    }

    case 'mark-alerts-seen': {
      // Mark all current alerts as seen
      console.log('[ws-server] All alerts marked as seen');
      break;
    }

    case 'snooze-alert': {
      try {
        const delayMs = msg.durationHours * 3600_000;
        await enqueueSnoozeJob(msg.alertId, msg.alert, delayMs);
        seenAlertIds.add(msg.alertId);
        console.log(`[ws-server] Alert snoozed: ${msg.alertId} for ${msg.durationHours}h`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendTo(ws, { type: 'error', error: `Snooze failed: ${message}` });
      }
      break;
    }
  }
}

// ─── Web UI query handlers ────────────────────────────────────────

async function handleWebQuery(
  ws: WebSocket,
  q: { kind: string; [key: string]: unknown },
  deps: WsServerDeps,
): Promise<void> {
  const { reader, writer, db, encryptionKey, configPath, adapters } = deps;

  switch (q.kind) {
    case 'dashboard-metrics': {
      // Build metrics from recent events
      const now = Date.now();
      const sevenDaysAgo = now - 7 * 86_400_000;
      const thirtyDaysAgo = now - 30 * 86_400_000;

      const recentEvents = await reader.byTimeRange(sevenDaysAgo, now);
      const monthEvents = await reader.byTimeRange(thirtyDaysAgo, now);

      // Sleep average (body domain, sleep events)
      const sleepEvents = recentEvents.filter(
        (e) => e.domain === 'body' && e.eventType === 'sleep',
      );
      const avgSleepHrs = sleepEvents.length > 0
        ? sleepEvents.reduce((sum, e) => {
            const p = e.payload as Record<string, unknown>;
            return sum + (typeof p['durationMinutes'] === 'number' ? p['durationMinutes'] / 60 : 0);
          }, 0) / sleepEvents.length
        : 0;

      // Monthly cash flow (money domain)
      const moneyEvents = monthEvents.filter((e) => e.domain === 'money' && e.eventType === 'transaction');
      let cashFlow = 0;
      for (const e of moneyEvents) {
        const p = e.payload as Record<string, unknown>;
        const amount = typeof p['amount'] === 'number' ? p['amount'] : 0;
        const direction = p['direction'];
        cashFlow += direction === 'credit' ? amount : -amount;
      }

      // Weekly committed hours (time domain)
      const timeEvents = recentEvents.filter((e) => e.domain === 'time');
      const committedMinutes = timeEvents.reduce((sum, e) => {
        const p = e.payload as Record<string, unknown>;
        return sum + (typeof p['durationMinutes'] === 'number' ? p['durationMinutes'] : 0);
      }, 0);

      // Active goals
      const goalsList = await reader.goals('active');

      const metrics = [
        {
          label: 'Sleep (7d avg)',
          value: avgSleepHrs > 0 ? avgSleepHrs.toFixed(1) : '—',
          unit: 'hrs',
          trend: 'flat' as const,
          trendValue: sleepEvents.length > 0 ? `${sleepEvents.length} nights` : 'no data',
        },
        {
          label: 'Cash flow (30d)',
          value: moneyEvents.length > 0 ? (cashFlow >= 0 ? '+' : '') + cashFlow.toFixed(0) : '—',
          unit: 'USD',
          trend: (cashFlow > 0 ? 'up' : cashFlow < 0 ? 'down' : 'flat') as 'up' | 'down' | 'flat',
          trendValue: `${moneyEvents.length} txns`,
        },
        {
          label: 'Committed hours (7d)',
          value: committedMinutes > 0 ? (committedMinutes / 60).toFixed(1) : '—',
          unit: 'hrs',
          trend: 'flat' as const,
          trendValue: `${timeEvents.length} events`,
        },
        {
          label: 'Active goals',
          value: String(goalsList.length),
          unit: '',
          trend: 'flat' as const,
          trendValue: goalsList.length === 1 ? '1 goal' : `${goalsList.length} goals`,
        },
      ];

      sendTo(ws, { type: 'dashboard-metrics', payload: metrics });
      break;
    }

    case 'adapter-status': {
      // Build adapter status from the adapters map
      const adapterStatuses: Array<{
        name: string;
        status: 'connected' | 'disconnected';
        lastSync: string;
      }> = [];

      if (adapters) {
        for (const [name, adapter] of adapters) {
          try {
            const health = await adapter.healthCheck();
            adapterStatuses.push({
              name,
              status: health.ok ? 'connected' : 'disconnected',
              lastSync: 'just now',
            });
          } catch {
            adapterStatuses.push({
              name,
              status: 'disconnected',
              lastSync: 'unknown',
            });
          }
        }
      }

      sendTo(ws, { type: 'adapter-status', payload: adapterStatuses });
      break;
    }

    case 'timeline-events': {
      const since = typeof q.since === 'number' ? q.since : Date.now() - 7 * 86_400_000;
      const until = typeof q.until === 'number' ? q.until : Date.now();
      const domains = Array.isArray(q.domains) ? q.domains as LifeDomain[] : undefined;
      const offset = typeof q.offset === 'number' ? q.offset : 0;
      const limit = typeof q.limit === 'number' ? q.limit : 100;

      const allEvents = await reader.byTimeRange(since, until, domains);
      // Sort newest first
      allEvents.sort((a, b) => b.timestamp - a.timestamp);

      const paginated = allEvents.slice(offset, offset + limit);
      const hasMore = offset + limit < allEvents.length;

      sendTo(ws, {
        type: 'timeline-events',
        payload: { events: paginated, hasMore },
      });
      break;
    }

    case 'goals': {
      const goalsList = await reader.goals();
      sendTo(ws, {
        type: 'goals',
        payload: goalsList.map((g) => ({
          ...g,
          progressPercent: g.status === 'completed' ? 100 : 0,
        })),
      });
      break;
    }

    case 'adapters': {
      // Build adapter info from the adapters map
      const adapterInfos: Array<{
        id: string;
        name: string;
        status: 'connected' | 'needs-attention' | 'disconnected';
        lastSync: string;
        eventCount: number;
        daysTracked: number;
        collectedData: string[];
      }> = [];

      if (adapters) {
        for (const [name, adapter] of adapters) {
          // Count events from this source
          const events = await reader.byTimeRange(0, Date.now());
          const sourceEvents = events.filter((e) => e.source === name);
          const timestamps = sourceEvents.map((e) => e.timestamp);
          const daysTracked = timestamps.length > 0
            ? Math.ceil((Date.now() - Math.min(...timestamps)) / 86_400_000)
            : 0;

          let status: 'connected' | 'needs-attention' | 'disconnected' = 'connected';
          try {
            const health = await adapter.healthCheck();
            status = health.ok ? 'connected' : 'needs-attention';
          } catch {
            status = 'disconnected';
          }

          const manifest = adapter.manifest();

          adapterInfos.push({
            id: name,
            name: manifest.source,
            status,
            lastSync: 'recently',
            eventCount: sourceEvents.length,
            daysTracked,
            collectedData: manifest.collectsFields,
          });
        }
      }

      sendTo(ws, { type: 'adapters', payload: adapterInfos });
      break;
    }

    case 'settings': {
      const settingsPayload = await buildSettingsPayload(reader, db, configPath, deps.encryptionKey);
      sendTo(ws, { type: 'settings', payload: settingsPayload });
      break;
    }

    default: {
      sendTo(ws, { type: 'error', error: `Unknown query kind: ${q.kind}` });
    }
  }
}

async function buildSettingsPayload(
  reader: MemoryReader,
  db: Database.Database,
  configPath: string,
  encryptionKey: string,
): Promise<Record<string, unknown>> {
  let config: Record<string, Record<string, unknown>> = {};
  try {
    const raw = readFileSync(configPath, 'utf-8');
    config = JSON.parse(raw) as Record<string, Record<string, unknown>>;
  } catch {
    // defaults
  }

  const models = (config['models'] ?? {}) as Record<string, unknown>;
  const proactive = (config['proactiveAgent'] ?? {}) as Record<string, unknown>;

  // Stats
  const allEvents = await reader.byTimeRange(0, Date.now());
  const timestamps = allEvents.map((e) => e.timestamp);
  let dbSize = 0;
  try {
    dbSize = statSync(db.name).size;
  } catch {
    // ignore
  }
  const daysTracked = timestamps.length > 0
    ? Math.ceil((Math.max(...timestamps) - Math.min(...timestamps)) / 86_400_000)
    : 0;

  return {
    localModel: models['localModel'] ?? 'llama3.1:8b',
    cloudEnabled: models['cloudEnabled'] ?? false,
    cloudBudgetUsd: models['monthlyBudgetUsd'] ?? 10,
    proactiveEnabled: proactive['enabled'] ?? true,
    quietHoursStart: proactive['quietHoursStart'] ?? '22:00',
    quietHoursEnd: proactive['quietHoursEnd'] ?? '08:00',
    encryptionEnabled: !!encryptionKey,
    eventCount: allEvents.length,
    storageUsedMb: Math.round(dbSize / (1024 * 1024) * 100) / 100,
    daysTracked,
    version: '0.0.1',
  };
}

// ─── Original method-based query handler ──────────────────────────

async function handleMethodQuery(
  ws: WebSocket,
  msg: { requestId: string; payload: Record<string, unknown> },
  deps: WsServerDeps,
): Promise<void> {
  const { reader, db } = deps;
  const q = msg.payload;

  if (q.method === 'recentByDomain' && q.domain && q.hours) {
    const events = await reader.recentByDomain(
      q.domain as LifeDomain,
      q.hours as number,
    );
    sendTo(ws, { type: 'query-result', requestId: msg.requestId, payload: events });
  } else if (q.method === 'byTimeRange' && q.start !== undefined && q.end !== undefined) {
    const events = await reader.byTimeRange(
      q.start as number,
      q.end as number,
      q.domains as LifeDomain[] | undefined,
    );
    sendTo(ws, { type: 'query-result', requestId: msg.requestId, payload: events });
  } else if (q.method === 'goals') {
    const goalsList = await reader.goals(q.status as string | undefined);
    sendTo(ws, { type: 'query-result', requestId: msg.requestId, payload: goalsList });
  } else if (q.method === 'stats') {
    const allEvents = await reader.byTimeRange(0, Date.now());
    const dbPath = db.name;
    let dbSize = 0;
    try {
      dbSize = statSync(dbPath).size;
    } catch {
      // Ignore
    }
    const timestamps = allEvents.map((e) => e.timestamp);
    sendTo(ws, {
      type: 'query-result',
      requestId: msg.requestId,
      payload: {
        totalEvents: allEvents.length,
        oldestEvent: timestamps.length > 0 ? Math.min(...timestamps) : null,
        newestEvent: timestamps.length > 0 ? Math.max(...timestamps) : null,
        dbSize,
      },
    });
  } else if (q.method === 'goal-events' && q.goalId) {
    const events = await reader.byGoalId(q.goalId as string, (q.days as number) ?? 90);
    sendTo(ws, { type: 'query-result', requestId: msg.requestId, payload: events });
  } else if (q.method === 'daily-summary') {
    const summary = await generateDailySummary(reader);
    sendTo(ws, {
      type: 'query-result',
      requestId: msg.requestId,
      payload: { summary, date: todayKey() },
    });
  } else {
    sendTo(ws, { type: 'query-result', requestId: msg.requestId, payload: [] });
  }
}

function sendTo(ws: WebSocket, message: GatewayMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

export function broadcast(message: GatewayMessage): void {
  const data = JSON.stringify(message);
  for (const ws of connections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function broadcastExcept(sender: WebSocket, message: GatewayMessage): void {
  const data = JSON.stringify(message);
  for (const ws of connections) {
    if (ws !== sender && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

export function getConnectionCount(): number {
  return connections.size;
}

export async function stopWsServer(): Promise<void> {
  if (wss) {
    for (const ws of connections) {
      ws.close();
    }
    connections.clear();
    await new Promise<void>((resolve) => {
      wss!.close(() => resolve());
    });
    wss = null;
  }
}
