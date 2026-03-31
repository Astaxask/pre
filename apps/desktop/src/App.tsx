import { useCallback, useEffect, useRef, useState } from 'react';
import { useGateway, AlertCard } from '@repo/ui';
import type { Alert } from '@repo/ui';
import type { LifeDomain } from '@pre/shared';

// ---------------------------------------------------------------------------
// Tauri interop — wrapped so the app also runs in a plain browser
// ---------------------------------------------------------------------------

type TrayState = 'Idle' | 'Alert' | 'NeedsAttention' | 'Offline';

let invokeImpl: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

async function getInvoke() {
  if (invokeImpl !== null) return invokeImpl;
  try {
    const mod = await import('@tauri-apps/api/core');
    invokeImpl = mod.invoke;
    return invokeImpl;
  } catch {
    invokeImpl = async () => {};
    return invokeImpl;
  }
}

async function setTrayState(state: TrayState): Promise<void> {
  try {
    const invoke = await getInvoke();
    await invoke('set_tray_state', { state });
  } catch {}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ObserverInfo = {
  name: string;
  enabled: boolean;
  available: boolean;
  last_collection: number | null;
  events_collected: number;
};

type ActivityEvent = {
  id: string;
  source: string;
  domain: string;
  event_type: string;
  timestamp: number;
  payload: Record<string, unknown>;
};

type InsightData = {
  id: string;
  insightType: string;
  category: string;
  urgency: string;
  confidence: number;
  domains: string[];
  estimatedImpact?: string;
  payload: {
    description: string;
    whyItMatters: string;
    suggestedAction?: string;
    evidence: Array<{ domain: string; summary: string; timeframe: string }>;
  };
  generatedAt: number;
  seen: boolean;
  dismissed: boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABS = ['brain', 'activity', 'insights'] as const;
type Tab = (typeof TABS)[number];

const DOMAIN_COLORS: Record<string, string> = {
  body: '#34C77B',
  money: '#F0C040',
  people: '#A855F7',
  time: '#4F79FF',
  mind: '#FF5A4A',
  world: '#9A9A96',
};

const DOMAIN_EMOJI: Record<string, string> = {
  body: '💪',
  money: '💰',
  people: '👥',
  time: '⏱',
  mind: '🧠',
  world: '🌍',
};

const INSIGHT_EMOJI: Record<string, string> = {
  'money-hack': '💰',
  'time-hack': '⚡',
  'health-correlation': '🔗',
  'relationship-nudge': '💬',
  'idea-synthesis': '💡',
  'self-knowledge': '🪞',
  prediction: '🔮',
  'behavior-loop': '🔄',
  'energy-map': '⚡',
  'burnout-signal': '🚨',
  opportunity: '🎯',
  'conflict-detected': '⚠️',
  'decision-support': '📊',
  'goal-drift': '📉',
  'pattern-detected': '📈',
  'trend-change': '📊',
  anomaly: '🔍',
  correlation: '🔗',
};

const URGENCY_LABELS: Record<string, { label: string; class: string }> = {
  interrupt: { label: 'NOW', class: 'bg-negative text-surface' },
  ambient: { label: 'NEW', class: 'bg-accent text-surface' },
  digest: { label: 'DIGEST', class: 'bg-surface-sunken text-text-secondary' },
  silent: { label: '', class: '' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function eventLabel(event: ActivityEvent): string {
  const p = event.payload;
  switch (event.event_type) {
    case 'app-session':
      return `${p.appName ?? 'Unknown app'} — ${formatDuration(Number(p.sessionDurationSeconds ?? 0))}`;
    case 'screen-session':
      return p.screenState === 'idle'
        ? `Idle for ${formatDuration(Number(p.idleDurationSeconds ?? 0))}`
        : `Screen ${p.screenState}`;
    case 'browsing-session':
      return `${p.domainVisited ?? 'site'} (${p.visitCount ?? 0} visits)`;
    case 'now-playing':
      return `♪ ${p.trackTitle ?? 'Unknown'} — ${p.artistName ?? ''}`;
    case 'communication':
      return `${p.direction === 'sent' ? '→' : '←'} ${p.messageCount ?? 1} messages (${p.channel ?? 'chat'})`;
    case 'calendar-event':
      return `${p.title ?? 'Event'} (${p.durationMinutes ?? 0}min)`;
    default:
      return event.event_type;
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  return rem > 0 ? `${hr}h ${rem}m` : `${hr}h`;
}

function computeTrayState(
  connected: boolean,
  hasInterruptInsights: boolean,
  hasAlerts: boolean,
): TrayState {
  if (!connected) return 'Offline';
  if (hasInterruptInsights) return 'Alert';
  if (hasAlerts) return 'NeedsAttention';
  return 'Idle';
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const { connected, alerts, sendMessage, lastMessage, insights } = useGateway();
  const [tab, setTab] = useState<Tab>('brain');
  const [observers, setObservers] = useState<ObserverInfo[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [insightList, setInsightList] = useState<InsightData[]>([]);
  const [dailySummary, setDailySummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);

  const lastTrayRef = useRef<TrayState | null>(null);

  // ── Process messages ────────────────────────────────────────────
  useEffect(() => {
    if (!lastMessage) return;

    if (lastMessage.type === 'daily-summary' && lastMessage.payload) {
      setDailySummary((lastMessage.payload as { text: string }).text);
      setSummaryLoading(false);
    }

    if (lastMessage.type === 'observer-status' && lastMessage.payload) {
      setObservers(lastMessage.payload as ObserverInfo[]);
    }

    if (lastMessage.type === 'ingest-result' && lastMessage.payload) {
      // Observer data was ingested — request updated activity
      sendMessage({ type: 'query', payload: { kind: 'recent-activity' } });
    }

    if (lastMessage.type === 'query-result' && lastMessage.payload) {
      const p = lastMessage.payload as Record<string, unknown>;
      if (Array.isArray(p.events)) {
        setActivity(p.events as ActivityEvent[]);
      }
    }

    if (lastMessage.type === 'insights-updated' || lastMessage.type === 'insight-update') {
      if (lastMessage.payload) {
        const payload = lastMessage.payload as { insights?: InsightData[] } | InsightData[];
        const list = Array.isArray(payload) ? payload : payload.insights ?? [];
        setInsightList(list);
      }
    }
  }, [lastMessage, sendMessage]);

  // ── Request data on connect ─────────────────────────────────────
  useEffect(() => {
    if (!connected) return;
    sendMessage({ type: 'query', payload: { kind: 'daily-summary' } });
    sendMessage({ type: 'query', payload: { kind: 'recent-activity' } });
    // Request observer status from Tauri
    getInvoke().then((invoke) => {
      invoke('get_observer_status')
        .then((status) => {
          if (Array.isArray(status)) setObservers(status as ObserverInfo[]);
        })
        .catch(() => {});
    });
  }, [connected, sendMessage]);

  useEffect(() => {
    const timer = setTimeout(() => setSummaryLoading(false), 8000);
    return () => clearTimeout(timer);
  }, []);

  // ── Refresh observer status periodically ────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      getInvoke().then((invoke) => {
        invoke('get_observer_status')
          .then((status) => {
            if (Array.isArray(status)) setObservers(status as ObserverInfo[]);
          })
          .catch(() => {});
      });
    }, 10_000);
    return () => clearInterval(interval);
  }, []);

  // ── Tray state ──────────────────────────────────────────────────
  const hasInterrupts = insightList.some((i) => i.urgency === 'interrupt' && !i.seen);
  useEffect(() => {
    const desired = computeTrayState(connected, hasInterrupts, alerts.length > 0);
    if (desired !== lastTrayRef.current) {
      lastTrayRef.current = desired;
      void setTrayState(desired);
    }
  }, [connected, hasInterrupts, alerts.length]);

  // ── Derived data ────────────────────────────────────────────────
  const activeObservers = observers.filter((o) => o.enabled);
  const totalEvents = observers.reduce((s, o) => s + o.events_collected, 0);
  const domainsActive = new Set(activity.map((a) => a.domain)).size;

  const sortedInsights = [...insightList]
    .filter((i) => !i.dismissed)
    .sort((a, b) => {
      const urgencyOrder: Record<string, number> = { interrupt: 0, ambient: 1, digest: 2, silent: 3 };
      const ua = urgencyOrder[a.urgency] ?? 3;
      const ub = urgencyOrder[b.urgency] ?? 3;
      if (ua !== ub) return ua - ub;
      return b.generatedAt - a.generatedAt;
    });

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-surface">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <div
            className={`h-2 w-2 rounded-full ${connected ? 'bg-positive' : 'bg-negative'}`}
            title={connected ? 'Connected' : 'Offline'}
          />
          <h1 className="text-heading text-text-primary font-medium">PRE</h1>
        </div>
        <div className="flex items-center gap-1">
          {activeObservers.length > 0 && (
            <span className="text-micro text-text-tertiary">
              {activeObservers.length} observers · {totalEvents} events
            </span>
          )}
        </div>
      </div>

      {/* ── Tab bar ────────────────────────────────────────────── */}
      <div className="flex border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`flex-1 py-2 text-center text-label transition-colors ${
              tab === t
                ? 'border-b-2 border-accent text-accent'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            {t === 'brain' ? '🧠 Brain' : t === 'activity' ? '📡 Live' : `✨ Insights${sortedInsights.length > 0 ? ` (${sortedInsights.length})` : ''}`}
          </button>
        ))}
      </div>

      {/* ── Tab content ────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {tab === 'brain' && (
          <BrainTab
            connected={connected}
            summary={dailySummary}
            summaryLoading={summaryLoading}
            alerts={alerts}
            observers={observers}
            domainsActive={domainsActive}
            topInsights={sortedInsights.slice(0, 3)}
            sendMessage={sendMessage}
          />
        )}
        {tab === 'activity' && (
          <ActivityTab activity={activity} />
        )}
        {tab === 'insights' && (
          <InsightsTab insights={sortedInsights} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brain Tab — the main "second brain" dashboard
// ---------------------------------------------------------------------------

function BrainTab({
  connected,
  summary,
  summaryLoading,
  alerts,
  observers,
  domainsActive,
  topInsights,
  sendMessage,
}: {
  connected: boolean;
  summary: string | null;
  summaryLoading: boolean;
  alerts: Alert[];
  observers: ObserverInfo[];
  domainsActive: number;
  topInsights: InsightData[];
  sendMessage: (msg: { type: string; payload: unknown }) => void;
}) {
  const activeObs = observers.filter((o) => o.enabled);
  const totalEvents = observers.reduce((s, o) => s + o.events_collected, 0);

  return (
    <div className="flex flex-col">
      {/* Connection warning */}
      {!connected && (
        <div className="bg-warning/10 px-4 py-2 text-center text-caption text-warning">
          ⚡ Connecting to gateway...
        </div>
      )}

      {/* Daily Summary */}
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-micro uppercase text-text-tertiary mb-1.5 tracking-wider">Today</h2>
        {summaryLoading ? (
          <div className="flex flex-col gap-2">
            <div className="h-3 w-full animate-pulse rounded bg-surface-sunken" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-surface-sunken" />
          </div>
        ) : summary ? (
          <p className="text-body text-text-secondary leading-relaxed">{summary}</p>
        ) : totalEvents > 0 ? (
          <p className="text-body text-text-secondary leading-relaxed">
            Collecting data... {totalEvents} observations across {domainsActive} domains so far.
            {totalEvents < 20 && ' Need ~20 events before insights can fire.'}
          </p>
        ) : (
          <p className="text-body text-text-tertiary">
            Waiting for first observations. Observers will start collecting data from your apps, browser, and screen activity.
          </p>
        )}
      </div>

      {/* Top Insights (if any) */}
      {topInsights.length > 0 && (
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-micro uppercase text-text-tertiary mb-2 tracking-wider">Latest Insights</h2>
          <div className="flex flex-col gap-2">
            {topInsights.map((insight) => (
              <InsightCard key={insight.id} insight={insight} compact />
            ))}
          </div>
        </div>
      )}

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-micro uppercase text-text-tertiary mb-2 tracking-wider">
            Alerts ({alerts.length})
          </h2>
          <div className="flex flex-col gap-2">
            {alerts.slice(0, 3).map((alert) => (
              <AlertCard key={alert.id} alert={alert} />
            ))}
          </div>
        </div>
      )}

      {/* Observers */}
      <div className="px-4 py-3">
        <h2 className="text-micro uppercase text-text-tertiary mb-2 tracking-wider">
          Observers {activeObs.length > 0 ? `(${activeObs.length} active)` : ''}
        </h2>
        {observers.length === 0 ? (
          <p className="text-caption text-text-tertiary">
            No observers detected. Launch the desktop app to start collecting data.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {observers.map((obs) => (
              <div
                key={obs.name}
                className="flex items-center justify-between py-0.5"
              >
                <div className="flex items-center gap-2">
                  <div className={`h-1.5 w-1.5 rounded-full ${
                    obs.enabled ? 'bg-positive animate-pulse' : 'bg-text-tertiary'
                  }`} />
                  <span className={`text-caption ${obs.enabled ? 'text-text-primary' : 'text-text-tertiary'}`}>
                    {obs.name}
                  </span>
                </div>
                <span className="text-micro text-text-tertiary">
                  {obs.events_collected > 0
                    ? `${obs.events_collected} events${obs.last_collection ? ` · ${timeAgo(obs.last_collection)}` : ''}`
                    : obs.enabled ? 'waiting...' : 'disabled'}
                </span>
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => sendMessage({ type: 'trigger-sync', source: 'all' })}
          className="mt-3 w-full rounded bg-surface-sunken py-1.5 text-caption text-text-secondary hover:bg-border transition-colors"
        >
          Sync all sources
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity Tab — live feed of what PRE is observing
// ---------------------------------------------------------------------------

function ActivityTab({ activity }: { activity: ActivityEvent[] }) {
  if (activity.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
        <span className="text-display mb-2">📡</span>
        <p className="text-body text-text-secondary">
          No activity yet. PRE is watching...
        </p>
        <p className="text-caption text-text-tertiary mt-1">
          App usage, browser history, screen time, and music will appear here as they're collected.
        </p>
      </div>
    );
  }

  // Group by time blocks (last hour, today, yesterday)
  const now = Date.now();
  const hourAgo = now - 3600000;
  const todayStart = new Date().setHours(0, 0, 0, 0);

  const lastHour = activity.filter((e) => e.timestamp > hourAgo);
  const today = activity.filter((e) => e.timestamp > todayStart && e.timestamp <= hourAgo);
  const older = activity.filter((e) => e.timestamp <= todayStart);

  return (
    <div className="flex flex-col">
      {lastHour.length > 0 && (
        <ActivitySection label="Last hour" events={lastHour} />
      )}
      {today.length > 0 && (
        <ActivitySection label="Earlier today" events={today} />
      )}
      {older.length > 0 && (
        <ActivitySection label="Previous" events={older} />
      )}
    </div>
  );
}

function ActivitySection({ label, events }: { label: string; events: ActivityEvent[] }) {
  return (
    <div className="border-b border-border">
      <div className="px-4 pt-3 pb-1">
        <span className="text-micro uppercase text-text-tertiary tracking-wider">{label}</span>
      </div>
      <div className="flex flex-col">
        {events.map((event) => (
          <div
            key={event.id}
            className="flex items-start gap-3 px-4 py-2 hover:bg-surface-raised/50 transition-colors"
          >
            <div
              className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-micro"
              style={{ backgroundColor: `${DOMAIN_COLORS[event.domain] ?? '#666'}20` }}
            >
              {DOMAIN_EMOJI[event.domain] ?? '•'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-caption text-text-primary truncate">
                {eventLabel(event)}
              </p>
              <p className="text-micro text-text-tertiary">
                {event.source} · {timeAgo(event.timestamp)}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Insights Tab — the superpower feed
// ---------------------------------------------------------------------------

function InsightsTab({ insights }: { insights: InsightData[] }) {
  if (insights.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
        <span className="text-display mb-2">✨</span>
        <p className="text-body text-text-secondary">
          No insights yet
        </p>
        <p className="text-caption text-text-tertiary mt-1">
          PRE needs to observe your patterns for a while before it can surface insights.
          Keep using your computer normally — it's learning.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-4">
      {insights.map((insight) => (
        <InsightCard key={insight.id} insight={insight} />
      ))}
    </div>
  );
}

function InsightCard({ insight, compact }: { insight: InsightData; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const emoji = INSIGHT_EMOJI[insight.insightType] ?? '💡';
  const urgencyInfo = URGENCY_LABELS[insight.urgency];

  return (
    <button
      type="button"
      onClick={() => setExpanded(!expanded)}
      className={`w-full text-left rounded-card border border-border p-3 transition-colors hover:bg-surface-raised/50 ${
        insight.urgency === 'interrupt' ? 'border-negative/30 bg-negative/5' : ''
      }`}
    >
      {/* Header */}
      <div className="flex items-start gap-2">
        <span className="text-body shrink-0">{emoji}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            {urgencyInfo && urgencyInfo.label && (
              <span className={`rounded-pill px-1.5 py-0.5 text-micro font-medium ${urgencyInfo.class}`}>
                {urgencyInfo.label}
              </span>
            )}
            <div className="flex gap-1">
              {insight.domains.map((d) => (
                <span
                  key={d}
                  className="text-micro"
                  style={{ color: DOMAIN_COLORS[d] ?? '#666' }}
                >
                  {d}
                </span>
              ))}
            </div>
            {insight.estimatedImpact && (
              <span className="text-micro text-positive font-medium">
                {insight.estimatedImpact}
              </span>
            )}
          </div>
          <p className={`${compact ? 'text-caption' : 'text-body'} text-text-primary leading-snug`}>
            {insight.payload.description}
          </p>
        </div>
      </div>

      {/* Expanded content */}
      {expanded && !compact && (
        <div className="mt-2 ml-6 flex flex-col gap-2">
          <div className="rounded bg-surface-sunken p-2">
            <p className="text-micro text-text-tertiary uppercase tracking-wider mb-1">Why this matters</p>
            <p className="text-caption text-text-secondary">{insight.payload.whyItMatters}</p>
          </div>

          {insight.payload.suggestedAction && (
            <div className="rounded bg-accent/10 p-2">
              <p className="text-micro text-accent uppercase tracking-wider mb-1">Suggested action</p>
              <p className="text-caption text-accent">{insight.payload.suggestedAction}</p>
            </div>
          )}

          {insight.payload.evidence.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-micro text-text-tertiary uppercase tracking-wider">Evidence</p>
              {insight.payload.evidence.map((e, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <span className="text-micro" style={{ color: DOMAIN_COLORS[e.domain] ?? '#666' }}>
                    {DOMAIN_EMOJI[e.domain] ?? '•'}
                  </span>
                  <span className="text-micro text-text-secondary">{e.summary}</span>
                  <span className="text-micro text-text-tertiary">({e.timeframe})</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-3 text-micro text-text-tertiary mt-1">
            <span>{Math.round(insight.confidence * 100)}% confidence</span>
            <span>{timeAgo(insight.generatedAt)}</span>
          </div>
        </div>
      )}
    </button>
  );
}
