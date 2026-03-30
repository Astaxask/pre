import type { DataSource, LifeDomain, LifeEvent, PrivacyLevel } from '@pre/shared';

export type SyncCursor = string;

export type AdapterManifest = {
  source: DataSource;
  description: string;
  domains: LifeDomain[];
  maxPrivacyLevel: PrivacyLevel;
  defaultSyncIntervalMinutes: number;
  collectsFields: string[];
  refusesFields: string[];
};

export type AdapterResult = {
  events: LifeEvent[];
  nextCursor: SyncCursor;
  hasMore: boolean;
};

export interface LifeAdapter {
  readonly source: DataSource;
  readonly domains: LifeDomain[];
  sync(cursor: SyncCursor | null): Promise<AdapterResult>;
  healthCheck(): Promise<{ ok: boolean; error?: string }>;
  manifest(): AdapterManifest;
}
