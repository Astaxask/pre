import { useCallback, useEffect, useRef, useState } from 'react';

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

type RawObservation = {
  id: string;
  source: string;
  domain: string;
  event_type: string;
  timestamp: number;
  payload: Record<string, unknown>;
};

type AIThought = {
  id: string;
  text: string;
  category: 'reflection' | 'insight' | 'pattern' | 'question' | 'prediction' | 'nudge';
  importance: 'ambient' | 'notable' | 'important';
  timestamp: number;
  isNew?: boolean;
  isStreaming?: boolean;
};

type ObserverInfo = {
  name: string;
  enabled: boolean;
  available: boolean;
  last_collection: number | null;
  events_collected: number;
};

// ---------------------------------------------------------------------------
// AI Engine — calls Ollama via Tauri command (bypasses CORS)
// ---------------------------------------------------------------------------

async function generateThoughts(): Promise<AIThought[]> {
  try {
    const raw = await tauriInvoke<Array<{
      id: string;
      text: string;
      category?: string;
      importance?: string;
      timestamp?: number;
    }>>('generate_ai_thoughts', { limit: 30 });

    if (!raw || raw.length === 0) return [];

    return raw.map((t) => ({
      id: t.id || crypto.randomUUID(),
      text: t.text || '',
      category: (t.category as AIThought['category']) || 'reflection',
      importance: (t.importance as AIThought['importance']) || 'ambient',
      timestamp: t.timestamp || Date.now(),
      isNew: true,
    }));
  } catch (err) {
    console.error('AI thought generation failed:', err);
    return [];
  }
}

/** Generate smart fallback thoughts from raw observations when AI is slow */
async function generateFallbackThoughts(): Promise<AIThought[]> {
  const obs = await tauriInvoke<RawObservation[]>('get_recent_observations', { limit: 20 });
  if (!obs || obs.length === 0) return [];

  const thoughts: AIThought[] = [];
  const now = Date.now();

  // Analyze app usage patterns
  const appSessions = obs.filter((o) => o.event_type === 'app-session');
  const appCounts: Record<string, { total: number; count: number }> = {};
  for (const s of appSessions) {
    const name = (s.payload.appName as string) || 'Unknown';
    const secs = (s.payload.sessionDurationSeconds as number) || 0;
    if (!appCounts[name]) appCounts[name] = { total: 0, count: 0 };
    appCounts[name].total += secs;
    appCounts[name].count += 1;
  }

  // Most used app
  const topApp = Object.entries(appCounts).sort((a, b) => b[1].total - a[1].total)[0];
  if (topApp) {
    const [name, data] = topApp;
    const mins = Math.round(data.total / 60);
    if (mins > 30) {
      thoughts.push({
        id: crypto.randomUUID(),
        text: `You've spent ${mins} minutes in ${name} across ${data.count} sessions. That's a deep focus pattern.`,
        category: 'pattern',
        importance: 'notable',
        timestamp: now,
        isNew: true,
      });
    } else if (data.count > 5) {
      thoughts.push({
        id: crypto.randomUUID(),
        text: `Switching to ${name} ${data.count} times — lots of quick checks. Are you waiting for something?`,
        category: 'question',
        importance: 'ambient',
        timestamp: now,
        isNew: true,
      });
    }
  }

  // App switching pattern
  if (appSessions.length > 8) {
    const uniqueApps = new Set(appSessions.map((s) => s.payload.appName as string)).size;
    if (uniqueApps >= 4) {
      thoughts.push({
        id: crypto.randomUUID(),
        text: `Jumping between ${uniqueApps} different apps — your attention is scattered right now. Might be worth picking one thing to focus on.`,
        category: 'nudge',
        importance: 'notable',
        timestamp: now - 5000,
        isNew: true,
      });
    }
  }

  // Browsing
  const browsing = obs.filter((o) => o.event_type === 'browsing-session');
  if (browsing.length > 0) {
    const sites = [...new Set(browsing.map((b) => b.payload.domainVisited as string))];
    if (sites.length > 3) {
      thoughts.push({
        id: crypto.randomUUID(),
        text: `You've been across ${sites.length} different sites. Research mode, or rabbit hole?`,
        category: 'reflection',
        importance: 'ambient',
        timestamp: now - 10000,
        isNew: true,
      });
    }
  }

  // Time awareness
  const hour = new Date().getHours();
  if (hour >= 23 || hour < 4) {
    thoughts.push({
      id: crypto.randomUUID(),
      text: `It's late. You're still active on your computer — is this intentional or did time slip away?`,
      category: 'nudge',
      importance: 'notable',
      timestamp: now - 15000,
      isNew: true,
    });
  }

  // Generic if no patterns found
  if (thoughts.length === 0 && obs.length > 0) {
    thoughts.push({
      id: crypto.randomUUID(),
      text: `Collecting ${obs.length} observations so far. Building a picture of your day...`,
      category: 'reflection',
      importance: 'ambient',
      timestamp: now,
      isNew: true,
    });
  }

  return thoughts;
}

