# CLAUDE.md — Personal Reality Engine (PRE)

> This file is your orientation document. Read it fully before touching any code.
> When in doubt about a decision, **stop and ask** rather than invent an answer.

---

## What this project is

A **local-first, privacy-preserving autonomous second brain** — a system that silently observes the user's digital life, builds a continuous model of their reality, and acts proactively on their behalf without ever requiring manual input.

It is NOT a task manager, a chatbot, a journaling app, or anything that asks the user to do work. **If the user has to type, tap, or think to feed data into the system, we have failed.** The entire value proposition is that PRE does the cognitive labor the user would otherwise have to do themselves.

### The three pillars

1. **Autonomous observation** — PRE silently collects data from every available digital signal: phone usage patterns, computer activity, browser behavior, financial transactions, health sensors, calendar, communication metadata, location context. The user installs it, grants permissions, and never thinks about data entry again.

2. **Proactive intelligence** — The inference engine continuously reasons across all six life domains. It detects patterns, identifies conflicts, generates goals, tracks progress, and surfaces insights — all without being asked. It writes its own goals based on observed behavior. It maintains its own memory. It is a self-sustaining cognitive loop.

3. **Consequence modeling** — Before the user makes a decision (or when the system detects one forming), PRE simulates probable outcomes across all affected domains, expressed as probability ranges with honest uncertainty.

### What makes this different

The user opens PRE and sees a living dashboard that already knows:
- Their sleep has been declining for 5 days and it correlates with late screen time
- Their spending pattern shifted this month toward dining out
- They have 3 meetings tomorrow but haven't had a focus block in 4 days
- A goal the system auto-created ("reduce screen time after 10pm") is 40% on track

**They did nothing to make this happen.** No logging, no tagging, no check-ins. The system observed, inferred, and presented.

---

## The autonomous data philosophy

### Zero-input design principle

Every feature must be evaluated against this question: **"Does this require the user to do anything?"** If yes, redesign it so it doesn't. The only acceptable user actions are:

- **Initial setup** — granting permissions, connecting accounts (one-time)
- **Reviewing what PRE found** — reading insights, alerts, simulations
- **Making decisions** — accepting/dismissing suggestions, asking "what if"
- **Overriding** — correcting something the system got wrong (rare, learning opportunity)

Manual data entry (journaling, mood logging, goal creation) should exist as a fallback but **never be the primary path**. The system should auto-detect mood from behavior patterns, auto-create goals from observed intentions, and auto-log activities from digital signals.

### Adapter-first architecture

Adapters are the lifeblood of PRE. The more signals we collect passively, the better the model. Current and planned adapters:

| Adapter | Domain(s) | Signal type | Priority |
|---------|-----------|-------------|----------|
| **Plaid** | money | Transactions, balances, bills | **Built** |
| **Google Calendar** | time | Events, duration, patterns | **Built** |
| **Apple HealthKit** | body | Sleep, HRV, steps, workouts, heart rate | **Next** |
| **Screen Time (iOS)** | time, mind | App usage, pickups, focus modes | **High** |
| **WHOOP** | body | Recovery, strain, sleep stages | **High** |
| **Oura** | body | Readiness, sleep quality, temperature | **High** |
| **Gmail metadata** | people | Communication frequency, response times | **Medium** |
| **Browser history** | mind, time | Topics of interest, time allocation | **Medium** |
| **macOS Screen Time** | time, mind | Application usage, focus patterns | **Medium** |
| **Garmin** | body | Workouts, body battery, stress | **Medium** |
| **Location (coarse)** | world | Home/work/transit patterns (no GPS stored) | **Medium** |
| **Spotify/Apple Music** | mind | Listening patterns, mood inference | **Low** |
| **iOS Shortcuts** | world | Custom automation triggers | **Low** |

### AI-generated goals and self-maintenance

The system does not wait for the user to set goals. It observes behavior patterns and creates goals automatically:

- Detects the user started running 3x/week → creates "Maintain running habit" goal, tracks adherence
- Notices spending increased 30% → creates "Monitor discretionary spending" goal
- Sees sleep declining → creates "Improve sleep consistency" goal with inferred target
- Observes deep work sessions decreasing → creates "Protect focus time" goal

