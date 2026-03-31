import { randomUUID } from 'node:crypto';
import type { TriggerRule, LifeInsight, TriggerContext, Alert } from '../../types.js';

/**
 * Fires when the Composer detects wasted money — unused subscriptions,
 * preventable impulse spending patterns, or cost optimization opportunities.
 */
export const moneyWasteDetected: TriggerRule = {
  id: 'money-waste-detected',
  name: 'Money Waste Detected',
  description: 'Fires on money-hack insights that identify savings opportunities',

  watchInsightTypes: ['money-hack'],
  watchDomains: ['money'],

  severity: 'info',
  cooldownHours: 48,
  maxPerWeek: 3,

  condition(insight: LifeInsight, _context: TriggerContext): boolean {
    return insight.confidence >= 0.6;
  },

  async compose(insight: LifeInsight, _context: TriggerContext): Promise<Alert> {
    return {
      id: randomUUID(),
      ruleId: 'money-waste-detected',
      ruleName: 'Money Waste Detected',
      severity: 'info',
      title: insight.estimatedImpact
        ? `💰 Save ${insight.estimatedImpact}`
        : '💰 Money-saving opportunity',
      body: insight.payload.description,
      domains: insight.domains,
      createdAt: Date.now(),
      insightId: insight.id,
      whyExplanation: insight.payload.whyItMatters,
      actionLabel: insight.payload.suggestedAction ? 'Take action' : undefined,
      actionType: 'open-detail',
    };
  },
};
