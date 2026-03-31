import { randomUUID } from 'node:crypto';
import { callModel } from '@pre/models';
import type { TriggerRule, LifeInsight, TriggerContext, Alert } from '../../types.js';

export const relationshipSilence: TriggerRule = {
  id: 'relationship-silence',
  name: 'Relationship Silence',
  description: 'Fires when communication in the people domain shows a declining anomaly',

  watchInsightTypes: ['anomaly'],
  watchDomains: ['people'],

  severity: 'info',
  cooldownHours: 168,
  maxPerWeek: 2,

  condition(insight: LifeInsight, _context: TriggerContext): boolean {
    if (!insight.domains.includes('people')) return false;
    const direction = insight.payload.metadata['direction'];
    return direction === 'declining';
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
            content: 'You generate brief, caring alerts. Do not recommend action. Do not use specific names or numbers.',
          },
          {
            role: 'user',
            content: 'Communication activity in the people domain has dropped significantly below the usual pattern. Generate a gentle alert about relationship engagement declining.',
          },
        ],
      });
      body = response.content;
    } catch {
      body = 'Communication patterns in your people domain have been unusually quiet recently.';
    }

    return {
      id: randomUUID(),
      ruleId: 'relationship-silence',
      ruleName: 'Relationship Silence',
      severity: 'info',
      title: 'Relationship engagement declining',
      body,
      domains: ['people'],
      createdAt: Date.now(),
      insightId: insight.id,
      whyExplanation: 'This alert fired because your communication patterns dropped significantly below your usual baseline.',
    };
  },
};
