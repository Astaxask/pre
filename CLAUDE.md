# CLAUDE.md — Personal Reality Engine (PRE)

> This file is your orientation document. Read it fully before touching any code.
> When in doubt about a decision, **stop and ask** rather than invent an answer.

---

## What this project is

A **local-first, privacy-preserving life OS** — a continuous model of the user's life that reasons across health, finance, time, relationships, and goals to act proactively on their behalf.

It is NOT a task manager, a chatbot wrapper, or an OpenClaw clone.
The core value proposition is three things no existing software does together:

1. A **unified memory layer** — all life data in one encrypted local store
2. A **proactive inference engine** — surfaces conflicts and patterns before the user asks
3. A **simulation core** — models probable consequences of decisions before they're made

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
│   ├── architecture.md
│   ├── privacy-model.md
│   └── data-schema.md
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
| Cloud models        | Anthropic Claude via API         | Only for non-sensitive reasoning tasks       |
| RAG pipeline        | LlamaIndex (Python)              | In the sidecar, not in Node                  |
| Stats/ML            | statsmodels + Prophet (Python)   | Time-series only                             |
| Simulation          | Custom Monte Carlo (TypeScript)  | See simulation spec in docs/                 |
| IPC (Node ↔ Python) | Local Unix socket + JSON-RPC 2.0 | No HTTP between processes                    |

---

## Architecture rules — these are hard constraints

### Privacy boundary (CRITICAL — never violate this)

Raw personal data **never leaves the device** by default. This means:

- Health readings, bank transactions, message content, location history → **local models only**
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

- Integration adapters in `packages/integrations/` — each adapter is self-contained
- Storage layer CRUD operations in `packages/memory/`
- WebSocket message handlers in `apps/gateway/`
- React Native screens that match the design spec in `docs/ui-spec.md`
- Test coverage for any module you create or modify
- Database migrations via Drizzle

**Always ask me before:**

- Changing the life schema in `packages/shared/src/life-schema.ts`
- Adding a new `TriggerRule` to the proactive agent
- Modifying the privacy boundary logic in `packages/models/src/router.ts`
- Changing how embeddings are generated or stored (affects all semantic memory)
- Adding a new external API integration that touches health or financial data
- Any change that would alter how data is encrypted at rest

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
- All new modules need a `README.md` explaining what they do and why

### Naming

- Adapters: `[source]-adapter.ts` (e.g. `plaid-adapter.ts`)
- Trigger rules: `[domain]-[condition]-rule.ts` (e.g. `money-stress-pattern-rule.ts`)
- LLM calls: always go through `packages/models/src/call.ts`, never instantiate clients directly

### Testing

- Unit tests for all pure functions (condition functions in trigger rules, schema parsers, simulation math)
- Integration tests for each adapter (use recorded API fixtures, not live calls)
- No tests for React Native UI components unless they contain logic
- Use Vitest for all TypeScript tests; pytest for Python sidecar

### Git

- Branch naming: `feat/[layer]-[what]` e.g. `feat/l1-plaid-adapter`
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

Do not add new sidecar methods without asking. Each method has a defined timeout; if it exceeds the timeout the gateway must degrade gracefully (return a cached result or skip the inference step).

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

# Init the database
pnpm --filter @pre/memory db:migrate

# Start all services in development
pnpm dev
```

Required env vars (see `.env.example` for full list):

```
ANTHROPIC_API_KEY=        # Claude API — only used for cloud-safe tasks
PLAID_CLIENT_ID=          # Finance integration
PLAID_SECRET=
GOOGLE_CLIENT_ID=         # Calendar + Gmail
GOOGLE_CLIENT_SECRET=
PRE_ENCRYPTION_KEY=       # 32-byte hex key — generate with: openssl rand -hex 32
```

---

## Current build status

| Layer           | Status                          | Notes                               |
| --------------- | ------------------------------- | ----------------------------------- |
| L1 Integrations | Not started                     | Start here                          |
| L2 Memory       | Schema drafted, not implemented | Schema in `docs/data-schema.md`     |
| L3 Model router | Not started                     | Build after L2                      |
| L4 Engines      | Design only                     | Do not build until L1–L3 are stable |
| L5 Gateway      | Scaffold only                   | `apps/gateway/src/index.ts` exists  |
| L6 Surfaces     | Not started                     | Build last                          |

**Recommended first task:** implement the Plaid adapter in `packages/integrations/src/plaid/`.
It is self-contained, has a clear input/output contract, and exercises the full L1→L2 pipeline.

---

## What success looks like

A working MVP means:

1. At least 3 integrations running and writing to the memory layer (health, finance, calendar)
2. The inference engine detecting at least one real cross-domain pattern on real personal data
3. One proactive trigger rule firing correctly without false positives for 7 days
4. All personal data encrypted at rest, verified by a test that reads raw SQLite bytes

Everything else is polish.

---

_Last updated: 2026-03-29_
_Owner: you_
_Questions: stop and ask, don't invent_

1. At least 3 integrations running and writing to the memory layer (health, finance, calendar)
2. The inference engine detecting at least one real cross-domain pattern on real personal data
3. One proactive trigger rule firing correctly without false positives for 7 days
4. All personal data encrypted at rest, verified by a test that reads raw SQLite bytes

Everything else is polish.

---

_Last updated: 2026-03-29_
_Owner: you_
_Questions: stop and ask, don't invent_
