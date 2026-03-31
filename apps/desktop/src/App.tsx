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
  source: 'ai' | 'local';
};

type ObserverInfo = {
  name: string;
  enabled: boolean;
  available: boolean;
  last_collection: number | null;
  events_collected: number;
};

// ---------------------------------------------------------------------------
// AI Engine — calls Ollama via Tauri command
// ---------------------------------------------------------------------------

async function callAI(): Promise<AIThought[]> {
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
      source: 'ai' as const,
    }));
  } catch (err) {
    console.error('AI call failed:', err);
    return [];
  }
}

async function checkAI(): Promise<boolean> {
  try {
    const r = await tauriInvoke<{ available: boolean }>('check_ai_status');
    return r?.available ?? false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Smart local analysis — instant, no AI needed
// ---------------------------------------------------------------------------

async function analyzeLocally(): Promise<AIThought[]> {
  const obs = await tauriInvoke<RawObservation[]>('get_recent_observations', { limit: 50 });
  if (!obs || obs.length === 0) return [];

  const thoughts: AIThought[] = [];
  const now = Date.now();
  const hour = new Date().getHours();

  // ── Analyze app usage ──
  const apps = obs.filter((o) => o.event_type === 'app-session');
  const appStats: Record<string, { totalSec: number; count: number; lastSeen: number }> = {};

  for (const s of apps) {
    const name = (s.payload.appName as string) || 'Unknown';
    const secs = (s.payload.sessionDurationSeconds as number) || 0;
    if (!appStats[name]) appStats[name] = { totalSec: 0, count: 0, lastSeen: 0 };
    appStats[name].totalSec += secs;
    appStats[name].count += 1;
    appStats[name].lastSeen = Math.max(appStats[name].lastSeen, s.timestamp);
  }

  const sortedApps = Object.entries(appStats).sort((a, b) => b[1].totalSec - a[1].totalSec);
  const topApp = sortedApps[0];
  const uniqueApps = sortedApps.length;

  // Deep focus detection
  if (topApp) {
    const [name, data] = topApp;
    const mins = Math.round(data.totalSec / 60);
    if (mins >= 60) {
      thoughts.push(mkThought(
        `${mins} minutes in ${name}. That's a serious deep work session — whatever you're building, you're locked in.`,
        'pattern', 'important',
      ));
    } else if (mins >= 20) {
      thoughts.push(mkThought(
        `${mins} minutes in ${name} so far. You're in a solid flow state.`,
        'reflection', 'notable',
      ));
    } else if (mins >= 5) {
      thoughts.push(mkThought(
        `Working in ${name} — ${mins} minutes across ${data.count} sessions.`,
        'reflection', 'ambient',
      ));
    }
  }

  // Context switching analysis
  if (apps.length > 0) {
    // Calculate switches in last 10 minutes
    const recentApps = apps.filter((a) => now - a.timestamp < 600_000);
    const recentSwitches = recentApps.length;

    if (recentSwitches > 12) {
      thoughts.push(mkThought(
        `${recentSwitches} app switches in the last 10 minutes. Your mind is racing — maybe take a breath and pick one thing.`,
        'nudge', 'notable',
      ));
    } else if (uniqueApps >= 5) {
      const names = sortedApps.slice(0, 4).map(([n]) => n).join(', ');
      thoughts.push(mkThought(
        `Bouncing between ${uniqueApps} apps (${names}). Multi-tasking mode — or are you looking for something?`,
        'question', 'ambient',
      ));
    }
  }

  // Two-app ping-pong pattern
  if (sortedApps.length >= 2) {
    const [first, second] = sortedApps;
    if (first[1].count >= 3 && second[1].count >= 3) {
      const ratio = Math.round(first[1].totalSec / Math.max(1, first[1].totalSec + second[1].totalSec) * 100);
      thoughts.push(mkThought(
        `You keep switching between ${first[0]} and ${second[0]} — ${ratio}/${100 - ratio} split. That's the rhythm of someone working through a problem.`,
        'insight', 'notable',
      ));
    }
  }

  // ── Browsing patterns ──
  const browsing = obs.filter((o) => o.event_type === 'browsing-session');
  if (browsing.length > 0) {
    const sites = [...new Set(browsing.map((b) => (b.payload.domainVisited as string) || ''))].filter(Boolean);
    const visitCounts = browsing.reduce((acc, b) => {
      const site = (b.payload.domainVisited as string) || '';
      acc[site] = (acc[site] || 0) + ((b.payload.visitCount as number) || 1);
      return acc;
    }, {} as Record<string, number>);

    const topSite = Object.entries(visitCounts).sort((a, b) => b[1] - a[1])[0];

    if (topSite && topSite[1] >= 5) {
      thoughts.push(mkThought(
        `You've visited ${topSite[0]} ${topSite[1]} times. Something there keeps pulling you back.`,
        'pattern', 'notable',
      ));
    } else if (sites.length >= 5) {
      thoughts.push(mkThought(
        `${sites.length} different sites browsed. Research mode — or just wandering?`,
        'question', 'ambient',
      ));
    } else if (sites.length > 0) {
      thoughts.push(mkThought(
        `Browsing activity across ${sites.slice(0, 3).join(', ')}${sites.length > 3 ? '...' : ''}.`,
        'reflection', 'ambient',
      ));
    }
  }

  // ── Music ──
  const music = obs.filter((o) => o.event_type === 'now-playing');
  if (music.length > 0) {
    const latest = music[0];
    const track = (latest.payload.trackTitle as string) || '';
    const artist = (latest.payload.artistName as string) || '';
    if (track) {
      thoughts.push(mkThought(
        `Listening to "${track}"${artist ? ` by ${artist}` : ''}. Music while working — you focus better with a soundtrack.`,
        'reflection', 'ambient',
      ));
    }
  }

  // ── Time awareness ──
  if (hour >= 23 || hour < 4) {
    const totalMins = apps.reduce((s, a) => s + ((a.payload.sessionDurationSeconds as number) || 0), 0) / 60;
    thoughts.push(mkThought(
      `It's ${hour >= 23 ? 'nearly midnight' : 'the early hours'}. You've been active for ${Math.round(totalMins)} minutes. Is this intentional, or did time slip away?`,
      'nudge', 'important',
    ));
  } else if (hour >= 20) {
    thoughts.push(mkThought(
      `Evening session. Your energy typically dips after 9pm — this might be a good time for lighter tasks.`,
      'prediction', 'ambient',
    ));
  }

  // ── Screen idle ──
  const screenEvents = obs.filter((o) => o.event_type === 'screen-session');
  const idleEvent = screenEvents.find((s) => (s.payload.screenState as string) === 'idle');
  if (idleEvent) {
    const idleMins = Math.round(((idleEvent.payload.idleDurationSeconds as number) || 0) / 60);
    if (idleMins >= 15) {
      thoughts.push(mkThought(
        `You stepped away for ${idleMins} minutes. Good — breaks are when your subconscious does its best work.`,
        'insight', 'notable',
      ));
    }
  }

  // ── Messages ──
  const msgs = obs.filter((o) => o.event_type === 'communication');
  if (msgs.length > 0) {
    const totalMsgs = msgs.reduce((s, m) => s + ((m.payload.messageCount as number) || 1), 0);
    if (totalMsgs > 20) {
      thoughts.push(mkThought(
        `${totalMsgs} messages exchanged. Heavy communication day — make sure you're not losing your deep work time to chat.`,
        'nudge', 'notable',
      ));
    }
  }

  // ── Overall summary if we don't have enough specific thoughts ──
  if (thoughts.length < 2 && obs.length > 5) {
    thoughts.push(mkThought(
      `${obs.length} observations collected. I'm building a picture of your patterns — the more data I gather, the deeper my insights will get.`,
      'reflection', 'ambient',
    ));
  }

  return thoughts.slice(0, 6); // Max 6 thoughts per cycle
}

function mkThought(
  text: string,
  category: AIThought['category'],
  importance: AIThought['importance'],
): AIThought {
  return {
    id: crypto.randomUUID(),
    text,
    category,
    importance,
    timestamp: Date.now() - Math.random() * 30000, // slight stagger
    isNew: true,
    source: 'local',
  };
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
  const [aiStatus, setAiStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [showStatus, setShowStatus] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const thinkingRef = useRef(false);
  const cycleCountRef = useRef(0);

  // ── Deduplicate and add new thoughts ───────────────────────────
  const addThoughts = useCallback((newThoughts: AIThought[]) => {
    if (newThoughts.length === 0) return;

    setThoughts((prev) => {
      const existing = new Set(prev.map((t) => t.text.slice(0, 40)));
      const fresh = newThoughts.filter((t) => t.text && !existing.has(t.text.slice(0, 40)));
      if (fresh.length === 0) return prev;

      const important = fresh.filter((t) => t.importance === 'important');
      if (important.length > 0) {
        setPinnedThoughts((pp) => {
          const existingPins = new Set(pp.map((p) => p.text.slice(0, 40)));
          const newPins = important.filter((i) => !existingPins.has(i.text.slice(0, 40)));
          return [...newPins, ...pp].slice(0, 3);
        });
      }

      return [...fresh, ...prev].slice(0, 60);
    });
  }, []);

  // ── Main think cycle ──────────────────────────────────────────
  const think = useCallback(async () => {
    // Prevent overlapping calls with ref (not state — no stale closure)
    if (thinkingRef.current) return;
    thinkingRef.current = true;
    setIsThinking(true);
    cycleCountRef.current += 1;

    try {
      // 1. Get observation count
      const rawObs = await tauriInvoke<RawObservation[]>('get_recent_observations', { limit: 50 });
      const count = rawObs?.length ?? 0;
      setObservationCount(count);

      if (count === 0) return;

      // 2. Instant local analysis (always works, <100ms)
      const localThoughts = await analyzeLocally();
      addThoughts(localThoughts);

      // 3. Show "thinking done" for local, keep thinking indicator for AI
      // Small delay so user sees local thoughts appear
      await new Promise((r) => setTimeout(r, 500));

      // 4. AI thoughts (slow, may take 30-90s) — fire and forget after local
      callAI().then((aiThoughts) => {
        if (aiThoughts.length > 0) {
          addThoughts(aiThoughts);
        }
      }).catch(() => {
        // AI failed silently — local thoughts already shown
      }).finally(() => {
        thinkingRef.current = false;
        setIsThinking(false);
      });

      // Don't wait for AI — return now so UI isn't blocked
      // (the finally above will clear thinking state when AI finishes)
      return;
    } catch (err) {
      console.error('Think cycle failed:', err);
      thinkingRef.current = false;
      setIsThinking(false);
    }
  }, [addThoughts]);

  // ── Initial setup ─────────────────────────────────────────────
  useEffect(() => {
    // Check AI status
    checkAI().then((ok) => setAiStatus(ok ? 'online' : 'offline'));

    // Load observers
    tauriInvoke<ObserverInfo[]>('get_observer_status').then((obs) => {
      if (obs) setObservers(obs);
    });

    // First think cycle immediately
    think();

    // Periodic: local analysis every 30s, AI every 90s
    let localInterval: ReturnType<typeof setInterval>;
    let aiInterval: ReturnType<typeof setInterval>;
    let obsInterval: ReturnType<typeof setInterval>;

    // After initial think, set up intervals
    const setupTimer = setTimeout(() => {
      // Refresh local analysis frequently
      localInterval = setInterval(async () => {
        const localThoughts = await analyzeLocally();
        addThoughts(localThoughts);
        // Update observation count
        const rawObs = await tauriInvoke<RawObservation[]>('get_recent_observations', { limit: 50 });
        setObservationCount(rawObs?.length ?? 0);
      }, 30_000);

      // AI thinking less frequently (it's slow)
      aiInterval = setInterval(async () => {
        if (thinkingRef.current) return;
        thinkingRef.current = true;
        setIsThinking(true);
        try {
          const aiThoughts = await callAI();
          if (aiThoughts.length > 0) addThoughts(aiThoughts);
        } catch { /* silent */ }
        thinkingRef.current = false;
        setIsThinking(false);
      }, 90_000);

      // Observer status refresh
      obsInterval = setInterval(async () => {
        const obs = await tauriInvoke<ObserverInfo[]>('get_observer_status');
        if (obs) setObservers(obs);
      }, 15_000);
    }, 5000);

    return () => {
      clearTimeout(setupTimer);
      clearInterval(localInterval);
      clearInterval(aiInterval);
      clearInterval(obsInterval);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Clear "new" flag after animation ──────────────────────────
  useEffect(() => {
    if (thoughts.some((t) => t.isNew)) {
      const timeout = setTimeout(() => {
        setThoughts((prev) => prev.map((t) => (t.isNew ? { ...t, isNew: false } : t)));
      }, 1500);
      return () => clearTimeout(timeout);
    }
  }, [thoughts]);

  // ── Derived state ─────────────────────────────────────────────
  const activeObs = observers.filter((o) => o.enabled);
  const totalEvents = observers.reduce((s, o) => s + o.events_collected, 0);

  return (
    <div className="flex h-screen w-full flex-col" style={{ background: '#0a0a0a' }}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-5 py-3 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="relative flex items-center justify-center" style={{ width: 10, height: 10 }}>
            <div
              className="h-2 w-2 rounded-full"
              style={{
                background: isThinking ? '#7b9aff' : thoughts.length > 2 ? '#4ade80' : '#3a3a36',
                transition: 'background 0.5s ease',
              }}
            />
            {isThinking && (
              <div
                className="absolute h-2 w-2 rounded-full"
                style={{
                  background: '#7b9aff',
                  animation: 'pulse-subtle 1.5s ease-in-out infinite',
                }}
              />
            )}
          </div>
          <span style={{ color: '#e8e8e4', fontSize: 13, fontWeight: 500, letterSpacing: '0.08em' }}>
            PRE
          </span>
          {isThinking && (
            <span className="fade-in" style={{ color: '#4a4a46', fontSize: 11 }}>
              thinking...
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowStatus(!showStatus)}
          style={{
            color: '#4a4a46', fontSize: 11, cursor: 'pointer',
            background: 'none', border: 'none', padding: '2px 6px',
          }}
        >
          {totalEvents > 0 ? `${totalEvents} signals` : observationCount > 0 ? `${observationCount} obs` : '...'}
        </button>
      </header>

      {/* ── Status panel ────────────────────────────────────────── */}
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
            <StatusRow label="AI Engine" value={
              aiStatus === 'online' ? 'llama3.1:8b' : aiStatus === 'offline' ? 'offline' : '...'
            } ok={aiStatus === 'online'} />
            <StatusRow label="Observations" value={`${observationCount} buffered`} ok={observationCount > 0} />
            <StatusRow label="Observers" value={`${activeObs.length} active`} ok={activeObs.length > 0} />
            {observers.map((obs) => (
              <div key={obs.name} className="flex items-center justify-between pl-3">
                <div className="flex items-center gap-1.5">
                  <div
                    className="h-1 w-1 rounded-full"
                    style={{ background: obs.enabled && obs.events_collected > 0 ? '#4ade80' : obs.enabled ? '#fbbf24' : '#2a2a26' }}
                  />
                  <span style={{ color: '#3a3a36', fontSize: 10 }}>{obs.name}</span>
                </div>
                <span style={{ color: '#2a2a26', fontSize: 10 }}>
                  {obs.events_collected > 0 ? obs.events_collected : obs.enabled ? 'waiting' : 'off'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Pinned thoughts ──────────────────────────────────────── */}
      {pinnedThoughts.length > 0 && (
        <div
          className="px-5 py-2 shrink-0"
          style={{
            borderBottom: '1px solid rgba(255,255,255,0.04)',
            background: 'rgba(251, 191, 36, 0.02)',
          }}
        >
          {pinnedThoughts.map((t) => (
            <div key={t.id} className="py-1.5">
              <p style={{ color: '#e8e8e4', fontSize: 13, lineHeight: 1.7, fontWeight: 400 }}>
                {t.text}
              </p>
              <span style={{ color: '#fbbf2430', fontSize: 9 }}>pinned</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Thought stream ──────────────────────────────────────── */}
      <div ref={streamRef} className="flex-1 overflow-y-auto px-5 pt-3 pb-8">
        {thoughts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-8">
            <div
              className="h-3 w-3 rounded-full mb-6 glow-breathe"
              style={{ background: '#7b9aff' }}
            />
            <p style={{ color: '#4a4a46', fontSize: 13, textAlign: 'center', maxWidth: 260 }}>
              Observing your digital life...
            </p>
            <p style={{ color: '#2a2a26', fontSize: 11, textAlign: 'center', marginTop: 8, maxWidth: 220 }}>
              Thoughts will appear as I learn your patterns.
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {thoughts.map((thought) => (
              <ThoughtBubble key={thought.id} thought={thought} />
            ))}
          </div>
        )}
      </div>

      {/* ── Footer ──────────────────────────────────────────────── */}
      <footer
        className="flex items-center justify-between px-5 py-2 shrink-0"
        style={{ borderTop: '1px solid rgba(255,255,255,0.03)' }}
      >
        <span style={{ color: '#2a2a26', fontSize: 10 }}>
          {thoughts.filter((t) => t.source === 'ai').length > 0
            ? `${thoughts.length} thoughts · ${thoughts.filter((t) => t.source === 'ai').length} from AI`
            : `${thoughts.length} thoughts`}
        </span>
        <button
          type="button"
          onClick={() => {
            if (!thinkingRef.current) think();
          }}
          style={{
            color: isThinking ? '#2a2a26' : '#4a4a46',
            fontSize: 10,
            cursor: isThinking ? 'default' : 'pointer',
            background: 'none',
            border: 'none',
            padding: '2px 6px',
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
// ThoughtBubble — a single thought in the consciousness stream
// ---------------------------------------------------------------------------

const CATEGORY_COLORS: Record<string, string> = {
  reflection: '#6a6a66',
  insight: '#7b9aff',
  pattern: '#a78bfa',
  question: '#fbbf24',
  prediction: '#34d399',
  nudge: '#fb923c',
};

function ThoughtBubble({ thought }: { thought: AIThought }) {
  const catColor = CATEGORY_COLORS[thought.category] || '#6a6a66';
  const isNotable = thought.importance !== 'ambient';

  return (
    <div
      className={thought.isNew ? 'thought-enter' : ''}
      style={{
        padding: '10px 0 10px 14px',
        borderLeft: isNotable ? `1.5px solid ${catColor}25` : '1.5px solid transparent',
        transition: 'border-color 0.3s ease',
      }}
    >
      <p style={{
        color: isNotable ? '#d4d4d0' : '#8a8a86',
        fontSize: 13,
        lineHeight: 1.75,
        fontWeight: isNotable ? 400 : 300,
        margin: 0,
      }}>
        {thought.text}
      </p>
      <div className="flex items-center gap-3" style={{ marginTop: 4 }}>
        <span style={{ color: '#1e1e1c', fontSize: 9 }}>
          {relativeTime(thought.timestamp)}
        </span>
        <span style={{ color: `${catColor}35`, fontSize: 9 }}>
          {thought.category}
        </span>
        {thought.source === 'ai' && (
          <span style={{ color: '#7b9aff20', fontSize: 9 }}>ai</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusRow
// ---------------------------------------------------------------------------

function StatusRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ color: '#4a4a46', fontSize: 11 }}>{label}</span>
      <span style={{ color: ok ? '#4ade80' : '#f87171', fontSize: 11 }}>{value}</span>
    </div>
  );
}
