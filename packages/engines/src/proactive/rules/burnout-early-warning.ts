import { randomUUID } from 'node:crypto';
import type { TriggerRule, LifeInsight, TriggerContext, Alert } from '../../types.js';

/**
 * Fires when the Composer detects compound burnout signals across
 * multiple domains: declining social activity + increasing screen time +
 * sleep disruption + browsing shift toward escapist content, etc.
 *
 * This is an INTERVENTION-level alert — it's serious.
 */
export const burnoutEarlyWarning: TriggerRule = {
  id: 'burnout-early-warning',
  name: 'Burnout Early Warning',
  description: 'Fires on burnout-signal insights that detect compound stress indicators',

  watchInsightTypes: ['burnout-signal'],
  watchDomains: ['body', 'mind', 'people', 'time'],

  severity: 'intervention',
  cooldownHours: 168, // 7 days — this is a heavy alert, don't spam
  maxPerWeek: 1,

  condition(insight: LifeInsight, _context: TriggerContext): boolean {
    // Only fire if multiple domains are involved (compound signal)
    return insight.domains.length >= 2 && insight.confidence >= 0.7;
  },

  async compose(insight: LifeInsight, _context: TriggerContext): Promise<Alert> {
    return {
      id: randomUUID(),
      ruleId: 'burnout-early-warning',
      ruleName: 'Burnout Early Warning',
      severity: 'intervention',
      title: '⚠️ Your data suggests rising stress',
      body: insight.payload.description,
      domains: insight.domains,
      createdAt: Date.now(),
      insightId: insight.id,
      whyExplanation: insight.payload.whyItMatters,
      actionLabel: 'See what PRE noticed',
      actionType: 'open-detail',
    };
  },
};