Goals are created by the inference engine with `source: 'inferred'` and `confidence` scores. The user can dismiss, modify, or promote them. Dismissed goals teach the system what matters to the user.

The proactive agent also self-maintains the memory:
- Archives stale goals automatically
- Adjusts sync frequencies based on data freshness
- Re-runs pattern detection when new adapter data arrives
- Prunes expired insights and updates confidence scores

---

## Monorepo structure

```
pre/
├── apps/
│   ├── gateway/          # Node.js control plane (L5)
│   ├── desktop/          # Tauri/Rust desktop shell (L6)
│   ├── mobile/           # React Native iOS+Android (L6)
│   └── web/              # WebSocket control panel UI (L6)
├── packages/
│   ├── memory/           # SQLite + LanceDB layer (L2)
│   ├── integrations/     # Data source adapters (L1)
│   ├── engines/          # Inference, simulation, proactive agent (L4)
│   ├── models/           # LLM routing abstraction (L3)
│   └── shared/           # Shared types, schemas, utils
├── sidecar/              # Python process for ML/stats (L4 support)
├── docs/
│   ├── architecture.md   # Full system architecture
│   ├── privacy-model.md  # Privacy enforcement spec
│   ├── data-schema.md    # Unified data model
│   ├── simulation-spec.md # Simulation engine spec
│   └── ui-spec.md        # UI/UX design language
├── scripts/              # Start/setup scripts
├── CLAUDE.md             # This file
└── turbo.json            # Turborepo config
```

---

## Tech stack — do not deviate without asking

| Layer               | Technology                       | Notes                                        |
| ------------------- | -------------------------------- | -------------------------------------------- |
| Monorepo            | Turborepo + pnpm workspaces      | Do not switch to nx or yarn                  |
| Gateway runtime     | Node.js 22 + TypeScript 5.4      | Strict mode, no `any`                        |
| Desktop shell       | Tauri 2 (Rust)                   | Wraps the gateway process                    |
| Mobile              | React Native 0.74 + Expo         | Bare workflow, not managed                   |
| Structured storage  | SQLite via `better-sqlite3`      | Managed with Drizzle ORM                     |
| Vector storage      | LanceDB (local)                  | Do not use Chroma in production              |
| Encryption          | `libsodium-wrappers` + `age`     | See privacy rules below                      |
| Job queue           | BullMQ + Redis (local)           | Redis runs as a sidecar process              |
| Scheduler           | `node-cron`                      | For proactive trigger checks                 |
| Schema validation   | Zod                              | All external data must be parsed through Zod |
| LLM routing         | LiteLLM (via Python sidecar)     | See model routing rules below                |
| Local models        | Ollama                           | Llama 3.1 8B for default private inference   |
| Cloud models        | Anthropic Claude via API         | Only for non-sensitive reasoning tasks        |
| RAG pipeline        | LlamaIndex (Python)              | In the sidecar, not in Node                  |
| Stats/ML            | statsmodels + Prophet (Python)   | Time-series only                             |
| Simulation          | Custom Monte Carlo (TypeScript)  | See simulation spec in docs/                 |
| IPC (Node <-> Python) | Local Unix socket + JSON-RPC 2.0 | No HTTP between processes                  |

---

## Architecture rules — these are hard constraints

### Privacy boundary (CRITICAL — never violate this)

Raw personal data **never leaves the device** by default. This means:

- Health readings, bank transactions, message content, location history -> **local models only**
- Abstract summaries without PII may go to cloud models: `"user shows high financial stress pattern this week"` is OK; `"user's Chase account balance is $847"` is NOT
- The privacy boundary is enforced in `packages/models/src/router.ts`
- Every LLM call must be tagged with a `privacyLevel: 'local' | 'cloud-safe'` enum
- If you are unsure whether data is cloud-safe: **default to local**

### The life schema is the source of truth

All data entering the system from any integration (L1) must be normalized into the unified life schema defined in `packages/shared/src/life-schema.ts`. Never let raw API responses flow into the memory layer directly.

