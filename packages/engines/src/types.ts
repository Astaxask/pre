import type { LifeDomain, PrivacyLevel } from '@pre/shared';

// ---------------------------------------------------------------------------
// LifeInsight — produced by the inference engine
// ---------------------------------------------------------------------------

export type InsightType =
  | 'pattern-detected'
  | 'trend-change'
  | 'goal-drift'
  | 'conflict-detected'
  | 'anomaly'
  | 'correlation';

export type InsightPayload = {
  description: string;
  metadata: Record<string, unknown>;
};

export type LifeInsight = {
  id: string;
  generatedAt: number;
  domains: LifeDomain[];
  insightType: InsightType;
  confidence: number; // 0–1
  payload: InsightPayload;
  expiresAt: number;
  privacyLevel: PrivacyLevel;
};

// ---------------------------------------------------------------------------
// TriggerRule — evaluated by the proactive agent
// ---------------------------------------------------------------------------

export type AlertSeverity = 'info' | 'warning' | 'intervention';

export type Alert = {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  domains: LifeDomain[];
  createdAt: number;
  insightId: string;
  whyExplanation: string;
};

export type TriggerContext = {
  recentEventsByDomain: Map<LifeDomain, number>; // count per domain (last 72h)
  activeGoalCount: number;
  lastAlertForRule: number | null; // timestamp of last alert from this rule
};

export interface TriggerRule {
  id: string;
  name: string;
  description: string;

  watchInsightTypes: InsightType[];
  watchDomains: LifeDomain[];

  condition(insight: LifeInsight, context: TriggerContext): boolean;

  severity: AlertSeverity;

  cooldownHours: number;

  maxPerWeek: number;

  compose(insight: LifeInsight, context: TriggerContext): Promise<Alert>;
}

// ---------------------------------------------------------------------------
// Inference engine result
// ---------------------------------------------------------------------------

export type InferenceResult = {
  insightsGenerated: number;
  patternsDetected: number;
  durationMs: number;
  errors: string[];
};

// ---------------------------------------------------------------------------
// Pattern detection (from sidecar)
// ---------------------------------------------------------------------------

export type DetectedPattern = {
  type: 'correlation' | 'trend-change' | 'anomaly';
  domains: string[];
  confidence: number;
  metadata: Record<string, unknown>;
};
