import type { LifeDomain, PrivacyLevel } from '@pre/shared';

// ---------------------------------------------------------------------------
// InsightType — the full taxonomy of cognitive superpowers
// ---------------------------------------------------------------------------

export type InsightType =
  // Statistical patterns (from sidecar)
  | 'pattern-detected'
  | 'trend-change'
  | 'anomaly'
  | 'correlation'
  // Cross-domain cognitive insights (from Dynamic Insight Composer)
  | 'money-hack'           // Actionable savings, waste detection, optimization
  | 'time-hack'            // Schedule optimization, productivity patterns
  | 'health-correlation'   // Behavior X → health outcome Y
  | 'relationship-nudge'   // Reach out, back off, social isolation warning
  | 'idea-synthesis'       // Connecting dots across browsing/reading/work
  | 'self-knowledge'       // "You think X but data says Y"
  | 'prediction'           // "Based on patterns, X will happen in Y days"
  | 'behavior-loop'        // Detected habit loop (cue → routine → reward)
  | 'energy-map'           // Peak performance windows, recovery needs
  | 'goal-drift'           // Stagnation or abandonment pattern
  | 'opportunity'          // You're positioned to do X
  | 'conflict-detected'    // Two commitments/goals/patterns contradicting
  | 'burnout-signal'       // Compound stress indicators across domains
  | 'decision-support';    // Data-backed recommendation for pending decision

// ---------------------------------------------------------------------------
// InsightCategory — what kind of value does this insight deliver?
// ---------------------------------------------------------------------------

export type InsightCategory =
  | 'save-money'       // Direct financial benefit
  | 'save-time'        // Reclaim wasted time
  | 'protect-health'   // Prevent health degradation
  | 'deepen-relations' // Strengthen relationships
  | 'boost-output'     // Increase productivity
  | 'expand-awareness' // Self-knowledge, meta-cognition
  | 'seize-opportunity'// Time-sensitive upside
  | 'prevent-harm';    // Avoid a negative outcome

// ---------------------------------------------------------------------------
// NotificationUrgency — how should this reach the user?
// ---------------------------------------------------------------------------

export type NotificationUrgency =
  | 'interrupt'   // Push notification NOW (financial risk, health warning, time-sensitive)
  | 'ambient'     // Show when user next checks the app (interesting but not urgent)
  | 'digest'      // Save for daily/weekly review (patterns, self-knowledge)
  | 'silent';     // Log it but don't surface (data point for future reasoning)

// ---------------------------------------------------------------------------
// LifeInsight — the expanded insight structure
// ---------------------------------------------------------------------------

export type InsightPayload = {
  /** Human-readable insight (1-3 sentences, actionable) */
  description: string;

  /** Why this matters — the "so what?" */
  whyItMatters: string;

  /** Specific suggested action (optional, but preferred) */
  suggestedAction?: string;

  /** Supporting evidence — what data points led to this insight */
  evidence: InsightEvidence[];

  /** Raw metadata from detection */
  metadata: Record<string, unknown>;
};

export type InsightEvidence = {
  domain: LifeDomain;
  summary: string;
  /** Relative time description: "last 3 days", "past month", etc. */
  timeframe: string;
};

export type LifeInsight = {
  id: string;
  generatedAt: number;
  domains: LifeDomain[];
  insightType: InsightType;
  category: InsightCategory;
  urgency: NotificationUrgency;
  confidence: number; // 0–1
  /** Estimated value: how much time/money/health this could save/improve */
  estimatedImpact?: string;
  payload: InsightPayload;
  expiresAt: number;
  privacyLevel: PrivacyLevel;
  /** If true, user has seen this insight */
  seen: boolean;
  /** If true, user dismissed this insight */
  dismissed: boolean;
};

// ---------------------------------------------------------------------------
// Alert — produced by the proactive agent from insights
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
  /** Suggested action button text */
  actionLabel?: string;
  /** What happens if user taps the action */
  actionType?: 'dismiss' | 'snooze' | 'open-detail' | 'open-external';
};

// ---------------------------------------------------------------------------
// TriggerRule — evaluated by the proactive agent
// ---------------------------------------------------------------------------

export type TriggerContext = {
  recentEventsByDomain: Map<LifeDomain, number>; // count per domain (last 72h)
  activeGoalCount: number;
  lastAlertForRule: number | null;
  /** Snapshot of recent events for deeper analysis */
  recentEvents?: Array<{
    domain: LifeDomain;
    eventType: string;
    timestamp: number;
    payload: Record<string, unknown>;
  }>;
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
  composerInsights: number;  // Insights from Dynamic Insight Composer
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

// ---------------------------------------------------------------------------
// Dynamic Insight Composer — types for the LLM-powered insight generator
// ---------------------------------------------------------------------------

/** A structured snapshot of the user's life data, sent to the LLM */
export type LifeSnapshot = {
  /** Time range this snapshot covers */
  windowHours: number;

  /** Per-domain summaries (no raw data, only aggregates) */
  domainSummaries: DomainSummary[];

  /** Active goals */
  goals: Array<{
    title: string;
    domain: LifeDomain;
    status: string;
    daysSinceActivity: number;
  }>;

  /** Recently detected statistical patterns */
  recentPatterns: Array<{
    type: string;
    domains: string[];
    direction: string;
    confidence: number;
  }>;

  /** Previous insights (to avoid repetition) */
  recentInsightTypes: InsightType[];
};

export type DomainSummary = {
  domain: LifeDomain;
  eventCount: number;
  /** Key aggregates (e.g., "avg sleep: 6.2h", "total spend: moderate") */
  highlights: string[];
  /** Trend direction over the window */
  trend: 'increasing' | 'decreasing' | 'stable' | 'insufficient-data';
  /** Notable anomalies or changes */
  anomalies: string[];
};

/** The LLM's response from the Dynamic Insight Composer */
export type ComposerOutput = {
  insights: Array<{
    type: InsightType;
    category: InsightCategory;
    urgency: NotificationUrgency;
    confidence: number;
    domains: LifeDomain[];
    description: string;
    whyItMatters: string;
    suggestedAction?: string;
    estimatedImpact?: string;
    evidence: Array<{
      domain: LifeDomain;
      summary: string;
      timeframe: string;
    }>;
  }>;
};