The life schema has six top-level domains:

```typescript
type LifeDomain = "body" | "money" | "people" | "time" | "mind" | "world";
```

Every `LifeEvent` has: `id`, `domain`, `timestamp`, `source`, `payload` (typed per domain), `embedding` (vector), `privacyLevel`.

### The inference engine is the brain — it must be autonomous

The inference engine (`packages/engines/src/inference/`) runs on a schedule (every 15 minutes) and after every sync. It does not wait for user input. Its responsibilities:

- **Pattern detection** — cross-domain correlations (sleep vs spending, exercise vs mood)
- **Trend analysis** — directional changes in any metric over time
- **Goal generation** — create goals from observed behavior patterns (source: 'inferred')
- **Goal tracking** — monitor progress on all goals, update confidence, archive stale ones
- **Anomaly detection** — flag unusual deviations from established patterns
- **Insight composition** — turn raw patterns into human-readable insights with confidence scores

### Proactive agent must never act without a trigger rule

The proactive agent (`packages/engines/src/proactive/`) fires on scheduled checks and event webhooks. It does NOT poll continuously. Every action the agent can take must be defined as a named `TriggerRule` with:

- A condition function (pure, testable)
- A severity level (`info | warning | intervention`)
- A cooldown period (prevent notification spam)
- An explicit list of data domains it reads

Do not add agent behaviors that aren't expressed as `TriggerRule` objects.

### The simulation core is probabilistic, not deterministic

The simulation does not predict the future. It samples from probability distributions. Results must always be expressed as ranges with confidence intervals, never as single values. The user must always see uncertainty clearly.

---

## What to build vs. what to ask me first

**Build autonomously:**

- New integration adapters in `packages/integrations/` — the more the better
- Adapter sync logic and data normalization
- New `TriggerRule` implementations for the proactive agent
- Inference engine improvements (pattern detection, goal generation)
- Storage layer CRUD operations in `packages/memory/`
- WebSocket message handlers in `apps/gateway/`
- UI screens that match the design spec in `docs/ui-spec.md`
- Test coverage for any module you create or modify
- Database migrations via Drizzle
- Sidecar methods for new ML/stats capabilities

**Always ask me before:**

- Changing the life schema in `packages/shared/src/life-schema.ts`
- Modifying the privacy boundary logic in `packages/models/src/router.ts`
- Changing how embeddings are generated or stored (affects all semantic memory)
- Any change that would alter how data is encrypted at rest
- Adding network calls to any new external service not in the adapter plan

---

## Coding standards

### TypeScript

- Strict mode always. Zero `any` types. Use `unknown` and narrow.
- Prefer `type` over `interface` for data shapes; `interface` for things that get implemented/extended
- All async functions must handle errors explicitly — no unhandled promise rejections
- Use Zod for all runtime validation of external data. Parse at the boundary, trust inside.
- Use `Result<T, E>` pattern (from `packages/shared/src/result.ts`) instead of throwing for recoverable errors

### File structure

- One export per file where practical
- `index.ts` barrel files are allowed only at package root
- Co-locate tests: `foo.ts` and `foo.test.ts` in the same directory

### Naming

- Adapters: `[source]-adapter.ts` (e.g. `plaid-adapter.ts`, `healthkit-adapter.ts`)
- Trigger rules: `[domain]-[condition]-rule.ts` (e.g. `money-stress-pattern-rule.ts`)
- LLM calls: always go through `packages/models/src/router.ts`, never instantiate clients directly

### Testing

- Unit tests for all pure functions (condition functions, schema parsers, simulation math)
- Integration tests for each adapter (use recorded API fixtures, not live calls)
- Mock external dependencies (LLM calls, sidecar) in tests — tests must not require running services
- Use Vitest for all TypeScript tests; pytest for Python sidecar

### Git

- Branch naming: `feat/[layer]-[what]` e.g. `feat/l1-healthkit-adapter`
- Commit messages: conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)
- Never commit `.env` files, API keys, or personal data fixtures
- PRs need a one-paragraph description of what changed and why

---

