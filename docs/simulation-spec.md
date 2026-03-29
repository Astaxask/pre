# Simulation Spec — Personal Reality Engine

> This document defines the exact behavior, algorithms, data requirements, input/output
> contracts, and failure modes of the PRE simulation core.
>
> For Claude Code: the simulation core lives in `packages/engines/src/simulation/`.
> The Python sidecar handles the statistical computation (`sidecar/simulation.py`).
> This document governs both sides of that boundary.

---

## What the simulation core is

The simulation core answers one question: **"If I make this decision, what is likely to happen across my life domains?"**

It does this by:

1. Building a baseline model of each relevant life domain from historical events
2. Estimating the likely impact of the decision on each domain, drawn from historical analogs
3. Running Monte Carlo sampling to produce probability distributions over outcomes
4. Expressing results as ranges — never single predicted values

It is not a prediction engine. It is a consequence-modeling engine. The distinction matters: a prediction claims to know the future. This system estimates the probability distribution of possible futures given a decision, and is honest about its uncertainty.

---

## Minimum data requirements

The simulation core degrades gracefully when data is sparse. These are the thresholds:

| Data available | Simulation mode | What the user sees                                                      |
| -------------- | --------------- | ----------------------------------------------------------------------- |
| < 14 days      | Disabled        | "Not enough data yet. Come back after 2 more weeks of tracking."        |
| 14–29 days     | Shallow         | Results with wide confidence intervals, explicit low-confidence warning |
| 30–89 days     | Standard        | Full simulation with moderate confidence                                |
| 90–179 days    | Deep            | Improved confidence, historical analog matching enabled                 |
| 180+ days      | Full            | Maximum confidence, seasonal patterns detectable                        |

The simulation must never show results without disclosing which mode it ran in and what the data basis was.

---

## Decision taxonomy

Before running any simulation, the user's natural-language decision is parsed into a structured `DecisionDescriptor`. The local LLM performs this parsing. The descriptor determines which domains are affected and which impact functions apply.

```typescript
type DecisionDescriptor = {
  raw: string; // Original user input, unmodified
  decisionType: DecisionType;
  affectedDomains: LifeDomain[]; // Inferred from decision type
  horizon: SimulationHorizon; // User-selected
  keyVariables: KeyVariable[]; // Extracted parameters
  confidence: number; // 0–1: how confident the parser is in this classification
  parserWarnings: string[]; // e.g. "Decision type ambiguous — assumed job-change"
};

type DecisionType =
  | "job-change" // New role, company change, quit, start own business
  | "financial-major" // Large purchase, investment, debt payoff, salary negotiation
  | "habit-add" // Start a new recurring behavior (exercise, sleep schedule, diet)
  | "habit-remove" // Stop a recurring behavior (quit alcohol, stop late nights)
  | "relationship-change" // Move in together, end relationship, new social commitment
  | "location-change" // Move city/country, remote work, long travel
  | "time-commitment" // New project, course, volunteer role, recurring obligation
  | "health-intervention"; // New medication, therapy, surgery, health program

type SimulationHorizon = "30d" | "90d" | "180d";

type KeyVariable = {
  name: string; // e.g. "new_salary", "hours_per_week", "commute_change_minutes"
  value: string; // Raw extracted value from the decision text
  unit?: string;
};
```

**Decision type → affected domains mapping (defaults, overridable by parser):**

| Decision type         | Primary domains            | Secondary domains               |
| --------------------- | -------------------------- | ------------------------------- |
| `job-change`          | `time`, `money`            | `body`, `people`, `mind`        |
| `financial-major`     | `money`                    | `mind`, `body`                  |
| `habit-add`           | `body` or `mind` (depends) | `time`                          |
| `habit-remove`        | `body` or `mind` (depends) | `time`, `people`                |
| `relationship-change` | `people`                   | `time`, `body`, `mind`, `money` |
| `location-change`     | `world`, `time`            | `money`, `people`, `body`       |
| `time-commitment`     | `time`                     | `body`, `mind`, `people`        |
| `health-intervention` | `body`                     | `mind`, `time`, `money`         |

---

## The pipeline in detail

### Step 1: Decision parsing (TypeScript, local LLM)

**Input:** `SimulationRequest.decision` (natural language string)

**Process:**

```
Prompt the local model with:
  - The decision text
  - The decision taxonomy above
  - The user's active goals (for context only, not for modification)
  - Instruction to output valid JSON matching DecisionDescriptor type

Parse and validate output with Zod.
If parsing fails or confidence < 0.5: return error to user with explanation.
```

