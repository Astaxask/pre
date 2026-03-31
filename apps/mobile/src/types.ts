export type LifeDomain = 'body' | 'money' | 'people' | 'time' | 'mind' | 'world';

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
  dismissed?: boolean;
};

export type InsightType =
  | 'pattern-detected'
  | 'trend-change'
  | 'goal-drift'
  | 'conflict-detected'
  | 'anomaly'
  | 'correlation';

export type LifeInsight = {
  id: string;
  generatedAt: number;
  domains: LifeDomain[];
  insightType: InsightType;
  confidence: number;
  payload: { description: string; metadata: Record<string, unknown> };
  expiresAt: number;
  privacyLevel: string;
};

export type Goal = {
  id: string;
  title: string;
  domain: string;
  targetDate: number | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  progressPercent?: number;
};
