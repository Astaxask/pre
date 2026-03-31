import { describe, it, expect } from 'vitest';
import {
  lifeDomainSchema,
  privacyLevelSchema,
  dataSourceSchema,
  lifeEventSchema,
  domainPayloadSchema,
  bodyPayloadSchema,
  moneyPayloadSchema,
  peoplePayloadSchema,
  timePayloadSchema,
  mindPayloadSchema,
  worldPayloadSchema,
} from './life-schema.js';

describe('lifeDomainSchema', () => {
  it('accepts all six domains', () => {
    for (const d of ['body', 'money', 'people', 'time', 'mind', 'world']) {
      expect(lifeDomainSchema.parse(d)).toBe(d);
    }
  });

  it('rejects invalid domains', () => {
    expect(() => lifeDomainSchema.parse('invalid')).toThrow();
    expect(() => lifeDomainSchema.parse('')).toThrow();
    expect(() => lifeDomainSchema.parse(42)).toThrow();
  });
});

describe('privacyLevelSchema', () => {
  it('accepts valid privacy levels', () => {
    for (const p of ['private', 'summarizable', 'cloud-safe']) {
      expect(privacyLevelSchema.parse(p)).toBe(p);
    }
  });

  it('rejects invalid privacy levels', () => {
    expect(() => privacyLevelSchema.parse('public')).toThrow();
  });
});

describe('dataSourceSchema', () => {
  it('accepts all data sources', () => {
    const sources = [
      'plaid', 'healthkit', 'google-fit', 'oura', 'whoop',
      'garmin', 'google-calendar', 'gmail', 'manual', 'inferred',
    ];
    for (const s of sources) {
      expect(dataSourceSchema.parse(s)).toBe(s);
    }
  });

  it('rejects unknown sources', () => {
    expect(() => dataSourceSchema.parse('twitter')).toThrow();
  });
});

describe('domainPayloadSchema', () => {
  it('parses a body payload', () => {
    const result = bodyPayloadSchema.parse({
      domain: 'body',
      subtype: 'sleep',
      sleepDuration: 480,
      sleepScore: 85,
    });
    expect(result.domain).toBe('body');
    expect(result.subtype).toBe('sleep');
    expect(result.sleepDuration).toBe(480);
  });

  it('parses a money payload', () => {
    const result = moneyPayloadSchema.parse({
      domain: 'money',
      subtype: 'transaction',
      amount: 42.5,
      currency: 'USD',
      direction: 'debit',
      merchantName: 'Coffee Shop',
    });
    expect(result.direction).toBe('debit');
  });

  it('parses a people payload', () => {
    const result = peoplePayloadSchema.parse({
      domain: 'people',
      subtype: 'communication',
      channel: 'email',
      direction: 'received',
    });
    expect(result.channel).toBe('email');
  });

  it('parses a time payload', () => {
    const result = timePayloadSchema.parse({
      domain: 'time',
      subtype: 'calendar-event',
      title: 'Team standup',
      durationMinutes: 15,
      isRecurring: true,
    });
    expect(result.isRecurring).toBe(true);
  });

  it('parses a mind payload', () => {
    const result = mindPayloadSchema.parse({
      domain: 'mind',
      subtype: 'mood-log',
      valence: 0.7,
      arousal: 0.3,
      note: 'Feeling calm',
    });
    expect(result.valence).toBe(0.7);
  });

  it('parses a world payload', () => {
    const result = worldPayloadSchema.parse({
      domain: 'world',
      subtype: 'weather',
      conditionSummary: 'Sunny',
      temperatureCelsius: 22,
    });
    expect(result.conditionSummary).toBe('Sunny');
  });

  it('discriminates domains correctly', () => {
    const bodyResult = domainPayloadSchema.parse({
      domain: 'body',
      subtype: 'hrv',
      hrvMs: 65,
    });
    expect(bodyResult.domain).toBe('body');

    const moneyResult = domainPayloadSchema.parse({
      domain: 'money',
      subtype: 'balance-snapshot',
      balance: 1500,
    });
    expect(moneyResult.domain).toBe('money');
  });

  it('rejects payloads with wrong domain discriminator', () => {
    expect(() =>
      domainPayloadSchema.parse({ domain: 'invalid', subtype: 'sleep' }),
    ).toThrow();
  });
});

describe('lifeEventSchema', () => {
  const validEvent = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    source: 'plaid' as const,
    sourceId: 'txn_123',
    domain: 'money' as const,
    eventType: 'transaction',
    timestamp: Date.now(),
    ingestedAt: Date.now(),
    payload: {
      domain: 'money' as const,
      subtype: 'transaction' as const,
      amount: 25.0,
      currency: 'USD',
      direction: 'debit' as const,
    },
    embedding: null,
    summary: null,
    privacyLevel: 'private' as const,
    confidence: 1.0,
  };

  it('parses a valid life event', () => {
    const result = lifeEventSchema.parse(validEvent);
    expect(result.id).toBe(validEvent.id);
    expect(result.domain).toBe('money');
    expect(result.privacyLevel).toBe('private');
  });

  it('accepts events with embeddings', () => {
    const result = lifeEventSchema.parse({
      ...validEvent,
      embedding: [0.1, 0.2, 0.3],
    });
    expect(result.embedding).toHaveLength(3);
  });

  it('accepts events with summaries', () => {
    const result = lifeEventSchema.parse({
      ...validEvent,
      summary: 'Spent $25 at a coffee shop',
    });
    expect(result.summary).toBe('Spent $25 at a coffee shop');
  });

  it('rejects events missing required fields', () => {
    const { id, ...noId } = validEvent;
    expect(() => lifeEventSchema.parse(noId)).toThrow();

    const { timestamp, ...noTimestamp } = validEvent;
    expect(() => lifeEventSchema.parse(noTimestamp)).toThrow();
  });

  it('rejects events with invalid domain', () => {
    expect(() =>
      lifeEventSchema.parse({ ...validEvent, domain: 'invalid' }),
    ).toThrow();
  });

  it('rejects events with invalid source', () => {
    expect(() =>
      lifeEventSchema.parse({ ...validEvent, source: 'twitter' }),
    ).toThrow();
  });
});
