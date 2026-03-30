import { z } from 'zod';

// ---------------------------------------------------------------------------
// Core enums
// ---------------------------------------------------------------------------

export type LifeDomain =
  | 'body'
  | 'money'
  | 'people'
  | 'time'
  | 'mind'
  | 'world';

export const lifeDomainSchema = z.enum([
  'body',
  'money',
  'people',
  'time',
  'mind',
  'world',
]);

export type PrivacyLevel =
  | 'private'
  | 'summarizable'
  | 'cloud-safe';

export const privacyLevelSchema = z.enum([
  'private',
  'summarizable',
  'cloud-safe',
]);

export type DataSource =
  | 'plaid'
  | 'healthkit'
  | 'google-fit'
  | 'oura'
  | 'whoop'
  | 'garmin'
  | 'google-calendar'
  | 'gmail'
  | 'manual'
  | 'inferred';

export const dataSourceSchema = z.enum([
  'plaid',
  'healthkit',
  'google-fit',
  'oura',
  'whoop',
  'garmin',
  'google-calendar',
  'gmail',
  'manual',
  'inferred',
]);

// ---------------------------------------------------------------------------
// Domain payloads
// ---------------------------------------------------------------------------

export type BodyPayload = {
  domain: 'body';
  subtype:
    | 'sleep'
    | 'hrv'
    | 'resting-hr'
    | 'activity'
    | 'recovery-score'
    | 'biometric'
    | 'symptom';

  // Sleep
  sleepDuration?: number;
  sleepScore?: number;
  deepSleepMinutes?: number;
  remSleepMinutes?: number;

  // HRV / HR
  hrvMs?: number;
  restingHeartRate?: number;

  // Activity
  steps?: number;
  activeCalories?: number;
  workoutType?: string;
  workoutDurationMinutes?: number;

  // Recovery
  recoveryScore?: number;
  strainScore?: number;

  // Biometric
  metric?: string;
  value?: number;
  unit?: string;

  // Symptom
  symptomDescription?: string;
  severity?: number;
};

export const bodyPayloadSchema = z.object({
  domain: z.literal('body'),
  subtype: z.enum([
    'sleep',
    'hrv',
    'resting-hr',
    'activity',
    'recovery-score',
    'biometric',
    'symptom',
  ]),
  sleepDuration: z.number().optional(),
  sleepScore: z.number().optional(),
  deepSleepMinutes: z.number().optional(),
  remSleepMinutes: z.number().optional(),
  hrvMs: z.number().optional(),
  restingHeartRate: z.number().optional(),
  steps: z.number().optional(),
  activeCalories: z.number().optional(),
  workoutType: z.string().optional(),
  workoutDurationMinutes: z.number().optional(),
  recoveryScore: z.number().optional(),
  strainScore: z.number().optional(),
  metric: z.string().optional(),
  value: z.number().optional(),
  unit: z.string().optional(),
  symptomDescription: z.string().optional(),
  severity: z.number().optional(),
});

export type MoneyPayload = {
  domain: 'money';
  subtype:
    | 'transaction'
    | 'balance-snapshot'
    | 'net-worth-snapshot'
    | 'bill-due'
    | 'income'
    | 'transfer';

  // Transaction
  amount?: number;
  currency?: string;
  direction?: 'debit' | 'credit';
  merchantName?: string;
  category?: string[];
  accountId?: string;

  // Balance / net worth
  balance?: number;
  accountType?: 'checking' | 'savings' | 'credit' | 'investment' | 'loan';

  // Bill
  billName?: string;
  dueDateTs?: number;
  estimatedAmount?: number;
};

export const moneyPayloadSchema = z.object({
  domain: z.literal('money'),
  subtype: z.enum([
    'transaction',
    'balance-snapshot',
    'net-worth-snapshot',
    'bill-due',
    'income',
    'transfer',
  ]),
  amount: z.number().optional(),
  currency: z.string().optional(),
  direction: z.enum(['debit', 'credit']).optional(),
  merchantName: z.string().optional(),
  category: z.array(z.string()).optional(),
  accountId: z.string().optional(),
  balance: z.number().optional(),
  accountType: z
    .enum(['checking', 'savings', 'credit', 'investment', 'loan'])
    .optional(),
  billName: z.string().optional(),
  dueDateTs: z.number().optional(),
  estimatedAmount: z.number().optional(),
});

export type PeoplePayload = {
  domain: 'people';
  subtype:
    | 'communication'
    | 'meeting'
    | 'relationship-signal';

  // Communication
  channel?: 'email' | 'sms' | 'slack' | 'whatsapp' | 'other';
  direction?: 'sent' | 'received';
  contactId?: string;

  // Relationship signal (inferred by engine)
  signalType?:
    | 'frequency-drop'
    | 'frequency-increase'
    | 'long-silence'
    | 'reconnect';
  daysSinceLastContact?: number;
};

export const peoplePayloadSchema = z.object({
  domain: z.literal('people'),
  subtype: z.enum(['communication', 'meeting', 'relationship-signal']),
  channel: z
    .enum(['email', 'sms', 'slack', 'whatsapp', 'other'])
    .optional(),
  direction: z.enum(['sent', 'received']).optional(),
  contactId: z.string().optional(),
  signalType: z
    .enum([
      'frequency-drop',
      'frequency-increase',
      'long-silence',
      'reconnect',
    ])
    .optional(),
  daysSinceLastContact: z.number().optional(),
});

