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

type Thought = {
  id: string;
  text: string;
  category: 'reflection' | 'insight' | 'pattern' | 'question' | 'prediction' | 'nudge' | 'plan' | 'memory';
  importance: 'ambient' | 'notable' | 'important';
  timestamp: number;
  isNew?: boolean;
  source: 'ai' | 'local';
  /** A stable key for dedup — thoughts with same templateKey are the same thought, updated */
  templateKey: string;
};

type ObserverInfo = {
  name: string;
  enabled: boolean;
  available: boolean;
  last_collection: number | null;
  events_collected: number;
};

// ---------------------------------------------------------------------------
// Persistent thought memory — survives across app restarts
// ---------------------------------------------------------------------------

/** In-memory cache of shown templates for fast dedup within a session */
const shownTemplates = new Map<string, { text: string; timestamp: number; count: number }>();

function shouldShow(key: string, newText: string): boolean {
  const prev = shownTemplates.get(key);
  if (!prev) return true;
  const timeDiff = Date.now() - prev.timestamp;
  if (timeDiff < 300_000) return false; // 5min cooldown
  const normalize = (s: string) => s.replace(/\d+/g, '#');
  if (normalize(newText) === normalize(prev.text)) return false;
  return true;
}

function markShown(key: string, text: string) {
  const prev = shownTemplates.get(key);
  shownTemplates.set(key, { text, timestamp: Date.now(), count: (prev?.count ?? 0) + 1 });
}

/** Save thoughts to SQLite for persistence across restarts */
async function persistThoughts(thoughts: Thought[]) {
  if (thoughts.length === 0) return;
  const payload = thoughts.map((t) => ({
    id: t.id,
    text: t.text,
    category: t.category,
    importance: t.importance,
    source: t.source,
    templateKey: t.templateKey,
  }));
  await tauriInvoke('save_thoughts', { thoughts: payload });
}

/** Load persisted thoughts from SQLite */
async function loadPersistedThoughts(): Promise<Thought[]> {
  const raw = await tauriInvoke<Array<{
    id: string; text: string; category: string; importance: string;
    source: string; templateKey: string; timestamp: number; updatedAt: number;
  }>>('load_thoughts', { limit: 40 });

  if (!raw || raw.length === 0) return [];

  return raw.map((t) => ({
    id: t.id,
    text: t.text,
    category: (t.category as Thought['category']) || 'reflection',
    importance: (t.importance as Thought['importance']) || 'ambient',
    timestamp: t.timestamp,
    source: (t.source as Thought['source']) || 'local',
    templateKey: t.templateKey,
    isNew: false, // Already seen
  }));
}

/** Save a core memory block (the AI's evolving understanding) */
async function saveCoreMemory(label: string, value: string) {
  await tauriInvoke('save_core_memory', { label, value });
}

/** Load all core memory blocks */
async function loadCoreMemory(): Promise<Record<string, string>> {
  const raw = await tauriInvoke<Array<{ label: string; value: string }>>('load_core_memory');
  if (!raw) return {};
  const result: Record<string, string> = {};
  for (const block of raw) {
    result[block.label] = block.value;
  }
  return result;
}

/** Build a user profile summary from observations (for core memory) */
async function buildUserProfile(obs: RawObservation[]): Promise<string> {
  const apps = obs.filter((o) => o.event_type === 'app-session');
  const appStats: Record<string, number> = {};
  for (const s of apps) {
    const name = (s.payload.appName as string) || '';
    if (!name || name === 'WindowManager' || name === 'Finder') continue;
    appStats[name] = (appStats[name] || 0) + ((s.payload.sessionDurationSeconds as number) || 0);
  }
  const topApps = Object.entries(appStats).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const browsing = obs.filter((o) => o.event_type === 'browsing-session');
  const sites = [...new Set(browsing.map((b) => (b.payload.domainVisited as string) || ''))].filter(Boolean).slice(0, 5);

  const lines = [];
  if (topApps.length > 0) {
    lines.push(`Most used apps: ${topApps.map(([n, s]) => `${n} (${Math.round(s / 60)}m)`).join(', ')}`);
  }
  if (sites.length > 0) {
    lines.push(`Frequent sites: ${sites.join(', ')}`);
  }
  const hour = new Date().getHours();
  lines.push(`Active hours: typically ${hour >= 22 || hour < 6 ? 'late night worker' : hour < 12 ? 'morning person' : 'afternoon/evening'}`);
  return lines.join('. ');
}

