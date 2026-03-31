import { randomUUID } from 'node:crypto';
import type { TriggerRule, LifeInsight, TriggerContext, Alert } from '../../types.js';

/**
 * Fires when the Composer identifies a time optimization opportunity —
 * peak performance windows being blocked by meetings, context-switching
 * patterns, or schedule restructuring suggestions.
 */
export const productivityHack: TriggerRule = {
  id: 'productivity-hack',
  name: 'Productivity Hack',
  description: 'Fires on time-hack insights with actionable schedule improvements',

  watchInsightTypes: ['time-hack', 'energy-map'],
  watchDomains: ['time', 'body', 'mind'],

  severity: 'info',
  cooldownHours: 24,
  maxPerWeek: 3,

  condition(insight: LifeInsight, _context: TriggerContext): boolean {
    // Only surface if there's a concrete suggestion
    return insight.confidence >= 0.65 && !!insight.payload.suggestedAction;
  },

  async compose(insight: LifeInsight, _context: TriggerContext): Promise<Alert> {
    return {
      id: randomUUID(),
      ruleId: 'productivity-hack',
      ruleName: 'Productivity Hack',
      severity: 'info',
      title: insight.estimatedImpact
        ? `⚡ ${insight.estimatedImpact}`
        : '⚡ Productivity insight',
      body: insight.payload.description,
      domains: insight.domains,
      createdAt: Date.now(),
      insightId: insight.id,
      whyExplanation: insight.payload.whyItMatters,
      actionLabel: insight.payload.suggestedAction ? 'See suggestion' : undefined,
      actionType: 'open-detail',
    };
  },
};
