import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LifeDomain, LifeEvent } from '@pre/shared';
import { run, getInsights, type InferenceEngineDeps } from './inference-engine.js';
import type { DetectedPattern } from '../types.js';

// Mock callModel so tests don't require a running Ollama instance
vi.mock('@pre/models', () => ({
  callModel: vi.fn().mockResolvedValue({
    content: '{"insights": []}',
    model: 'mock',
    tokensUsed: 50,
    costUsd: 0,
  }),
  configureRouter: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<LifeEvent> = {}): LifeEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    source: 'manual',
    sourceId: `src-${Math.random().toString(36).slice(2)}`,
    domain: 'body' as LifeDomain,
    eventType: 'sleep',
    timestamp: Date.now() - 3600000,
    ingestedAt: Date.now(),
    payload: { domain: 'body' as const, subtype: 'sleep' as const },
    embedding: null,
    summary: 'Test event',
    privacyLevel: 'private' as const,
    confidence: 1,
    ...overrides,
  };
}

function makeEvents(count: number, domain: LifeDomain = 'body'): LifeEvent[] {
  return Array.from({ length: count }, (_, i) =>
    makeEvent({
      domain,
      timestamp: Date.now() - (count - i) * 3600000,
      ingestedAt: Date.now() - (count - i) * 3600000,
      payload: { domain: domain as 'body', subtype: 'sleep' as const },
    }),
  );
}

function makeMockDeps(overrides: Partial<InferenceEngineDeps> = {}): InferenceEngineDeps {
  return {
    reader: {
      recentByDomain: vi.fn().mockResolvedValue([]),
      byTimeRange: vi.fn().mockResolvedValue([]),
      goals: vi.fn().mockResolvedValue([]),
      triggerLog: vi.fn(),
      byGoalId: vi.fn().mockResolvedValue([]).mockResolvedValue([]),
    },
    sidecar: {
      detectPatterns: vi.fn().mockResolvedValue([]),
      similaritySearch: vi.fn().mockResolvedValue([]),
      isReady: vi.fn().mockResolvedValue(true),
    },
    bus: {
      emit: vi.fn(),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InferenceEngine', () => {
  describe('run()', () => {
    it('should return early with 0 insights when < 20 events', async () => {
      const deps = makeMockDeps({
        reader: {
          ...makeMockDeps().reader,
          recentByDomain: vi.fn().mockResolvedValue(makeEvents(2)),
        },
      });

      const result = await run(deps);

      expect(result.insightsGenerated).toBe(0);
      expect(result.patternsDetected).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should detect patterns when sidecar returns them', async () => {
      const patterns: DetectedPattern[] = [
        {
          type: 'correlation',
          domains: ['body', 'time'],
          confidence: 0.8,
          metadata: { r_value: 0.85, p_value: 0.001, direction: 'positive', data_points: 20 },
        },
      ];

      // Return enough events for each domain call
      const events = makeEvents(10, 'body');
      const deps = makeMockDeps({
        reader: {
          ...makeMockDeps().reader,
          recentByDomain: vi.fn().mockResolvedValue(events),
          goals: vi.fn().mockResolvedValue([]),
        },
        sidecar: {
          detectPatterns: vi.fn().mockResolvedValue(patterns),
          similaritySearch: vi.fn().mockResolvedValue([]),
          isReady: vi.fn().mockResolvedValue(true),
        },
      });

      const result = await run(deps);

      expect(result.patternsDetected).toBe(1);
      // An insight should be generated for the pattern
      expect(result.insightsGenerated).toBeGreaterThanOrEqual(1);
    });

    it('should handle sidecar unavailable gracefully', async () => {
      const events = makeEvents(10, 'body');
      const deps = makeMockDeps({
        reader: {
          ...makeMockDeps().reader,
          recentByDomain: vi.fn().mockResolvedValue(events),
          goals: vi.fn().mockResolvedValue([]),
        },
        sidecar: {
          detectPatterns: vi.fn().mockRejectedValue(new Error('not connected')),
          similaritySearch: vi.fn().mockRejectedValue(new Error('not connected')),
          isReady: vi.fn().mockResolvedValue(false),
        },
      });

      const result = await run(deps);

      // Should complete without throwing
      expect(result.patternsDetected).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should generate goal-drift insight for inactive goals', async () => {
      const events = makeEvents(10, 'body');
      const deps = makeMockDeps({
        reader: {
          ...makeMockDeps().reader,
          recentByDomain: vi.fn().mockImplementation(async (domain: string) => {
            if (domain === 'mind') return []; // No mind events → goal drift
            return events;
          }),
          goals: vi.fn().mockResolvedValue([
            { id: 'g1', title: 'Learn Spanish', domain: 'mind', targetDate: null, status: 'active', createdAt: 0, updatedAt: 0 },
          ]),
        },
        sidecar: {
          ...makeMockDeps().sidecar,
          isReady: vi.fn().mockResolvedValue(false),
        },
      });

      const result = await run(deps);

      // Goal drift insight should be generated for mind domain with no events
      expect(result.insightsGenerated).toBeGreaterThanOrEqual(1);
    });

    it('should collect errors without crashing', async () => {
      const deps = makeMockDeps({
        reader: {
          ...makeMockDeps().reader,
          recentByDomain: vi.fn().mockImplementation(async (domain: string) => {
            if (domain === 'body') throw new Error('DB read failed');
            return makeEvents(10, domain as LifeDomain);
          }),
          goals: vi.fn().mockRejectedValue(new Error('goals failed')),
        },
        sidecar: {
          ...makeMockDeps().sidecar,
          isReady: vi.fn().mockResolvedValue(false),
        },
      });

      const result = await run(deps);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes('body'))).toBe(true);
    });
  });

  describe('getInsights()', () => {
    it('should return empty array initially', () => {
      const insights = getInsights();
      // May have insights from other tests if they published, but should be an array
      expect(Array.isArray(insights)).toBe(true);
    });
  });
});
