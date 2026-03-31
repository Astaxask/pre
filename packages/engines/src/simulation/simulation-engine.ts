import { createHash, randomUUID } from 'node:crypto';
import type { LifeDomain, LifeEvent } from '@pre/shared';
import type { MemoryReader, Goal } from '@pre/memory';
import { isOk } from '@pre/shared';
import type {
  SimulationRequest,
  SimulationResult,
  SimulationMode,
  DomainOutcome,
  DataBasis,
  Distribution,
} from './simulation-types.js';
import { parseDecision } from './decision-parser.js';
import { generateNarrative } from './narrative-generator.js';

// ---------------------------------------------------------------------------
// Sidecar interface for simulation
// ---------------------------------------------------------------------------

type SimulationSidecar = {
  forecastDomain(
    domain: string,
    events: Array<Record<string, unknown>>,
    horizonDays: number,
  ): Promise<{
    insufficient_data: boolean;
    metric: string;
    p10_final: number;
    p50_final: number;
    p90_final: number;
    unit: string;
    confidence: number;
  }>;
  estimateImpact(
    decisionType: string,
    domain: string,
    events: Array<Record<string, unknown>>,
    horizonDays: number,
  ): Promise<{
    source: 'empirical' | 'generic-prior';
    analog_count: number;
    delta_p10: number;
    delta_p50: number;
    delta_p90: number;
    confidence: number;
  }>;
  runSimulation(
    baselines: Array<Record<string, unknown>>,
    impacts: Array<Record<string, unknown>>,
    nSamples: number,
  ): Promise<Array<{
    domain: string;
    metric: string;
    unit: string;
    baseline_p10: number;
    baseline_p50: number;
    baseline_p90: number;
    projected_p10: number;
    projected_p50: number;
    projected_p90: number;
    confidence: number;
    impact_source: string;
    analog_count: number;
  }>>;
};

export type SimulationEngineDeps = {
  reader: MemoryReader;
  sidecar: SimulationSidecar;
};

// ---------------------------------------------------------------------------
// Cache (in-memory, 24h TTL)
// ---------------------------------------------------------------------------

const cache = new Map<string, SimulationResult>();

