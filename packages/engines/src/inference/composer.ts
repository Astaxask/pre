// ---------------------------------------------------------------------------
// Dynamic Insight Composer
//
// This is the brain. Instead of matching against hardcoded rules, it uses
// an LLM to reason across ALL of the user's life data and discover insights
// that no predefined rule could anticipate.
//
// How it works:
// 1. Build a privacy-safe "life snapshot" — aggregated summaries per domain,
//    no raw data, no PII, no dollar amounts, no names
// 2. Send the snapshot to the LLM with a system prompt that teaches it
//    the full taxonomy of insight types
// 3. The LLM identifies the most valuable insights it can surface
// 4. Parse the structured response into LifeInsight objects
//
// The key innovation: the LLM is not just labeling patterns — it's doing
// genuine cross-domain REASONING. It can connect sleep quality to spending
// habits, browser patterns to career goals, social isolation to health
// outcomes, in ways that statistical pattern detection never could.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import type { LifeDomain, LifeEvent } from '@pre/shared';
import type { MemoryReader, Goal } from '@pre/memory';
import { callModel } from '@pre/models';
import type {
  LifeInsight,
  LifeSnapshot,
  DomainSummary,
  ComposerOutput,
  InsightType,
  InsightCategory,
  NotificationUrgency,
  DetectedPattern,
} from '../types.js';

// ---------------------------------------------------------------------------
// The system prompt — this is what makes PRE a superpower
// ---------------------------------------------------------------------------

const COMPOSER_SYSTEM_PROMPT = `You are the cognitive core of PRE — a Personal Reality Engine that acts as the user's second brain. You have access to aggregated summaries of a person's life across 6 domains: body (health/fitness), money (finances), people (relationships), time (calendar/productivity), mind (goals/learning/browsing), and world (location/environment).

Your job: identify the MOST VALUABLE insights you can surface to this person RIGHT NOW. Not obvious observations — genuine cognitive superpowers that connect dots across domains in ways the human brain cannot.

## Insight Types You Can Generate

- **money-hack**: Actionable savings or financial optimization. "You're paying for X but haven't used it in Y days." "Your spending spikes on days with pattern Z — here's how to prevent it."
- **time-hack**: Schedule/productivity optimization. "Your peak deep-work window is X-Y but you have meetings during it." "You context-switch N times/hour on Mondays."
- **health-correlation**: Cross-domain health insight. "When you sleep under Xh, your spending increases Y% the next day." "Your productivity drops Z% after sedentary days."
- **relationship-nudge**: Social connection insight. "You haven't contacted [person] in X days, your average gap is Y." "Communication with [person] is becoming one-sided."
- **idea-synthesis**: Connect browsing/reading/learning patterns. "You've been researching X across Y sessions — here's the pattern."
- **self-knowledge**: Counter-intuitive self-insight. "You think you're a morning person but your peak output is at X." "You consistently underestimate task duration by Xx."
- **prediction**: Probabilistic forecast. "Based on your current trajectory, X will happen in Y days."
- **behavior-loop**: Detected habit loop. "Every time X happens, you do Y, which leads to Z."
- **energy-map**: Performance/energy pattern. "Your energy dips at X time — this correlates with Y."
- **burnout-signal**: Compound stress warning. "Multiple indicators suggest rising stress: X, Y, Z."
- **opportunity**: Time-sensitive upside. "You're positioned to do X because of Y."
- **conflict-detected**: Contradicting goals/commitments. "Goal A requires X, but your behavior shows Y."
- **decision-support**: Data-backed recommendation. "You're facing X decision — here's what your data says."
- **goal-drift**: Goal stagnation. "No activity toward goal X in Y days."

## Rules

1. NEVER include specific dollar amounts, account numbers, names, or PII in your output
2. Use relative terms: "moderate spending", "above your average", "declining trend"
3. Prioritize CROSS-DOMAIN insights (connecting 2+ domains) over single-domain observations
4. Prioritize ACTIONABLE insights over observations
5. Be specific about what the user should DO, not just what you noticed
6. Assign urgency honestly: "interrupt" only for financial risk, health warning, or time-sensitive items
7. Don't repeat insights the user has recently seen (check recentInsightTypes)
8. Quality over quantity: 1-3 genuinely valuable insights is better than 5 generic ones
9. The "whyItMatters" field should answer: "Why should I care about this RIGHT NOW?"
10. Evidence should cite specific domain data that supports the insight

## Response Format

Respond with ONLY a valid JSON object (no markdown, no code fences):
{
  "insights": [
    {
      "type": "<InsightType>",
      "category": "<InsightCategory: save-money|save-time|protect-health|deepen-relations|boost-output|expand-awareness|seize-opportunity|prevent-harm>",
      "urgency": "<interrupt|ambient|digest|silent>",
      "confidence": 0.0-1.0,
      "domains": ["domain1", "domain2"],
      "description": "1-2 sentence insight",
      "whyItMatters": "Why this matters right now",
      "suggestedAction": "What to do about it",
      "estimatedImpact": "e.g., 'save ~2h/week' or 'reduce spending ~15%'",
      "evidence": [
        {"domain": "...", "summary": "what data supports this", "timeframe": "last 7 days"}
      ]
    }
  ]
}

If there are no genuinely valuable insights to surface, return {"insights": []}.
Do NOT fabricate insights. Only report what the data actually shows.`;

