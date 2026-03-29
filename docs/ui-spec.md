# UI Spec — Personal Reality Engine

> This document defines the design language, component patterns, screen layouts,
> and interaction model for all PRE surfaces.
>
> For Claude Code: when building React Native screens or the macOS web panel,
> every layout and component decision should be checkable against this document.
> Do not invent UI patterns that aren't described here — ask first.

---

## Design language

### Core principles

**1. Calm technology.**
PRE holds the most personal data in a person's life. The UI must feel like a trusted advisor, not a productivity app. No urgent colors for routine information. No gamification. No streaks or badges. Restraint is a feature.

**2. Show reasoning, not just results.**
Every insight, alert, and simulation result must make its reasoning visible. The user should always be able to ask "why am I seeing this?" and get a real answer within one tap.

**3. Earn attention, don't demand it.**
Interruptions are expensive. The proactive agent fires rarely. When it does, the UI must make it trivially easy to dismiss, snooze, or dig deeper. Never trap the user in an alert.

**4. Honest uncertainty.**
Confidence intervals are shown everywhere data has uncertainty. A simulation result that omits its confidence range is a design violation. Progress bars and trend lines include uncertainty bands.

---

### Visual system

**Color palette:**

The UI uses a minimal palette. Color encodes meaning, not decoration.

| Token | Value (light) | Value (dark) | Usage |
|-------|--------------|-------------|-------|
| `surface` | `#FFFFFF` | `#111111` | Primary background |
| `surface-raised` | `#F5F5F3` | `#1C1C1C` | Cards, panels |
| `surface-sunken` | `#EBEBEA` | `#0A0A0A` | Input backgrounds |
| `text-primary` | `#1A1A1A` | `#F0F0EE` | Body text, headings |
| `text-secondary` | `#6B6B68` | `#9A9A96` | Labels, metadata |
| `text-tertiary` | `#A8A8A4` | `#5A5A56` | Hints, timestamps |
| `border` | `rgba(0,0,0,0.08)` | `rgba(255,255,255,0.08)` | Card borders, dividers |
| `accent` | `#2D5BE3` | `#4F79FF` | Primary actions, links |
| `positive` | `#1A7F4B` | `#34C77B` | Improvements, upward trends |
| `negative` | `#C0392B` | `#FF5A4A` | Declines, warnings |
| `warning` | `#B07A00` | `#F0C040` | Caution states |
| `neutral-trend` | `#6B6B68` | `#9A9A96` | Flat or unclear trends |

**Domain colors** (used consistently across all surfaces for domain identification):

| Domain | Color token | Hex (light) |
|--------|------------|-------------|
| `body` | `domain-body` | `#1A7F4B` (green) |
| `money` | `domain-money` | `#B07A00` (amber) |
| `people` | `domain-people` | `#7B3FC4` (purple) |
| `time` | `domain-time` | `#2D5BE3` (blue) |
| `mind` | `domain-mind` | `#C0392B` (coral) |
| `world` | `domain-world` | `#5A5A56` (gray) |

These colors are fixed. A `body` event is always green everywhere in the app. Consistency makes domain recognition effortless.

**Typography:**

```
Font: System default (SF Pro on Apple, Roboto on Android)
Sizes:
  display:    28px / weight 500 / line-height 1.2
  title:      20px / weight 500 / line-height 1.3
  heading:    17px / weight 500 / line-height 1.4
  body:       15px / weight 400 / line-height 1.6
  label:      13px / weight 500 / line-height 1.4
  caption:    12px / weight 400 / line-height 1.5
  micro:      11px / weight 400 / line-height 1.4
```

**Spacing scale (8px base):**
`4 · 8 · 12 · 16 · 24 · 32 · 48 · 64`

**Border radius:**
`4px` (subtle), `8px` (default), `12px` (cards), `24px` (pills/tags), `9999px` (fully rounded)

---

## Component library

### DomainTag

A small pill label identifying a life domain. Used on event cards, insight cards, alerts.

```
Props:
  domain: LifeDomain
  size: 'sm' | 'md'

Appearance:
  Background: domain color at 12% opacity
  Text: domain color at 100% opacity
  Border-radius: 9999px (fully rounded)
  Padding: 2px 8px (sm) / 4px 10px (md)
  Font: caption / label
  Content: domain name, sentence case ('Body', 'Money', etc.)
```

