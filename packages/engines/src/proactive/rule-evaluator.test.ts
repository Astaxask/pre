import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { LifeDomain } from '@pre/shared';
import { evaluate } from './rule-evaluator.js';
import type { LifeInsight, TriggerRule, Alert, TriggerContext } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInsight(overrides: Partial<LifeInsight> = {}): LifeInsight {
  return {
    id: randomUUID(),
    generatedAt: Date.now(),
    domains: ['body'] as LifeDomain[],
    insightType: 'trend-change',
    confidence: 0.8,
    payload: {
      description: 'Test insight',
      metadata: { direction: 'declining' },
    },
    expiresAt: Date.now() + 86400000,
    privacyLevel: 'private',
    ...overrides,
  };
}

function makeRule(overrides: Partial<TriggerRule> = {}): TriggerRule {
  return {
    id: 'test-rule',
    name: 'Test Rule',
    description: 'A test trigger rule',
    watchInsightTypes: ['trend-change'],
    watchDomains: ['body'],
    severity: 'warning',
    cooldownHours: 24,
    maxPerWeek: 5,
    condition: vi.fn().mockReturnValue(true),
    compose: vi.fn().mockResolvedValue({
      id: randomUUID(),
      ruleId: 'test-rule',
      ruleName: 'Test Rule',
      severity: 'warning',
      title: 'Test Alert',
      body: 'Something happened',
      domains: ['body'] as LifeDomain[],
      createdAt: Date.now(),
      insightId: 'insight-1',
      whyExplanation: 'Test reason',
    } satisfies Alert),
    ...overrides,
  };
}

function makeDeps() {
  return {
    reader: {
      recentByDomain: vi.fn().mockResolvedValue([]),
      byTimeRange: vi.fn().mockResolvedValue([]),
      goals: vi.fn().mockResolvedValue([]),
      triggerLog: vi.fn(),
      byGoalId: vi.fn().mockResolvedValue([]).mockResolvedValue([]),
    },
    writeTriggerLog: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RuleEvaluator', () => {
  describe('evaluate()', () => {
    it('should fire a rule when condition returns true', async () => {
      const insight = makeInsight();
      const rule = makeRule();
      const deps = makeDeps();

      const alerts = await evaluate([insight], [rule], deps);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.ruleId).toBe('test-rule');
      expect(rule.condition).toHaveBeenCalledWith(insight, expect.any(Object));
      expect(deps.writeTriggerLog).toHaveBeenCalledTimes(1);
    });

    it('should not fire when condition returns false', async () => {
      const insight = makeInsight();
      const rule = makeRule({
        condition: vi.fn().mockReturnValue(false),
      });
      const deps = makeDeps();

      const alerts = await evaluate([insight], [rule], deps);

      expect(alerts).toHaveLength(0);
      expect(deps.writeTriggerLog).not.toHaveBeenCalled();
    });

    it('should skip rule when insight type does not match', async () => {
      const insight = makeInsight({ insightType: 'anomaly' });
      const rule = makeRule({
        watchInsightTypes: ['trend-change'], // Does not include 'anomaly'
      });
      const deps = makeDeps();

      const alerts = await evaluate([insight], [rule], deps);

      expect(alerts).toHaveLength(0);
      expect(rule.condition).not.toHaveBeenCalled();
    });

    it('should skip rule when domain does not match', async () => {
      const insight = makeInsight({ domains: ['money'] });
      const rule = makeRule({
        watchDomains: ['body'], // Does not include 'money'
      });
      const deps = makeDeps();

      const alerts = await evaluate([insight], [rule], deps);

      expect(alerts).toHaveLength(0);
    });

    it('should respect cooldown', async () => {
      const insight = makeInsight();
      const rule = makeRule({ cooldownHours: 24 });
      const deps = makeDeps();

      // Simulate recent firing within cooldown
      deps.reader.triggerLog = vi.fn().mockResolvedValue([
        { id: '1', ruleId: 'test-rule', firedAt: Date.now() - 3600000, severity: 'warning' },
      ]);

      const alerts = await evaluate([insight], [rule], deps);

      expect(alerts).toHaveLength(0);
    });

    it('should respect maxPerWeek', async () => {
      const insight = makeInsight();
      const rule = makeRule({ maxPerWeek: 2, cooldownHours: 0.001 });
      const deps = makeDeps();

      // First call for cooldown check returns empty (no cooldown)
      // Second call for maxPerWeek check returns 2 entries (at limit)
      let callCount = 0;
      deps.reader.triggerLog = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return []; // cooldown check
        return [
          { id: '1', ruleId: 'test-rule', firedAt: Date.now() - 86400000, severity: 'warning' },
          { id: '2', ruleId: 'test-rule', firedAt: Date.now() - 172800000, severity: 'warning' },
        ]; // maxPerWeek check
      });

      const alerts = await evaluate([insight], [rule], deps);

      expect(alerts).toHaveLength(0);
    });

    it('should handle condition errors gracefully', async () => {
      const insight = makeInsight();
      const rule = makeRule({
        condition: vi.fn().mockImplementation(() => {
          throw new Error('condition boom');
        }),
      });
      const deps = makeDeps();

      const alerts = await evaluate([insight], [rule], deps);

      expect(alerts).toHaveLength(0);
    });

    it('should handle compose errors gracefully', async () => {
      const insight = makeInsight();
      const rule = makeRule({
        compose: vi.fn().mockRejectedValue(new Error('compose boom')),
      });
      const deps = makeDeps();

      const alerts = await evaluate([insight], [rule], deps);

      expect(alerts).toHaveLength(0);
    });

    it('should evaluate multiple rules against multiple insights', async () => {
      const insights = [
        makeInsight({ insightType: 'trend-change', domains: ['body'] }),
        makeInsight({ insightType: 'anomaly', domains: ['people'] }),
      ];

      const rules = [
        makeRule({
          id: 'rule-1',
          watchInsightTypes: ['trend-change'],
          watchDomains: ['body'],
        }),
        makeRule({
          id: 'rule-2',
          watchInsightTypes: ['anomaly'],
          watchDomains: ['people'],
          compose: vi.fn().mockResolvedValue({
            id: randomUUID(),
            ruleId: 'rule-2',
            ruleName: 'Rule 2',
            severity: 'info',
            title: 'Alert 2',
            body: 'People domain anomaly',
            domains: ['people'] as LifeDomain[],
            createdAt: Date.now(),
            insightId: 'insight-2',
            whyExplanation: 'Test',
          } satisfies Alert),
        }),
      ];

      const deps = makeDeps();
      const alerts = await evaluate(insights, rules, deps);

      expect(alerts).toHaveLength(2);
      expect(deps.writeTriggerLog).toHaveBeenCalledTimes(2);
    });
  });
});