**Output:** `DecisionDescriptor`

---

### Step 2: Baseline forecasting (Python sidecar, Prophet)

**Input:** `DecisionDescriptor.affectedDomains`, user's historical events

**Process:**
For each affected domain, extract the relevant time-series metric and forecast it forward assuming the decision is NOT made (the "do nothing" baseline):

```python
def forecast_domain(domain: str, events: list[LifeEvent], horizon_days: int) -> ForecastResult:
    # Extract the primary metric for this domain
    series = extract_domain_metric(domain, events)  # see metric map below

    # Require minimum data
    if len(series) < 14:
        return ForecastResult(insufficient_data=True)

    # Fit Prophet model
    model = Prophet(
        daily_seasonality=len(series) >= 30,
        weekly_seasonality=len(series) >= 14,
        yearly_seasonality=len(series) >= 180,
        uncertainty_samples=1000
    )
    model.fit(series)

    future = model.make_future_dataframe(periods=horizon_days)
    forecast = model.predict(future)

    return ForecastResult(
        metric=domain_primary_metric(domain),
        baseline_p10=forecast['yhat_lower'].tail(horizon_days).values,
        baseline_p50=forecast['yhat'].tail(horizon_days).values,
        baseline_p90=forecast['yhat_upper'].tail(horizon_days).values,
        confidence=compute_forecast_confidence(series, forecast)
    )
```

**Primary metric per domain:**

| Domain   | Primary metric                | Unit        | Extraction logic                              |
| -------- | ----------------------------- | ----------- | --------------------------------------------- |
| `body`   | Sleep duration                | hours/night | Mean of sleep events per day                  |
| `money`  | Monthly net cash flow         | USD         | Sum of credit - debit per month               |
| `time`   | Weekly committed hours        | hours/week  | Sum of calendar event durations per week      |
| `people` | Relationship engagement score | 0–100       | Composite of contact frequency across network |
| `mind`   | Goal progress velocity        | % per week  | Slope of goal_progress events                 |
| `world`  | Not forecasted                | —           | External, not user-controllable               |

**Output:** `ForecastResult[]` (one per domain)

---

### Step 3: Impact estimation (Python sidecar)

This is the most novel and uncertain part of the pipeline. We estimate the likely impact of the decision on each domain's trajectory by finding historical analogs in the user's own data.

**Concept:** If the user has previously made a similar decision (or a related life change), the system uses what happened afterward as an empirical prior for the current simulation.

```python
def estimate_impact(
    decision: DecisionDescriptor,
    domain: str,
    events: list[LifeEvent],
    horizon_days: int
) -> ImpactEstimate:

    # Find historical events that signal a similar life change
    # (Uses semantic similarity search via LanceDB)
    analogs = find_historical_analogs(decision, events, min_similarity=0.65)

    if len(analogs) >= 3:
        # Empirical impact: measure what actually changed after analog events
        impact_samples = []
        for analog in analogs:
            before = get_domain_metric_window(domain, analog.timestamp, days=-30)
            after  = get_domain_metric_window(domain, analog.timestamp, days=horizon_days)
            delta  = compute_delta(before, after)
            impact_samples.append(delta)

        return ImpactEstimate(
            source='empirical',
            analog_count=len(analogs),
            delta_p10=np.percentile(impact_samples, 10),
            delta_p50=np.percentile(impact_samples, 50),
            delta_p90=np.percentile(impact_samples, 90),
            confidence=min(0.85, 0.4 + len(analogs) * 0.15)  # caps at 0.85
        )

    else:
        # Generic prior: use population-level priors for this decision type
        # These are hardcoded distributions based on published research
        # NOT personalized — disclosed to user as "based on general patterns"
        prior = GENERIC_PRIORS[decision.decision_type][domain]
        return ImpactEstimate(
            source='generic-prior',
            analog_count=len(analogs),
            delta_p10=prior.p10,
            delta_p50=prior.p50,
            delta_p90=prior.p90,
            confidence=0.25   # Low — generic priors are weak evidence
        )
```

**Generic priors (hardcoded, based on published research, disclosed to user):**

These are fallback distributions used when the user has no personal analogs. They are deliberately conservative (wide distributions, low confidence). The source must always be disclosed.

