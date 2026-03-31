import { randomUUID } from 'node:crypto';
import type { LifeDomain, LifeEvent } from '@pre/shared';
import type { MemoryReader, Goal } from '@pre/memory';
import { callModel } from '@pre/models';
import type {
  LifeInsight,
  InsightType,
  InferenceResult,
  DetectedPattern,
} from '../types.js';

// ---------------------------------------------------------------------------
// Types for dependencies (injected at construction)
// ---------------------------------------------------------------------------

type SidecarInterface = {
  similaritySearch(
    queryEmbedding: number[],
    topK: number,
    domains?: LifeDomain[],
  ): Promise<Array<{ id: string; domain: string; eventType: string; timestamp: number; summary: string }>>;
  detectPatterns(events: Array<Record<string, unknown>>): Promise<DetectedPattern[]>;
  isReady(): Promise<boolean>;
};

type EventBusInterface = {
  emit(event: string, payload: unknown): void;
};

export type InferenceEngineDeps = {
  reader: MemoryReader;
  sidecar: SidecarInterface;
  bus: EventBusInterface;
};

// ---------------------------------------------------------------------------
// In-memory insight store with TTL
// ---------------------------------------------------------------------------

const insightStore = new Map<string, LifeInsight>();

export function getInsights(): LifeInsight[] {
  evictExpired();
  return Array.from(insightStore.values());
}

function evictExpired(): void {
  const now = Date.now();
  for (const [id, insight] of insightStore) {
    if (insight.expiresAt < now) {
      insightStore.delete(id);
    }
  }
}

function publishInsight(insight: LifeInsight): void {
  insightStore.set(insight.id, insight);
}

// ---------------------------------------------------------------------------
// All six life domains
// ---------------------------------------------------------------------------

const ALL_DOMAINS: LifeDomain[] = ['body', 'money', 'people', 'time', 'mind', 'world'];

// ---------------------------------------------------------------------------
// Payload extraction — numeric values only for pattern detection
// ---------------------------------------------------------------------------

function extractNumericFields(event: LifeEvent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    domain: event.domain,
    timestamp: event.timestamp,
    eventType: event.eventType,
  };

  const p = event.payload;
  if (p.domain === 'body') {
    if ('sleepDuration' in p && p.sleepDuration != null) base['sleepDurationHours'] = p.sleepDuration;
    if ('hrvMs' in p && p.hrvMs != null) base['hrvMs'] = p.hrvMs;
    if ('restingHeartRate' in p && p.restingHeartRate != null) base['restingHeartRate'] = p.restingHeartRate;
    if ('recoveryScore' in p && p.recoveryScore != null) base['recoveryScore'] = p.recoveryScore;
  } else if (p.domain === 'money') {
    if ('amount' in p && p.amount != null) {
      base['amount'] = p.amount;
      base['direction'] = 'direction' in p ? p.direction : 'debit';
    }
  } else if (p.domain === 'time') {
    if ('durationMinutes' in p && p.durationMinutes != null) base['durationMinutes'] = p.durationMinutes;
  } else if (p.domain === 'people') {
    base['communicationCount'] = 1;
  } else if (p.domain === 'mind') {
    if ('progressPercent' in p && p.progressPercent != null) base['progressPercent'] = p.progressPercent;
  }

  return base;
}

// ---------------------------------------------------------------------------
// run() — the entry point
// ---------------------------------------------------------------------------