// ---------------------------------------------------------------------------
// buildLifeSnapshot — aggregate raw events into privacy-safe summaries
// ---------------------------------------------------------------------------

export async function buildLifeSnapshot(
  reader: MemoryReader,
  allEvents: LifeEvent[],
  patterns: DetectedPattern[],
  recentInsightTypes: InsightType[],
  windowHours: number = 72,
): Promise<LifeSnapshot> {
  const domainSummaries: DomainSummary[] = [];

  // Group events by domain
  const byDomain = new Map<LifeDomain, LifeEvent[]>();
  for (const e of allEvents) {
    const existing = byDomain.get(e.domain as LifeDomain) ?? [];
    existing.push(e);
    byDomain.set(e.domain as LifeDomain, existing);
  }

  const allDomains: LifeDomain[] = ['body', 'money', 'people', 'time', 'mind', 'world'];

  for (const domain of allDomains) {
    const events = byDomain.get(domain) ?? [];
    const summary = summarizeDomain(domain, events, windowHours);
    domainSummaries.push(summary);
  }

  // Goals
  let goals: Goal[] = [];
  try {
    goals = await reader.goals('active');
  } catch {
    // ok
  }

  const goalSummaries = goals.map((g) => {
    const domain = g.domain as LifeDomain;
    const domainEvents = byDomain.get(domain) ?? [];
    const lastEventTs = domainEvents.length > 0
      ? Math.max(...domainEvents.map((e) => e.timestamp))
      : 0;
    const daysSince = lastEventTs > 0
      ? Math.floor((Date.now() - lastEventTs) / (24 * 3600000))
      : 999;

    return {
      title: g.title,
      domain,
      status: g.status ?? 'active',
      daysSinceActivity: daysSince,
    };
  });

  // Recent patterns from sidecar
  const recentPatterns = patterns.map((p) => ({
    type: p.type,
    domains: p.domains,
    direction: String(p.metadata['direction'] ?? p.metadata['slope_direction'] ?? 'unknown'),
    confidence: p.confidence,
  }));

  return {
    windowHours,
    domainSummaries,
    goals: goalSummaries,
    recentPatterns,
    recentInsightTypes,
  };
}

// ---------------------------------------------------------------------------
// Per-domain summarization — PRIVACY SAFE (no raw values, only aggregates)
// ---------------------------------------------------------------------------

