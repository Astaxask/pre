import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

const adapterConfigSchema = z.object({
  enabled: z.boolean().default(false),
  syncIntervalMinutes: z.number().positive().default(60),
});

const configSchema = z.object({
  adapters: z
    .object({
      plaid: adapterConfigSchema.default({ enabled: false, syncIntervalMinutes: 360 }),
      healthkit: adapterConfigSchema.default({ enabled: false, syncIntervalMinutes: 15 }),
      oura: adapterConfigSchema.default({ enabled: false, syncIntervalMinutes: 30 }),
      whoop: adapterConfigSchema.default({ enabled: false, syncIntervalMinutes: 30 }),
      garmin: adapterConfigSchema.default({ enabled: false, syncIntervalMinutes: 60 }),
      'google-calendar': adapterConfigSchema.default({ enabled: false, syncIntervalMinutes: 10 }),
      gmail: adapterConfigSchema.default({ enabled: false, syncIntervalMinutes: 30 }),
    })
    .default({}),
  models: z
    .object({
      localModel: z.string().default('llama3.1:8b'),
      cloudEnabled: z.boolean().default(false),
      monthlyBudgetUsd: z.number().nonnegative().default(10),
    })
    .default({}),
  proactiveAgent: z
    .object({
      enabled: z.boolean().default(true),
      quietHoursStart: z.string().default('22:00'),
      quietHoursEnd: z.string().default('08:00'),
    })
    .default({}),
  retention: z
    .object({
      eventRetentionDays: z.number().positive().default(365),
      insightRetentionDays: z.number().positive().default(30),
    })
    .default({}),
});

export type Config = z.infer<typeof configSchema>;
export type AdapterConfig = z.infer<typeof adapterConfigSchema>;

const CONFIG_DIR = join(homedir(), '.pre');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: Config = configSchema.parse({});

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): Config {
  ensureConfigDir();

  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    return DEFAULT_CONFIG;
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const json: unknown = JSON.parse(raw);
    return configSchema.parse(json);
  } catch (e) {
    console.warn(
      `[config] Failed to parse ${CONFIG_PATH}, using defaults:`,
      e instanceof Error ? e.message : String(e),
    );
    return DEFAULT_CONFIG;
  }
}

export function reloadConfig(): Config {
  return loadConfig();
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function getDataDir(): string {
  ensureConfigDir();
  return CONFIG_DIR;
}