export type TimePayload = {
  domain: 'time';
  subtype:
    | 'calendar-event'
    | 'time-block'
    | 'commitment'
    | 'time-audit';

  // Calendar event
  title?: string;
  durationMinutes?: number;
  attendeeCount?: number;
  isRecurring?: boolean;
  calendarType?: 'work' | 'personal' | 'health' | 'other';

  // Time block
  blockType?: 'focus' | 'rest' | 'admin' | 'social' | 'exercise';

  // Commitment (inferred)
  commitmentLabel?: string;
  weeklyHours?: number;
};

export const timePayloadSchema = z.object({
  domain: z.literal('time'),
  subtype: z.enum([
    'calendar-event',
    'time-block',
    'commitment',
    'time-audit',
  ]),
  title: z.string().optional(),
  durationMinutes: z.number().optional(),
  attendeeCount: z.number().optional(),
  isRecurring: z.boolean().optional(),
  calendarType: z
    .enum(['work', 'personal', 'health', 'other'])
    .optional(),
  blockType: z
    .enum(['focus', 'rest', 'admin', 'social', 'exercise'])
    .optional(),
  commitmentLabel: z.string().optional(),
  weeklyHours: z.number().optional(),
});

export type MindPayload = {
  domain: 'mind';
  subtype:
    | 'goal'
    | 'goal-progress'
    | 'mood-log'
    | 'learning-session'
    | 'reflection';

  // Goal
  goalId?: string;
  goalTitle?: string;
  goalDomain?: LifeDomain;
  targetDate?: number;
  status?: 'active' | 'completed' | 'abandoned' | 'paused';

  // Goal progress
  progressPercent?: number;
  progressNote?: string;

  // Mood
  valence?: number;
  arousal?: number;
  note?: string;

  // Learning
  topic?: string;
  durationMinutes?: number;
  medium?: 'book' | 'article' | 'course' | 'video' | 'practice' | 'other';

  // Reflection
  contentHash?: string;
  wordCount?: number;
};

export const mindPayloadSchema = z.object({
  domain: z.literal('mind'),
  subtype: z.enum([
    'goal',
    'goal-progress',
    'mood-log',
    'learning-session',
    'reflection',
  ]),
  goalId: z.string().optional(),
  goalTitle: z.string().optional(),
  goalDomain: lifeDomainSchema.optional(),
  targetDate: z.number().optional(),
  status: z
    .enum(['active', 'completed', 'abandoned', 'paused'])
    .optional(),
  progressPercent: z.number().optional(),
  progressNote: z.string().optional(),
  valence: z.number().optional(),
  arousal: z.number().optional(),
  note: z.string().optional(),
  topic: z.string().optional(),
  durationMinutes: z.number().optional(),
  medium: z
    .enum(['book', 'article', 'course', 'video', 'practice', 'other'])
    .optional(),
  contentHash: z.string().optional(),
  wordCount: z.number().optional(),
});

export type WorldPayload = {
  domain: 'world';
  subtype:
    | 'weather'
    | 'location-context'
    | 'external-event';

  // Weather
  conditionSummary?: string;
  temperatureCelsius?: number;

  // Location context (deliberately coarse — never store GPS)
  locationType?: 'home' | 'work' | 'commuting' | 'traveling' | 'other';

  // External event
  eventCategory?:
    | 'economic'
    | 'health'
    | 'weather-extreme'
    | 'local'
    | 'other';
  headline?: string;
  relevantDomains?: LifeDomain[];
};

export const worldPayloadSchema = z.object({
  domain: z.literal('world'),
  subtype: z.enum(['weather', 'location-context', 'external-event']),
  conditionSummary: z.string().optional(),
  temperatureCelsius: z.number().optional(),
  locationType: z
    .enum(['home', 'work', 'commuting', 'traveling', 'other'])
    .optional(),
  eventCategory: z
    .enum(['economic', 'health', 'weather-extreme', 'local', 'other'])
    .optional(),
  headline: z.string().optional(),
  relevantDomains: z.array(lifeDomainSchema).optional(),
});

// ---------------------------------------------------------------------------
// Discriminated union of all domain payloads
// ---------------------------------------------------------------------------

export type DomainPayload =
  | BodyPayload
  | MoneyPayload
  | PeoplePayload
  | TimePayload
  | MindPayload
  | WorldPayload;

export const domainPayloadSchema = z.discriminatedUnion('domain', [
  bodyPayloadSchema,
  moneyPayloadSchema,
  peoplePayloadSchema,
  timePayloadSchema,
  mindPayloadSchema,
  worldPayloadSchema,
]);

// ---------------------------------------------------------------------------
// LifeEvent — the root type
// ---------------------------------------------------------------------------

export type LifeEvent = {
  id: string;
  source: DataSource;
  sourceId: string;
  domain: LifeDomain;
  eventType: string;
  timestamp: number;
  ingestedAt: number;
  payload: DomainPayload;
  embedding: number[] | null;
  summary: string | null;
  privacyLevel: PrivacyLevel;
  confidence: number;
};

export const lifeEventSchema = z.object({
  id: z.string(),
  source: dataSourceSchema,
  sourceId: z.string(),
  domain: lifeDomainSchema,
  eventType: z.string(),
  timestamp: z.number(),
  ingestedAt: z.number(),
  payload: domainPayloadSchema,
  embedding: z.array(z.number()).nullable(),
  summary: z.string().nullable(),
  privacyLevel: privacyLevelSchema,
  confidence: z.number(),
});
