import { randomUUID } from 'node:crypto';
import { callModel } from '@pre/models';
import type { TriggerRule, LifeInsight, TriggerContext, Alert } from '../../types.js';

export const financialStressPattern: TriggerRule = {
  id: 'financial-stress-pattern',
  name: 'Financial Stress Pattern',
  description: 'Fires when a negative correlation is detected between money stress and HRV/body metrics',

  watchInsightTypes: ['correlation'],
  watchDomains: ['money', 'body'],

  severity: 'warning',
  cooldownHours: 96,
  maxPerWeek: 1,

  condition(insight: LifeInsight, _context: TriggerContext): boolean {
    if (!insight.domains.includes('money') || !insight.domains.includes('body')) return false;
    const r = insight.payload.metadata['r_value'];
    if (typeof r !== 'number') return false;
    // Negative correlation: money stress ↑ when HRV ↓ (r < -0.65)
    return r < -0.65 || Math.abs(r) > 0.65;
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
            content: 'You generate brief, caring alerts. Do not recommend action. Do not use specific numbers. Name the domains involved. Include a "why am I seeing this" explanation.',
          },
          {
            role: 'user',
            content: 'A correlation was detected between financial patterns and body health metrics. When financial stress increases, physical recovery appears to decrease. Generate an alert.',
          },
        ],
      });
      body = response.content;
    } catch {
      body = 'A pattern has emerged linking your financial activity and physical wellbeing. Changes in your money domain appear correlated with changes in your body domain.';
    }

    return {
      id: randomUUID(),
      ruleId: 'financial-stress-pattern',
      ruleName: 'Financial Stress Pattern',
      severity: 'warning',
      title: 'Financial stress affecting health',
      body,
      domains: ['money', 'body'],
      createdAt: Date.now(),
      insightId: insight.id,
      whyExplanation: 'This alert fired because a statistical correlation was detected between your financial patterns and body health metrics.',
    };
  },
};