// ---------------------------------------------------------------------------
// AI Engine — calls Ollama via Tauri command
// ---------------------------------------------------------------------------

async function callAI(): Promise<Thought[]> {
  try {
    const raw = await tauriInvoke<Array<{
      id: string; text: string; category?: string; importance?: string; timestamp?: number;
    }>>('generate_ai_thoughts', { limit: 30 });

    if (!raw || raw.length === 0) return [];

    return raw.map((t) => ({
      id: t.id || crypto.randomUUID(),
      text: t.text || '',
      category: (t.category as Thought['category']) || 'reflection',
      importance: (t.importance as Thought['importance']) || 'ambient',
      timestamp: t.timestamp || Date.now(),
      isNew: true,
      source: 'ai' as const,
      templateKey: `ai-${(t.text || '').replace(/\d+/g, '#').slice(0, 60)}`,
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
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Deep local analysis — not just reporting, but reasoning
// ---------------------------------------------------------------------------

async function analyzeLife(): Promise<Thought[]> {
  const obs = await tauriInvoke<RawObservation[]>('get_recent_observations', { limit: 100 });
  if (!obs || obs.length === 0) return [];

  const thoughts: Thought[] = [];
  const now = Date.now();
  const hour = new Date().getHours();
  const dayOfWeek = new Date().getDay(); // 0=Sun

  // ── Parse all observations ──
  const apps = obs.filter((o) => o.event_type === 'app-session');
  const browsing = obs.filter((o) => o.event_type === 'browsing-session');
  const music = obs.filter((o) => o.event_type === 'now-playing');
  const screen = obs.filter((o) => o.event_type === 'screen-session');
  const msgs = obs.filter((o) => o.event_type === 'communication');

  // ── App usage stats ──
  const appStats: Record<string, { totalSec: number; count: number; lastSeen: number }> = {};
  for (const s of apps) {
    const name = (s.payload.appName as string) || '';
    if (!name || name === 'WindowManager' || name === 'UserNotificationCenter' || name === 'Finder') continue;
    const secs = (s.payload.sessionDurationSeconds as number) || 0;
    if (!appStats[name]) appStats[name] = { totalSec: 0, count: 0, lastSeen: 0 };
    appStats[name].totalSec += secs;
    appStats[name].count += 1;
    appStats[name].lastSeen = Math.max(appStats[name].lastSeen, s.timestamp);
  }

  const sorted = Object.entries(appStats).sort((a, b) => b[1].totalSec - a[1].totalSec);
  const totalScreenMins = sorted.reduce((s, [, d]) => s + d.totalSec, 0) / 60;

  // ── Classify work pattern ──
  const devApps = ['Cursor', 'VS Code', 'Code', 'Terminal', 'iTerm2', 'Xcode', 'IntelliJ'];
  const commApps = ['Slack', 'Discord', 'Teams', 'Messages', 'Mail', 'Zoom'];
  const creativeApps = ['Figma', 'Sketch', 'Photoshop', 'Logic Pro', 'Final Cut'];
  const consumeApps = ['Safari', 'Google Chrome', 'Firefox', 'YouTube', 'Netflix', 'Twitter'];

  const devTime = sorted.filter(([n]) => devApps.some((d) => n.includes(d))).reduce((s, [, d]) => s + d.totalSec, 0);
  const commTime = sorted.filter(([n]) => commApps.some((c) => n.includes(c))).reduce((s, [, d]) => s + d.totalSec, 0);
  const consumeTime = sorted.filter(([n]) => consumeApps.some((c) => n.includes(c))).reduce((s, [, d]) => s + d.totalSec, 0);

  // ── THOUGHT: Work mode classification ──
  if (totalScreenMins > 10) {
    const devPct = Math.round((devTime / (devTime + commTime + consumeTime + 1)) * 100);
    const commPct = Math.round((commTime / (devTime + commTime + consumeTime + 1)) * 100);
    const consumePct = Math.round((consumeTime / (devTime + commTime + consumeTime + 1)) * 100);

    let modeThought = '';
    if (devPct > 60) {
      modeThought = `You're in deep build mode — ${devPct}% of your screen time is creation, not consumption. This is your most productive state. Protect it.`;
    } else if (commPct > 40) {
      modeThought = `Communication is dominating your session at ${commPct}%. If this isn't intentional, you might want to batch your messages and get back to focused work.`;
    } else if (consumePct > 50) {
      modeThought = `You're mostly consuming right now — browsing, reading, watching. That's fine if it's research, but if you had a goal for today, now might be the time to switch gears.`;
    } else {
      modeThought = `Mixed session: ${devPct}% building, ${commPct}% communicating, ${consumePct}% browsing. You're juggling modes — might be more effective to commit to one for the next hour.`;
    }

    emit(thoughts, 'work-mode', modeThought, 'insight', 'notable');
  }

  // ── THOUGHT: Energy & time planning ──
  if (hour >= 6 && hour < 10 && totalScreenMins > 5) {
    emit(thoughts, 'morning-plan',
      dayOfWeek === 0 || dayOfWeek === 6
        ? `Weekend morning. No agenda pressure — but if there's one thing you'd be proud to finish today, start it now while your willpower is fresh.`
        : `Morning block is your highest-value time. Whatever matters most today, do it now — before meetings and messages fragment your attention.`,
      'plan', 'important',
    );
  } else if (hour >= 10 && hour < 12) {
    emit(thoughts, 'mid-morning',
      `Mid-morning. If you haven't started your most important task yet, you have about 2 hours before the post-lunch dip. What's the one thing?`,
      'nudge', 'ambient',
    );
  } else if (hour >= 14 && hour < 16) {
    emit(thoughts, 'afternoon-dip',
      `Afternoon dip zone. Most people's focus drops now. This is actually a good time for creative tasks — your prefrontal cortex loosens up, which helps lateral thinking.`,
      'insight', 'ambient',
    );
  } else if (hour >= 22) {
    emit(thoughts, 'late-night',
      `It's late. Screen time after 10pm shifts your circadian rhythm by about 30 minutes per hour of exposure. If you're still going, at least switch to a warmer screen tone.`,
      'nudge', 'important',
    );
  }

  // ── THOUGHT: Focus quality analysis ──
  const recentApps = apps.filter((a) => now - a.timestamp < 600_000);
  const switchRate = recentApps.length;

  if (switchRate > 15) {
    emit(thoughts, 'focus-scattered',
      `High context-switching detected — ${switchRate} switches in 10 minutes. Research shows each switch costs about 23 minutes of refocus time. Your effective productivity is much lower than it feels.`,
      'insight', 'important',
    );
  } else if (switchRate < 4 && totalScreenMins > 15) {
    emit(thoughts, 'focus-deep',
      `Deep focus detected. You've barely switched apps. This is the state where breakthroughs happen — guard it fiercely.`,
      'reflection', 'notable',
    );
  }

  // ── THOUGHT: Primary workflow pattern ──
  if (sorted.length >= 2) {
    const [first, second] = sorted;
    const totalPairSec = first[1].totalSec + second[1].totalSec;
    const pairPct = Math.round((totalPairSec / Math.max(1, sorted.reduce((s, [, d]) => s + d.totalSec, 0))) * 100);

    if (pairPct > 60 && first[1].count >= 3 && second[1].count >= 3) {
      const firstMins = Math.round(first[1].totalSec / 60);
      const secondMins = Math.round(second[1].totalSec / 60);

      // Identify what kind of workflow this is
      const isDevBrowser = (devApps.some((d) => first[0].includes(d)) && consumeApps.some((c) => second[0].includes(c))) ||
                           (devApps.some((d) => second[0].includes(d)) && consumeApps.some((c) => first[0].includes(c)));

      if (isDevBrowser) {
        emit(thoughts, 'workflow-dev-browser',
          `Your workflow: ${first[0]} (${firstMins}m) ↔ ${second[0]} (${secondMins}m). Classic build-and-reference loop. Tip: try split-screen to reduce the switching overhead.`,
          'prediction', 'ambient',
        );
      } else {
        emit(thoughts, 'workflow-pair',
          `${pairPct}% of your time is in ${first[0]} and ${second[0]}. That's your current world.`,
          'reflection', 'ambient',
        );
      }
    }
  }

  // ── THOUGHT: Browsing analysis ──
  if (browsing.length > 0) {
    const siteVisits: Record<string, number> = {};
    for (const b of browsing) {
      const site = (b.payload.domainVisited as string) || '';
      if (site) siteVisits[site] = (siteVisits[site] || 0) + ((b.payload.visitCount as number) || 1);
    }
    const topSites = Object.entries(siteVisits).sort((a, b) => b[1] - a[1]);

    // Repeated site = fixation
    if (topSites[0] && topSites[0][1] >= 5) {
      emit(thoughts, 'site-fixation',
        `You keep returning to ${topSites[0][0]} (${topSites[0][1]}x). When you return to something that often, it usually means there's an unresolved decision or unanswered question there. What are you actually looking for?`,
        'question', 'notable',
      );
    }

    // Research breadth
    if (topSites.length >= 6) {
      const siteList = topSites.slice(0, 4).map(([s]) => s).join(', ');
      emit(thoughts, 'research-breadth',
        `Wide research mode: ${topSites.length} sites including ${siteList}. Consider capturing what you've found before it disperses. Even a 2-line note helps.`,
        'nudge', 'notable',
      );
    }
  }

  // ── THOUGHT: Music & mood ──
  if (music.length > 0) {
    const latest = music[0];
    const track = (latest.payload.trackTitle as string) || '';
    const artist = (latest.payload.artistName as string) || '';
    if (track) {
      emit(thoughts, 'music-playing',
        `Playing "${track}"${artist ? ` by ${artist}` : ''}. You tend to turn on music when you want to lock in. Is this the start of a focus session?`,
        'question', 'ambient',
      );
    }
  }

  // ── THOUGHT: Communication patterns ──
  if (msgs.length > 0) {
    const totalMsgs = msgs.reduce((s, m) => s + ((m.payload.messageCount as number) || 1), 0);
    if (totalMsgs > 20) {
      emit(thoughts, 'heavy-comms',
        `${totalMsgs} messages today. That's a lot of reactive time. Consider setting specific communication windows — say 10am, 1pm, 5pm — and batch everything else.`,
        'plan', 'notable',
      );
    }
  }

  // ── THOUGHT: Screen idle = thinking break ──
  const idleEvent = screen.find((s) => (s.payload.screenState as string) === 'idle');
  if (idleEvent) {
    const idleMins = Math.round(((idleEvent.payload.idleDurationSeconds as number) || 0) / 60);
    if (idleMins >= 10) {
      emit(thoughts, 'break-taken',
        `${idleMins} minute break. Research on creative problem-solving shows that incubation periods — stepping away — are when your default mode network makes unexpected connections. If you were stuck on something before, check if a new angle appeared.`,
        'insight', 'notable',
      );
    }
  }

  // ── THOUGHT: Day summary / life planning ──
  if (totalScreenMins > 60) {
    const productiveRatio = Math.round((devTime / Math.max(1, devTime + consumeTime)) * 100);
    if (productiveRatio < 30) {
      emit(thoughts, 'productivity-ratio',
        `Only ${productiveRatio}% of your screen time has been active creation. The rest is consumption. There's nothing wrong with that — unless you expected otherwise.`,
        'reflection', 'notable',
      );
    }
  }

  // ── THOUGHT: Weekend pattern ──
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    if (devTime > 1800) { // 30+ mins of dev on weekend
      emit(thoughts, 'weekend-work',
        `You're coding on a weekend. That's either passion or pressure. If it's passion — great, flow state doesn't care about calendars. If it's pressure — the work will still be there Monday, and rest compounds.`,
        'reflection', 'notable',
      );
    }
  }

  return thoughts;
}

function emit(
  thoughts: Thought[],
  templateKey: string,
  text: string,
  category: Thought['category'],
  importance: Thought['importance'],
) {
  if (!shouldShow(templateKey, text)) return;
  markShown(templateKey, text);
  thoughts.push({
    id: crypto.randomUUID(),
    text,
    category,
    importance,
    timestamp: Date.now(),
    isNew: true,
    source: 'local',
    templateKey,
  });
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
  if (min === 1) return '1m ago';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr === 1) return '1h ago';
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [pinnedThoughts, setPinnedThoughts] = useState<Thought[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [observers, setObservers] = useState<ObserverInfo[]>([]);
  const [observationCount, setObservationCount] = useState(0);
  const [aiStatus, setAiStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [showStatus, setShowStatus] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const thinkingRef = useRef(false);

  // ── Merge thoughts by template key — update in place, don't duplicate ──
  const mergeThoughts = useCallback((incoming: Thought[]) => {
    if (incoming.length === 0) return;

    setThoughts((prev) => {
      const byKey = new Map(prev.map((t) => [t.templateKey, t]));
      const result = [...prev];
      const newOnes: Thought[] = [];

      for (const t of incoming) {
        const existing = byKey.get(t.templateKey);
        if (existing) {
          // Update text in place (thought evolved, e.g. "30 min" → "45 min")
          const idx = result.indexOf(existing);
          if (idx >= 0) {
            result[idx] = { ...t, isNew: false }; // Don't re-animate updates
          }
        } else {
          newOnes.push(t);
          byKey.set(t.templateKey, t);
        }
      }

      // Pin important new thoughts
      const important = newOnes.filter((t) => t.importance === 'important');
      if (important.length > 0) {
        setPinnedThoughts((pp) => {
          const keys = new Set(pp.map((p) => p.templateKey));
          const fresh = important.filter((i) => !keys.has(i.templateKey));
          return [...fresh, ...pp].slice(0, 3);
        });
      }

      return [...newOnes, ...result].slice(0, 40);
    });
  }, []);

  // ── Main think cycle ──
  const think = useCallback(async () => {
    if (thinkingRef.current) return;
    thinkingRef.current = true;
    setIsThinking(true);

    try {
      const rawObs = await tauriInvoke<RawObservation[]>('get_recent_observations', { limit: 100 });
      setObservationCount(rawObs?.length ?? 0);

      if (!rawObs || rawObs.length === 0) return;

      // Phase 1: Deep local analysis (instant)
      const local = await analyzeLife();
      mergeThoughts(local);

      // Persist local thoughts immediately
      if (local.length > 0) {
        persistThoughts(local).catch(() => {});
      }

      // Phase 2: Update core memory (user profile)
      buildUserProfile(rawObs).then((profile) => {
        if (profile) saveCoreMemory('user_profile', profile).catch(() => {});
      });

      // Phase 3: AI (fire and forget)
      callAI().then((ai) => {
        if (ai.length > 0) {
          mergeThoughts(ai);
          persistThoughts(ai).catch(() => {});
        }
      }).catch(() => {}).finally(() => {
        thinkingRef.current = false;
        setIsThinking(false);
      });

      return; // Don't wait for AI
    } catch {
      thinkingRef.current = false;
      setIsThinking(false);
    }
  }, [mergeThoughts]);

  // ── Setup ──
  useEffect(() => {
    checkAI().then((ok) => setAiStatus(ok ? 'online' : 'offline'));

    tauriInvoke<ObserverInfo[]>('get_observer_status').then((obs) => {
      if (obs) setObservers(obs);
    });

    // Load persisted thoughts from previous sessions FIRST
    loadPersistedThoughts().then((persisted) => {
      if (persisted.length > 0) {
        setThoughts(persisted);
        // Populate shownTemplates cache to prevent re-generation
        for (const t of persisted) {
          shownTemplates.set(t.templateKey, { text: t.text, timestamp: t.timestamp, count: 1 });
        }
      }
    });

    // Then start fresh thinking (will add new thoughts on top)
    think();

    const setupTimer = setTimeout(() => {
      // Local analysis every 60s (not 30 — reduce repetition)
      const localInt = setInterval(async () => {
        const local = await analyzeLife();
        mergeThoughts(local);
        const rawObs = await tauriInvoke<RawObservation[]>('get_recent_observations', { limit: 100 });
        setObservationCount(rawObs?.length ?? 0);
      }, 60_000);

      // AI every 2 minutes
      const aiInt = setInterval(async () => {
        if (thinkingRef.current) return;
        thinkingRef.current = true;
        setIsThinking(true);
        try {
          const ai = await callAI();
          if (ai.length > 0) mergeThoughts(ai);
        } catch { /* */ }
        thinkingRef.current = false;
        setIsThinking(false);
      }, 120_000);

      // Observer refresh
      const obsInt = setInterval(async () => {
        const obs = await tauriInvoke<ObserverInfo[]>('get_observer_status');
        if (obs) setObservers(obs);
      }, 15_000);

      return () => { clearInterval(localInt); clearInterval(aiInt); clearInterval(obsInt); };
    }, 3000);

    return () => clearTimeout(setupTimer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Clear new flag ──
  useEffect(() => {
    if (thoughts.some((t) => t.isNew)) {
      const timeout = setTimeout(() => {
        setThoughts((prev) => prev.map((t) => (t.isNew ? { ...t, isNew: false } : t)));
      }, 2000);
      return () => clearTimeout(timeout);
    }
  }, [thoughts]);

  const activeObs = observers.filter((o) => o.enabled);
  const totalEvents = observers.reduce((s, o) => s + o.events_collected, 0);

  // ── Render ──
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100%', background: '#0a0a0a', overflow: 'hidden' }}>

      {/* ── Header ── */}
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 20px 10px', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ position: 'relative', width: 8, height: 8 }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: isThinking ? '#7b9aff' : thoughts.length > 0 ? '#4ade80' : '#2a2a26',
              transition: 'background 0.6s',
            }} />
            {isThinking && <div style={{
              position: 'absolute', top: 0, left: 0, width: 8, height: 8, borderRadius: '50%',
              background: '#7b9aff', animation: 'pulse-subtle 1.5s ease-in-out infinite',
            }} />}
          </div>
          <span style={{ color: '#e8e8e4', fontSize: 13, fontWeight: 500, letterSpacing: '0.1em' }}>PRE</span>
          {isThinking && <span className="fade-in" style={{ color: '#3a3a36', fontSize: 10 }}>thinking</span>}
        </div>
        <button
          type="button"
          onClick={() => setShowStatus(!showStatus)}
          style={{
            color: '#3a3a36', fontSize: 10, cursor: 'pointer',
            background: showStatus ? '#141414' : 'none',
            border: 'none', padding: '3px 8px', borderRadius: 4,
          }}
        >
          {totalEvents > 0 ? `${totalEvents} signals` : '···'}
        </button>
      </header>

      {/* ── Status panel ── */}
      {showStatus && (
        <div className="fade-in" style={{
          padding: '10px 20px 12px',
          borderTop: '1px solid rgba(255,255,255,0.03)',
          borderBottom: '1px solid rgba(255,255,255,0.03)',
          background: '#0c0c0c',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <StatusRow label="AI Engine" value={aiStatus === 'online' ? 'llama 3.1 8b' : aiStatus === 'offline' ? 'offline' : '…'} ok={aiStatus === 'online'} />
            <StatusRow label="Buffered" value={String(observationCount)} ok={observationCount > 0} />
            <StatusRow label="Observers" value={`${activeObs.length} active`} ok={activeObs.length > 0} />
            <div style={{ marginTop: 4, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px' }}>
              {observers.map((obs) => (
                <div key={obs.name} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 6, minWidth: 0,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                    <div style={{
                      width: 4, height: 4, borderRadius: '50%', flexShrink: 0,
                      background: obs.enabled && obs.events_collected > 0 ? '#4ade80' : obs.enabled ? '#fbbf24' : '#1a1a18',
                    }} />
                    <span style={{
                      color: '#2a2a26', fontSize: 9,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{obs.name}</span>
                  </div>
                  <span style={{
                    color: '#1e1e1c', fontSize: 9, flexShrink: 0,
                  }}>
                    {obs.events_collected > 0 ? obs.events_collected : obs.enabled ? '–' : 'off'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Pinned ── */}
      {pinnedThoughts.length > 0 && (
        <div style={{
          padding: '8px 20px', flexShrink: 0,
          borderBottom: '1px solid rgba(255,255,255,0.03)',
          background: 'rgba(123, 154, 255, 0.02)',
        }}>
          {pinnedThoughts.map((t) => (
            <div key={t.id} style={{ padding: '4px 0' }}>
              <p style={{ color: '#d4d4d0', fontSize: 12.5, lineHeight: 1.75, margin: 0, fontWeight: 400 }}>
                {t.text}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* ── Thought stream ── */}
      <div ref={streamRef} className="overflow-y-auto" style={{ flex: 1, padding: '12px 20px 40px' }}>
        {thoughts.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            height: '100%', padding: '0 32px',
          }}>
            <div className="glow-breathe" style={{ width: 10, height: 10, borderRadius: '50%', background: '#7b9aff', marginBottom: 24 }} />
            <p style={{ color: '#3a3a36', fontSize: 12, textAlign: 'center', lineHeight: 1.8 }}>
              Observing your digital life...<br />
              <span style={{ color: '#2a2a26' }}>Thoughts will appear as patterns emerge.</span>
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {thoughts.map((t) => <ThoughtRow key={t.id} thought={t} />)}
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <footer style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 20px 8px', flexShrink: 0,
        borderTop: '1px solid rgba(255,255,255,0.02)',
      }}>
        <span style={{ color: '#1a1a18', fontSize: 9 }}>
          {thoughts.length} thoughts{thoughts.filter((t) => t.source === 'ai').length > 0
            ? ` · ${thoughts.filter((t) => t.source === 'ai').length} ai` : ''}
        </span>
        <button
          type="button"
          onClick={() => { if (!thinkingRef.current) think(); }}
          disabled={isThinking}
          style={{
            color: isThinking ? '#1a1a18' : '#3a3a36', fontSize: 9,
            cursor: isThinking ? 'default' : 'pointer',
            background: 'none', border: 'none', padding: '2px 6px',
          }}
        >
          {isThinking ? 'thinking' : 'think now'}
        </button>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ThoughtRow
// ---------------------------------------------------------------------------

const CAT_ACCENT: Record<string, string> = {
  reflection: '#5a5a56',
  insight: '#7b9aff',
  pattern: '#a78bfa',
  question: '#fbbf24',
  prediction: '#34d399',
  nudge: '#fb923c',
  plan: '#f472b6',
  memory: '#38bdf8',
};

function ThoughtRow({ thought }: { thought: Thought }) {
  const accent = CAT_ACCENT[thought.category] || '#5a5a56';
  const notable = thought.importance !== 'ambient';

  return (
    <div
      className={thought.isNew ? 'thought-enter' : ''}
      style={{
        padding: '10px 0 10px 12px',
        borderLeft: `1.5px solid ${notable ? accent + '20' : 'transparent'}`,
        marginBottom: 2,
      }}
    >
      <p style={{
        color: notable ? '#c8c8c4' : '#7a7a76',
        fontSize: 12.5,
        lineHeight: 1.8,
        fontWeight: notable ? 400 : 300,
        margin: 0,
        letterSpacing: '-0.005em',
      }}>
        {thought.text}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
        <span style={{ color: '#1a1a18', fontSize: 8.5 }}>{relativeTime(thought.timestamp)}</span>
        <span style={{ color: accent + '30', fontSize: 8.5 }}>{thought.category}</span>
        {thought.source === 'ai' && <span style={{ color: '#7b9aff18', fontSize: 8.5 }}>ai</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusRow
// ---------------------------------------------------------------------------

function StatusRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ color: '#3a3a36', fontSize: 10 }}>{label}</span>
      <span style={{ color: ok ? '#4ade8088' : '#f8717188', fontSize: 10 }}>{value}</span>
    </div>
  );
}
