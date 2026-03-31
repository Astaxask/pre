import { randomUUID } from 'node:crypto';
import type { TriggerRule, LifeInsight, TriggerContext, Alert } from '../../types.js';

/**
 * Fires when the Composer discovers something counter-intuitive about the
 * user's actual behavior vs their self-perception. These are the "wow"
 * moments — "I had no idea I did that."
 *
 * Saved for weekly digest since they're reflective, not urgent.
 */
export const selfKnowledgeReveal: TriggerRule = {
  id: 'self-knowledge-reveal',
  name: 'Self-Knowledge Reveal',
  description: 'Fires on self-knowledge insights that reveal surprising behavior patterns',

  watchInsightTypes: ['self-knowledge', 'behavior-loop'],
  watchDomains: ['body', 'money', 'people', 'time', 'mind', 'world'],

  severity: 'info',
  cooldownHours: 72,
  maxPerWeek: 2,

  condition(insight: LifeInsight, _context: TriggerContext): boolean {
    return insight.confidence >= 0.7;
  },

  async compose(insight: LifeInsight, _context: TriggerContext): Promise<Alert> {
    return {
      id: randomUUID(),
      ruleId: 'self-knowledge-reveal',
      ruleName: 'Self-Knowledge Reveal',
      severity: 'info',
      title: '🪞 Something about you',
      body: insight.payload.description,
      domains: insight.domains,
      createdAt: Date.now(),
      insightId: insight.id,
      whyExplanation: insight.payload.whyItMatters,
      actionLabel: 'Learn more',
      actionType: 'open-detail',
    };
  },
};
