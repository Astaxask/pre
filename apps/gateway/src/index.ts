import { config } from "dotenv";
import { resolve as dotenvResolve } from "path";
config({ path: dotenvResolve(process.cwd(), "../../.env") });
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Redis as IORedis, type RedisOptions } from 'ioredis';
import { openDatabase, createWriter, createReader } from '@pre/memory';
import { PlaidAdapter, GoogleCalendarAdapter } from '@pre/integrations';
import { configureRouter } from '@pre/models';
import type { LifeAdapter } from '@pre/integrations';
import { EventBus } from './event-bus.js';
import { loadConfig, getDataDir } from './config.js';
import { initQueues, closeQueues } from './queues.js';
import { startSyncWorker } from './workers/sync-worker.js';
import { startEmbedWorker } from './workers/embed-worker.js';
import { SidecarClient } from './sidecar-client.js';
import * as scheduler from './scheduler.js';
import { startWsServer, stopWsServer, broadcast } from './ws-server.js';
import { getConfigPath } from './config.js';
import { startInsightWorker } from './workers/insight-worker.js';
import { enqueueInferenceJob } from './queues.js';

async function main(): Promise<void> {
  console.log('[PRE Gateway] Starting...');

  // Step 1: Load and validate config + encryption key
  const encryptionKey = process.env['PRE_ENCRYPTION_KEY'];
  if (!encryptionKey) {
    console.error(
      '[PRE Gateway] PRE_ENCRYPTION_KEY is required. Generate one with: openssl rand -hex 32',
    );
    process.exit(1);
  }

  const config = loadConfig();
  const dataDir = getDataDir();

  // Step 2: Connect to SQLite (create tables if needed)
  const dbPath = process.env['PRE_DB_PATH'] ?? join(dataDir, 'pre.db');
  const db = openDatabase(dbPath);
  const writer = createWriter(db, encryptionKey);
  const reader = createReader(db, encryptionKey);
  console.log(`[PRE Gateway] SQLite connected: ${dbPath}`);

  // Step 3: Connect to LanceDB (via sidecar — path passed as env var)
  const lancedbPath = process.env['PRE_LANCEDB_PATH'] ?? join(dataDir, 'lancedb');
  console.log(`[PRE Gateway] LanceDB path: ${lancedbPath}`);

  // Step 4: Verify Redis is reachable
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const redisOpts: RedisOptions = { maxRetriesPerRequest: null };
  if (redisUrl !== 'redis://localhost:6379') {
    const url = new URL(redisUrl);
    redisOpts.host = url.hostname;
    redisOpts.port = Number(url.port) || 6379;
  }

  const redis = new IORedis(redisOpts);
  try {
    await redis.ping();
    console.log('[PRE Gateway] Redis connected');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[PRE Gateway] Redis not reachable: ${message}`);
    console.error(
      '[PRE Gateway] Start Redis with: brew services start redis (macOS) or docker run -d -p 6379:6379 redis:alpine',
    );
    process.exit(1);
  } finally {
    await redis.quit();
  }

  // Step 5: Start BullMQ queues and workers
  const bus = new EventBus();
  const { syncQueue, embedQueue, inferenceQueue } = initQueues(redisOpts);

  const adapters = new Map<string, LifeAdapter>();

  // Step 6: Spawn Python sidecar
  let sidecarProcess: ChildProcess | null = null;
  const sidecarClient = new SidecarClient();
  let sidecarReady = false;

  // Resolve project root from compiled output (dist/) or source (src/) — both are 3 levels deep
  const projectRoot = resolve(import.meta.dirname, '..', '..', '..');
  const sidecarScript = resolve(projectRoot, 'sidecar', 'main.py');
  const sidecarVenvPython = resolve(projectRoot, 'sidecar', '.venv', 'bin', 'python3');
  const sidecarCwd = resolve(projectRoot, 'sidecar');

  if (!existsSync(sidecarScript)) {
    console.warn('[PRE Gateway] Sidecar script not found, skipping');
  } else {
    let sidecarPython: string;
    if (existsSync(sidecarVenvPython)) {
      sidecarPython = sidecarVenvPython;
    } else {
      console.warn(
        '[PRE Gateway] Sidecar venv not found at:', sidecarVenvPython,
        '\nRun: cd sidecar && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt',
      );
      sidecarPython = 'python3';
    }

    try {
      sidecarProcess = spawn(sidecarPython, [sidecarScript], {
        cwd: sidecarCwd,
        env: {
          ...process.env,
          PRE_LANCEDB_PATH: lancedbPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      sidecarProcess.stdout?.on('data', (d: Buffer) => {
        console.log('[sidecar]', d.toString().trim());
      });
      sidecarProcess.stderr?.on('data', (d: Buffer) => {
        console.error('[sidecar]', d.toString().trim());
      });

      sidecarProcess.on('error', (err) => {
        console.error(`[PRE Gateway] Sidecar process error: ${err.message}`);
      });

      sidecarProcess.on('exit', (code) => {
        if (code !== 0) console.error(`[PRE Gateway] Sidecar exited with code ${code}`);
        sidecarProcess = null;
      });

      // Wait up to 30 seconds for sidecar to be ready (sentence_transformers is slow to load)
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        sidecarReady = await sidecarClient.isReady();
        if (sidecarReady) break;
      }

      if (sidecarReady) {
        console.log('[PRE Gateway] Sidecar connected and ready');
      } else {
        console.warn('[PRE Gateway] Sidecar not ready yet — will retry before status summary');
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[PRE Gateway] Failed to spawn sidecar: ${message}`);
    }
  }

  // Configure the model router
  configureRouter({
    localModel: config.models.localModel,
    cloudEnabled: config.models.cloudEnabled,
    monthlyBudgetUsd: config.models.monthlyBudgetUsd,
    anthropicApiKey: process.env['ANTHROPIC_API_KEY'],
  });

  const syncWorker = startSyncWorker({
    db,
    masterKey: encryptionKey,
    adapters,
    bus,
    redisOpts,
  });

  const embedWorker = startEmbedWorker({
    db,
    sidecarClient,
    redisOpts,
  });

  const insightWorker = startInsightWorker({
    reader,
    writer,
    sidecarClient,
    bus,
    redisOpts,
  });
  console.log('[PRE Gateway] BullMQ workers started (sync, embed, insight)');

  // Step 7: Initialize configured adapters and run healthCheck()
  const failedAdapters: Array<{ source: string; error: string }> = [];

  const adapterFactories: Array<{ name: string; create: () => LifeAdapter | null }> = [
    {
      name: 'plaid',
      create: () => {
        if (!config.adapters.plaid.enabled) return null;
        const plaidClientId = process.env['PLAID_CLIENT_ID'];
        const plaidSecret = process.env['PLAID_SECRET'];
        const plaidAccessToken = process.env['PLAID_ACCESS_TOKEN'];
        const plaidEnv = (process.env['PLAID_ENV'] ?? 'sandbox') as 'sandbox' | 'production';
        if (!plaidClientId || !plaidSecret || !plaidAccessToken) {
          console.warn('[adapter] ✗ plaid: missing env vars (PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ACCESS_TOKEN)');
          return null;
        }
        return new PlaidAdapter({
          clientId: plaidClientId,
          secret: plaidSecret,
          accessToken: plaidAccessToken,
          environment: plaidEnv,
        });
      },
    },
    {
      name: 'google-calendar',
      create: () => {
        if (!config.adapters['google-calendar'].enabled) return null;
        const googleClientId = process.env['GOOGLE_CLIENT_ID'];
        const googleClientSecret = process.env['GOOGLE_CLIENT_SECRET'];
        let refreshToken = process.env['GOOGLE_REFRESH_TOKEN'];
        if (!refreshToken) {
          try {
            const tokenPath = join(homedir(), '.pre', 'google-tokens.json');
            if (existsSync(tokenPath)) {
              const tokens = JSON.parse(readFileSync(tokenPath, 'utf-8')) as { refresh_token?: string };
              refreshToken = tokens.refresh_token;
            }
          } catch {
            // Token file not readable
          }
        }
        if (!googleClientId || !googleClientSecret) {
          console.warn('[adapter] ✗ google-calendar: missing env vars (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)');
          return null;
        }
        if (!refreshToken) {
          failedAdapters.push({ source: 'google-calendar', error: 'Google Calendar not authorized. Run: pnpm setup:google' });
          console.warn('[adapter] ✗ google-calendar: not authorized. Run: pnpm setup:google');
          return null;
        }
        return new GoogleCalendarAdapter({
          clientId: googleClientId,
          clientSecret: googleClientSecret,
          refreshToken,
        });
      },
    },
  ];

  for (const entry of adapterFactories) {
    const adapter = entry.create();
    if (!adapter) continue;

    try {
      const health = await adapter.healthCheck();
      if (health.ok) {
        adapters.set(entry.name, adapter);
        console.log(`[adapter] ✓ ${entry.name} initialized`);
      } else {
        failedAdapters.push({ source: entry.name, error: health.error ?? 'unknown' });
        console.warn(`[adapter] ✗ ${entry.name} healthCheck failed: ${health.error}`);
        console.warn(`[adapter]   This adapter will not sync until the issue is resolved.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failedAdapters.push({ source: entry.name, error: message });
      console.error(`[adapter] ✗ ${entry.name} threw during healthCheck:`, message);
    }
  }

  console.log(
    `[PRE Gateway] ${adapters.size} adapter(s) initialized`,
  );

  // Step 8: Register cron jobs
  scheduler.start(config);

  // Step 9: Start WebSocket server
  const wsPort = Number(process.env['PRE_GATEWAY_PORT']) || 18789;
  startWsServer({
    port: wsPort,
    reader,
    writer,
    db,
    encryptionKey,
    configPath: getConfigPath(),
    sidecarClient,
    adapters,
  });

  // Wire event bus to broadcast sync status updates to connected surfaces
  bus.on('sync-completed', (payload) => {
    broadcast({
      type: 'sync-status',
      payload: {
        source: payload.source,
        status: 'completed',
        lastSyncAt: Date.now(),
      },
    });

    // Trigger inference after a successful sync
    enqueueInferenceJob('post-sync').catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[PRE Gateway] Failed to enqueue post-sync inference: ${message}`);
    });
  });

  bus.on('sync-failed', (payload) => {
    broadcast({
      type: 'sync-status',
      payload: {
        source: payload.source,
        status: 'error',
        lastSyncAt: null,
      },
    });
  });

  bus.on('adapter-needs-reauth', (payload) => {
    broadcast({
      type: 'sync-status',
      payload: {
        source: payload.source,
        status: 'needs-reauth',
        lastSyncAt: null,
      },
    });
  });

  // Wire alert-fired to broadcast to surfaces
  bus.on('alert-fired', (payload) => {
    broadcast({
      type: 'alert',
      payload,
    });
  });

  // Wire insight-generated to broadcast to surfaces
  bus.on('insight-generated', (payload) => {
    broadcast({
      type: 'insight-update',
      payload: [payload],
    });
  });

  // Step 10: Emit ready
  bus.emit('gateway-ready', { timestamp: Date.now() });

  // Final sidecar retry — it may have started while adapters were initializing
  if (!sidecarReady) {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      sidecarReady = await sidecarClient.isReady();
      if (sidecarReady) {
        console.log('[PRE Gateway] Sidecar connected and ready (late start)');
        break;
      }
    }
  }

  console.log('\n── PRE Gateway Status ──────────────────');
  console.log(`  SQLite:    ✓ connected`);
  console.log(`  Redis:     ✓ connected`);
  console.log(`  Sidecar:   ${sidecarReady ? '✓ ready' : '✗ unavailable'}`);
  console.log(`  Adapters:  ${adapters.size} active`);
  for (const [source] of adapters) {
    console.log(`    ✓ ${source}`);
  }
  for (const { source, error } of failedAdapters) {
    console.log(`    ✗ ${source}: ${error}`);
  }
  console.log(`  Gateway:   ws://127.0.0.1:${wsPort}`);
  console.log('────────────────────────────────────────\n');

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log('[PRE Gateway] Shutting down...');
    scheduler.stop();
    await stopWsServer();
    await syncWorker.close();
    await embedWorker.close();
    await insightWorker.close();
    await closeQueues();
    sidecarClient.close();
    if (sidecarProcess) {
      sidecarProcess.kill('SIGTERM');
    }
    db.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error('[PRE Gateway] Fatal error:', err);
  process.exit(1);
});
