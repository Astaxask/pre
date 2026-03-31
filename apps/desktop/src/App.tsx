import { useCallback, useEffect, useRef, useState } from 'react';
import { useGateway } from '@repo/ui';

// ---------------------------------------------------------------------------
// Tauri interop
// ---------------------------------------------------------------------------

let invokeImpl: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

async function getInvoke() {
  if (invokeImpl !== null) return invokeImpl;
  try {
    const mod = await import('@tauri-apps/api/core');
    invokeImpl = mod.invoke;
    return invokeImpl;
  } catch {
    invokeImpl = async () => [];
    return invokeImpl;
  }
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    const invoke = await getInvoke();
    return (await invoke(cmd, args)) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ThinkingEntry = {
  text: string;
  domain: string;
  event_type: string;
  timestamp: number;
  source: string;
};

type ObserverInfo = {
  name: string;
  enabled: boolean;
  available: boolean;
  last_collection: number | null;
  events_collected: number;
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
  };
  generatedAt: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOMAIN_COLORS: Record<string, string> = {
  body: '#34C77B', money: '#F0C040', people: '#A855F7',
  time: '#4F79FF', mind: '#FF5A4A', world: '#9A9A96',
};

const DOMAIN_EMOJI: Record<string, string> = {
  body: '💪', money: '💰', people: '👥',
  time: '⏱', mind: '🧠', world: '🌍',
};

const INSIGHT_EMOJI: Record<string, string> = {
  'money-hack': '💰', 'time-hack': '⚡', 'health-correlation': '🔗',
  'relationship-nudge': '💬', 'idea-synthesis': '💡', 'self-knowledge': '🪞',
  'prediction': '🔮', 'behavior-loop': '🔄', 'energy-map': '⚡',
  'burnout-signal': '🚨', 'opportunity': '🎯', 'conflict-detected': '⚠️',
  'decision-support': '📊', 'goal-drift': '📉',
  'pattern-detected': '📈', 'trend-change': '📊', 'anomaly': '🔍', 'correlation': '🔗',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return 'now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const { connected, insights, lastMessage, sendMessage } = useGateway();
  const [stream, setStream] = useState<ThinkingEntry[]>([]);
  const [observers, setObservers] = useState<ObserverInfo[]>([]);
  const [importantInsights, setImportantInsights] = useState<InsightData[]>([]);
  const [showObservers, setShowObservers] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);

  // ── Load thinking stream from local buffer (works without gateway) ──
  const refreshStream = useCallback(async () => {
    const thoughts = await tauriInvoke<ThinkingEntry[]>('get_thinking_stream', { limit: 200 });
    if (thoughts && thoughts.length > 0) {
      setStream(thoughts);
    }
  }, []);

  const refreshObservers = useCallback(async () => {
    const obs = await tauriInvoke<ObserverInfo[]>('get_observer_status');
    if (obs) setObservers(obs);
  }, []);

  // Initial load + periodic refresh
  useEffect(() => {
    refreshStream();
    refreshObservers();
    const interval = setInterval(() => {
      refreshStream();
      refreshObservers();
    }, 5_000); // Refresh every 5 seconds
    return () => clearInterval(interval);
  }, [refreshStream, refreshObservers]);

  // ── Process gateway insights when connected ─────────────────────
  useEffect(() => {
    if (lastMessage?.type === 'insights-updated' || lastMessage?.type === 'insight-update') {
      const payload = lastMessage.payload as InsightData[] | { insights?: InsightData[] };
      const list = Array.isArray(payload) ? payload : (payload?.insights ?? []);
      setImportantInsights(
        list
          .filter((i) => i.urgency === 'interrupt' || i.urgency === 'ambient')
          .sort((a, b) => b.generatedAt - a.generatedAt)
          .slice(0, 5)
      );
    }
  }, [lastMessage]);

  // Use gateway insights too
  useEffect(() => {
    if (insights && insights.length > 0) {
      const mapped = (insights as unknown as InsightData[])
        .filter((i) => i.urgency === 'interrupt' || i.urgency === 'ambient')
        .sort((a, b) => b.generatedAt - a.generatedAt)
        .slice(0, 5);
      if (mapped.length > 0) setImportantInsights(mapped);
    }
  }, [insights]);

  // ── Derived ─────────────────────────────────────────────────────
  const activeObs = observers.filter((o) => o.enabled);
  const totalEvents = observers.reduce((s, o) => s + o.events_collected, 0);

  return (
    <div className="flex h-screen w-full flex-col bg-surface">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${
            stream.length > 0 ? 'bg-positive animate-pulse' : 'bg-text-tertiary'
          }`} />
          <span className="text-label text-text-primary font-medium">PRE</span>
          <span className="text-micro text-text-tertiary">
            {totalEvents > 0 ? `${totalEvents} observations` : 'starting up...'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {connected && (
            <span className="text-micro text-positive">● gateway</span>
          )}
          <button
            type="button"
            onClick={() => setShowObservers(!showObservers)}
            className="text-micro text-text-tertiary hover:text-text-secondary transition-colors"
          >
            {activeObs.length} observers
          </button>
        </div>
      </div>

      {/* ── Observer panel (collapsible) ───────────────────────── */}
      {showObservers && (
        <div className="border-b border-border bg-surface-raised px-4 py-2">
          <div className="flex flex-col gap-1">
            {observers.map((obs) => (
              <div key={obs.name} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`h-1.5 w-1.5 rounded-full ${
                    obs.enabled ? 'bg-positive' : 'bg-text-tertiary'
                  }`} />
                  <span className="text-micro text-text-primary">{obs.name}</span>
                </div>
                <span className="text-micro text-text-tertiary">
                  {obs.events_collected > 0 ? `${obs.events_collected}` : obs.enabled ? '...' : 'off'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Important insights (pinned at top) ─────────────────── */}
      {importantInsights.length > 0 && (
        <div className="border-b border-border">
          {importantInsights.map((insight) => (
            <InsightBanner key={insight.id} insight={insight} />
          ))}
        </div>
      )}

      {/* ── Thinking stream (the main content) ─────────────────── */}
      <div ref={streamRef} className="flex-1 overflow-y-auto">
        {stream.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-6 text-center">
            <div className="text-display mb-3 animate-pulse">🧠</div>
            <p className="text-body text-text-secondary">
              Starting to observe...
            </p>
            <p className="text-caption text-text-tertiary mt-1">
              PRE is watching your apps, browser, and screen activity.
              Observations will appear here as a continuous stream.
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {stream.map((entry, i) => (
              <ThinkingRow key={`${entry.timestamp}-${i}`} entry={entry} />
            ))}
          </div>
        )}
      </div>

      {/* ── Footer status ──────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-1.5 border-t border-border text-micro text-text-tertiary">
        <span>
          {stream.length > 0
            ? `${stream.length} thoughts · updated ${timeAgo(stream[0]?.timestamp ?? 0)}`
            : 'Waiting for observations...'}
        </span>
        {!connected && (
          <span className="text-warning">gateway offline — running locally</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ThinkingRow — a single observation in the stream
// ---------------------------------------------------------------------------

function ThinkingRow({ entry }: { entry: ThinkingEntry }) {
  const color = DOMAIN_COLORS[entry.domain] ?? '#666';
  const emoji = DOMAIN_EMOJI[entry.domain] ?? '•';

  return (
    <div className="flex items-start gap-3 px-4 py-2 border-b border-border/50 hover:bg-surface-raised/30 transition-colors">
      {/* Time column */}
      <span className="text-micro text-text-tertiary w-10 shrink-0 pt-0.5 text-right tabular-nums">
        {formatTime(entry.timestamp)}
      </span>

      {/* Domain indicator */}
      <span className="text-caption shrink-0 pt-0.5" style={{ color }}>
        {emoji}
      </span>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-caption text-text-primary leading-relaxed">
          {entry.text}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InsightBanner — important insight pinned at top
// ---------------------------------------------------------------------------

function InsightBanner({ insight }: { insight: InsightData }) {
  const [expanded, setExpanded] = useState(false);
  const emoji = INSIGHT_EMOJI[insight.insightType] ?? '💡';
  const isUrgent = insight.urgency === 'interrupt';

  return (
    <button
      type="button"
      onClick={() => setExpanded(!expanded)}
      className={`w-full text-left px-4 py-2.5 border-b border-border/50 transition-colors ${
        isUrgent ? 'bg-negative/5' : 'bg-accent/5'
      } hover:bg-surface-raised/50`}
    >
      <div className="flex items-start gap-2">
        <span className="text-body shrink-0">{emoji}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            {isUrgent && (
              <span className="rounded-pill px-1.5 py-0.5 text-micro font-medium bg-negative text-surface">
                IMPORTANT
              </span>
            )}
            {insight.estimatedImpact && (
              <span className="text-micro text-positive font-medium">
                {insight.estimatedImpact}
              </span>
            )}
            <div className="flex gap-1">
              {insight.domains.map((d) => (
                <span key={d} className="text-micro" style={{ color: DOMAIN_COLORS[d] ?? '#666' }}>
                  {d}
                </span>
              ))}
            </div>
          </div>
          <p className="text-caption text-text-primary leading-snug">
            {insight.payload.description}
          </p>

          {expanded && (
            <div className="mt-2 flex flex-col gap-1.5">
              <p className="text-micro text-text-secondary">
                {insight.payload.whyItMatters}
              </p>
              {insight.payload.suggestedAction && (
                <p className="text-micro text-accent font-medium">
                  → {insight.payload.suggestedAction}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}
