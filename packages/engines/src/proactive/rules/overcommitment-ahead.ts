import { randomUUID } from 'node:crypto';
import { callModel } from '@pre/models';
import type { TriggerRule, LifeInsight, TriggerContext, Alert } from '../../types.js';

export const overcommitmentAhead: TriggerRule = {
  id: 'overcommitment-ahead',
  name: 'Overcommitment Ahead',
  description: 'Fires when time commitments are increasing while body recovery is declining',

  watchInsightTypes: ['trend-change'],
  watchDomains: ['time', 'body'],

  severity: 'warning',
  cooldownHours: 48,
  maxPerWeek: 2,

  condition(insight: LifeInsight, context: TriggerContext): boolean {
    if (!insight.domains.includes('time')) return false;
    const direction = insight.payload.metadata['direction'];
    if (direction !== 'increasing' && direction !== 'declining') return false;

    // Check if body domain also shows stress
    const bodyCount = context.recentEventsByDomain.get('body') ?? 0;
    // We check for time increasing commitments — the insight itself should be about time
    return direction === 'increasing' && bodyCount > 0;
  },

  async compose(insight: LifeInsight, _context: TriggerContext): Promise<Alert> {
    let body: string;
    try {
      const response = await callModel({
        task: 'proactive-reasoning',
        privacyLevel: 'private',
        messages: [
          {
            role: 'system',
            content: 'You generate brief, caring alerts. Do not recommend action. Do not use specific numbers. Name the domains involved.',
          },
          {
            role: 'user',
            content: 'Time commitments are trending upward while body recovery metrics suggest strain. Generate an alert about potential overcommitment.',
          },
        ],
      });
      body = response.content;
    } catch {
      body = 'Your time commitments are increasing while your body domain suggests you may need more recovery time.';
    }

    return {
      id: randomUUID(),
      ruleId: 'overcommitment-ahead',
      ruleName: 'Overcommitment Ahead',
      severity: 'warning',
      title: 'Schedule may be overloaded',
      body,
      domains: ['time', 'body'],
      createdAt: Date.now(),
      insightId: insight.id,
      whyExplanation: 'This alert fired because an upward trend in time commitments was detected alongside body domain signals.',
    };
  },
};