async function checkAIAvailable(): Promise<boolean> {
  try {
    const result = await tauriInvoke<{ available: boolean; models: string[] }>('check_ai_status');
    return result?.available ?? false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Seed thoughts (shown while AI warms up)
// ---------------------------------------------------------------------------

function getSeedThoughts(): AIThought[] {
  return [
    {
      id: 'seed-1',
      text: 'Waking up... I can see your screen activity starting to flow in. Give me a moment to understand what you\'re working on.',
      category: 'reflection',
      importance: 'ambient',
      timestamp: Date.now() - 30000,
    },
    {
      id: 'seed-2',
      text: 'I\'m your second brain — I\'ll be thinking about your life even when you\'re not looking. Check back anytime.',
      category: 'reflection',
      importance: 'notable',
      timestamp: Date.now() - 15000,
    },
  ];
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 30) return 'just now';
  if (sec < 60) return 'moments ago';
  const min = Math.floor(sec / 60);
  if (min === 1) return 'a minute ago';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr === 1) return 'an hour ago';
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// App — The Living Second Brain
// ---------------------------------------------------------------------------

export function App() {
  const [thoughts, setThoughts] = useState<AIThought[]>([]);
  const [pinnedThoughts, setPinnedThoughts] = useState<AIThought[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [observers, setObservers] = useState<ObserverInfo[]>([]);
  const [observationCount, setObservationCount] = useState(0);
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  const [showStatus, setShowStatus] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const thoughtIdSet = useRef(new Set<string>());
  const lastGenerationRef = useRef(0);
  const initialLoadDone = useRef(false);

  // ── Check if Ollama is available ──────────────────────────────
  useEffect(() => {
    checkAIAvailable().then(setAiAvailable);
  }, []);

  // ── Load observers status ─────────────────────────────────────
  const refreshObservers = useCallback(async () => {
    const obs = await tauriInvoke<ObserverInfo[]>('get_observer_status');
    if (obs) setObservers(obs);
  }, []);

  // ── Helper to merge new thoughts into state ───────────────────
  const addThoughts = useCallback((newThoughts: AIThought[]) => {
    if (newThoughts.length === 0) return;

    setThoughts((prev) => {
      const existing = new Set(prev.map((t) => t.text.slice(0, 50)));
      const fresh = newThoughts.filter((t) => !existing.has(t.text.slice(0, 50)));
      fresh.forEach((t) => { t.isNew = true; });

      const important = fresh.filter((t) => t.importance === 'important');
      if (important.length > 0) {
        setPinnedThoughts((pp) => [...important, ...pp].slice(0, 3));
      }

      return [...fresh, ...prev].slice(0, 50);
    });
  }, []);

  // ── Generate AI thoughts from observations ────────────────────
  const think = useCallback(async () => {
    if (isThinking) return;
    if (Date.now() - lastGenerationRef.current < 20000) return;

    setIsThinking(true);
    lastGenerationRef.current = Date.now();

    try {
      // Get observation count
      const rawObs = await tauriInvoke<RawObservation[]>('get_recent_observations', { limit: 30 });
      setObservationCount(rawObs?.length ?? 0);

      if (!rawObs || rawObs.length === 0) {
        setIsThinking(false);
        return;
      }

      // Immediately show smart fallback thoughts (instant, no AI needed)
      const fallback = await generateFallbackThoughts();
      addThoughts(fallback);

      // Then try AI thoughts (may take 10-45 seconds)
      const aiThoughts = await generateThoughts();
      if (aiThoughts.length > 0) {
        addThoughts(aiThoughts);
      }
    } catch (err) {
      console.error('Thinking failed:', err);
    } finally {
      setIsThinking(false);
    }
  }, [isThinking, addThoughts]);

  // ── Initial setup ─────────────────────────────────────────────
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;

    refreshObservers();

    // Immediately try to show smart thoughts from existing observations
    (async () => {
      const fallback = await generateFallbackThoughts();
      if (fallback.length > 0) {
        setThoughts(fallback);
      } else {
        setThoughts(getSeedThoughts());
      }

      // Then kick off AI thinking in background
      setTimeout(() => think(), 2000);
    })();
  }, [think, refreshObservers]);

  // ── Periodic thinking loop ────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      think();
      refreshObservers();
    }, 60_000); // Think every 60 seconds

    return () => clearInterval(interval);
  }, [think, refreshObservers]);

  // ── Clear "new" flag after animation ──────────────────────────
  useEffect(() => {
    const timeout = setTimeout(() => {
      setThoughts((prev) =>
        prev.map((t) => (t.isNew ? { ...t, isNew: false } : t))
      );
    }, 2000);
    return () => clearTimeout(timeout);
  }, [thoughts]);

  // ── Derived state ─────────────────────────────────────────────
  const activeObs = observers.filter((o) => o.enabled);
  const totalEvents = observers.reduce((s, o) => s + o.events_collected, 0);

  return (
    <div className="flex h-screen w-full flex-col" style={{ background: '#0a0a0a' }}>
      {/* ── Minimal header ─────────────────────────────────────── */}
      <header className="flex items-center justify-between px-5 py-3 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <div
              className={`h-2 w-2 rounded-full ${
                isThinking ? 'bg-accent glow-breathe' : thoughts.length > 2 ? 'bg-positive' : 'bg-text-tertiary'
              }`}
              style={isThinking ? { background: '#7b9aff' } : thoughts.length > 2 ? { background: '#4ade80' } : {}}
            />
            {isThinking && (
              <div
                className="absolute inset-0 h-2 w-2 rounded-full"
                style={{
                  background: '#7b9aff',
                  animation: 'pulse-subtle 1.5s ease-in-out infinite',
                }}
              />
            )}
          </div>
          <span
            className="text-xs font-medium tracking-wide"
            style={{ color: '#e8e8e4', letterSpacing: '0.1em' }}
          >
            PRE
          </span>
          {isThinking && (
            <span
              className="text-xs fade-in"
              style={{ color: '#4a4a46' }}
            >
              thinking...
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowStatus(!showStatus)}
          className="text-xs transition-colors"
          style={{ color: '#4a4a46', cursor: 'pointer', background: 'none', border: 'none' }}
        >
          {totalEvents > 0 ? `${totalEvents} signals` : 'starting'}
        </button>
      </header>

      {/* ── Status panel (collapsible) ──────────────────────────── */}
      {showStatus && (
        <div
          className="px-5 py-3 fade-in"
          style={{
            borderTop: '1px solid rgba(255,255,255,0.04)',
            borderBottom: '1px solid rgba(255,255,255,0.04)',
            background: '#0e0e0e',
          }}
        >
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs" style={{ color: '#4a4a46' }}>
                AI Engine
              </span>
              <span className="text-xs" style={{ color: aiAvailable ? '#4ade80' : '#f87171' }}>
                {aiAvailable === null ? 'checking...' : aiAvailable ? `${MODEL}` : 'offline'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs" style={{ color: '#4a4a46' }}>
                Observations
              </span>
              <span className="text-xs" style={{ color: '#8a8a86' }}>
                {observationCount} in buffer
              </span>
            </div>
            {observers.map((obs) => (
              <div key={obs.name} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div
                    className="h-1 w-1 rounded-full"
                    style={{ background: obs.enabled ? '#4ade80' : '#2a2a26' }}
                  />
                  <span className="text-xs" style={{ color: '#4a4a46' }}>
                    {obs.name}
                  </span>
                </div>
                <span className="text-xs" style={{ color: '#3a3a36' }}>
                  {obs.events_collected > 0
                    ? obs.events_collected
                    : obs.enabled
                      ? '...'
                      : 'off'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Pinned important thoughts ───────────────────────────── */}
      {pinnedThoughts.length > 0 && (
        <div
          className="px-5 py-3 shrink-0"
          style={{
            borderBottom: '1px solid rgba(255,255,255,0.04)',
            background: 'rgba(251, 191, 36, 0.02)',
          }}
        >
          {pinnedThoughts.map((thought) => (
            <PinnedThought key={thought.id} thought={thought} />
          ))}
        </div>
      )}

      {/* ── Thought stream — the consciousness ──────────────────── */}
      <div ref={streamRef} className="flex-1 overflow-y-auto px-5 pt-4 pb-6">
        {thoughts.length === 0 ? (
          <WakingUp />
        ) : (
          <div className="flex flex-col gap-0.5">
            {thoughts.map((thought) => (
              <ThoughtEntry key={thought.id} thought={thought} />
            ))}
          </div>
        )}
      </div>

      {/* ── Ambient footer ──────────────────────────────────────── */}
      <footer
        className="flex items-center justify-between px-5 py-2 shrink-0"
        style={{ borderTop: '1px solid rgba(255,255,255,0.03)' }}
      >
        <span className="text-xs" style={{ color: '#2a2a26' }}>
          {thoughts.length > 2
            ? `${thoughts.length} thoughts`
            : 'warming up'}
        </span>
        <button
          type="button"
          onClick={() => think()}
          className="text-xs transition-all"
          style={{
            color: isThinking ? '#3a3a36' : '#4a4a46',
            cursor: isThinking ? 'default' : 'pointer',
            background: 'none',
            border: 'none',
          }}
          disabled={isThinking}
        >
          {isThinking ? 'thinking...' : 'think now'}
        </button>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ThoughtEntry — a single thought in the stream
// ---------------------------------------------------------------------------

const CATEGORY_MARKERS: Record<string, { symbol: string; color: string }> = {
  reflection: { symbol: '', color: '#8a8a86' },
  insight: { symbol: '', color: '#7b9aff' },
  pattern: { symbol: '', color: '#a78bfa' },
  question: { symbol: '', color: '#fbbf24' },
  prediction: { symbol: '', color: '#34d399' },
  nudge: { symbol: '', color: '#fb923c' },
};

function ThoughtEntry({ thought }: { thought: AIThought }) {
  const marker = CATEGORY_MARKERS[thought.category] || CATEGORY_MARKERS.reflection;
  const isNotable = thought.importance === 'notable' || thought.importance === 'important';

  return (
    <div
      className={`py-3 ${thought.isNew ? 'thought-enter' : ''}`}
      style={{
        borderLeft: isNotable ? `1.5px solid ${marker.color}20` : '1.5px solid transparent',
        paddingLeft: '16px',
        marginLeft: '-16px',
      }}
    >
      <p
        className="text-sm leading-relaxed"
        style={{
          color: isNotable ? '#d4d4d0' : '#9a9a96',
          fontWeight: isNotable ? 400 : 300,
          lineHeight: 1.7,
        }}
      >
        {thought.text}
      </p>
      <div className="flex items-center gap-3 mt-1.5">
        <span
          className="text-xs"
          style={{ color: '#2a2a26', fontSize: '10px' }}
        >
          {relativeTime(thought.timestamp)}
        </span>
        <span
          className="text-xs"
          style={{ color: `${marker.color}40`, fontSize: '10px' }}
        >
          {thought.category}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PinnedThought — important insight pinned at top
// ---------------------------------------------------------------------------

function PinnedThought({ thought }: { thought: AIThought }) {
  return (
    <div className="py-2">
      <p
        className="text-sm leading-relaxed"
        style={{
          color: '#e8e8e4',
          fontWeight: 400,
          lineHeight: 1.7,
        }}
      >
        {thought.text}
      </p>
      <span
        className="text-xs mt-1 inline-block"
        style={{ color: '#fbbf2440', fontSize: '10px' }}
      >
        pinned
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WakingUp — shown while the brain initializes
// ---------------------------------------------------------------------------

function WakingUp() {
  return (
    <div className="flex flex-col items-center justify-center h-full px-8">
      <div
        className="h-3 w-3 rounded-full mb-6 glow-breathe"
        style={{ background: '#7b9aff' }}
      />
      <p
        className="text-sm text-center leading-relaxed"
        style={{ color: '#4a4a46', maxWidth: '280px' }}
      >
        Observing your digital life...
      </p>
      <p
        className="text-xs text-center mt-2"
        style={{ color: '#2a2a26', maxWidth: '240px' }}
      >
        I&apos;ll start thinking once I have enough to work with.
      </p>
    </div>
  );
}
