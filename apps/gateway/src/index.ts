import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Redis as IORedis, type RedisOptions } from 'ioredis';
import { openDatabase, createWriter, createReader } from '@pre/memory';
import { PlaidAdapter } from '@pre/integrations';
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

  const sidecarPythonPath = join(dataDir, '..', 'development', 'pre', 'sidecar', '.venv', 'bin', 'python3');
  const sidecarMainPath = join(dataDir, '..', 'development', 'pre', 'sidecar', 'main.py');

  // Try to find the sidecar relative to the gateway
  const possibleSidecarPaths = [
    join(process.cwd(), '..', '..', 'sidecar', 'main.py'),
    join(process.cwd(), 'sidecar', 'main.py'),
  ];

  let sidecarScript: string | null = null;
  for (const p of possibleSidecarPaths) {
    try {
      const { accessSync } = await import('node:fs');
      accessSync(p);
      sidecarScript = p;
      break;
    } catch {
      // Not found, try next
    }
  }

  if (sidecarScript) {
    try {
      sidecarProcess = spawn('python3', [sidecarScript], {
        env: {
          ...process.env,
          PRE_LANCEDB_PATH: lancedbPath,
        },
        stdio: ['ignore', 'ignore', 'inherit'],
      });

      sidecarProcess.on('error', (err) => {
        console.error(`[PRE Gateway] Sidecar process error: ${err.message}`);
      });

      sidecarProcess.on('exit', (code) => {
        console.warn(`[PRE Gateway] Sidecar exited with code ${code}`);
        sidecarProcess = null;
      });

      // Wait up to 10 seconds for sidecar to be ready
      const deadline = Date.now() + 10_000;
      let ready = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        ready = await sidecarClient.isReady();
        if (ready) break;
      }

      if (ready) {
        console.log('[PRE Gateway] Sidecar connected');
      } else {
        console.warn('[PRE Gateway] Sidecar not ready within 10s, continuing without it');
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[PRE Gateway] Failed to spawn sidecar: ${message}`);
    }
  } else {
    console.log('[PRE Gateway] Sidecar script not found, skipping');
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
  const plaidClientId = process.env['PLAID_CLIENT_ID'];
  const plaidSecret = process.env['PLAID_SECRET'];
  const plaidAccessToken = process.env['PLAID_ACCESS_TOKEN'];
  const plaidEnv = (process.env['PLAID_ENV'] ?? 'sandbox') as
    | 'sandbox'
    | 'production';

  if (
    config.adapters.plaid.enabled &&
    plaidClientId &&
    plaidSecret &&
    plaidAccessToken
  ) {
    const plaid = new PlaidAdapter({
      clientId: plaidClientId,
      secret: plaidSecret,
      accessToken: plaidAccessToken,
      environment: plaidEnv,
    });

    const health = await plaid.healthCheck();
    if (health.ok) {
      adapters.set('plaid', plaid);
      console.log('[PRE Gateway] Plaid adapter: healthy');
    } else {
      console.warn(
        `[PRE Gateway] Plaid adapter: healthCheck failed — ${health.error}`,
      );
    }
  }

  // TODO: Initialize Google Calendar adapter when credentials are available
  // TODO: Initialize other adapters

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
  console.log(
    `[PRE Gateway] Ready — port ${wsPort}, ${adapters.size} adapter(s)`,
  );

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
