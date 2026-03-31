import { randomUUID } from 'node:crypto';
import { callModel } from '@pre/models';
import type { TriggerRule, LifeInsight, TriggerContext, Alert } from '../../types.js';

export const sleepDebtAccumulating: TriggerRule = {
  id: 'sleep-debt-accumulating',
  name: 'Sleep Debt Accumulating',
  description: 'Fires when sleep is declining and calendar shows a high-density week ahead',

  watchInsightTypes: ['trend-change'],
  watchDomains: ['body', 'time'],

  severity: 'warning',
  cooldownHours: 72,
  maxPerWeek: 2,

  condition(insight: LifeInsight, context: TriggerContext): boolean {
    // Sleep declining trend
    if (!insight.domains.includes('body')) return false;
    const direction = insight.payload.metadata['direction'];
    if (direction !== 'declining') return false;

    // High-density calendar: >35h committed in time domain (recent 72h events)
    const timeEventCount = context.recentEventsByDomain.get('time') ?? 0;
    return timeEventCount > 10; // rough proxy: many calendar events
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
            content: 'You generate brief, caring alerts for a life-tracking system. Do not recommend action. Do not use specific numbers. Name the domains involved. Include a one-sentence "why am I seeing this" explanation.',
          },
          {
            role: 'user',
            content: 'A declining sleep trend has been detected in the body domain, and the time domain shows a busy period ahead. Generate an alert.',
          },
        ],
      });
      body = response.content;
    } catch {
      body = 'Your sleep pattern has been declining while your schedule ahead looks busy. Both your body and time domains are showing stress signals.';
    }

    return {
      id: randomUUID(),
      ruleId: 'sleep-debt-accumulating',
      ruleName: 'Sleep Debt Accumulating',
      severity: 'warning',
      title: 'Sleep debt building up',
      body,
      domains: ['body', 'time'],
      createdAt: Date.now(),
      insightId: insight.id,
      whyExplanation: 'This alert fired because a declining sleep trend was detected while your calendar shows high upcoming commitments.',
    };
  },
};