### ConfidenceBar

A horizontal bar showing a confidence level. Never show a number above 90% confidence.

```
Props:
  value: number   // 0–1
  label?: string  // optional override e.g. "Low — based on 12 days of data"

Appearance:
  Track: surface-sunken, height 4px, border-radius 2px
  Fill: 
    value >= 0.7 → accent color
    value >= 0.4 → warning color
    value < 0.4  → text-tertiary
  Label below track:
    value >= 0.7 → "Good confidence"
    value >= 0.4 → "Moderate confidence"
    value < 0.4  → "Low confidence — [reason if available]"
```

### DistributionRange

The core component for showing simulation and forecast results. Never use a single value display where a distribution exists.

```
Props:
  p10: number
  p50: number
  p90: number
  unit: string
  baseline?: { p10, p50, p90 }   // If provided, shows before/after comparison
  label?: string

Appearance (single):
  [p10 ——[  p50  ]—— p90]
   dimmed    bold    dimmed
  
  Under the bar: "p10  unit · likely  p50  unit · p90  unit"
  
Appearance (with baseline, before/after):
  Before: [p10 ——[ p50 ]—— p90]
  After:  [p10 ——[   p50   ]—— p90]  ← wider bar if improvement
  
  Delta label:
    If projected p50 > baseline p50: "↑ +Δ unit (likely)" in positive color
    If projected p50 < baseline p50: "↓ −Δ unit (likely)" in negative color
    If within 1 std dev: "→ Similar to current" in neutral color
```

### InsightCard

Used in the insight browser and the today summary.

```
Props:
  insight: LifeInsight
  expanded?: boolean

Collapsed:
  ┌─────────────────────────────────────┐
  │ [DomainTag] [DomainTag]   2h ago   │
  │ One-line summary of the insight     │
  └─────────────────────────────────────┘

Expanded (tap to expand):
  ┌─────────────────────────────────────┐
  │ [DomainTag] [DomainTag]   2h ago   │
  │ Full insight description            │
  │                                     │
  │ [ConfidenceBar]                     │
  │                                     │
  │ Based on: 47 events over 14 days    │
  │ [Dismiss]              [Learn more] │
  └─────────────────────────────────────┘
```

### AlertCard

Used for proactive agent alerts. The dismiss action must be the most prominent tap target.

```
Props:
  alert: Alert

Appearance:
  Left border: 4px solid in severity color
    info → accent
    warning → warning
    intervention → negative
  
  ┌────────────────────────────────────────┐
  │ ▌ [severity badge]        [DomainTag] │
  │ ▌                                     │
  │ ▌ Alert headline (heading size)        │
  │ ▌ Brief explanation (body size)        │
  │ ▌                                     │
  │ ▌ Why am I seeing this? (caption,     │
  │ ▌ links to insight detail)            │
  │ ▌                                     │
  │ ▌ [Dismiss]  [Snooze 1d]  [Act on it] │
  └────────────────────────────────────────┘

Interaction:
  Tap anywhere except buttons → expand to full explanation
  Tap Dismiss → mark dismissed, remove from list immediately (optimistic)
  Tap Snooze → hide for 24h, re-surface same alert tomorrow
  Tap Act on it → navigate to relevant surface (simulation, event log, goal)
```

### GoalCard

```
Props:
  goal: Goal
  recentProgress?: LifeEvent[]

┌─────────────────────────────────────────┐
│ [domain-color dot]  Goal title          │
│ Target: [date]             [DomainTag]  │
│                                         │
│ Progress ──────────────────── 64%       │
│                                         │
│ Last activity: 3 days ago               │
│ [View history]              [Log event] │
└─────────────────────────────────────────┘
```

---

## Screen specs: macOS menu bar

The menu bar app is the primary surface. It should feel like a lightweight, always-available companion — not a dashboard.

### Menu bar icon states

```
●  Solid dot   → Running normally, no new alerts
◉  Ring dot    → New insight or alert (unread)
○  Empty dot   → One or more adapters need attention
—  Dash        → Gateway not running
```