function summarizeDomain(
  domain: LifeDomain,
  events: LifeEvent[],
  windowHours: number,
): DomainSummary {
  if (events.length === 0) {
    return {
      domain,
      eventCount: 0,
      highlights: [],
      trend: 'insufficient-data',
      anomalies: [],
    };
  }

  const highlights: string[] = [];
  const anomalies: string[] = [];

  // Sort by timestamp
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const midpoint = Math.floor(sorted.length / 2);
  const firstHalf = sorted.slice(0, midpoint);
  const secondHalf = sorted.slice(midpoint);

  // Detect trend by comparing event density in first vs second half
  let trend: DomainSummary['trend'] = 'stable';
  if (events.length >= 4) {
    const ratio = secondHalf.length / Math.max(firstHalf.length, 1);
    if (ratio > 1.3) trend = 'increasing';
    else if (ratio < 0.7) trend = 'decreasing';
  } else {
    trend = 'insufficient-data';
  }

  switch (domain) {
    case 'body': {
      const subtypes = countSubtypes(events);
      if (subtypes['sleep']) highlights.push(`${subtypes['sleep']} sleep records`);
      if (subtypes['activity'] || subtypes['motion-activity']) {
        highlights.push(`${(subtypes['activity'] ?? 0) + (subtypes['motion-activity'] ?? 0)} activity records`);
      }
      // Compute averages without revealing exact numbers
      const sleepEvents = events.filter((e) => e.payload.subtype === 'sleep');
      if (sleepEvents.length >= 3) {
        const durations = sleepEvents
          .map((e) => ('sleepDuration' in e.payload ? e.payload.sleepDuration : null))
          .filter((d): d is number => d != null);
        if (durations.length > 0) {
          const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
          const label = avg > 480 ? 'above average' : avg > 360 ? 'moderate' : 'below recommended';
          highlights.push(`sleep duration: ${label}`);
          // Detect declining sleep
          if (durations.length >= 4) {
            const recentAvg = durations.slice(-2).reduce((a, b) => a + b, 0) / 2;
            const olderAvg = durations.slice(0, 2).reduce((a, b) => a + b, 0) / 2;
            if (recentAvg < olderAvg * 0.85) anomalies.push('sleep duration declining recently');
          }
        }
      }
      break;
    }

    case 'money': {
      const subtypes = countSubtypes(events);
      if (subtypes['transaction']) {
        highlights.push(`${subtypes['transaction']} transactions`);
        // Spending frequency trend (not amounts)
        const debits = events.filter(
          (e) => e.payload.subtype === 'transaction' && 'direction' in e.payload && e.payload.direction === 'debit',
        );
        const credits = events.filter(
          (e) => e.payload.subtype === 'transaction' && 'direction' in e.payload && e.payload.direction === 'credit',
        );
        highlights.push(`${debits.length} outgoing, ${credits.length} incoming`);

        // Detect spending frequency spikes (without revealing amounts)
        const dailySpendCounts = groupByDay(debits);
        const avgDaily = Object.values(dailySpendCounts).reduce((a, b) => a + b, 0) / Math.max(Object.keys(dailySpendCounts).length, 1);
        const maxDay = Math.max(...Object.values(dailySpendCounts), 0);
        if (maxDay > avgDaily * 2) anomalies.push('spending frequency spiked on at least one day');
      }
      if (subtypes['balance-snapshot']) highlights.push(`${subtypes['balance-snapshot']} balance snapshots`);
      break;
    }

    case 'people': {
      const subtypes = countSubtypes(events);
      if (subtypes['communication']) {
        highlights.push(`${subtypes['communication']} communication events`);
        const sent = events.filter((e) => 'direction' in e.payload && e.payload.direction === 'sent').length;
        const received = events.filter((e) => 'direction' in e.payload && e.payload.direction === 'received').length;
        highlights.push(`${sent} sent, ${received} received`);
        if (sent > received * 3) anomalies.push('heavily outgoing communication ratio');
        if (received > sent * 3) anomalies.push('heavily incoming communication ratio');
      }
      if (subtypes['meeting']) highlights.push(`${subtypes['meeting']} meetings`);
      break;
    }

    case 'time': {
      const subtypes = countSubtypes(events);
      if (subtypes['calendar-event']) highlights.push(`${subtypes['calendar-event']} calendar events`);
      if (subtypes['app-session']) {
        highlights.push(`${subtypes['app-session']} app sessions tracked`);
        // Group by app
        const apps = new Map<string, number>();
        for (const e of events) {
          if (e.payload.subtype === 'app-session' && 'appName' in e.payload) {
            const name = String(e.payload.appName);
            apps.set(name, (apps.get(name) ?? 0) + 1);
          }
        }
        if (apps.size > 0) {
          const topApps = Array.from(apps.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);
          highlights.push(`top apps: ${topApps.map(([name, count]) => `${name} (${count} sessions)`).join(', ')}`);
        }
      }
      if (subtypes['screen-session']) {
        const idleSessions = events.filter(
          (e) => e.payload.subtype === 'screen-session' && 'screenState' in e.payload && e.payload.screenState === 'idle',
        );
        if (idleSessions.length > 0) highlights.push(`${idleSessions.length} idle periods detected`);
      }
      break;
    }

    case 'mind': {
      const subtypes = countSubtypes(events);
      if (subtypes['browsing-session']) {
        highlights.push(`${subtypes['browsing-session']} browsing sessions`);
        // Top domains
        const domains = new Map<string, number>();
        for (const e of events) {
          if (e.payload.subtype === 'browsing-session' && 'domainVisited' in e.payload) {
            const d = String(e.payload.domainVisited);
            domains.set(d, (domains.get(d) ?? 0) + 1);
          }
        }
        if (domains.size > 0) {
          const topDomains = Array.from(domains.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
          highlights.push(`top sites: ${topDomains.map(([d, c]) => `${d} (${c})`).join(', ')}`);
        }
      }
      if (subtypes['now-playing']) highlights.push(`${subtypes['now-playing']} tracks played`);
      if (subtypes['goal'] || subtypes['goal-progress']) {
        highlights.push(`${(subtypes['goal'] ?? 0) + (subtypes['goal-progress'] ?? 0)} goal-related events`);
      }
      if (subtypes['mood-log']) highlights.push(`${subtypes['mood-log']} mood logs`);
      break;
    }

    case 'world': {
      const subtypes = countSubtypes(events);
      if (subtypes['location-context']) {
        highlights.push(`${subtypes['location-context']} location changes`);
      }
      if (subtypes['weather']) highlights.push(`${subtypes['weather']} weather records`);
      break;
    }
  }

  return {
    domain,
    eventCount: events.length,
    highlights,
    trend,
    anomalies,
  };
}

function countSubtypes(events: LifeEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) {
    const subtype = e.payload.subtype ?? e.eventType;
    counts[subtype] = (counts[subtype] ?? 0) + 1;
  }
  return counts;
}