function getCacheKey(request: SimulationRequest): string {
  return createHash('sha256')
    .update(JSON.stringify({ decision: request.decision, horizon: request.horizon }))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Determine simulation mode from data
// ---------------------------------------------------------------------------

function determineMode(daysCovered: number): SimulationMode {
  if (daysCovered < 14) return 'disabled';
  if (daysCovered < 30) return 'shallow';
  if (daysCovered < 90) return 'standard';
  if (daysCovered < 180) return 'deep';
  return 'full';
}

function horizonToDays(horizon: string): number {
  if (horizon === '30d') return 30;
  if (horizon === '90d') return 90;
  return 180;
}

// ---------------------------------------------------------------------------
// run()
// ---------------------------------------------------------------------------

export async function runSimulation(
  request: SimulationRequest,
  deps: SimulationEngineDeps,
): Promise<SimulationResult> {
  // Check cache
  const cacheKey = getCacheKey(request);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.generatedAt < 24 * 3600000) {
    return cached;
  }

  const horizonDays = horizonToDays(request.horizon);

  // Gather all events to check data availability
  const allEvents: LifeEvent[] = [];
  const dataBasis: DataBasis[] = [];
  const now = Date.now();

  for (const domain of request.domains) {
    const events = await deps.reader.byTimeRange(0, now, [domain]);
    allEvents.push(...events);

    if (events.length > 0) {
      const oldest = Math.min(...events.map((e) => e.timestamp));
      const daysCovered = Math.floor((now - oldest) / (24 * 3600000));
      dataBasis.push({
        domain,
        eventsAnalyzed: events.length,
        daysCovered,
        oldestEventTs: oldest,
      });
    } else {
      dataBasis.push({ domain, eventsAnalyzed: 0, daysCovered: 0, oldestEventTs: 0 });
    }
  }

  // Check minimum data
  const maxDays = Math.max(...dataBasis.map((d) => d.daysCovered), 0);
  const mode = determineMode(maxDays);

  if (mode === 'disabled') {
    const daysNeeded = 14 - maxDays;
    return {
      requestId: randomUUID(),
      decision: request.decision,
      decisionType: 'job-change', // placeholder
      horizon: request.horizon,
      simulationMode: 'disabled',
      generatedAt: Date.now(),
      outcomes: [],
      narrative: `Not enough data yet. Come back after ${daysNeeded} more days of tracking.`,
      assumptions: [],
      dataBasis,
      overallConfidence: 0,
      hasGenericPriors: false,
      genericPriorDomains: [],
    };
  }

  // Step 1: Parse decision
  let goals: Goal[];
  try {
    goals = await deps.reader.goals('active');
  } catch {
    goals = [];
  }

  const parseResult = await parseDecision(request.decision, request.horizon, goals);
  if (!isOk(parseResult)) {
    return {
      requestId: randomUUID(),
      decision: request.decision,
      decisionType: 'job-change',
      horizon: request.horizon,
      simulationMode: mode,
      generatedAt: Date.now(),
      outcomes: [],
      narrative: `I couldn't understand that decision well enough to simulate. ${parseResult.error}`,
      assumptions: [],
      dataBasis,
      overallConfidence: 0,
      hasGenericPriors: false,
      genericPriorDomains: [],
    };
  }

  const descriptor = parseResult.value;

  // Step 2-4: Baseline + Impact + Monte Carlo via sidecar
  const baselines: Array<Record<string, unknown>> = [];
  const impacts: Array<Record<string, unknown>> = [];

  for (const domain of descriptor.affectedDomains) {
    const domainEvents = allEvents
      .filter((e) => e.domain === domain)
      .map((e) => ({
        domain: e.domain,
        timestamp: e.timestamp,
        eventType: e.eventType,
      }));

    try {
      const forecast = await deps.sidecar.forecastDomain(domain, domainEvents, horizonDays);
      if (forecast.insufficient_data) {
        baselines.push({
          domain,
          metric: forecast.metric || domain,
          unit: forecast.unit || '',
          p10_final: 0,
          p50_final: 0,
          p90_final: 0,
          confidence: 0.1,
          insufficient_data: true,
        });
      } else {
        baselines.push({
          domain,
          metric: forecast.metric,
          unit: forecast.unit,
          p10_final: forecast.p10_final,
          p50_final: forecast.p50_final,
          p90_final: forecast.p90_final,
          confidence: forecast.confidence,
        });
      }
    } catch {
      baselines.push({
        domain,
        metric: domain,
        unit: '',
        p10_final: 0,
        p50_final: 0,
        p90_final: 0,
        confidence: 0.1,
      });
    }

    try {
      const impact = await deps.sidecar.estimateImpact(
        descriptor.decisionType,
        domain,
        domainEvents,
        horizonDays,
      );
      impacts.push({
        domain,
        source: impact.source,
        analog_count: impact.analog_count,
        delta_p10: impact.delta_p10,
        delta_p50: impact.delta_p50,
        delta_p90: impact.delta_p90,
        confidence: impact.confidence,
      });
    } catch {
      impacts.push({
        domain,
        source: 'generic-prior',
        analog_count: 0,
        delta_p10: 0,
        delta_p50: 0,
        delta_p90: 0,
        confidence: 0.25,
      });
    }
  }

  // Run Monte Carlo
  let rawOutcomes: Array<Record<string, unknown>>;
  try {
    rawOutcomes = await deps.sidecar.runSimulation(baselines, impacts, 1000);
  } catch {
    rawOutcomes = [];
  }

  // Build DomainOutcome objects
  const outcomes: DomainOutcome[] = rawOutcomes.map((r) => {
    const bP10 = Number(r['baseline_p10'] ?? 0);
    const bP50 = Number(r['baseline_p50'] ?? 0);
    const bP90 = Number(r['baseline_p90'] ?? 0);
    const pP10 = Number(r['projected_p10'] ?? 0);
    const pP50 = Number(r['projected_p50'] ?? 0);
    const pP90 = Number(r['projected_p90'] ?? 0);
    const unit = String(r['unit'] ?? '');

    const delta: Distribution = {
      p10: pP10 - bP10,
      p50: pP50 - bP50,
      p90: pP90 - bP90,
      unit,
    };

    const baselineRange = bP90 - bP10;
    const deltaIsSignificant = baselineRange > 0
      ? Math.abs(delta.p50) > baselineRange * 0.25
      : Math.abs(delta.p50) > 0;

    return {
      domain: String(r['domain'] ?? '') as LifeDomain,
      metric: String(r['metric'] ?? ''),
      unit,
      baseline: { p10: bP10, p50: bP50, p90: bP90, unit },
      projected: { p10: pP10, p50: pP50, p90: pP90, unit },
      delta,
      deltaIsSignificant,
      confidence: Number(r['confidence'] ?? 0),
      impactSource: (r['impact_source'] === 'empirical' ? 'empirical' : 'generic-prior') as 'empirical' | 'generic-prior',
      analogCount: Number(r['analog_count'] ?? 0),
    };
  });

  // Step 5: Narrative
  const narrative = await generateNarrative(outcomes, request.decision, request.horizon);

  // Compute overall stats
  const genericPriorDomains = outcomes
    .filter((o) => o.impactSource === 'generic-prior')
    .map((o) => o.domain);

  const overallConfidence = outcomes.length > 0
    ? Math.min(...outcomes.map((o) => o.confidence))
    : 0;

  const assumptions = [
    `Based on ${mode} simulation mode with ${maxDays} days of data`,
    ...genericPriorDomains.map((d) => `${d} domain used general population patterns, not personal data`),
  ];

  const result: SimulationResult = {
    requestId: randomUUID(),
    decision: request.decision,
    decisionType: descriptor.decisionType,
    horizon: request.horizon,
    simulationMode: mode,
    generatedAt: Date.now(),
    outcomes,
    narrative,
    assumptions,
    dataBasis,
    overallConfidence,
    hasGenericPriors: genericPriorDomains.length > 0,
    genericPriorDomains,
  };

  // Cache
  cache.set(cacheKey, result);

  return result;
}

export function clearCache(): void {
  cache.clear();
}