### Popover (main menu, appears on click)

Width: 320px. Max height: 480px (scrollable).

```
┌────────────────────────────────────────┐
│ Today                       [Settings] │
├────────────────────────────────────────┤
│ [Daily summary — 2–3 lines, refreshes  │
│  at 7am. Font: body. Muted tone.]      │
├────────────────────────────────────────┤
│ ALERTS (if any)                        │
│ [AlertCard, collapsed]                 │
│ [AlertCard, collapsed]                 │
├────────────────────────────────────────┤
│ [Run simulation…]                      │
│ [View all insights]                    │
│ [Event timeline]                       │
├────────────────────────────────────────┤
│ ADAPTERS                               │
│ ● Plaid          Synced 2h ago         │
│ ● HealthKit      Synced 8m ago         │
│ ⚠ Google Cal     Needs reauth          │
├────────────────────────────────────────┤
│ [Sync now]                  [Quit PRE] │
└────────────────────────────────────────┘

Color coding for adapter rows:
  ● green  → syncing normally
  ● amber  → sync delayed (> 2× expected interval)
  ⚠ red    → needs attention (auth error, disabled)
```

### Settings panel (opens as separate window, 480px wide)

Sections:
1. **Integrations** — enable/disable adapters, re-auth, view collection manifest, delete data per source
2. **Model preferences** — local model selection, cloud enable/disable, monthly budget
3. **Proactive agent** — enable/disable, quiet hours, per-rule toggles
4. **Privacy** — view encryption status, export data, delete all data
5. **About** — version, data stats (total events, storage used, days tracked)

---

## Screen specs: mobile (React Native)

The mobile app is a companion, not a replacement for the desktop. It is optimized for reading alerts and quick logging. Heavy analysis happens on desktop.

### Tab structure

```
[Alerts]  [Insights]  [Goals]  [Log]  [Settings]
```

### Alerts tab

Default view. Shows unread alerts sorted by severity then time.

```
Header: "Alerts" + unread count badge

List of AlertCards (full width, 16px horizontal padding)

Empty state:
  ┌──────────────────────────────────┐
  │                                  │
  │   No alerts right now.           │
  │   PRE is watching.               │
  │                                  │
  └──────────────────────────────────┘
  (no illustration — keep it calm)
```

### Insights tab

Scrollable list of InsightCards, grouped by domain.

Domain filter row at top (scrollable pills):
`All · Body · Money · People · Time · Mind`

### Goals tab

List of GoalCards. FAB (floating action button) to add a new goal.

New goal sheet (bottom sheet, 3 fields):
- What's the goal? (text input)
- Which domain? (domain selector)
- Target date? (optional date picker)

### Log tab

Quick event entry — for manual logging (mood, symptom, reflection).

```
Large text input: "What's happening?"
[DomainTag selector row — pick which domain]
[Log it →] button
```

This is intentionally minimal. It writes a `LifeEvent` with `source='manual'` and the selected domain.

### Settings tab

