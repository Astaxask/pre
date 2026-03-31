import { useCallback, useEffect, useRef, useState } from 'react';
import type { LifeDomain } from '@pre/shared';
import { DistributionRange, useGateway } from '@repo/ui';

const DOMAINS: { key: LifeDomain; label: string }[] = [
  { key: 'body', label: 'Body' },
  { key: 'money', label: 'Money' },
  { key: 'time', label: 'Time' },
  { key: 'people', label: 'People' },
  { key: 'mind', label: 'Mind' },
];

type Horizon = 30 | 90 | 180;

type DomainOutcome = {
  domain: LifeDomain;
  label: string;
  unit: string;
  projected: { p10: number; p50: number; p90: number };
  baseline: { p10: number; p50: number; p90: number };
};

type SimulationResult = {
  narrative: string;
  hasGenericPriors: boolean;
  dataBasisSummary: string;
  domainOutcomes: DomainOutcome[];
};

type SimulationError = {
  code: 'insufficient_data' | 'parse_failure' | 'sidecar_timeout';
  message: string;
};

const PROGRESS_STEPS = [
  'Understanding your decision...',
  'Modeling current trajectories...',
  'Running 1,000 simulations...',
  'Writing your summary...',
];

const STEP_DURATION_MS = 5000;

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export function Simulation() {
  const { connected, sendMessage, lastMessage } = useGateway();
  const [decision, setDecision] = useState('');
  const [horizon, setHorizon] = useState<Horizon>(90);
  const [selectedDomains, setSelectedDomains] = useState<Set<LifeDomain>>(
    new Set(DOMAINS.map((d) => d.key)),
  );
  const [running, setRunning] = useState(false);
  const [progressStep, setProgressStep] = useState(0);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [error, setError] = useState<SimulationError | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const stepTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const canRun = decision.trim().length >= 20 && connected && !running;

  const toggleDomain = (domain: LifeDomain) => {
    setSelectedDomains((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) {
        next.delete(domain);
      } else {
        next.add(domain);
      }
      return next;
    });
  };

  const startProgressSteps = useCallback(() => {
    setProgressStep(0);
    let step = 0;
    stepTimerRef.current = setInterval(() => {
      step += 1;
      if (step < PROGRESS_STEPS.length - 1) {
        setProgressStep(step);
      } else {
        if (stepTimerRef.current) clearInterval(stepTimerRef.current);
      }
    }, STEP_DURATION_MS);
  }, []);

  const runSimulation = () => {
    if (!canRun) return;
    const id = generateId();
    requestIdRef.current = id;
    setRunning(true);
    setResult(null);
    setError(null);
    startProgressSteps();

    sendMessage({
      type: 'simulate',
      payload: {
        requestId: id,
        decision: decision.trim(),
        horizonDays: horizon,
        domains: [...selectedDomains],
      },
    });
  };

  useEffect(() => {
    if (!lastMessage || !running) return;

    if (
      lastMessage.type === 'simulation-result' &&
      (lastMessage.payload as Record<string, unknown>)['requestId'] === requestIdRef.current
    ) {
      if (stepTimerRef.current) clearInterval(stepTimerRef.current);
      setProgressStep(PROGRESS_STEPS.length - 1);
      const payload = lastMessage.payload as Record<string, unknown>;
      if (payload['error']) {
        setError(payload['error'] as SimulationError);
      } else {
        setResult(payload['result'] as SimulationResult);
      }
      setRunning(false);
    }
  }, [lastMessage, running]);

  useEffect(() => {
    return () => {
      if (stepTimerRef.current) clearInterval(stepTimerRef.current);
    };
  }, []);

  const reset = () => {
    setDecision('');
    setResult(null);
    setError(null);
    setRunning(false);
    setProgressStep(0);
    requestIdRef.current = null;
  };

  if (running) {
    return (
      <div>
        <h1 className="text-display text-text-primary">Simulation</h1>
        <div className="mt-12 flex flex-col items-center gap-6">
          {PROGRESS_STEPS.map((step, idx) => (
            <div key={step} className="flex items-center gap-3">
              <span
                className={`inline-block h-3 w-3 rounded-pill ${
                  idx <= progressStep ? 'bg-accent' : 'bg-surface-sunken'
                }`}
              />
              <span
                className={`text-body ${
                  idx <= progressStep ? 'text-text-primary' : 'text-text-tertiary'
                }`}
              >
                {step}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div>
        <h1 className="text-display text-text-primary">Simulation Results</h1>

        {result.hasGenericPriors && (
          <div
            className="mt-6 rounded-card border border-warning bg-warning/5 p-4"
            data-testid="generic-priors-warning"
          >
            <p className="text-body text-warning">
              Some projections rely on population-level averages rather than your personal data.
              Results will improve as PRE collects more about your patterns.
            </p>
          </div>
        )}

        <div className="mt-6">
          <p className="text-body text-text-primary leading-relaxed">{result.narrative}</p>
        </div>

        <div className="mt-6 rounded-card border border-border bg-surface-raised p-4">
          <p className="text-caption text-text-secondary">{result.dataBasisSummary}</p>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          {result.domainOutcomes.map((outcome) => (
            <div
              key={outcome.domain}
              className="rounded-card border border-border bg-surface-raised p-4"
            >
              <h3 className="text-heading text-text-primary">{outcome.label}</h3>
              <div className="mt-3">
                <DistributionRange
                  p10={outcome.projected.p10}
                  p50={outcome.projected.p50}
                  p90={outcome.projected.p90}
                  unit={outcome.unit}
                  baseline={outcome.baseline}
                />
              </div>
            </div>
          ))}
        </div>

        <button
          type="button"
          className="mt-8 rounded bg-accent px-6 py-3 text-label text-surface hover:opacity-90"
          onClick={reset}
        >
          Run another simulation
        </button>
      </div>
    );
  }

  if (error) {
    const errorMessages: Record<SimulationError['code'], string> = {
      insufficient_data:
        'Not enough personal data to run a meaningful simulation. Keep collecting data for a few more days.',
      parse_failure:
        'Something went wrong interpreting the simulation results. Please try again.',
      sidecar_timeout:
        'The simulation engine took too long to respond. Please try again in a moment.',
    };

    return (
      <div>
        <h1 className="text-display text-text-primary">Simulation</h1>
        <div className="mt-8 rounded-card border border-negative bg-negative/5 p-6">
          <p className="text-body text-negative">
            {errorMessages[error.code]}
          </p>
        </div>
        <button
          type="button"
          className="mt-4 rounded bg-surface-raised px-6 py-2 text-label text-text-secondary hover:bg-surface-sunken"
          onClick={reset}
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-display text-text-primary">Simulation</h1>

      <div className="mt-6">
        <label htmlFor="decision-input" className="text-label text-text-secondary">
          What decision are you thinking about?
        </label>
        <textarea
          id="decision-input"
          value={decision}
          onChange={(e) => setDecision(e.target.value)}
          placeholder="I'm considering taking a new job with more responsibility..."
          className="mt-2 w-full rounded border border-border bg-surface-raised px-4 py-3 text-body text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
          rows={4}
          data-testid="decision-input"
        />
        <p className="mt-1 text-caption text-text-tertiary">
          {decision.trim().length < 20
            ? `${20 - decision.trim().length} more characters needed`
            : 'Ready to simulate'}
        </p>
      </div>

      <div className="mt-6">
        <p className="text-label text-text-secondary">Horizon</p>
        <div className="mt-2 flex gap-2">
          {([30, 90, 180] as Horizon[]).map((h) => (
            <button
              key={h}
              type="button"
              className={`rounded-pill px-4 py-2 text-label transition-colors ${
                horizon === h
                  ? 'bg-accent text-surface'
                  : 'bg-surface-raised text-text-secondary hover:bg-surface-sunken'
              }`}
              onClick={() => setHorizon(h)}
            >
              {h} days
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6">
        <p className="text-label text-text-secondary">Domains to model</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {DOMAINS.map((d) => (
            <label
              key={d.key}
              className={`flex cursor-pointer items-center gap-2 rounded-pill px-3 py-1 text-label transition-colors ${
                selectedDomains.has(d.key)
                  ? 'bg-accent/10 text-accent'
                  : 'bg-surface-raised text-text-tertiary'
              }`}
            >
              <input
                type="checkbox"
                checked={selectedDomains.has(d.key)}
                onChange={() => toggleDomain(d.key)}
                className="sr-only"
              />
              {d.label}
            </label>
          ))}
        </div>
      </div>

      <button
        type="button"
        disabled={!canRun}
        className="mt-8 rounded bg-accent px-6 py-3 text-label text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        onClick={runSimulation}
        data-testid="run-simulation"
      >
        Run simulation →
      </button>
    </div>
  );
}
