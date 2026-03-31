import { randomUUID } from 'node:crypto';
import type { MemoryReader, TriggerLogEntry } from '@pre/memory';
import type {
  LifeInsight,
  TriggerRule,
  TriggerContext,
  Alert,
} from '../types.js';
import type { LifeDomain } from '@pre/shared';

type RuleEvaluatorDeps = {
  reader: MemoryReader;
  writeTriggerLog: (entry: {
    id: string;
    ruleId: string;
    firedAt: number;
    severity: string;
  }) => void;
};

export async function evaluate(
  insights: LifeInsight[],
  rules: TriggerRule[],
  deps: RuleEvaluatorDeps,
): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const now = Date.now();

  // Build trigger context once
  const context = await buildContext(deps.reader);

  for (const insight of insights) {
    for (const rule of rules) {
      // Check if rule watches this insight type and domain
      if (!rule.watchInsightTypes.includes(insight.insightType)) continue;
      const domainMatch = rule.watchDomains.some((d) =>
        insight.domains.includes(d),
      );
      if (!domainMatch) continue;

      // Check cooldown
      const cooldownSince = now - rule.cooldownHours * 3600000;
      try {
        const recentFires = await deps.reader.triggerLog(rule.id, cooldownSince);
        if (recentFires.length > 0) continue;
      } catch {
        // If we can't check trigger log, skip to be safe
        continue;
      }

      // Check maxPerWeek
      const weekAgo = now - 7 * 24 * 3600000;
      try {
        const weekFires = await deps.reader.triggerLog(rule.id, weekAgo);
        if (weekFires.length >= rule.maxPerWeek) continue;
      } catch {
        continue;
      }

      // Run condition
      try {
        const fires = rule.condition(insight, context);
        if (!fires) continue;
      } catch (e) {
        console.warn(
          `[proactive] Rule ${rule.id} condition error: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }

      // Compose alert
      try {
        const alert = await rule.compose(insight, context);
        alerts.push(alert);

        // Write to trigger log
        deps.writeTriggerLog({
          id: randomUUID(),
          ruleId: rule.id,
          firedAt: now,
          severity: rule.severity,
        });
      } catch (e) {
        console.warn(
          `[proactive] Rule ${rule.id} compose error: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  return alerts;
}

async function buildContext(reader: MemoryReader): Promise<TriggerContext> {
  const recentEventsByDomain = new Map<LifeDomain, number>();
  const domains: LifeDomain[] = ['body', 'money', 'people', 'time', 'mind', 'world'];

  for (const domain of domains) {
    try {
      const events = await reader.recentByDomain(domain, 72);
      recentEventsByDomain.set(domain, events.length);
    } catch {
      recentEventsByDomain.set(domain, 0);
    }
  }

  let activeGoalCount = 0;
  try {
    const goals = await reader.goals('active');
    activeGoalCount = goals.length;
  } catch {
    // ok
  }

  return {
    recentEventsByDomain,
    activeGoalCount,
    lastAlertForRule: null,
  };
}
