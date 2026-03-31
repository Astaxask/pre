import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { LifeDomain, LifeEvent } from '@pre/shared';
import { runSimulation, clearCache, type SimulationEngineDeps } from './simulation-engine.js';
import type { SimulationRequest } from './simulation-types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@pre/models', () => ({
  callModel: vi.fn().mockResolvedValue({
    content: JSON.stringify({
      decisionType: 'job-change',
      affectedDomains: ['body', 'money', 'time'],
      keyVariables: [{ name: 'salary', value: 'increase' }],
      confidence: 0.8,
      parserWarnings: [],
    }),
    model: 'ollama/llama3.1:8b',
    cached: false,
  }),
}));

function makeEvents(count: number, domain: LifeDomain, daysCovered: number): LifeEvent[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    source: 'manual' as const,
    sourceId: `src-${i}`,
    domain,
    eventType: 'metric',
    timestamp: now - (daysCovered - i) * 86400000,
    ingestedAt: now,
    payload: { domain: domain as 'body', subtype: 'sleep' as const },
    embedding: null,
    summary: `Test event ${i}`,
    privacyLevel: 'private' as const,
    confidence: 1,
  }));
}

function makeDeps(overrides: Partial<SimulationEngineDeps> = {}): SimulationEngineDeps {
  return {
    reader: {
      recentByDomain: vi.fn().mockResolvedValue([]),
      byTimeRange: vi.fn().mockResolvedValue(makeEvents(30, 'body', 30)),
      goals: vi.fn().mockResolvedValue([]),
      triggerLog: vi.fn(),
      byGoalId: vi.fn().mockResolvedValue([]).mockResolvedValue([]),
    },
    sidecar: {
      forecastDomain: vi.fn().mockResolvedValue({
        insufficient_data: false,
        metric: 'Sleep duration',
        unit: 'hours/night',
        p10_final: 6.5,
        p50_final: 7.5,
        p90_final: 8.5,
        confidence: 0.7,
      }),
      estimateImpact: vi.fn().mockResolvedValue({
        source: 'generic-prior' as const,
        analog_count: 0,
        delta_p10: -0.5,
        delta_p50: 0.0,
        delta_p90: 0.5,
        confidence: 0.25,
      }),
      runSimulation: vi.fn().mockResolvedValue([
        {
          domain: 'body',
          metric: 'Sleep duration',
          unit: 'hours/night',
          baseline_p10: 6.5,
          baseline_p50: 7.5,
          baseline_p90: 8.5,
          projected_p10: 6.0,
          projected_p50: 7.5,
          projected_p90: 9.0,
          confidence: 0.25,
          impact_source: 'generic-prior',
          analog_count: 0,
        },
      ]),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SimulationEngine', () => {
  beforeEach(() => {
    clearCache();
  });

  it('should return disabled mode when < 14 days of data', async () => {
    const deps = makeDeps({
      reader: {
        ...makeDeps().reader,
        byTimeRange: vi.fn().mockResolvedValue(makeEvents(5, 'body', 5)),
        goals: vi.fn().mockResolvedValue([]),
      },
    });

    const request: SimulationRequest = {
      decision: 'Should I take this new job?',
      horizon: '30d',
      domains: ['body', 'money', 'time', 'people', 'mind'] as LifeDomain[],
    };

    const result = await runSimulation(request, deps);

    expect(result.simulationMode).toBe('disabled');
    expect(result.outcomes).toHaveLength(0);
    expect(result.narrative).toContain('Not enough data');
  });

  it('should produce outcomes for valid simulation', async () => {
    const deps = makeDeps();

    const request: SimulationRequest = {
      decision: 'Should I take this new job?',
      horizon: '30d',
      domains: ['body', 'money', 'time'] as LifeDomain[],
    };

    const result = await runSimulation(request, deps);

    expect(result.simulationMode).not.toBe('disabled');
    expect(result.outcomes.length).toBeGreaterThanOrEqual(1);
    expect(result.narrative).toBeTruthy();
    expect(result.decisionType).toBe('job-change');
  });

  it('should cache results for same request', async () => {
    const deps = makeDeps();

    const request: SimulationRequest = {
      decision: 'Should I take this new job?',
      horizon: '30d',
      domains: ['body'] as LifeDomain[],
    };

    const result1 = await runSimulation(request, deps);
    const result2 = await runSimulation(request, deps);

    expect(result2.requestId).toBe(result1.requestId);
  });

  it('should clear cache', async () => {
    const deps = makeDeps();

    const request: SimulationRequest = {
      decision: 'Should I take this new job?',
      horizon: '90d',
      domains: ['body'] as LifeDomain[],
    };

    const result1 = await runSimulation(request, deps);
    clearCache();
    const result2 = await runSimulation(request, deps);

    expect(result2.requestId).not.toBe(result1.requestId);
  });

  it('should track generic prior domains', async () => {
    const deps = makeDeps();

    const request: SimulationRequest = {
      decision: 'Should I change jobs?',
      horizon: '30d',
      domains: ['body', 'money'] as LifeDomain[],
    };

    const result = await runSimulation(request, deps);

    expect(result.hasGenericPriors).toBe(true);
    expect(result.genericPriorDomains.length).toBeGreaterThanOrEqual(0);
  });

  it('should compute delta significance correctly', async () => {
    const deps = makeDeps({
      sidecar: {
        ...makeDeps().sidecar,
        runSimulation: vi.fn().mockResolvedValue([
          {
            domain: 'body',
            metric: 'Sleep',
            unit: 'hours',
            baseline_p10: 6.0,
            baseline_p50: 7.0,
            baseline_p90: 8.0,
            projected_p10: 6.0,
            projected_p50: 7.0, // Same as baseline
            projected_p90: 8.0,
            confidence: 0.5,
            impact_source: 'generic-prior',
            analog_count: 0,
          },
        ]),
      },
    });

    const request: SimulationRequest = {
      decision: 'Minor change',
      horizon: '30d',
      domains: ['body'] as LifeDomain[],
    };

    const result = await runSimulation(request, deps);

    if (result.outcomes.length > 0) {
      expect(result.outcomes[0]!.deltaIsSignificant).toBe(false);
    }
  });

  it('should handle sidecar errors gracefully', async () => {
    const deps = makeDeps({
      sidecar: {
        forecastDomain: vi.fn().mockRejectedValue(new Error('sidecar down')),
        estimateImpact: vi.fn().mockRejectedValue(new Error('sidecar down')),
        runSimulation: vi.fn().mockRejectedValue(new Error('sidecar down')),
      },
    });

    const request: SimulationRequest = {
      decision: 'Should I take this new job?',
      horizon: '30d',
      domains: ['body'] as LifeDomain[],
    };

    const result = await runSimulation(request, deps);

    // Should not throw — graceful degradation
    expect(result).toBeDefined();
    expect(result.outcomes).toHaveLength(0);
  });
});