```python
GENERIC_PRIORS = {
    'job-change': {
        'body': ImpactPrior(p10=-0.8, p50=0.0, p90=0.5, unit='hours_sleep_delta'),
        'money': ImpactPrior(p10=-0.15, p50=0.10, p90=0.35, unit='fraction_income_change'),
        'time': ImpactPrior(p10=-5, p50=2, p90=12, unit='hours_committed_per_week_delta'),
        'mind': ImpactPrior(p10=-15, p50=5, p90=25, unit='goal_progress_velocity_delta'),
        'people': ImpactPrior(p10=-20, p50=-5, p90=10, unit='engagement_score_delta'),
    },
    'habit-add': {
        'body': ImpactPrior(p10=0.0, p50=0.3, p90=0.8, unit='hours_sleep_delta'),
        'time': ImpactPrior(p10=2, p50=5, p90=10, unit='hours_committed_per_week_delta'),
        'mind': ImpactPrior(p10=-5, p50=10, p90=30, unit='goal_progress_velocity_delta'),
    },
    # ... remaining decision types
}
```

**Output:** `ImpactEstimate[]` (one per domain)

---

### Step 4: Monte Carlo sampling (Python sidecar)

Combine the baseline forecast and the impact estimate to produce projected outcome distributions.

```python
def run_simulation(
    baselines: list[ForecastResult],
    impacts: list[ImpactEstimate],
    n_samples: int = 1000
) -> SimulationResult:

    domain_outcomes = []

    for baseline, impact in zip(baselines, impacts):
        samples = []

        for _ in range(n_samples):
            # Sample a delta from the impact distribution
            # Model impact as a triangular distribution between p10 and p90
            delta = np.random.triangular(
                left=impact.delta_p10,
                mode=impact.delta_p50,
                right=impact.delta_p90
            )

            # Apply delta to the baseline p50 trajectory
            projected_value = baseline.p50_final + delta
            samples.append(projected_value)

        domain_outcomes.append(DomainOutcome(
            domain=baseline.domain,
            metric=baseline.metric,
            unit=baseline.unit,
            baseline=Distribution(
                p10=baseline.p10_final,
                p50=baseline.p50_final,
                p90=baseline.p90_final
            ),
            projected=Distribution(
                p10=float(np.percentile(samples, 10)),
                p50=float(np.percentile(samples, 50)),
                p90=float(np.percentile(samples, 90))
            ),
            confidence=min(baseline.confidence, impact.confidence),
            impact_source=impact.source,
            analog_count=impact.analog_count
        ))

    return SimulationResult(outcomes=domain_outcomes)
```

**Output:** `SimulationResult` with `DomainOutcome[]`

---

### Step 5: Narrative generation (TypeScript, local LLM)

The simulation result numbers are turned into a plain-language summary. This step runs in TypeScript using the model router with `privacyLevel='private'`.

**Prompt structure:**

```
You are summarizing the results of a life decision simulation.
The user is considering: [decision.raw]
Time horizon: [horizon]

Here are the projected outcomes for each life domain:
[for each outcome: domain, metric, baseline p50, projected p50, confidence, source]

Write a 3–4 sentence summary that:
1. Names the domains most likely to change significantly
2. Describes the direction of change (better/worse/uncertain)
3. Explicitly mentions uncertainty where confidence is below 0.5
4. Does NOT recommend for or against the decision
5. Does NOT use specific numbers from the simulation (describe directionally)

End with one sentence naming the assumptions this simulation rests on.
```

**The narrative must never recommend.** The system describes consequences; the user decides. If the model output contains language like "you should", "I recommend", or "the best choice is", it must be regenerated.

**Output:** `SimulationResult.narrative` (string)

---

### Step 6: Caching

Simulations are expensive (10–30 seconds). Cache results for 24 hours.

```typescript
const cacheKey = crypto
  .createHash("sha256")
  .update(
    JSON.stringify({ decision: request.decision, horizon: request.horizon }),
  )
  .digest("hex");

// Check cache before running
const cached = await simulationCache.get(cacheKey);
if (cached && Date.now() - cached.generatedAt < 24 * 60 * 60 * 1000) {
  return cached;
}
```

Cache is in-memory (Map). It does not persist across gateway restarts — simulations are re-run on next request after restart.

---

## Output contract

The full `SimulationResult` type, as returned by the gateway to surfaces:

