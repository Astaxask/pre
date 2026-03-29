# Privacy Model — Personal Reality Engine (PRE)

> This document defines the privacy philosophy, threat model, data governance rules,
> and technical enforcement mechanisms for PRE.
>
> For Claude Code: the privacy boundary is not a suggestion. Every decision that touches
> how data moves, is stored, or is transmitted must be checked against this document.
> When in doubt: the more private option is always correct.

---

## Table of contents

1. [Philosophy](#1-philosophy)
2. [Threat model](#2-threat-model)
3. [The three-tier privacy classification](#3-the-three-tier-privacy-classification)
4. [What each integration collects — and what it refuses to](#4-what-each-integration-collects--and-what-it-refuses-to)
5. [Technical enforcement](#5-technical-enforcement)
6. [The cloud boundary in detail](#6-the-cloud-boundary-in-detail)
7. [User rights and controls](#7-user-rights-and-controls)
8. [What we never do](#8-what-we-never-do)
9. [Legal considerations](#9-legal-considerations)

---

## 1. Philosophy

PRE is built on a simple premise: **the most personal data ever assembled about a human being should be controlled entirely by that human being.**

Health readings, bank transactions, relationship patterns, sleep quality, mood, location, goals — no other software in history has assembled all of these in one place. That fact demands an equally unusual approach to privacy: not compliance-driven, not marketing-driven, but built from first principles as a core engineering constraint.

The guiding principle is **data minimalism with maximum utility.** We collect what is necessary to provide a specific, named benefit. We store it locally. We encrypt it. We never transmit raw personal data. We provide full export. We provide full deletion. We explain everything to the user in plain language.

Privacy in PRE is not a feature. It is the architecture.

---

## 2. Threat model

Understanding what we are protecting against shapes every technical decision below.

### Threats we protect against

**T1 — Compromised device storage**
An attacker gains read access to the files on the user's device (stolen laptop, malware, forensic imaging). They can read the SQLite file and the LanceDB directory.

_Mitigation:_ SQLCipher encryption on the entire database. Field-level libsodium encryption on private payloads. age encryption on the vector store directory. The raw files are useless without `PRE_ENCRYPTION_KEY`.

**T2 — Compromised encryption key**
An attacker obtains `PRE_ENCRYPTION_KEY` (keylogger, shoulder surfing, insecure storage in another app).

_Mitigation:_ HKDF key derivation means one key never directly decrypts everything — separate derived keys per purpose. The root key is never stored on disk; it is provided at gateway startup and held only in memory.

**T3 — Malicious or compromised cloud model provider**
The user has cloud models enabled. A cloud model provider (Anthropic, OpenAI) could log prompts, use them for training, or be compelled by law enforcement to produce them.

_Mitigation:_ Raw personal data never reaches cloud models. Only abstracted, non-PII summaries do. See section 6 for exactly what "abstracted" means in practice.

**T4 — Supply chain attack on dependencies**
A malicious npm or PyPI package exfiltrates data by making outbound network requests.

_Mitigation:_ The gateway has a strict outbound allowlist (only configured API endpoints). All outbound requests are logged. The sidecar runs without network access by default.

**T5 — Gateway process memory exposure**
An attacker with code execution on the user's machine reads the gateway process memory, which holds decrypted event payloads during processing.

_Mitigation:_ Decrypted payloads exist in memory only for the duration of a specific operation. The gateway minimizes the window. We cannot fully prevent this threat — it is a fundamental constraint of running software on a general-purpose OS. We document it honestly.

**T6 — Rogue adapter or skill**
A third-party adapter (from a future plugin ecosystem) exfiltrates data by sending it to a remote server.

_Mitigation:_ Third-party adapters run in a sandboxed worker thread with no direct access to the memory layer. They produce `LifeEvent` objects which the gateway validates and classifies. The network allowlist in the gateway blocks unapproved outbound destinations.

### Threats we explicitly do not protect against

- **Full device compromise with root access.** If an attacker has root on your device, no software-level protection holds.
- **Physical coercion.** We cannot protect against a user being forced to decrypt their own data.
- **User choice to weaken privacy.** If the user deliberately enables cloud models and sends rich personal context, they have made that choice.

---

## 3. The three-tier privacy classification

Every `LifeEvent` carries a `privacyLevel` field. This is the single most important field in the system. It controls where data can go, who can see it, and what the model router will do with it.

### Tier 1: `private`

**Definition:** Raw personal data that could identify the user, reveal sensitive health or financial status, or expose private relationships. This data must never leave the device in any form.

**Examples:**

- Bank transaction amounts, merchant names, account balances
- Raw sleep duration, HRV readings, heart rate
- Recovery scores and biometric values (weight, blood pressure)
- Calendar event titles and attendee counts
- Email metadata (sender/recipient opaque IDs, timestamps)
- Mood logs and journal entries
- Exact workout types and durations

**Technical rules for `private` data:**

- Stored encrypted at two levels (SQLCipher + libsodium secretbox)
- Never passed to the model router with `privacyLevel='cloud-safe'`
- Never included in WebSocket messages sent outside localhost
- Embeddings generated only by local Ollama models
- Summaries generated only by local Ollama models
- Logs must never contain the payload — only `eventId` and `domain`

---

### Tier 2: `summarizable`

**Definition:** Data that is private in its raw form but can be abstracted into a non-identifying summary that is safe for cloud model reasoning. The raw form stays local; only the abstraction may travel.

**Examples:**

- "User's sleep has been declining over the past week" (from raw sleep minutes)
- "Unusual spending pattern detected" (from raw transactions, no amounts or merchants)
- "High recovery this week" (from raw HRV and recovery scores)
- "Calendar density is above normal" (from raw event count and duration)

**Technical rules for `summarizable` data:**

- Raw payload stored and processed exactly like `private` data
- The inference engine may generate an abstracted summary using a local model
- That generated summary is tagged `privacyLevel='cloud-safe'` and may enter cloud model prompts
- The abstraction step is one-way: the cloud model sees only the summary, never the source events
- Abstractions must not contain: specific numbers, named entities, dates, locations, or account identifiers

---

### Tier 3: `cloud-safe`

**Definition:** Abstract, non-identifying signals that contain no PII and no sensitive raw values. These may be included in cloud model prompts.

**Examples:**

- "User is in a high-stress pattern across health and financial domains"
- "User has an active goal related to fitness that is drifting"
- "User has a relationship in their network showing a 30-day silence signal"
- "Simulation request: what if user changes job type? (no company names, no salary figures)"

**Technical rules for `cloud-safe` data:**

- May be included in Anthropic or OpenAI API calls
- Must still be transmitted over HTTPS (no plaintext API calls)
- The router validates that messages flagged `cloud-safe` do not contain patterns suggesting raw PII
- If validation fails, the call is downgraded to local model automatically

---

## 4. What each integration collects — and what it refuses to

This is the explicit contract for each adapter. Claude Code: if an API offers data not listed in the "Collects" column, do not collect it, even if it seems useful.

### Plaid (Money)

| Collects                               | Does not collect                              |
| -------------------------------------- | --------------------------------------------- |
| Transaction amount, direction, date    | Account numbers (uses opaque Plaid IDs only)  |
| Merchant name (for categorization)     | SSN, DOB, or any identity fields              |
| Plaid category hierarchy               | Full account holder name                      |
| Account type (checking/savings/credit) | Routing numbers                               |
| Account balance snapshot               | Transaction descriptions longer than 50 chars |
| Bill due dates and estimated amounts   | Investment holdings detail                    |

### Apple HealthKit (Body)

| Collects                                 | Does not collect                |
| ---------------------------------------- | ------------------------------- |
| Sleep duration, stages (deep/REM)        | GPS coordinates or location     |
| Resting heart rate, HRV                  | Medical records or diagnoses    |
| Step count, active calories              | Medication or supplement data   |
| Workout type and duration                | Menstrual cycle data            |
| Recovery/readiness scores (if available) | Blood oxygen beyond basic range |

### Oura / WHOOP / Garmin (Body)

| Collects                      | Does not collect                  |
| ----------------------------- | --------------------------------- |
| Sleep score, duration, stages | GPS tracks or route data          |
| Recovery/readiness score      | Social features or sharing data   |
| HRV, resting HR               | Device ID or hardware identifiers |
| Strain/activity score         | Account email or name             |

### Google Calendar (Time)

| Collects                                                  | Does not collect                  |
| --------------------------------------------------------- | --------------------------------- |
| Event start time, end time, duration                      | Event title or description        |
| Is recurring (boolean)                                    | Attendee names or email addresses |
| Attendee count (integer only)                             | Video conference links            |
| Calendar ID (hashed, not raw)                             | Event location                    |
| Rough category (work/personal, inferred from calendar ID) | Attached files or notes           |

### Gmail (People)

| Collects                                             | Does not collect                      |
| ---------------------------------------------------- | ------------------------------------- |
| Email timestamp                                      | Subject line                          |
| Direction (sent vs received)                         | Body content — not a single character |
| Contact opaque ID (SHA-256 of email address, salted) | Sender or recipient email addresses   |
| Thread depth (reply count)                           | CC or BCC recipients                  |
| Response latency (hours to reply)                    | Attachment names or contents          |

_Note: Gmail metadata collection requires explicit user opt-in with a clear explanation of exactly what is and is not read. Default is off._

---

## 5. Technical enforcement

Privacy rules are enforced at three independent layers. A violation must pass through all three to succeed — defense in depth.

### Layer A: Adapter classification (ingestion time)

Each adapter sets `privacyLevel` on every `LifeEvent` it produces. The gateway validates this against the adapter's declared manifest — if an adapter marks a financial transaction as `cloud-safe`, the gateway rejects it and logs the violation. Adapters cannot exceed the maximum privacy tier declared in their manifest.

```typescript
// In each adapter's manifest:
maxPrivacyLevel: "private"; // This adapter cannot produce cloud-safe events
```

### Layer B: Model router enforcement (call time)

The model router inspects every message array before dispatching to a model. It:

1. Checks the `privacyLevel` of the request
2. If `cloud-safe`, scans message content for PII patterns:
   - Numbers that look like currency values (> $100 with $ sign or "USD")
   - Named individuals (simple NER heuristic)
   - Dates combined with health metrics
   - Account-like strings (16-digit numbers, routing number patterns)
3. If PII patterns detected: downgrade to local model, log the attempt
4. If `private`: route to local model unconditionally, no content scanning needed

### Layer C: Network-level allowlist (runtime)

The gateway process runs with an outbound network allowlist enforced at the OS level (via `pf` on macOS, `iptables` on Linux). Allowed outbound destinations:

- `api.anthropic.com` (only if cloud enabled)
- `api.openai.com` (only if cloud enabled)
- `production.plaid.com`, `sandbox.plaid.com`
- `api.ouraring.com`
- `api.whoop.com`
- `api.fitbit.com`
- `www.googleapis.com`
- `localhost` (for Redis, sidecar, surfaces)

Any other outbound connection is blocked and logged. This prevents a compromised dependency from exfiltrating data even if it bypasses Layer A and B.

---

## 6. The cloud boundary in detail

This section defines precisely what a cloud model prompt may and may not contain.

### Permitted in cloud model prompts

```
✓ Abstract pattern descriptions without numbers
  "User's sleep quality has been declining this week"

✓ Domain-level status without specifics
  "Financial stress pattern detected"

✓ Goal descriptions without personal details
  "User has an active fitness goal that is drifting"

✓ Temporal patterns without dates
  "User shows a recurring low-energy pattern mid-week"

✓ Relationship signals without identities
  "A relationship in user's network shows a long-silence signal"

✓ Simulation decision types without personal context
  "What are the likely effects of a job change on health and finances?"
```

### Forbidden in cloud model prompts

```
✗ Any specific number tied to health or finance
  "User's HRV is 34ms"  →  forbidden
  "User spent $2,847 this month"  →  forbidden
  "User slept 5.2 hours"  →  forbidden

✗ Named individuals (other than the user themselves by first name only)
  "User's colleague Sarah said..."  →  forbidden

✗ Company names, institutions, or locations
  "User banks at Chase"  →  forbidden
  "User works at Acme Corp"  →  forbidden
  "User lives in Austin"  →  forbidden

✗ Dates combined with sensitive information
  "On March 15, user had a panic attack"  →  forbidden

✗ Medical or diagnostic language
  "User may have sleep apnea"  →  forbidden
  "User's blood pressure is elevated"  →  forbidden

✗ Raw event payloads of any kind
  Entire LifeEvent objects  →  forbidden, even if domain='world'
```

### The abstraction transform

When the inference engine needs to use `summarizable` data in a cloud model call, it must first run the abstraction transform using a local model:

```
Input (local model only):
  "Analyze these sleep events and produce a cloud-safe one-sentence summary.
   Do not include specific numbers, dates, or identifiers.
   Output only the summary sentence, nothing else."
  + [raw sleep events, processed locally]

Output (becomes cloud-safe):
  "User's sleep quality has been below their personal baseline for an extended period."

This output may then enter a cloud model prompt.
```

The abstraction step is mandatory. There is no shortcut where raw data goes directly to a cloud model with a "please be careful" instruction.

---

## 7. User rights and controls

PRE users have the following rights, all implemented in the settings UI:

### Right to know

The integration settings screen shows for each adapter:

- Exactly what data fields are collected (links to section 4 of this document)
- When the adapter last ran
- How many events it has produced in total
- The current sync status

### Right to restrict

Any adapter can be disabled instantly. Disabling an adapter:

1. Stops all future sync jobs for that source
2. Marks all existing events from that source as `source-disabled` in the database
3. Does NOT delete existing events (see right to delete below)
4. Does NOT remove embeddings (they remain, flagged as disabled)

### Right to delete

The settings screen provides domain-level and source-level deletion:

- "Delete all Plaid data" → removes all events where `source='plaid'` and their embeddings
- "Delete all body domain data" → removes all events where `domain='body'`
- "Delete everything" → drops and recreates the entire database, removes all vectors, resets config

Deletion is immediate and permanent. There is no soft delete, no recycle bin, no recovery. This is by design — deletion should mean deletion.

### Right to export

The user can export their full dataset at any time as an encrypted JSON archive:

```
pre-export-YYYY-MM-DD.age
```

Encrypted with the same `age` key as the vector store. Contains:

- All `LifeEvent` objects in JSON
- All `Goal` objects
- Configuration (without secrets)
- A `README.txt` explaining the format

The export format is documented publicly so users can build their own readers.

### Right to understand

Any alert or insight shown to the user must include a "Why am I seeing this?" explanation that names:

- Which domains contributed
- The approximate time window of data used
- Which trigger rule fired
- How to disable that rule

---

## 8. What we never do

These are hard constraints that cannot be overridden by configuration, user request, or future feature development without a documented revision to this document.

1. **We never transmit raw personal data off-device.** Not health. Not finance. Not communications metadata in identifiable form. Not location. Ever.

2. **We never log prompt or response content from LLM calls.** Token counts and latencies only. The content of what the model is asked or says is not logged anywhere.

3. **We never store API keys or OAuth tokens in the database.** They live in the OS keychain (macOS Keychain, Linux Secret Service) and are retrieved at runtime.

4. **We never use personal data to train any model.** Not locally, not via opt-in, not via any API that would forward our data to a training pipeline.

5. **We never implement analytics, telemetry, or crash reporting that transmits data off-device.** Crash logs stay local. Usage statistics are not collected.

6. **We never implement social features that share data between users.** The Phase 5 federated insight concept (see architecture.md) must be implemented with differential privacy and zero knowledge of individual user data before it can ship.

7. **We never make outbound connections to domains not on the allowlist.** No CDN calls, no font loading, no analytics pixels, no version-check pings.

---

## 9. Legal considerations

_This section is informational, not legal advice. Consult a lawyer before distributing PRE to users other than yourself._

### GDPR (EU)

If PRE is distributed to EU users, the operator (you) becomes a data controller. The privacy architecture described here — local storage, user rights to access/delete/export, no third-party sharing — aligns well with GDPR requirements. The explicit "what we collect" tables in section 4 support transparency obligations. However: GDPR also requires a lawful basis for processing, a privacy policy, and in some configurations a Data Processing Agreement with API providers.

### HIPAA (US)

PRE collects health data (sleep, heart rate, HRV). If distributed commercially in the US, evaluate whether this constitutes a covered health application under HIPAA. The local-first architecture (no server, no cloud health data) substantially reduces HIPAA exposure, but get legal advice before commercial distribution.

### CCPA (California)

California users have rights to know, delete, and opt out of sale of personal information. PRE never sells data (see section 8), which satisfies the opt-out requirement. Deletion is implemented (section 7). A privacy notice describing data practices is required for commercial distribution.

### Financial data (Plaid)

Plaid's API Terms of Service restrict certain uses of financial data. Review Plaid's Developer Policy before distributing PRE commercially. Plaid's usage policies around data storage and permissible use apply to data retrieved via their API.

### OAuth tokens and third-party ToS

Gmail, Google Calendar, and Apple HealthKit are accessed via OAuth. Each service's developer terms govern acceptable use. Notably: Google's API Services User Data Policy requires a privacy policy and restricts certain uses of Gmail data. The metadata-only approach described in section 4 is designed to comply with these restrictions, but review the current terms before distribution.

---

_Last updated: 2026-03-29_
_See also: `docs/architecture.md`, `docs/data-schema.md`_
_This document must be reviewed and re-signed off by the project owner after any change to the integration layer, model layer, or encryption implementation._

### GDPR (EU)

If PRE is distributed to EU users, the operator (you) becomes a data controller. The privacy architecture described here — local storage, user rights to access/delete/export, no third-party sharing — aligns well with GDPR requirements. The explicit "what we collect" tables in section 4 support transparency obligations. However: GDPR also requires a lawful basis for processing, a privacy policy, and in some configurations a Data Processing Agreement with API providers.

### HIPAA (US)

PRE collects health data (sleep, heart rate, HRV). If distributed commercially in the US, evaluate whether this constitutes a covered health application under HIPAA. The local-first architecture (no server, no cloud health data) substantially reduces HIPAA exposure, but get legal advice before commercial distribution.

### CCPA (California)

California users have rights to know, delete, and opt out of sale of personal information. PRE never sells data (see section 8), which satisfies the opt-out requirement. Deletion is implemented (section 7). A privacy notice describing data practices is required for commercial distribution.

### Financial data (Plaid)

Plaid's API Terms of Service restrict certain uses of financial data. Review Plaid's Developer Policy before distributing PRE commercially. Plaid's usage policies around data storage and permissible use apply to data retrieved via their API.

### OAuth tokens and third-party ToS

Gmail, Google Calendar, and Apple HealthKit are accessed via OAuth. Each service's developer terms govern acceptable use. Notably: Google's API Services User Data Policy requires a privacy policy and restricts certain uses of Gmail data. The metadata-only approach described in section 4 is designed to comply with these restrictions, but review the current terms before distribution.

---

_Last updated: 2026-03-29_
_See also: `docs/architecture.md`, `docs/data-schema.md`_
_This document must be reviewed and re-signed off by the project owner after any change to the integration layer, model layer, or encryption implementation._
