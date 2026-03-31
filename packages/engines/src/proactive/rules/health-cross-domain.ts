import { randomUUID } from 'node:crypto';
import type { TriggerRule, LifeInsight, TriggerContext, Alert } from '../../types.js';

/**
 * Fires when the Composer finds a cross-domain health correlation —
 * sleep quality affecting spending, sedentary patterns impacting
 * productivity, exercise correlating with mood, etc.
 *
 * These insights are the core value prop: connections no single-domain
 * app could ever make.
 */
export const healthCrossDomain: TriggerRule = {
  id: 'health-cross-domain',
  name: 'Health Cross-Domain Correlation',
  description: 'Fires on health-correlation insights that span multiple life domains',

  watchInsightTypes: ['health-correlation'],
  watchDomains: ['body', 'money', 'time', 'mind', 'people'],

  severity: 'info',
  cooldownHours: 48,
  maxPerWeek: 3,

  condition(insight: LifeInsight, _context: TriggerContext): boolean {
    // Must actually cross domains
    return insight.domains.length >= 2 && insight.confidence >= 0.6;
  },

  async compose(insight: LifeInsight, _context: TriggerContext): Promise<Alert> {
    return {
      id: randomUUID(),
      ruleId: 'health-cross-domain',
      ruleName: 'Health Cross-Domain Correlation',
      severity: 'info',
      title: '🔗 Health connection discovered',
      body: insight.payload.description,
      domains: insight.domains,
      createdAt: Date.now(),
      insightId: insight.id,
      whyExplanation: insight.payload.whyItMatters,
      actionLabel: insight.payload.suggestedAction ? 'What to do' : undefined,
      actionType: 'open-detail',
    };
  },
};
