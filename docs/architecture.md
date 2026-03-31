# Architecture — Personal Reality Engine (PRE)

> This document captures the full system architecture, design philosophy, component contracts,
> and long-term evolution plan for the PRE. It is the single source of truth for every
> engineering decision made in this project.
>
> If you are Claude Code: read this before touching any file. If a decision you are about to make
> contradicts something in here, stop and surface the conflict rather than resolving it yourself.

---

## Table of contents

1. [Philosophy](#1-philosophy)
2. [System overview](#2-system-overview)
3. [Component deep-dives](#3-component-deep-dives)
   - 3.1 Integration layer (L1)
   - 3.2 Memory layer (L2)
   - 3.3 Model layer (L3)
   - 3.4 Core engines (L4)
   - 3.5 Gateway & runtime (L5)
   - 3.6 Surfaces (L6)
4. [Data flow](#4-data-flow)
5. [Cross-cutting concerns](#5-cross-cutting-concerns)
6. [Failure modes & degradation](#6-failure-modes--degradation)
7. [Long-term evolution](#7-long-term-evolution)
8. [Decision log](#8-decision-log)

---

## 1. Philosophy

### The four laws of PRE architecture

**Law 1 — Zero input, maximum output.**
The user should never have to manually enter data, create goals, or configure anything beyond initial setup. PRE is an autonomous second brain that silently observes digital life, builds understanding, and presents insights — all without being asked. If a feature requires the user to do cognitive work to feed the system, redesign it until it doesn't.

**Law 2 — Local first, cloud never by default.**
Every capability must work with zero internet connection and zero cloud API calls. Cloud models are an optional upgrade path, never a dependency. A user with no API keys must still get value.

**Law 3 — Data is the product; the software is the delivery mechanism.**
The value of PRE compounds over time as the memory layer grows. Architectural decisions that risk data integrity, data loss, or data exposure are existential threats — treat them as such. Migrations, backups, and encryption are first-class features, not afterthoughts.

**Law 4 — The system earns trust through restraint.**
PRE has access to the most sensitive data in a person's life. Every feature must be designed with the minimum footprint necessary. The inference engine reads broadly but acts narrowly. The proactive agent interrupts rarely and explains always. The simulation core shows uncertainty rather than false confidence.

---

## 2. System overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        SURFACES (L6)                            │
│   macOS menu bar   │   iOS/Android   │   Web panel   │  Watch   │
└────────────────────────────┬────────────────────────────────────┘
                             │ WebSocket / local IPC
┌────────────────────────────▼────────────────────────────────────┐
│                     GATEWAY & RUNTIME (L5)                      │
│   Event bus · Job queue · Scheduler · Session manager           │
└──────┬──────────────────┬──────────────────────┬───────────────┘
       │                  │                      │
┌──────▼──────┐  ┌────────▼────────┐  ┌─────────▼──────────────┐
│   ENGINES   │  │   MODEL LAYER   │  │   MEMORY LAYER (L2)    │
│    (L4)     │  │      (L3)       │  │                        │
│             │  │                 │  │  SQLite (structured)   │
│  Inference  │◄─┤  Local (Ollama) │  │  LanceDB (vectors)     │
│  Proactive  │  │  Cloud (Claude) │  │  Encrypted at rest     │
│  Simulation │  │  Router         │  │                        │
└──────┬──────┘  └────────┬────────┘  └────────────────────────┘
       │                  │
       └──────────────────┘ (engines call models via router)
                             │
                    ┌────────▼────────┐
                    │  PYTHON SIDECAR │
                    │  LlamaIndex     │
                    │  Prophet        │
                    │  Monte Carlo    │
                    └────────┬────────┘
                             │ Unix socket / JSON-RPC
┌────────────────────────────▼────────────────────────────────────┐
│                   INTEGRATION LAYER (L1)                        │
│  Plaid · HealthKit · Oura · WHOOP · Google Calendar · Gmail     │
└─────────────────────────────────────────────────────────────────┘
```

The gateway is the spine. Everything connects to it; nothing connects directly to anything else. This means:

- The integration layer pushes events into the gateway, which writes them to memory
- The engines read from memory via the sidecar, never directly
- The surfaces talk to the gateway, never to the engines or memory directly
- The model layer is called only by the engines, never by surfaces or integrations

---

## 3. Component deep-dives

### 3.1 Integration layer (L1)

**Location:** `packages/integrations/`

**Responsibility:** Pull data from external sources, normalize it into `LifeEvent` objects, and hand it to the gateway for storage. Nothing else.

**Every adapter must implement this interface:**

```typescript
interface LifeAdapter {
  readonly source: DataSource;
  readonly domains: LifeDomain[];

  // Called by the scheduler. Returns new events since last sync.
  sync(cursor: SyncCursor | null): Promise<AdapterResult>;

  // Called once during setup. Validates credentials and permissions.
  healthCheck(): Promise<{ ok: boolean; error?: string }>;

  // Returns a human-readable description of what this adapter collects.
  manifest(): AdapterManifest;
}

type AdapterResult = {
  events: LifeEvent[];
  nextCursor: SyncCursor;
  hasMore: boolean; // If true, gateway will call sync() again immediately
};
```

**Adapters are the lifeblood of PRE.** The more passive signals we collect, the better the autonomous model. Every adapter collects data silently after initial setup — the user never interacts with adapters directly.

**Adapter sync schedule (configurable, these are defaults):**

| Adapter           | Domain(s)   | Interval         | Signal type                                       | Status      |
| ----------------- | ----------- | ---------------- | ------------------------------------------------- | ----------- |
| Plaid             | money       | Every 6 hours    | Transactions, balances, bills                      | **Built**   |
| Google Calendar   | time        | Every 10 minutes | Events, duration, recurring patterns               | **Built**   |
| Apple HealthKit   | body        | Every 15 minutes | Sleep, HRV, steps, workouts, heart rate            | **Next**    |
| WHOOP             | body        | Every 30 minutes | Recovery, strain, sleep stages                     | **Planned** |
| Oura              | body        | Every 30 minutes | Readiness, sleep quality, temperature              | **Planned** |
| Screen Time (iOS) | time, mind  | Every 30 minutes | App usage, pickups, focus modes                    | **Planned** |
| Gmail metadata    | people      | Every 30 minutes | Communication frequency, response latency          | **Planned** |
| macOS Screen Time | time, mind  | Every 30 minutes | Application usage, focus time patterns             | **Planned** |
| Browser history   | mind, time  | Every 1 hour     | Topics of interest, time allocation                | **Planned** |
| Garmin            | body        | Every 1 hour     | Workouts, body battery, stress                     | **Planned** |
| Location (coarse) | world       | Every 1 hour     | Home/work/transit patterns (no GPS coordinates)    | **Planned** |
| Spotify/Music     | mind        | Every 1 hour     | Listening patterns for mood inference              | **Planned** |

**Adapter failure policy:**

- Transient failure (timeout, rate limit): BullMQ retries with exponential backoff, max 5 attempts
- Auth failure: mark adapter as `needs-reauth`, surface alert to user, stop retrying
- Partial failure: commit successfully parsed events, log failed items with source IDs for retry
- An adapter failure must NEVER crash the gateway or block other adapters

**Privacy enforcement at the adapter boundary:**
Every `LifeEvent` produced by an adapter must have `privacyLevel` set explicitly. The adapter knows best what it is producing. The gateway validates this and rejects events with missing `privacyLevel`. Health and financial raw payloads default to `'private'` and adapters cannot override this to `'cloud-safe'` — only the inference engine's abstraction step can produce cloud-safe summaries.

**Build order for adapters:**

1. ~~`plaid`~~ — **Done.** Financial transactions and balances
2. ~~`google-calendar`~~ — **Done.** Calendar events and time patterns
3. `healthkit` — **Next.** Covers the critical body domain, passive data from iPhone/Apple Watch
4. `whoop` / `oura` — Recovery and sleep quality signals (body domain depth)
5. `screen-time` — Phone and computer usage patterns (time + mind domains)
6. `gmail` — metadata only (subject omitted, body never touched), relationship signals
7. `browser-history` — Interest tracking and time allocation (mind domain)
8. `garmin` — Workout data and body battery (body domain breadth)

---

### 3.2 Memory layer (L2)

**Location:** `packages/memory/`

**Responsibility:** Persist `LifeEvent` objects to SQLite and their embeddings to LanceDB. Provide typed query interfaces to the engines. Own all encryption and decryption.

**Two storage systems running in parallel:**

```
SQLite (structured)                    LanceDB (semantic)
─────────────────────                  ─────────────────
life_events table                      events_vectors table
  id, domain, timestamp     ←──id──►   id, embedding[1536]
  payload (typed JSON)                 metadata (domain, timestamp)
  encrypted private payloads

goals, trigger_log,
integration_sync tables
(no vector counterparts)
```

**The memory module exposes three namespaces:**

```typescript
// 1. Writer — used by the gateway after adapter sync
memory.write.event(event: LifeEvent): Promise<void>
memory.write.events(events: LifeEvent[]): Promise<BatchWriteResult>

// 2. Reader — used by the engines
memory.read.recentByDomain(domain, hours): Promise<LifeEvent[]>
memory.read.byTimeRange(start, end, domains?): Promise<LifeEvent[]>
memory.read.goals(status?): Promise<Goal[]>
memory.read.triggerLog(ruleId, since): Promise<TriggerLogEntry[]>

// 3. Semantic — proxied through the Python sidecar
memory.semantic.search(query, topK, domains?): Promise<LifeEvent[]>
memory.semantic.findSimilar(eventId, topK): Promise<LifeEvent[]>
```

**The engines never call SQLite directly.** They always go through `memory.read.*` or `memory.semantic.*`. This allows the encryption layer to be a single controlled choke point.

**Encryption architecture:**

```
Disk
└── pre.db (SQLCipher AES-256, key = HKDF(PRE_ENCRYPTION_KEY, "sqlite"))
    └── life_events.payload (for privacy_level='private')
        └── additionally wrapped in libsodium secretbox
            key = HKDF(PRE_ENCRYPTION_KEY, "payload-" + domain)

└── lancedb/ (directory encrypted with age)
    key = HKDF(PRE_ENCRYPTION_KEY, "vectors")
```

The HKDF derivation means compromising one key does not compromise the others. The `PRE_ENCRYPTION_KEY` is the single root secret. It must never be logged, stored in the database, or transmitted anywhere.

**Embedding strategy:**

- Model: `nomic-embed-text` via Ollama (local, 768-dim) for standard use
- Cloud fallback: `text-embedding-3-small` via OpenAI API (only if user opts in)
- Embedding is async — events are written to SQLite immediately, embedding happens in a background BullMQ job
- Events without embeddings are still fully usable for structured queries; they simply don't appear in semantic search results

---

### 3.3 Model layer (L3)

**Location:** `packages/models/`

**Responsibility:** Abstract all LLM calls behind a single typed interface. Enforce the privacy boundary. Track token usage and cost. Route to local or cloud models based on the `privacyLevel` of the context.

**The router is the privacy boundary enforcer:**

```typescript
// This is the ONLY way to call an LLM in this codebase.
// Direct instantiation of Anthropic, OpenAI, or Ollama clients is forbidden.
async function callModel(request: ModelRequest): Promise<ModelResponse>;

type ModelRequest = {
  task: ModelTask; // What kind of task is this
  privacyLevel: PrivacyLevel; // Determines routing
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
};

type ModelTask =
  | "summarize-event" // Generate a LifeEvent summary for RAG
  | "pattern-analysis" // Analyze patterns across events
  | "proactive-reasoning" // Reason about trigger conditions
  | "simulation-narrative" // Narrate simulation results
  | "user-conversation" // Direct chat with the user
  | "goal-extraction"; // Extract goals from user input
```

**Routing logic:**

```
if privacyLevel === 'private'
  → always Ollama (local)
  → model: llama3.1:8b (default) or phi3:mini (low-power devices)

if privacyLevel === 'summarizable'
  → Ollama for the summarization step
  → the resulting summary gets privacyLevel='cloud-safe'
  → that summary may then be used in subsequent cloud model calls

if privacyLevel === 'cloud-safe'
  → Claude Sonnet via Anthropic API (default)
  → falls back to Ollama if no API key is configured
```

**The router rejects any request that tries to include private data in a cloud-safe call.** It scans message content for patterns that suggest raw PII (account numbers, named individuals, raw health values) and logs a warning. This is a best-effort check, not a guarantee — the real enforcement is the adapter-level classification at ingestion time.

**Token budget management:**

- Each `ModelTask` has a default `maxTokens` ceiling (configurable)
- The router tracks cumulative token usage per day and per month
- If cloud spend exceeds the configured monthly budget, the router falls back to local models for all tasks until the budget resets
- Token usage is logged to `integration_sync` table for the user to inspect

---

### 3.4 Core engines (L4)

**Location:** `packages/engines/`

This is the heart of what makes PRE different from everything else. Three engines, each with a distinct responsibility and a strict interface.

---

#### 3.4.1 Inference engine

**What it does:** Runs continuously in the background, reading from memory, detecting cross-domain patterns, and building an always-current model of the user's life state. It produces `LifeInsight` objects that the proactive agent and simulation core consume.

```typescript
type LifeInsight = {
  id: string;
  generatedAt: number;
  domains: LifeDomain[]; // Which domains contributed to this insight
  insightType: InsightType;
  confidence: number; // 0–1
  payload: InsightPayload;
  expiresAt: number; // Insights are time-bounded; stale ones are discarded
  privacyLevel: PrivacyLevel; // Inherited from the most restrictive source event
};

type InsightType =
  | "pattern-detected" // Recurring cross-domain pattern
  | "trend-change" // A domain metric is trending in a new direction
  | "goal-drift" // User is drifting from a stated goal
  | "conflict-detected" // Two commitments or goals are in tension
  | "anomaly" // Something unusual in one or more domains
  | "correlation"; // Two domain signals are moving together
```

**Inference engine pipeline (runs every 15 minutes via cron AND after every sync):**

```
1. SNAPSHOT
   Read the last 72 hours of LifeEvents across all domains from memory

2. EMBED & SEARCH
   Call sidecar.similarity_search() for recently-added events
   to find semantically related historical events

3. PATTERN DETECTION
   Call sidecar.detect_patterns() — Python statsmodels
   Looks for: cross-domain correlations, trend changes, anomalies

4. LLM REASONING (local model only)
   For each detected pattern, generate a LifeInsight via callModel()
   with privacyLevel='private', task='pattern-analysis'

5. AUTONOMOUS GOAL GENERATION
   Analyze behavior patterns and auto-create goals:
   - Detected consistent running → "Maintain running habit" (body)
   - Spending increased 30%+ → "Monitor discretionary spending" (money)
   - Sleep declining 3+ nights → "Improve sleep consistency" (body)
   - Deep work hours dropping → "Protect focus time" (time)
   Goals are created with source='inferred', confidence score, and
   can be dismissed by the user (which trains the system)

6. GOAL DRIFT CHECK
   For each active goal (user-created AND auto-generated),
   compare recent domain events to goal trajectory.
   If drift exceeds threshold, emit a 'goal-drift' insight.
   Auto-archive stale goals that have had no activity for 60+ days.

7. SELF-MAINTENANCE
   - Update confidence scores on existing insights
   - Prune expired insights from the store
   - Adjust sync frequency recommendations based on data freshness

8. PUBLISH
   Write new insights to the insight store (in-memory, TTL-keyed)
   Write auto-generated goals to the goals table
   Notify the proactive agent of new insights via the event bus
```

**What the inference engine must NOT do:**

- Call cloud models (all inference is local)
- Make decisions on behalf of the user — it surfaces patterns, creates goals, but the user retains control
- Run expensive operations synchronously — all heavy work goes through BullMQ

---

#### 3.4.2 Proactive agent

**What it does:** Watches the stream of `LifeInsight` objects from the inference engine and fires when defined `TriggerRule` conditions are met. It is the only engine that communicates with the user without being asked.

**The golden rule of the proactive agent: interrupt rarely, explain always.**

Every alert the proactive agent sends must include:

1. What it noticed
2. Why it thinks this matters (which data it based this on)
3. What, if anything, it suggests
4. A dismiss option that feeds back into the cooldown system

```typescript
interface TriggerRule {
  id: string;
  name: string;
  description: string;

  // Which insights trigger this rule
  watchInsightTypes: InsightType[];
  watchDomains: LifeDomain[];

  // The condition function — must be pure and fast (<10ms)
  condition(insight: LifeInsight, context: TriggerContext): boolean;

  // Severity of the resulting alert
  severity: "info" | "warning" | "intervention";

  // How long to wait before this rule can fire again for the same pattern
  cooldownHours: number;

  // Max alerts per week from this rule (prevents spam even within cooldown)
  maxPerWeek: number;

  // Generates the user-facing alert content (may call local LLM for phrasing)
  compose(insight: LifeInsight, context: TriggerContext): Promise<Alert>;
}
```

**V1 trigger rules (ship with these, add more only after 30 days of real data):**

| Rule ID                    | Watches     | Fires when                                                                        |
| -------------------------- | ----------- | --------------------------------------------------------------------------------- |
| `sleep-debt-accumulating`  | body, time  | Sleep < 6.5h for 3+ consecutive nights AND calendar shows high-density week ahead |
| `financial-stress-pattern` | money, body | Unusual spending spike AND HRV decline in same 72h window                         |
| `goal-drift-warning`       | mind, time  | Active goal has had zero relevant events for 14+ days                             |
| `relationship-silence`     | people      | No contact with a flagged relationship for 30+ days                               |
| `overcommitment-ahead`     | time, body  | Next 7 days have >40h of scheduled time AND recovery score is low                 |
| `energy-decision-mismatch` | body, time  | High-cognitive-load meetings scheduled on low-recovery days                       |

---

#### 3.4.3 Simulation core

**What it does:** Samples from probability distributions built from the user's historical data to model likely outcomes across all life domains, projected forward in time. Simulations can be triggered in two ways:

1. **Auto-triggered by the inference engine** — when the system detects a forming decision (browsing job listings, researching a new city, looking at gym memberships, considering a large purchase), it proactively runs a simulation and surfaces the result as an insight
2. **On-demand** — as a fallback, the user can request a simulation through the UI, but this is NOT the primary path

**This is not prediction. It is consequence modeling.**

The output is always expressed as a range with confidence intervals. The UI must always display uncertainty visually. A simulation result that shows a single number is a bug.

```typescript
type SimulationRequest = {
  decision: DecisionDescription; // Auto-detected or user-described decision
  horizon: "30d" | "90d" | "180d"; // How far forward to project
  domains: LifeDomain[]; // Which domains to model (auto or user selects)
  trigger: "auto" | "manual"; // How this simulation was initiated
};

type SimulationResult = {
  requestId: string;
  decision: string;
  horizon: string;
  generatedAt: number;

  // Per-domain outcome distributions
  outcomes: DomainOutcome[];

  // Cross-domain summary narrative (local LLM generated)
  narrative: string;

  // Confidence in the simulation overall (degrades with horizon)
  overallConfidence: number;

  // Key assumptions the simulation is based on
  assumptions: string[];

  // What historical data was used
  dataBasis: { domain: LifeDomain; eventsUsed: number; daysCovered: number }[];
};

type DomainOutcome = {
  domain: LifeDomain;
  metric: string; // What is being measured (e.g. 'sleep duration', 'monthly spend')
  baseline: Distribution; // Current trajectory if decision is NOT made
  projected: Distribution; // Projected trajectory if decision IS made
  confidence: number;
};

type Distribution = {
  p10: number; // 10th percentile (pessimistic)
  p50: number; // Median (expected)
  p90: number; // 90th percentile (optimistic)
  unit: string;
};
```

**Simulation pipeline:**

```
1. DETECT OR PARSE DECISION
   Auto-trigger: Inference engine detects behavior patterns that suggest a
   forming decision (browsing job sites, researching locations, comparing prices)
   and constructs a DecisionDescriptor automatically.

   Manual fallback: User describes a decision; local LLM extracts structured
   DecisionDescriptor:
     - decision type (job change / financial / relationship / habit / location)
     - affected domains
     - key variables

2. BASELINE MODELING
   Sidecar runs sidecar.forecast_domain() for each affected domain
   Uses Prophet to extrapolate current trajectory (the "do nothing" scenario)

3. IMPACT ESTIMATION
   For each domain, build an impact function from historical data:
     "Last time a job-change-type event happened, how did body/money/time change?"
   This requires at least 90 days of data to be meaningful

4. MONTE CARLO SAMPLING
   Sidecar runs sidecar.run_simulation():
     - 1000 samples per domain
     - Each sample draws from the impact distribution
     - Results aggregated into p10/p50/p90 Distribution objects

5. NARRATIVE GENERATION
   Local LLM synthesizes a plain-language summary of the outcomes
   It must explicitly mention the uncertainty and what data it's based on
   It must NOT recommend. It describes. The user decides.

6. RETURN
   SimulationResult assembled and returned to the gateway
   Cached for 24h (simulations are expensive)
```

---

### 3.5 Gateway & runtime (L5)

**Location:** `apps/gateway/`

**Responsibility:** The always-on process that orchestrates everything. It is the only process that knows about all other components. It manages the lifecycle of adapters, the engine schedule, the job queue, and all surface connections.

**Gateway internal architecture:**

```
apps/gateway/src/
├── index.ts                  # Entry point, process lifecycle
├── event-bus.ts              # Internal pub/sub (EventEmitter-based)
├── scheduler.ts              # node-cron jobs for adapter sync + engine runs
├── session-manager.ts        # WebSocket session lifecycle for surfaces
├── routes/
│   ├── sync.ts               # Trigger manual adapter sync
│   ├── query.ts              # Surface queries to memory
│   ├── simulate.ts           # Invoke simulation core
│   ├── goals.ts              # CRUD for goals
│   └── alerts.ts             # Alert history and dismissal
├── workers/
│   ├── embed-worker.ts       # BullMQ worker: generate embeddings for new events
│   ├── sync-worker.ts        # BullMQ worker: run adapter sync jobs
│   └── insight-worker.ts     # BullMQ worker: run inference engine pass
└── sidecar-client.ts         # JSON-RPC client for the Python sidecar
```

**WebSocket message protocol:**

All surface ↔ gateway communication uses a simple typed message protocol:

```typescript
type GatewayMessage =
  | { type: "alert"; payload: Alert }
  | { type: "insight-update"; payload: LifeInsight[] }
  | { type: "sync-status"; payload: SyncStatus }
  | { type: "query-result"; requestId: string; payload: LifeEvent[] }
  | { type: "simulation-result"; requestId: string; payload: SimulationResult }
  | { type: "error"; requestId?: string; error: string };

type SurfaceMessage =
  | { type: "query"; requestId: string; payload: QueryRequest }
  | { type: "simulate"; requestId: string; payload: SimulationRequest }
  | { type: "dismiss-alert"; alertId: string }
  | { type: "create-goal"; payload: GoalInput }
  | { type: "trigger-sync"; source: DataSource };
```

**Process lifecycle:**

```
Gateway starts
  ↓
Load and validate config + encryption key
  ↓
Connect to SQLite (decrypt, run pending migrations)
  ↓
Connect to LanceDB
  ↓
Start Redis (local, embedded)
  ↓
Start BullMQ workers (embed, sync, insight)
  ↓
Spawn Python sidecar, wait for ready signal
  ↓
Initialize all configured adapters (healthCheck each one)
  ↓
Register cron jobs (adapter schedules + engine schedule)
  ↓
Start WebSocket server (port 18789, localhost only)
  ↓
Emit 'gateway-ready' event
  ↓
[Running — processing jobs, handling WS connections]
```

**Gateway must survive adapter and engine failures.** A crash in a BullMQ worker must not crash the gateway. All workers are isolated in separate worker threads using `worker_threads`. The main gateway process only orchestrates; it does not run heavy computation itself.

---

### 3.6 Surfaces (L6)

**Location:** `apps/desktop/`, `apps/mobile/`, `apps/web/`

**Responsibility:** Render the user interface. Talk to the gateway via WebSocket. Store no application state locally — the gateway is the state authority.

**Design principles for all surfaces:**

1. **Show reasoning, not just results.** When the proactive agent fires an alert, show which domains contributed. When the simulation returns results, show the confidence interval and the data basis.

2. **Minimize cognitive load at interruption points.** Menu bar alerts should be dismissible in one tap. The full insight lives one click deeper.

3. **Never show a loading spinner for > 3 seconds without a status update.** Simulations can take 10–30 seconds. Show progress: "Analyzing 847 events across 6 domains…"

4. **The user controls what is collected.** The settings screen for integrations must show, for each adapter: what data it collects, how often, and when it last ran. Disabling an adapter immediately stops sync and flags those events as `source-disabled` in memory.

**macOS menu bar (primary surface):**

The menu bar icon is the heartbeat of PRE. It should communicate system state at a glance:

- Solid icon: running normally
- Pulsing icon: new insight or alert waiting
- Dimmed icon: one or more adapters need attention

Menu structure:

```
[PRE icon]
  ├── Today's summary (1 paragraph, LLM generated, refreshes at 7am)
  ├── Active alerts (if any)
  ├── ─────────────
  ├── Run simulation…
  ├── View insights
  ├── ─────────────
  ├── Sync now
  ├── Integrations…
  └── Settings
```

**Mobile companion (secondary surface):**

- Receives push notifications for `severity='warning'` and `severity='intervention'` alerts
- Full insight browser for reading patterns on the go
- Auto-generated goals visible with progress tracking — no manual goal creation required
- Acts as a passive data source itself (HealthKit, Screen Time, location context)
- Does NOT run the gateway — connects to the desktop gateway over local network via Tailscale

**Web panel (developer/power-user surface):**

- Full event timeline browser
- Raw insight inspector
- Simulation interface with domain selection
- Adapter health dashboard
- Token usage and cost tracking

---

## 4. Data flow

### Ingestion flow (adapter sync → memory)

```
Cron fires sync job for [source]
  ↓
sync-worker.ts picks up BullMQ job
  ↓
adapter.sync(cursor) → AdapterResult
  ↓
For each event in result:
  Validate with Zod life event schema
  Set privacyLevel (adapter default, validated)
  Deduplicate against existing (source, sourceId)
  ↓
memory.write.events(validatedEvents)
  → SQLite: insert life_events
  → For private payloads: libsodium encrypt before JSON
  ↓
Enqueue embedding jobs for new events (BullMQ)
  ↓
emit 'events-ingested' on event bus
  ↓
[Async] embed-worker picks up embedding jobs
  → Call sidecar.embed(event.summary or event.payload excerpt)
  → Store vector in LanceDB
  → Update embedding_sync table
```

### Insight flow (inference engine → alert)

```
Cron fires inference job (every 15 min)
  ↓
insight-worker.ts picks up BullMQ job
  ↓
Inference engine:
  memory.read.recentByDomain(all, 72h)
  sidecar.detect_patterns(events)
  callModel(task='pattern-analysis', privacyLevel='private')
  → produces LifeInsight[]
  ↓
Publish insights to in-memory insight store
  ↓
Proactive agent evaluates each insight:
  For each TriggerRule:
    Check cooldown (query trigger_log)
    Run condition(insight, context)
    If fires: compose(insight) → Alert
    Write to trigger_log
  ↓
If alerts generated:
  Broadcast via WebSocket to connected surfaces
  Send push notification (mobile) for severity >= 'warning'
```

### Simulation flow (auto-triggered or on-demand)

```
Auto-trigger: Inference engine detects forming decision from behavior patterns
OR Manual: Surface sends { type: 'simulate', payload: SimulationRequest }
  ↓
Gateway routes to simulation engine
  ↓
Check cache (24h TTL keyed by decision hash)
  ↓ [cache miss]
Local LLM parses/validates decision → DecisionDescriptor
  ↓
For each affected domain:
  sidecar.forecast_domain(domain, 90d of history) → baseline
  ↓
sidecar.run_simulation(decision, baselines, 1000 samples) → distributions
  ↓
Local LLM generates narrative from distributions
  ↓
Assemble SimulationResult, cache it
  ↓
Auto-triggered: Publish as insight (type='simulation-available')
  → Surface shows as an insight card: "PRE noticed you might be considering X..."
Manual: Gateway sends { type: 'simulation-result', payload: SimulationResult }
  → Surface renders distributions as range charts with confidence intervals
```

---

## 5. Cross-cutting concerns

### Logging

- Use `pino` for structured JSON logging throughout the gateway
- Log levels: `trace` (dev only), `debug`, `info`, `warn`, `error`, `fatal`
- Never log raw payloads from private events — log only `eventId`, `domain`, `eventType`
- Never log API keys, encryption keys, or personal identifiers
- Log all LLM calls: task type, model used, token count, latency, cost (no prompts/responses)

### Error handling

- Gateway layer: `Result<T, E>` pattern — never throw for recoverable errors
- Adapter layer: return `AdapterResult` with partial events + error array on partial failure
- Engine layer: return `null` or an empty result set on failure, log the error, do not propagate
- Worker layer: BullMQ handles retries — workers must be idempotent

### Observability

- `/health` endpoint on the gateway WebSocket server for the desktop app to poll
- BullMQ dashboard available at `http://localhost:18790/queues` in dev mode
- Daily digest written to `~/.pre/logs/daily-YYYY-MM-DD.json` for debugging

### Configuration

All user-configurable settings live in `~/.pre/config.json`. Never in the database, never in env vars (those are secrets only):

```json
{
  "adapters": {
    "plaid": { "enabled": true, "syncIntervalMinutes": 360 },
    "healthkit": { "enabled": true, "syncIntervalMinutes": 15 }
  },
  "models": {
    "localModel": "llama3.1:8b",
    "cloudEnabled": false,
    "monthlyBudgetUsd": 10
  },
  "proactiveAgent": {
    "enabled": true,
    "quietHoursStart": "22:00",
    "quietHoursEnd": "08:00"
  },
  "retention": {
    "eventRetentionDays": 365,
    "insightRetentionDays": 30
  }
}
```

---

## 6. Failure modes & degradation

| Failure               | Impact                                    | Degradation strategy                                                                                           |
| --------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Ollama unreachable    | No local LLM inference                    | Disable inference engine, surface alert. Structured queries still work.                                        |
| Redis unreachable     | No job queue                              | Switch to synchronous in-process execution for sync jobs. Log warning.                                         |
| Sidecar crash         | No embeddings, no patterns, no simulation | Disable inference engine and simulation. Memory reads still work. Sidecar restarts automatically.              |
| SQLite corruption     | Total data loss risk                      | Immediately halt writes. Copy to `~/.pre/recovery/`. Alert user. Do not attempt auto-repair.                   |
| Plaid auth expired    | No financial data                         | Mark adapter `needs-reauth`. Existing events unaffected. Alert user.                                           |
| Disk full             | Cannot write new events                   | Pause all sync jobs. Alert user with current storage usage. Offer to purge old events.                         |
| Cloud API key invalid | No cloud model calls                      | Fall back to local models for all tasks. Log warning, do not alert user unless they have `cloudEnabled: true`. |

---

## 7. Long-term evolution

### Phase 1 — Foundation (months 1–3)

Goal: passive data flows from multiple sources.

- 5+ adapters silently collecting data (money, time, body, people, mind)
- SQLite + LanceDB layer solid, encrypted, tested
- Gateway running stably with no crashes over a 7-day period
- Web panel showing live event timeline populated entirely by adapters
- **Zero manual input required** — a user who connects accounts and does nothing should see data flowing

### Phase 2 — Autonomous Intelligence (months 3–5)

Goal: the system thinks for itself.

- Embeddings generated for all historical events
- Inference engine detecting cross-domain patterns on real personal data
- **AI-generated goals** appearing automatically from observed behavior
- Auto-triggered simulations when behavior suggests forming decisions
- Proactive alerts firing with genuine utility (sleep + spending correlations, etc.)

### Phase 3 — Self-Maintaining Brain (months 5–8)

Goal: the system maintains and improves itself.

- All V1 trigger rules deployed and auto-tuned based on user feedback
- macOS menu bar app shipping as primary surface
- Goal lifecycle fully autonomous: creation, tracking, archival — all AI-driven
- System adjusts its own sync frequencies and inference schedules based on data patterns
- Simulation core uses real personal analogs, not just generic priors

### Phase 4 — Deep Understanding (months 8–12)

Goal: the system understands the user better than they understand themselves.

- Cross-domain correlation models trained on personal data
- Behavioral prediction: "You typically overspend after poor sleep weeks"
- Mobile companion as passive data source (HealthKit, Screen Time, location)
- Optional: multi-device sync (gateway-to-gateway, fully encrypted, no cloud relay)

### Phase 5 — Ecosystem (12+ months)

Goal: the system as a platform.

- Public adapter SDK so third parties can build new data sources
- Export format for full personal data (portability as a right, not a feature)
- Federated insight sharing: share pattern types (not data) with other PRE users to improve priors
- On-device fine-tuning of the local model on personal behavior patterns

---

## 8. Decision log

Significant architectural decisions with their rationale, recorded here so future engineers (human or AI) understand why things are the way they are.

---

**2026-03-29 — Use LanceDB over Chroma for vector storage**

Chroma is popular but requires a server process and has historically had breaking API changes. LanceDB is embedded (like SQLite), written in Rust, and has a stable TypeScript SDK. For a local-first application where we cannot require the user to manage a separate server, embedded wins. We accept the tradeoff that LanceDB's ecosystem is smaller.

---

**2026-03-29 — No message content in the People domain**

We made an explicit decision not to store any message body content from emails, SMS, or messaging apps. The relationship signals we care about (frequency, silence, reconnection) are derivable from metadata alone. Storing message content would dramatically expand the privacy risk surface and create legal exposure in many jurisdictions. The marginal insight value does not justify this.

---

**2026-03-29 — Python sidecar over native TypeScript ML**

LlamaIndex, Prophet, and proper Monte Carlo sampling libraries are mature in Python. The TypeScript ML ecosystem (while improving) lacks equivalents with the same stability and community validation. Rather than port these or use immature alternatives, we run a Python sidecar and accept the IPC overhead. For inference tasks that take seconds anyway, sub-millisecond IPC cost is irrelevant.

---

**2026-03-29 — Local-first even at the cost of capability**

We had an early debate about whether to build cloud-first (simpler architecture, better models immediately) and add local as a later option. We chose local-first because: (1) the trust model of this product requires it — users will not connect bank and health data to a cloud service they don't control; (2) once you build cloud-first, local becomes an afterthought; (3) on-device model quality is improving fast enough that this is a time-limited disadvantage.

---

**2026-03-29 — Simulation output must express uncertainty**

Early prototypes showed single-value outputs ("your sleep will improve by 45 minutes"). Users found these compelling but they were false confidence. We mandated p10/p50/p90 distributions after recognizing that the real value of simulation is helping users understand the _range_ of outcomes, not predicting a specific one. A simulation that shows "your sleep will be somewhere between 30 minutes worse and 90 minutes better, with the most likely outcome being 20 minutes better" is more honest and ultimately more useful.

---

**2026-03-31 — Zero-input as a first principle**

We decided that every feature must be evaluated against the question "Does this require the user to do cognitive work?" Manual data entry, journaling prompts, and explicit goal creation were all redesigned. Goals are now auto-generated by the inference engine from observed behavior. Simulations are auto-triggered when the system detects forming decisions. The user's role is to review, accept, or dismiss — never to create from scratch.

---

_Last updated: 2026-03-31_
_Maintained by: project owner + AI co-architect_
_Next review: after Phase 1 completion_
