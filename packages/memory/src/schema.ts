import {
  sqliteTable,
  text,
  integer,
  real,
  unique,
  index,
} from 'drizzle-orm/sqlite-core';

export const lifeEvents = sqliteTable(
  'life_events',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    domain: text('domain').notNull(),
    eventType: text('event_type').notNull(),
    timestamp: integer('timestamp').notNull(),
    ingestedAt: integer('ingested_at').notNull(),
    payload: text('payload').notNull(),
    summary: text('summary'),
    privacyLevel: text('privacy_level').notNull().default('private'),
    confidence: real('confidence').notNull().default(1.0),
  },
  (table) => [
    unique('uq_source_sourceid').on(table.source, table.sourceId),
    index('idx_events_domain').on(table.domain),
    index('idx_events_timestamp').on(table.timestamp),
    index('idx_events_source').on(table.source),
  ],
);

export const embeddingSync = sqliteTable('embedding_sync', {
  eventId: text('event_id')
    .primaryKey()
    .references(() => lifeEvents.id),
  embeddedAt: integer('embedded_at'),
  model: text('model'),
});

export const goals = sqliteTable('goals', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  domain: text('domain').notNull(),
  targetDate: integer('target_date'),
  status: text('status').notNull().default('active'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const triggerLog = sqliteTable('trigger_log', {
  id: text('id').primaryKey(),
  ruleId: text('rule_id').notNull(),
  firedAt: integer('fired_at').notNull(),
  severity: text('severity').notNull(),
  dismissedAt: integer('dismissed_at'),
});

export const integrationSync = sqliteTable('integration_sync', {
  source: text('source').primaryKey(),
  lastSyncAt: integer('last_sync_at'),
  cursor: text('cursor'),
  status: text('status').notNull().default('idle'),
});