Simplified version of the macOS settings panel:
- Adapter status (read-only on mobile)
- Notification preferences (which alert severities push to mobile)
- Export data
- Disconnect mobile (removes this device from the gateway's client list)

---

## Screen specs: web panel

The web panel is the power-user surface. It runs in a browser, connecting to the local gateway on `ws://localhost:18789`.

### Navigation (left sidebar, 240px)

```
PRE
─────────────
Dashboard
Timeline
Insights
Simulation
Goals
─────────────
Adapters
Settings
```

### Dashboard

4-column metric grid at top (one per key domain metric):
- Sleep (last 7 nights average, trend arrow)
- Net cash flow (current month, vs last month)
- Weekly committed hours (vs personal average)
- Active goal count / goals on track

Below: 2-column layout
- Left: Last 5 alerts (AlertCards)
- Right: Adapter health dashboard

### Timeline

The raw event browser. This is for power users who want to see everything.

```
Date range picker + domain filter + search

For each day:
  [Date header]
  [EventRow] [EventRow] [EventRow] ...

EventRow:
  [Domain color dot] [time] [event type] [brief payload summary]
  Tap to expand: full payload detail
```

Events with `privacyLevel='private'` show payload details by default. This is the local app — the user is always authenticated. There is no read-restriction on your own local data.

### Simulation screen

```
┌─────────────────────────────────────────────────────┐
│ What decision are you thinking about?               │
│ [Large text input, placeholder: "I'm considering    │
│  taking a new job with more responsibility..."]     │
│                                                     │
│ Time horizon:  [30 days]  [90 days]  [180 days]    │
│                                                     │
│ Domains to model:                                   │
│ [✓ Body] [✓ Money] [✓ Time] [✓ People] [Mind] [World] │
│                                                     │
│                          [Run simulation →]         │
└─────────────────────────────────────────────────────┘
```

**Results layout:**

```
[Narrative text — 3–4 sentences, full width]

[Generic priors warning if applicable]

[Data basis summary: "Based on 847 events over 94 days"]

For each domain outcome:
┌──────────────────────────────────────────────────┐
│ [DomainTag] Sleep duration              · 78%    │
│                                    confidence    │
│ Without this decision:                           │
│ [DistributionRange baseline]                     │
│                                                  │
│ With this decision:                              │
│ [DistributionRange projected]      ↑ +0.4h/night │
│                                    (likely)      │
│                                                  │
│ Based on 3 personal analogs · [What does this   │
│ mean?] (collapsible explanation)                 │
└──────────────────────────────────────────────────┘
```

---

## Interaction patterns

### Loading states

Never show a spinner alone. Always show a status message with it.

| Operation | Loading message |
|-----------|----------------|
| Adapter sync | "Syncing Plaid data…" |
| Inference engine run | "Looking for patterns across your data…" |
| Simulation (step 1) | "Understanding your decision…" |
| Simulation (step 2) | "Modeling current trajectories…" |
| Simulation (step 3) | "Running 1,000 simulations…" |
| Simulation (step 4) | "Writing your summary…" |
| Embedding generation | "Indexing [N] new events…" |

For simulation specifically, use a multi-step progress indicator that advances through the 4 steps above.

### Empty states

Every list view needs an empty state. Empty states must be calm and explanatory, not playful.

| Screen | Empty state text |
|--------|-----------------|
| Alerts | "No alerts right now. PRE is watching." |
| Insights | "No insights yet. Keep collecting data for a few more days." |
| Timeline | "No events in this time range." |
| Goals | "No active goals. Tap + to add one." |
| Simulation (no data) | "You need at least 14 days of tracking to run a simulation. [N] days to go." |

### Error states

Errors must explain what happened and what to do. Never show a raw error code.

| Error | User message |
|-------|-------------|
| Gateway not running | "PRE isn't running. Open the menu bar app to start it." |
| Adapter auth expired | "Your [source] connection needs to be refreshed. Tap to reconnect." |
| Simulation failed | "Something went wrong with the simulation. Try again, or simplify your decision." |
| No internet (cloud model) | "Cloud reasoning is unavailable offline. Using local model instead." |

---

## Accessibility

- All interactive elements have accessible labels
- Color is never the only signal — always pair with text or icon
- Minimum tap target: 44×44pt on iOS, 48×48dp on Android
- Support Dynamic Type on iOS (all text scales with system font size setting)
- VoiceOver / TalkBack: domain tags read as "Body domain", "Money domain" etc.
- Confidence bars have accessible value: "78% confidence" or "Low confidence"
- Distribution ranges read as: "Projected sleep: between 6.1 and 7.8 hours, likely 6.9 hours"

---

## What the UI must never do

1. **Never show a countdown, streak counter, or gamification element.** PRE is not a habit app.
2. **Never use red for routine negative trends.** Red is reserved for alerts requiring attention. A declining sleep metric in a chart is `negative` color, not an alert.
3. **Never auto-navigate away from a screen the user is reading.** Alerts arriving while the user is on the simulation screen go to the alert badge, not a forced navigation.
4. **Never truncate confidence intervals.** If the range is too wide to fit, reduce the font size or the number of decimal places — do not omit p10 or p90.
5. **Never show the word "AI" in the UI.** PRE is the system. The word AI is not used anywhere in the interface. It either works or it doesn't.

---

*Last updated: 2026-03-29*
*See also: `docs/architecture.md` (section 3.6), `docs/simulation-spec.md`*
