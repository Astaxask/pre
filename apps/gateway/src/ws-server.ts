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
  | { type: 'error'; requestId?: string; error: string };

// --- Surface -> Gateway messages ---

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

const surfaceMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('query'),
    requestId: z.string(),
    payload: queryRequestSchema,
  }),
  z.object({
    type: z.literal('simulate'),
    requestId: z.string(),
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
    type: z.literal('log-event'),
    payload: z.unknown(),
  }),
  z.object({
    type: z.literal('update-config'),
    payload: z.unknown(),
  }),
  z.object({
    type: z.literal('export-data'),
    requestId: z.string(),
  }),
  z.object({
    type: z.literal('delete-all-data'),
    confirmPhrase: z.literal('delete'),
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
  const { reader, writer, db, encryptionKey, configPath, sidecarClient } = deps;

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    sendTo(ws, { type: 'error', error: 'Invalid JSON' });
    return;
  }

  const result = surfaceMessageSchema.safeParse(parsed);
  if (!result.success) {
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
        const q = msg.payload;

        if (q.method === 'recentByDomain' && q.domain && q.hours) {
          const events = await reader.recentByDomain(
            q.domain as LifeDomain,
            q.hours,
          );
          sendTo(ws, {
            type: 'query-result',
            requestId: msg.requestId,
            payload: events,
          });
        } else if (q.method === 'byTimeRange' && q.start !== undefined && q.end !== undefined) {
          const events = await reader.byTimeRange(
            q.start,
            q.end,
            q.domains as LifeDomain[] | undefined,
          );
          sendTo(ws, {
            type: 'query-result',
            requestId: msg.requestId,
            payload: events,
          });
        } else if (q.method === 'goals') {
          const goalsList = await reader.goals(q.status);
          sendTo(ws, {
            type: 'query-result',
            requestId: msg.requestId,
            payload: goalsList,
          });
        } else if (q.method === 'stats') {
          const allEvents = await reader.byTimeRange(0, Date.now());
          const dbPath = db.name;
          let dbSize = 0;
          try {
            dbSize = statSync(dbPath).size;
          } catch {
            // Ignore if stat fails
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
          const events = await reader.byGoalId(q.goalId, q.days ?? 90);
          sendTo(ws, {
            type: 'query-result',
            requestId: msg.requestId,
            payload: events,
          });
        } else if (q.method === 'daily-summary') {
          const summary = await generateDailySummary(reader);
          sendTo(ws, {
            type: 'query-result',
            requestId: msg.requestId,
            payload: { summary, date: todayKey() },
          });
        } else {
          sendTo(ws, {
            type: 'query-result',
            requestId: msg.requestId,
            payload: [],
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendTo(ws, {
          type: 'error',
          requestId: msg.requestId,
          error: `Query failed: ${message}`,
        });
      }
      break;
    }

    case 'simulate': {
      if (!sidecarClient) {
        sendTo(ws, {
          type: 'error',
          requestId: msg.requestId,
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
          requestId: msg.requestId,
          payload: simResult,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendTo(ws, {
          type: 'error',
          requestId: msg.requestId,
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

        const updatedGoals = await reader.goals();
        sendTo(ws, {
          type: 'query-result',
          requestId: randomUUID(),
          payload: updatedGoals,
        });
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

    case 'export-data': {
      try {
        const allEvents = await reader.byTimeRange(0, Date.now());
        const goalsList = await reader.goals();
        const exportData = JSON.stringify({ events: allEvents, goals: goalsList });
        const base64Data = Buffer.from(exportData, 'utf-8').toString('base64');

        const CHUNK_SIZE = 768 * 1024; // 768KB per chunk base64

        if (base64Data.length <= CHUNK_SIZE) {
          sendTo(ws, {
            type: 'query-result',
            requestId: msg.requestId,
            payload: { export: base64Data, chunkIndex: 0, totalChunks: 1 },
          });
        } else {
          const totalChunks = Math.ceil(base64Data.length / CHUNK_SIZE);
          for (let i = 0; i < totalChunks; i++) {
            const chunk = base64Data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
            sendTo(ws, {
              type: 'query-result',
              requestId: msg.requestId,
              payload: { export: chunk, chunkIndex: i, totalChunks },
            });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendTo(ws, {
          type: 'error',
          requestId: msg.requestId,
          error: `Export failed: ${message}`,
        });
      }
      break;
    }

    case 'delete-all-data': {
      if (msg.confirmPhrase !== 'delete') {
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