## Python sidecar

The sidecar lives in `sidecar/` and runs as a separate process. The gateway spawns it on startup.

Communication: Unix socket at `/tmp/pre-sidecar.sock`, JSON-RPC 2.0 protocol.

The sidecar exposes these methods:

- `embed(text: str) -> list[float]` — generate embeddings
- `similarity_search(query_embedding, top_k) -> list[LifeEvent]` — semantic search
- `forecast_domain(domain, history) -> ForecastResult` — time-series forecast
- `detect_patterns(events) -> list[Pattern]` — cross-domain correlation detection
- `run_simulation(decision, context) -> SimulationResult` — Monte Carlo sampling
- `estimate_impact(decision_type, domain, events, horizon_days) -> ImpactEstimate` — historical analog matching

Each method has a defined timeout; if it exceeds the timeout the gateway must degrade gracefully (return a cached result or skip the inference step).

---

## Environment setup

```bash
# Prerequisites: Node 22, pnpm 9, Python 3.11, Rust toolchain, Ollama

# Install dependencies
pnpm install

# Pull the default local model
ollama pull llama3.1:8b

# Set up local Redis (required for BullMQ)
brew install redis && brew services start redis   # macOS
# or: docker run -d -p 6379:6379 redis:alpine

# Copy env template and fill in API keys
cp .env.example .env

# Start all services
pnpm start

# Or start individual services
pnpm start:web        # Web control panel
pnpm setup:google     # One-time Google OAuth setup
```

Required env vars (see `.env.example` for full list):

```
PRE_ENCRYPTION_KEY=       # 32-byte hex key — generate with: openssl rand -hex 32
ANTHROPIC_API_KEY=        # Claude API — only used for cloud-safe tasks
PLAID_CLIENT_ID=          # Finance integration
PLAID_SECRET=
PLAID_ACCESS_TOKEN=       # From Plaid Link token exchange
GOOGLE_CLIENT_ID=         # Calendar + Gmail
GOOGLE_CLIENT_SECRET=
```

---

## Current build status

| Layer           | Status          | Notes                                       |
| --------------- | --------------- | ------------------------------------------- |
| L1 Integrations | 2 adapters live | Plaid (money) + Google Calendar (time)       |
| L2 Memory       | Working         | SQLite + encryption + Drizzle migrations     |
| L3 Model router | Working         | Privacy routing, PII scanning, budget limits |
| L4 Engines      | Working         | Inference, simulation, proactive agent       |
| L5 Gateway      | Working         | Full startup, WebSocket, BullMQ workers      |
| L6 Surfaces     | Web panel live  | Dashboard, timeline, goals, adapters, settings |

**All 142 tests passing across 9 packages.**

### Next priorities (in order)

1. **Apple HealthKit adapter** — covers the critical body domain, passive collection
2. **WHOOP / Oura adapter** — recovery and sleep quality signals
3. **Autonomous goal generation** — inference engine auto-creates goals from patterns
4. **Screen Time adapter** — phone/computer usage patterns (time + mind domains)
5. **Gmail metadata adapter** — communication frequency signals (people domain)
6. **Browser history adapter** — interest and attention tracking (mind domain)
7. **More trigger rules** — sleep-trend, spending-spike, goal-drift, social-silence

---

## What success looks like

A working autonomous system means:

1. **5+ adapters** collecting data passively across body, money, time, people, and mind domains
2. **Zero manual input required** — the user opens the app and sees a populated dashboard
3. **AI-generated goals** appearing based on observed behavior (not user-created)
4. **Cross-domain insights** firing automatically (sleep affects spending, exercise improves focus)
5. **Proactive alerts** that are genuinely useful and not annoying (< 3/day average)
6. **Simulation** that uses real personal history to model decisions
7. **All personal data encrypted at rest**, verified by a test that reads raw SQLite bytes
8. **Graceful degradation** — every component works even when others are down

The north star: **a user who installed PRE 30 days ago and never manually entered anything should have a rich, accurate model of their life.**

---

_Last updated: 2026-03-31_
_Owner: you_
_Questions: stop and ask, don't invent_