function groupByDay(events: LifeEvent[]): Record<string, number> {
  const days: Record<string, number> = {};
  for (const e of events) {
    const day = new Date(e.timestamp).toISOString().slice(0, 10);
    days[day] = (days[day] ?? 0) + 1;
  }
  return days;
}

// ---------------------------------------------------------------------------
// compose() — the main entry point for Dynamic Insight Composer
// ---------------------------------------------------------------------------

export async function compose(
  snapshot: LifeSnapshot,
): Promise<LifeInsight[]> {
  // Don't run if we have almost no data
  const totalEvents = snapshot.domainSummaries.reduce((sum, d) => sum + d.eventCount, 0);
  if (totalEvents < 20) {
    return [];
  }

  // Count how many domains have meaningful data
  const activeDomains = snapshot.domainSummaries.filter((d) => d.eventCount > 0).length;
  if (activeDomains < 2) {
    // Need at least 2 domains for cross-domain reasoning
    return [];
  }

  const snapshotText = formatSnapshotForLLM(snapshot);

  const messages = [
    {
      role: 'system' as const,
      content: COMPOSER_SYSTEM_PROMPT,
    },
    {
      role: 'user' as const,
      content: snapshotText,
    },
  ];

  try {
    const response = await callModel({
      task: 'insight-composer',
      privacyLevel: 'private', // Everything stays local
      messages,
    });

    const parsed = parseComposerResponse(response.content);
    if (!parsed || parsed.insights.length === 0) {
      return [];
    }

    return parsed.insights.map((i) => ({
      id: randomUUID(),
      generatedAt: Date.now(),
      domains: i.domains,
      insightType: i.type,
      category: i.category,
      urgency: i.urgency,
      confidence: Math.min(Math.max(i.confidence, 0), 1),
      estimatedImpact: i.estimatedImpact,
      payload: {
        description: i.description,
        whyItMatters: i.whyItMatters,
        suggestedAction: i.suggestedAction,
        evidence: i.evidence,
        metadata: {},
      },
      expiresAt: Date.now() + ttlForType(i.type),
      privacyLevel: 'private' as const,
      seen: false,
      dismissed: false,
    }));
  } catch (e) {
    console.warn(
      `[composer] LLM insight composition failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Format the snapshot as a human-readable prompt for the LLM
// ---------------------------------------------------------------------------

function formatSnapshotForLLM(snapshot: LifeSnapshot): string {
  const sections: string[] = [];

  sections.push(`=== Life Snapshot (last ${snapshot.windowHours} hours) ===\n`);

  for (const d of snapshot.domainSummaries) {
    if (d.eventCount === 0) {
      sections.push(`[${d.domain.toUpperCase()}] No data in this window.\n`);
      continue;
    }

    sections.push(`[${d.domain.toUpperCase()}] ${d.eventCount} events, trend: ${d.trend}`);
    if (d.highlights.length > 0) {
      sections.push(`  Highlights: ${d.highlights.join('; ')}`);
    }
    if (d.anomalies.length > 0) {
      sections.push(`  ⚠ Anomalies: ${d.anomalies.join('; ')}`);
    }
    sections.push('');
  }

  if (snapshot.goals.length > 0) {
    sections.push(`=== Active Goals ===`);
    for (const g of snapshot.goals) {
      sections.push(`  - "${g.title}" (${g.domain}) — ${g.status}, ${g.daysSinceActivity} days since last activity`);
    }
    sections.push('');
  }

  if (snapshot.recentPatterns.length > 0) {
    sections.push(`=== Statistical Patterns Detected ===`);
    for (const p of snapshot.recentPatterns) {
      sections.push(`  - ${p.type} across ${p.domains.join(', ')}: direction=${p.direction}, confidence=${p.confidence.toFixed(2)}`);
    }
    sections.push('');
  }

  if (snapshot.recentInsightTypes.length > 0) {
    sections.push(`=== Recently Surfaced (avoid repeating) ===`);
    sections.push(`  Types: ${snapshot.recentInsightTypes.join(', ')}`);
    sections.push('');
  }

  sections.push(`What are the most valuable insights you can surface right now?`);

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Parse the LLM's JSON response
// ---------------------------------------------------------------------------

function parseComposerResponse(content: string): ComposerOutput | null {
  try {
    // Strip markdown code fences if present
    let cleaned = content.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(cleaned) as ComposerOutput;

    // Validate structure
    if (!parsed.insights || !Array.isArray(parsed.insights)) {
      return null;
    }

    // Filter out insights with missing required fields
    parsed.insights = parsed.insights.filter(
      (i) =>
        i.type &&
        i.category &&
        i.urgency &&
        typeof i.confidence === 'number' &&
        Array.isArray(i.domains) &&
        i.domains.length > 0 &&
        i.description &&
        i.whyItMatters,
    );

    return parsed;
  } catch {
    console.warn('[composer] Failed to parse LLM response as JSON');
    return null;
  }
}

// ---------------------------------------------------------------------------
// TTL per insight type
// ---------------------------------------------------------------------------

function ttlForType(type: InsightType): number {
  const HOUR = 3600000;

  switch (type) {
    // Time-sensitive: short TTL
    case 'prediction':
    case 'opportunity':
    case 'burnout-signal':
      return 6 * HOUR;

    // Actionable: medium TTL
    case 'money-hack':
    case 'time-hack':
    case 'relationship-nudge':
    case 'health-correlation':
    case 'conflict-detected':
    case 'decision-support':
    case 'anomaly':
      return 24 * HOUR;

    // Reflective: long TTL
    case 'self-knowledge':
    case 'idea-synthesis':
    case 'behavior-loop':
    case 'energy-map':
    case 'goal-drift':
      return 72 * HOUR;

    // Statistical patterns
    case 'pattern-detected':
    case 'trend-change':
    case 'correlation':
      return 24 * HOUR;

    default:
      return 24 * HOUR;
  }
}
