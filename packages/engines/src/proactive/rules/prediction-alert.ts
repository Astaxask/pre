import { randomUUID } from 'node:crypto';
import type { TriggerRule, LifeInsight, TriggerContext, Alert } from '../../types.js';

/**
 * Fires when the Composer makes a probabilistic prediction that requires
 * timely action — upcoming overdraft, likely event cancellation,
 * approaching deadline with insufficient progress, etc.
 *
 * These are INTERRUPT-level because they're time-sensitive.
 */
export const predictionAlert: TriggerRule = {
  id: 'prediction-alert',
  name: 'Predictive Intervention',
  description: 'Fires on prediction insights that are time-sensitive and actionable',

  watchInsightTypes: ['prediction', 'opportunity', 'conflict-detected'],
  watchDomains: ['body', 'money', 'people', 'time', 'mind', 'world'],

  severity: 'warning',
  cooldownHours: 24,
  maxPerWeek: 3,

  condition(insight: LifeInsight, _context: TriggerContext): boolean {
    // Only interrupt-worthy predictions
    return (
      insight.urgency === 'interrupt' &&
      insight.confidence >= 0.65 &&
      !!insight.payload.suggestedAction
    );
  },

  async compose(insight: LifeInsight, _context: TriggerContext): Promise<Alert> {
    const isNegative = insight.category === 'prevent-harm';

    return {
      id: randomUUID(),
      ruleId: 'prediction-alert',
      ruleName: 'Predictive Intervention',
      severity: 'warning',
      title: isNegative
        ? `🚨 ${insight.payload.description.slice(0, 60)}`
        : `🔮 ${insight.payload.description.slice(0, 60)}`,
      body: insight.payload.description,
      domains: insight.domains,
      createdAt: Date.now(),
      insightId: insight.id,
      whyExplanation: insight.payload.whyItMatters,
      actionLabel: insight.payload.suggestedAction ? 'Take action now' : undefined,
      actionType: 'open-detail',
    };
  },
};
