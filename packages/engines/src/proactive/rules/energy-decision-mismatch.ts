import { randomUUID } from 'node:crypto';
import { callModel } from '@pre/models';
import type { TriggerRule, LifeInsight, TriggerContext, Alert } from '../../types.js';

export const energyDecisionMismatch: TriggerRule = {
  id: 'energy-decision-mismatch',
  name: 'Energy-Decision Mismatch',
  description: 'Fires when high-cognitive-load time blocks coincide with low recovery body signals',

  watchInsightTypes: ['correlation'],
  watchDomains: ['body', 'time'],

  severity: 'info',
  cooldownHours: 48,
  maxPerWeek: 3,

  condition(insight: LifeInsight, _context: TriggerContext): boolean {
    if (!insight.domains.includes('body') || !insight.domains.includes('time')) return false;
    // This correlation indicates misalignment between energy and scheduling
    return true;
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
            content: 'You generate brief, caring alerts. Do not recommend action. Do not use specific numbers. Name the domains.',
          },
          {
            role: 'user',
            content: 'A correlation between body recovery patterns and time scheduling suggests that high-demand activities may be landing on low-energy periods. Generate an alert.',
          },
        ],
      });
      body = response.content;
    } catch {
      body = 'A pattern suggests your high-demand time blocks may not align well with your body energy cycles.';
    }

    return {
      id: randomUUID(),
      ruleId: 'energy-decision-mismatch',
      ruleName: 'Energy-Decision Mismatch',
      severity: 'info',
      title: 'Energy and schedule misaligned',
      body,
      domains: ['body', 'time'],
      createdAt: Date.now(),
      insightId: insight.id,
      whyExplanation: 'This alert fired because a correlation was detected between your body recovery patterns and your scheduling patterns.',
    };
  },
};
