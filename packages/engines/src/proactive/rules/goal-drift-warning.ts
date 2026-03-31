import { randomUUID } from 'node:crypto';
import { callModel } from '@pre/models';
import type { TriggerRule, LifeInsight, TriggerContext, Alert } from '../../types.js';

export const goalDriftWarning: TriggerRule = {
  id: 'goal-drift-warning',
  name: 'Goal Drift Warning',
  description: 'Fires when an active goal has had zero relevant events for 14+ days',

  watchInsightTypes: ['goal-drift'],
  watchDomains: ['body', 'money', 'people', 'time', 'mind', 'world'],

  severity: 'info',
  cooldownHours: 168, // 7 days
  maxPerWeek: 3,

  condition(insight: LifeInsight, _context: TriggerContext): boolean {
    // Always true for goal-drift insights — the detection already validated the absence
    return insight.insightType === 'goal-drift';
  },

  async compose(insight: LifeInsight, _context: TriggerContext): Promise<Alert> {
    const goalTitle = insight.payload.metadata['goalTitle'] ?? 'a goal';

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
            content: `A goal in the ${insight.domains.join(', ')} domain has had no related activity for over two weeks. Generate a gentle reminder alert.`,
          },
        ],
      });
      body = response.content;
    } catch {
      body = `An active goal in the ${insight.domains.join(' and ')} domain hasn't seen any related activity recently.`;
    }

    return {
      id: randomUUID(),
      ruleId: 'goal-drift-warning',
      ruleName: 'Goal Drift Warning',
      severity: 'info',
      title: 'Goal activity has paused',
      body,
      domains: insight.domains,
      createdAt: Date.now(),
      insightId: insight.id,
      whyExplanation: `This alert fired because no events related to your goal "${String(goalTitle)}" were detected in the past 14 days.`,
    };
  },
};
