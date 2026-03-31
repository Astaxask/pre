import Database from 'better-sqlite3';
import { join } from 'node:path';

/**
 * Opens (or creates) the SQLite database and ensures all tables exist.
 * This uses raw SQL matching docs/data-schema.md so the gateway can start
 * without needing drizzle-kit migrations on first run.
 */
export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS life_events (
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

    CREATE INDEX IF NOT EXISTS idx_events_domain    ON life_events(domain);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON life_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_source    ON life_events(source);

    CREATE TABLE IF NOT EXISTS embedding_sync (
      event_id     TEXT PRIMARY KEY REFERENCES life_events(id),
      embedded_at  INTEGER,
      model        TEXT
    );

    CREATE TABLE IF NOT EXISTS goals (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      domain       TEXT NOT NULL,
      target_date  INTEGER,
      status       TEXT NOT NULL DEFAULT 'active',
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trigger_log (
      id           TEXT PRIMARY KEY,
      rule_id      TEXT NOT NULL,
      fired_at     INTEGER NOT NULL,
      severity     TEXT NOT NULL,
      dismissed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS integration_sync (
      source       TEXT PRIMARY KEY,
      last_sync_at INTEGER,
      cursor       TEXT,
      status       TEXT NOT NULL DEFAULT 'idle'
    );
  `);

  return db;
}