export async function run(deps: InferenceEngineDeps): Promise<InferenceResult> {
  const startMs = Date.now();
  const errors: string[] = [];
  let patternsDetected = 0;
  let insightsGenerated = 0;

  try {
    // STEP 1: SNAPSHOT
    const allEvents: LifeEvent[] = [];
    for (const domain of ALL_DOMAINS) {
      try {
        const events = await deps.reader.recentByDomain(domain, 72);
        allEvents.push(...events);
      } catch (e) {
        errors.push(`Snapshot failed for ${domain}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (allEvents.length < 50) {
      console.log(`[inference] Insufficient data for inference pass (${allEvents.length} events, need 50+)`);
      return {
        insightsGenerated: 0,
        patternsDetected: 0,
        durationMs: Date.now() - startMs,
        errors,
      };
    }

    // STEP 2: EMBED & SEARCH
    const twoHoursAgo = Date.now() - 2 * 3600000;
    const recentEvents = allEvents.filter((e) => e.ingestedAt > twoHoursAgo);
    const semanticContext: Array<{ id: string; domain: string; summary: string }> = [];

    let sidecarAvailable = false;
    try {
      sidecarAvailable = await deps.sidecar.isReady();
    } catch {
      // Sidecar not available
    }

    if (sidecarAvailable && recentEvents.length > 0) {
      for (const event of recentEvents.slice(0, 10)) {
        // Only search if event has an embedding (via summary)
        if (!event.summary) continue;
        try {
          const similar = await deps.sidecar.similaritySearch(
            [], // We don't have the embedding here; the sidecar would need the text
            5,
            [event.domain as LifeDomain],
          );
          semanticContext.push(...similar);
        } catch (e) {
          errors.push(`Similarity search failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    // STEP 3: PATTERN DETECTION
    const patterns: DetectedPattern[] = [];
    if (sidecarAvailable) {
      try {
        const extracted = allEvents.map(extractNumericFields);
        const detected = await deps.sidecar.detectPatterns(extracted);
        patterns.push(...detected);
        patternsDetected = detected.length;
      } catch (e) {
        errors.push(`Pattern detection failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // STEP 4: LLM REASONING
    for (const pattern of patterns) {
      try {
        const insight = await reasonAboutPattern(pattern);
        if (insight) {
          publishInsight(insight);
          insightsGenerated++;
        }
      } catch (e) {
        errors.push(`LLM reasoning failed for pattern: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // STEP 5: GOAL DRIFT CHECK
    try {
      const goalInsights = await checkGoalDrift(deps.reader, allEvents);
      for (const insight of goalInsights) {
        publishInsight(insight);
        insightsGenerated++;
      }
    } catch (e) {
      errors.push(`Goal drift check failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // STEP 6: PUBLISH
    evictExpired();
    const currentInsights = getInsights();
    deps.bus.emit('insights-updated', { insights: currentInsights });

  } catch (e) {
    errors.push(`Pipeline error: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    insightsGenerated,
    patternsDetected,
    durationMs: Date.now() - startMs,
    errors,
  };
}

// ---------------------------------------------------------------------------
// LLM Reasoning — convert pattern to LifeInsight
// ---------------------------------------------------------------------------

async function reasonAboutPattern(pattern: DetectedPattern): Promise<LifeInsight | null> {
  const direction =
    pattern.metadata['direction'] ?? pattern.metadata['slope_direction'] ?? 'unknown';

  const messages = [
    {
      role: 'system' as const,
      content: [
        'You are an analyst for a personal life-tracking system.',
        'Given a detected pattern across life domains, produce a brief insight.',
        'Rules:',
        '- Do NOT include specific numbers, dollar amounts, or PII.',
        '- Describe the pattern in general terms.',
        '- Name the domains involved.',
        '- Keep it under 2 sentences.',
      ].join('\n'),
    },
    {
      role: 'user' as const,
      content: `Pattern detected: type="${pattern.type}", domains=${pattern.domains.join(', ')}, direction="${String(direction)}", confidence=${pattern.confidence.toFixed(2)}.`,
    },
  ];

  try {
    const response = await callModel({
      task: 'pattern-analysis',
      privacyLevel: 'private',
      messages,
    });

    const insightType: InsightType =
      pattern.type === 'correlation' ? 'correlation' :
      pattern.type === 'trend-change' ? 'trend-change' :
      'anomaly';

    const ttlMs =
      insightType === 'anomaly' ? 6 * 3600000 : 24 * 3600000;

    return {
      id: randomUUID(),
      generatedAt: Date.now(),
      domains: pattern.domains as LifeDomain[],
      insightType,
      confidence: pattern.confidence,
      payload: {
        description: response.content,
        metadata: pattern.metadata,
      },
      expiresAt: Date.now() + ttlMs,
      privacyLevel: 'private',
    };
  } catch (e) {
    console.warn(`[inference] LLM reasoning failed: ${e instanceof Error ? e.message : String(e)}`);
    // Return a fallback insight without LLM text
    return {
      id: randomUUID(),
      generatedAt: Date.now(),
      domains: pattern.domains as LifeDomain[],
      insightType: pattern.type === 'correlation' ? 'correlation' : pattern.type === 'trend-change' ? 'trend-change' : 'anomaly',
      confidence: pattern.confidence,
      payload: {
        description: `${pattern.type} detected across ${pattern.domains.join(' and ')}`,
        metadata: pattern.metadata,
      },
      expiresAt: Date.now() + 24 * 3600000,
      privacyLevel: 'private',
    };
  }
}

// ---------------------------------------------------------------------------
// Goal Drift Check
// ---------------------------------------------------------------------------

async function checkGoalDrift(
  reader: MemoryReader,
  allEvents: LifeEvent[],
): Promise<LifeInsight[]> {
  const insights: LifeInsight[] = [];
  let activeGoals: Goal[];

  try {
    activeGoals = await reader.goals('active');
  } catch {
    return insights;
  }

  if (activeGoals.length === 0) return insights;

  const fourteenDaysAgo = Date.now() - 14 * 24 * 3600000;

  for (const goal of activeGoals) {
    const domain = goal.domain as LifeDomain;
    const domainEvents = allEvents.filter(
      (e) => e.domain === domain && e.timestamp > fourteenDaysAgo,
    );

    if (domainEvents.length === 0) {
      // Zero relevant events in 14 days → high-confidence drift
      insights.push({
        id: randomUUID(),
        generatedAt: Date.now(),
        domains: [domain],
        insightType: 'goal-drift',
        confidence: 0.9,
        payload: {
          description: `Goal "${goal.title}" has had no related activity in the ${domain} domain for over 14 days`,
          metadata: { goalId: goal.id, goalTitle: goal.title, daysSinceActivity: 14 },
        },
        expiresAt: Date.now() + 24 * 3600000,
        privacyLevel: 'private',
      });
    }
    // If events exist but trend is declining, we'd check here
    // but we need the trend-change patterns from the sidecar first
  }

  return insights;
}