```typescript
type SimulationResult = {
  requestId: string;
  decision: string; // Original user input
  decisionType: DecisionType;
  horizon: SimulationHorizon;
  simulationMode: SimulationMode; // 'disabled' | 'shallow' | 'standard' | 'deep' | 'full'
  generatedAt: number; // Unix ms

  outcomes: DomainOutcome[];
  narrative: string; // 3–4 sentence plain-language summary

  assumptions: string[]; // What the simulation assumed about the decision
  dataBasis: DataBasis[]; // What data was used per domain

  overallConfidence: number; // Min of all domain confidences — honest composite
  hasGenericPriors: boolean; // true if any domain used generic rather than personal priors
  genericPriorDomains: string[]; // Which domains used generic priors (must be disclosed in UI)
};

type DomainOutcome = {
  domain: LifeDomain;
  metric: string; // Human-readable e.g. "Sleep duration"
  unit: string; // e.g. "hours/night"

  baseline: Distribution; // Projected trajectory if decision NOT made
  projected: Distribution; // Projected trajectory if decision IS made

  delta: Distribution; // projected - baseline (convenience, derived)
  deltaIsSignificant: boolean; // true if p50 delta > 1 standard deviation of baseline variance

  confidence: number; // 0–1
  impactSource: "empirical" | "generic-prior";
  analogCount: number; // How many historical analogs were found
};

type Distribution = {
  p10: number;
  p50: number;
  p90: number;
  unit: string;
};

type DataBasis = {
  domain: LifeDomain;
  eventsAnalyzed: number;
  daysCovered: number;
  oldestEventTs: number;
};
```

---

## UI rendering requirements

These are constraints on how the simulation results must be displayed in surfaces. This section is for whoever builds the frontend.

**1. Never show a single number.**
Every outcome must be displayed as a range. Use a range bar, a distribution curve, or a min/median/max display. A single number (even the p50) presented without the range is a design violation.

**2. Confidence must be visible.**
Every domain outcome card must show confidence as a visual signal — opacity, a label ("low confidence"), or a warning icon. Outcomes with `confidence < 0.4` must be visually distinct from high-confidence outcomes.

**3. Generic priors must be disclosed.**
If `hasGenericPriors` is true, display a notice: "Some outcomes are based on general population patterns, not your personal history." List `genericPriorDomains` by name.

**4. The narrative comes first.**
Show the narrative text before the per-domain outcome cards. It orients the user before they dive into numbers.

**5. Baseline vs. projected must be shown together.**
The user needs to see what happens if they do nothing alongside what happens if they make the decision. A chart or table showing both is required. Don't show only the projected outcome.

**6. Show the data basis.**
A collapsible "How was this calculated?" section must be available on every simulation result, showing `dataBasis` for each domain. Users deserve to understand what their simulation is based on.

---

## Error states

| Error                       | User-facing message                                                                                                                 | Technical action                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `insufficient_data`         | "Not enough history yet. Keep tracking for [N] more days."                                                                          | Return error, no simulation run          |
| `parse_failure`             | "I couldn't understand that decision well enough to simulate. Try rephrasing it."                                                   | Return error with parser warnings        |
| `sidecar_timeout`           | "The simulation is taking too long. Try a shorter horizon or fewer domains."                                                        | Cancel sidecar job, return timeout error |
| `all_generic_priors`        | Show result but with prominent warning: "This simulation has no personal data to draw from. Results reflect general patterns only." | Return result with flag                  |
| `horizon_too_long_for_data` | Automatically shorten horizon to match available data, notify user                                                                  | Adjust and proceed                       |

---

## Testing the simulation core

The simulation core is the hardest component to test because its outputs are probabilistic. Use these strategies:

**Unit tests (deterministic):**

- Decision parser: test each `DecisionType` with 3–5 example inputs, verify correct classification
- Impact estimator: with mocked historical events, verify delta direction and confidence are sensible
- Distribution math: verify p10 < p50 < p90 always holds
- Cache: verify cache hit/miss behavior

**Property tests:**

- For any valid `SimulationRequest`, the result must have `p10 ≤ p50 ≤ p90` for every distribution
- `overallConfidence` must equal `min(all domain confidences)`
- `deltaIsSignificant` must be consistent with the delta values

**Integration tests (use fixture data):**

- Load 90 days of synthetic `LifeEvent` fixtures (provided in `sidecar/tests/fixtures/`)
- Run a `job-change` simulation, verify the result structure matches the contract
- Verify that generic-prior domains are correctly flagged when no analogs exist

**Do not test with live personal data.** Fixtures only.

---

_Last updated: 2026-03-29_
_See also: `docs/architecture.md` (section 3.4.3), `docs/privacy-model.md`_
**Do not test with live personal data.** Fixtures only.

---

_Last updated: 2026-03-29_
_See also: `docs/architecture.md` (section 3.4.3), `docs/privacy-model.md`_
