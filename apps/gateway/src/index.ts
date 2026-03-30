import { EventBus } from './event-bus.js';

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

  // Step 2: Connect to SQLite (decrypt, run pending migrations)
  // TODO: const memory = createMemory(dbPath, encryptionKey);

  // Step 3: Connect to LanceDB
  // TODO: Initialize LanceDB connection for vector storage

  // Step 4: Start Redis (local, embedded)
  // TODO: Connect to Redis at REDIS_URL for BullMQ

  // Step 5: Start BullMQ workers (embed, sync, insight)
  // TODO: Initialize embed-worker, sync-worker, insight-worker

  // Step 6: Spawn Python sidecar, wait for ready signal
  // TODO: Spawn sidecar process, connect via Unix socket at /tmp/pre-sidecar.sock

  // Step 7: Initialize all configured adapters (healthCheck each one)
  // TODO: Load adapter configs, instantiate adapters, run healthCheck()

  // Step 8: Register cron jobs (adapter schedules + engine schedule)
  // TODO: node-cron schedules per adapter + inference engine every 15 min

  // Step 9: Start WebSocket server (port 18789, localhost only)
  // TODO: ws server for surface connections

  // Step 10: Emit ready
  const bus = new EventBus();
  bus.emit('gateway-ready', { timestamp: Date.now() });
  console.log('[PRE Gateway] Ready');
}

main().catch((err: unknown) => {
  console.error('[PRE Gateway] Fatal error:', err);
  process.exit(1);
});
