import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Tauri interop
// ---------------------------------------------------------------------------

let invokeImpl: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
async function getInvoke() {
  if (invokeImpl) return invokeImpl;
  try { const m = await import('@tauri-apps/api/core'); invokeImpl = m.invoke; return invokeImpl; }
  catch { invokeImpl = async () => []; return invokeImpl!; }
}
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try { return (await (await getInvoke())(cmd, args)) as T; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Thought = {
  id: string;
  text: string;
  category: 'idea' | 'blindspot' | 'question' | 'pattern' | 'challenge' | 'insight' | 'reflection' | 'nudge' | 'prediction' | 'plan' | 'memory';
  importance: 'ambient' | 'notable' | 'important';
  timestamp: number;
  isNew?: boolean;
  source: 'ai' | 'local';
  templateKey: string;
};

type CoreMemoryBlock = { label: string; value: string; updatedAt: number; version: number };

type RawObservation = {
  id: string; source: string; domain: string;
  event_type: string; timestamp: number;
  payload: Record<string, unknown>;
};

type ObserverInfo = {
  name: string; enabled: boolean; available: boolean;
  last_collection: number | null; events_collected: number;
};

type Tab = 'stream' | 'memory';

// ---------------------------------------------------------------------------
// Persistent memory helpers
// ---------------------------------------------------------------------------

const shownTemplates = new Map<string, { text: string; timestamp: number }>();

function shouldShow(key: string, newText: string): boolean {
  const prev = shownTemplates.get(key);
  if (!prev) return true;
  if (Date.now() - prev.timestamp < 300_000) return false;
  const normalize = (s: string) => s.replace(/\d+/g, '#').toLowerCase();
  return normalize(newText) !== normalize(prev.text);
}

function markShown(key: string, text: string) {
  shownTemplates.set(key, { text, timestamp: Date.now() });
}

async function persistThoughts(thoughts: Thought[]) {
  if (!thoughts.length) return;
  await tauriInvoke('save_thoughts', { thoughts: thoughts.map(t => ({
    id: t.id, text: t.text, category: t.category,
    importance: t.importance, source: t.source, templateKey: t.templateKey,
  })) });
}

async function loadPersistedThoughts(): Promise<Thought[]> {
  const raw = await tauriInvoke<Array<{
    id: string; text: string; category: string; importance: string;
    source: string; templateKey: string; timestamp: number;
  }>>('load_thoughts', { limit: 40 });
  if (!raw?.length) return [];
  return raw.map(t => ({
    id: t.id, text: t.text,
    category: (t.category as Thought['category']) || 'reflection',
    importance: (t.importance as Thought['importance']) || 'ambient',
    timestamp: t.timestamp, isNew: false,
    source: (t.source as Thought['source']) || 'local',
    templateKey: t.templateKey,
  }));
}

async function saveCoreMemory(label: string, value: string) {
  await tauriInvoke('save_core_memory', { label, value });
}

async function loadCoreMemory(): Promise<CoreMemoryBlock[]> {
  return (await tauriInvoke<CoreMemoryBlock[]>('load_core_memory')) ?? [];
}

// ---------------------------------------------------------------------------
// AI Engine — calls Ollama with life-strategist framing
// ---------------------------------------------------------------------------

async function callAI(coreMemory: CoreMemoryBlock[], prevThoughts: Thought[]): Promise<Thought[]> {
  try {
    const obs = await tauriInvoke<RawObservation[]>('get_recent_observations', { limit: 20 });
    if (!obs?.length) return [];

    // Build compact activity summary
    const appStats: Record<string, number> = {};
    const sites: string[] = [];
    for (const o of obs) {
      if (o.event_type === 'app-session') {
        const name = (o.payload.appName as string) || '';
        if (name && name !== 'WindowManager' && name !== 'Finder') {
          appStats[name] = (appStats[name] || 0) + ((o.payload.sessionDurationSeconds as number) || 0);
        }
      }
      if (o.event_type === 'browsing-session') {
        const site = o.payload.domainVisited as string;
        if (site && !sites.includes(site)) sites.push(site);
      }
    }

    const topApps = Object.entries(appStats).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([n, s]) => `${n} ${Math.round(s/60)}min`).join(', ');

    const memCtx = coreMemory.length
      ? coreMemory.map(b => `${b.label}: ${b.value}`).join('\n')
      : '';

    const prevCtx = prevThoughts.slice(0, 4)
      .map(t => `- ${t.text.slice(0, 80)}`).join('\n');

    const h = new Date().getHours();
    const timeOfDay = h < 6 ? 'late night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';

    const prompt = `You are PRE — a brutally honest life strategist with infinite memory. You know this person deeply. Your job is NOT to describe what they're doing. Your job is to surface ideas they've never thought of, blind spots they're missing, and provocative questions that could change something.

WHAT YOU KNOW:
${memCtx || 'Still learning about this person.'}

PREVIOUS THOUGHTS (don't repeat):
${prevCtx || 'none yet'}

RIGHT NOW: ${timeOfDay}, apps: ${topApps || 'no data'}, sites: ${sites.slice(0, 4).join(', ') || 'none'}

RULES:
- Never describe what they're doing. They know what they're doing.
- Instead: what does their behavior MEAN? What are they avoiding? What opportunity are they missing?
- Connect dots they haven't connected: chess + coding + late nights = ?
- Give one surprising, specific idea they could act on TODAY
- Be direct. No fluff. Max 2 sentences per thought.
- If you see chess.com, kick.com, or similar — what does that say about their interests and how could they monetize or level-up that passion?

Reply ONLY with JSON array:
[{"text":"...","category":"idea","importance":"important"}]
Categories: idea, blindspot, question, challenge, insight, prediction
Importance: notable, important`;

    const raw = await tauriInvoke<Array<{ text: string; category?: string; importance?: string }>>('generate_ai_thoughts', { limit: 20, customPrompt: prompt });

    if (!raw?.length) return [];
    return raw.filter(t => t.text).map(t => ({
      id: crypto.randomUUID(),
      text: t.text,
      category: (t.category as Thought['category']) || 'insight',
      importance: (t.importance as Thought['importance']) || 'notable',
      timestamp: Date.now(),
      isNew: true,
      source: 'ai' as const,
      templateKey: `ai-${t.text.slice(0, 50).replace(/\d+/g, '#')}`,
    }));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Idea engine — provocations, not observations
// ---------------------------------------------------------------------------

async function generateIdeas(coreMemory: CoreMemoryBlock[]): Promise<Thought[]> {
  const obs = await tauriInvoke<RawObservation[]>('get_recent_observations', { limit: 100 });
  if (!obs?.length) return [];

  const thoughts: Thought[] = [];
  const now = Date.now();
  const hour = new Date().getHours();
  const dayOfWeek = new Date().getDay();

  // ── Parse observations ──
  const apps = obs.filter(o => o.event_type === 'app-session');
  const browsing = obs.filter(o => o.event_type === 'browsing-session');

  const appStats: Record<string, { totalSec: number; count: number }> = {};
  for (const s of apps) {
    const name = (s.payload.appName as string) || '';
    if (!name || ['WindowManager', 'Finder', 'loginwindow', 'UserNotificationCenter'].includes(name)) continue;
    const secs = (s.payload.sessionDurationSeconds as number) || 0;
    if (!appStats[name]) appStats[name] = { totalSec: 0, count: 0 };
    appStats[name].totalSec += secs;
    appStats[name].count += 1;
  }

  const sorted = Object.entries(appStats).sort((a, b) => b[1].totalSec - a[1].totalSec);
  const totalMins = sorted.reduce((s, [, d]) => s + d.totalSec, 0) / 60;

  const siteVisits: Record<string, number> = {};
  for (const b of browsing) {
    const site = (b.payload.domainVisited as string) || '';
    if (site) siteVisits[site] = (siteVisits[site] || 0) + ((b.payload.visitCount as number) || 1);
  }
  const topSites = Object.entries(siteVisits).sort((a, b) => b[1] - a[1]);

  // ── Classify apps ──
  const devApps = ['Cursor', 'VS Code', 'Code', 'Terminal', 'iTerm2', 'Xcode'];
  const isBuilder = sorted.some(([n]) => devApps.some(d => n.includes(d)));
  const devMins = sorted.filter(([n]) => devApps.some(d => n.includes(d))).reduce((s, [, d]) => s + d.totalSec, 0) / 60;
  const chromeMins = (appStats['Google Chrome']?.totalSec || 0) / 60;
  const claudeMins = (appStats['Claude']?.totalSec || 0) / 60;

  // ─────────────────────────────────────────────────────────────────────────
  // IDEAS — not observations. Provocations. Blind spots. Opportunities.
  // ─────────────────────────────────────────────────────────────────────────

  // Idea: Chrome vs creation imbalance
  if (chromeMins > 30 && devMins < 10) {
    emit(thoughts, 'idea-browser-vs-build',
      `${Math.round(chromeMins)} minutes browsing, ${Math.round(devMins)} building. The internet is a read-only version of the world — you want the write access.`,
      'blindspot', 'important');
  }

  // Idea: Chess.com pattern — competitive intelligence
  if (siteVisits['www.chess.com'] >= 3 || siteVisits['chess.com'] >= 3) {
    emit(thoughts, 'idea-chess-pattern',
      `You keep returning to chess. Chess players who build tools for chess communities have built real businesses — Lichess, Chess Tempo, countless bots. You're already obsessed with the domain.`,
      'idea', 'important');
  }

  // Idea: kick.com — content creation angle
  if (siteVisits['kick.com'] >= 2) {
    emit(thoughts, 'idea-kick-content',
      `You watch on Kick but you're also building software. A developer who streams their build process has a built-in audience — technical people are the most loyal viewers.`,
      'idea', 'notable');
  }

  // Idea: Claude usage — what are you actually using it for?
  if (claudeMins > 10) {
    emit(thoughts, 'idea-claude-leverage',
      `You're spending time with Claude. Most people use it reactively — for one-off answers. The 1% use it to externalise their entire thinking process. Are you in the 1%?`,
      'question', 'notable');
  }

  // Idea: Builder with no shipping signal
  if (isBuilder && devMins > 20) {
    emit(thoughts, 'idea-shipping',
      `You're writing code. The most dangerous phase is when you've been building long enough to have something, but haven't shipped it to a single real user yet. Is that where you are?`,
      'challenge', 'important');
  }

  // Idea: Morning time use
  if (hour >= 6 && hour < 10 && totalMins > 10) {
    emit(thoughts, 'idea-morning-capital',
      `Morning is when your dopamine baseline is highest and your resistance to difficult tasks is lowest. Most people waste it on email. You have 2 hours of premium cognitive time right now.`,
      'idea', 'important');
  }

  // Idea: Weekend leverage
  if ((dayOfWeek === 0 || dayOfWeek === 6) && isBuilder) {
    emit(thoughts, 'idea-weekend-asymmetry',
      `You're building on a weekend. 95% of people are not. This is where leverage comes from — not working harder during the week, but doing something on Saturday that others won't do.`,
      'insight', 'notable');
  }

  // Idea: Switching = unprocessed decisions
  const recent10m = apps.filter(a => now - a.timestamp < 600_000);
  if (recent10m.length > 10) {
    emit(thoughts, 'idea-switching-cost',
      `Rapid context switching is usually a symptom of an unmade decision. What are you avoiding deciding right now?`,
      'question', 'notable');
  }

  // Idea: Deep focus = monetisable skill
  const recent10mSwitches = recent10m.length;
  if (recent10mSwitches <= 3 && totalMins > 20) {
    emit(thoughts, 'idea-focus-rare',
      `You just sustained deep focus for an extended period. That's genuinely rare. The ability to concentrate is becoming one of the most economically valuable skills — protect it like an asset.`,
      'insight', 'notable');
  }

  // Idea: Site obsession = unresolved question
  const fixatedSite = topSites.find(([, v]) => v >= 8);
  if (fixatedSite) {
    const [site] = fixatedSite;
    const clean = site.replace('www.', '');
    emit(thoughts, 'idea-site-fixation',
      `${fixatedSite[1]} visits to ${clean}. Obsessive return-visits usually mean one thing: you have a question you haven't asked out loud yet. What is it?`,
      'blindspot', 'notable');
  }

  // Idea: Late night compound effect
  if (hour >= 23 || hour < 4) {
    emit(thoughts, 'idea-latenight',
      `Every hour past midnight costs you more than it gives — compounding sleep debt reduces your effective IQ by up to 20 points the next day. Your best decisions won't happen tonight.`,
      'challenge', 'important');
  }

  // Idea: The unseen opportunity cost
  if (totalMins > 60 && !isBuilder) {
    emit(thoughts, 'idea-opportunity-cost',
      `An hour a day of deliberate skill-building compounds to 365 hours a year — roughly the equivalent of a university semester. What skill, if you had it, would change everything?`,
      'idea', 'notable');
  }

  // Idea: Research without synthesis
  const uniqueSites = Object.keys(siteVisits).length;
  if (uniqueSites >= 6) {
    emit(thoughts, 'idea-research-synthesis',
      `You've been across ${uniqueSites} sites. Research without capture is just entertainment — you'll remember about 10% of it by tomorrow. Even two sentences of notes would 10x the return.`,
      'nudge', 'notable');
  }

  // Idea: From core memory — identify interests and push further
  const profile = coreMemory.find(b => b.label === 'user_profile')?.value || '';
  if (profile.includes('chess') && isBuilder) {
    emit(thoughts, 'idea-chess-builder',
      `A developer who loves chess and is building software: you're sitting on a specific niche. The world's best chess tools are built by people who are passionate about the game AND technical. That's rare.`,
      'idea', 'important');
  }

  return thoughts;
}

function emit(
  thoughts: Thought[], templateKey: string, text: string,
  category: Thought['category'], importance: Thought['importance'],
) {
  if (!shouldShow(templateKey, text)) return;
  markShown(templateKey, text);
  thoughts.push({
    id: crypto.randomUUID(), text, category, importance,
    timestamp: Date.now(), isNew: true, source: 'local', templateKey,
  });
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function relativeTime(ts: number): string {
  const d = Date.now() - ts, s = Math.floor(d / 1000);
  if (s < 30) return 'just now';
  if (s < 60) return 'moments ago';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const [tab, setTab] = useState<Tab>('stream');
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [pinnedThoughts, setPinnedThoughts] = useState<Thought[]>([]);
  const [coreMemory, setCoreMemory] = useState<CoreMemoryBlock[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [observers, setObservers] = useState<ObserverInfo[]>([]);
  const [observationCount, setObservationCount] = useState(0);
  const [aiStatus, setAiStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [showStatus, setShowStatus] = useState(false);
  const thinkingRef = useRef(false);

  // ── Merge thoughts by template key ──
  const mergeThoughts = useCallback((incoming: Thought[]) => {
    if (!incoming.length) return;
    setThoughts(prev => {
      const byKey = new Map(prev.map(t => [t.templateKey, t]));
      const result = [...prev];
      const newOnes: Thought[] = [];
      for (const t of incoming) {
        const existing = byKey.get(t.templateKey);
        if (existing) {
          const idx = result.indexOf(existing);
          if (idx >= 0) result[idx] = { ...t, isNew: false };
        } else {
          newOnes.push(t);
          byKey.set(t.templateKey, t);
        }
      }
      const important = newOnes.filter(t => t.importance === 'important');
      if (important.length) {
        setPinnedThoughts(pp => {
          const keys = new Set(pp.map(p => p.templateKey));
          return [...important.filter(i => !keys.has(i.templateKey)), ...pp].slice(0, 3);
        });
      }
      return [...newOnes, ...result].slice(0, 50);
    });
  }, []);

  // ── Think cycle ──
  const think = useCallback(async () => {
    if (thinkingRef.current) return;
    thinkingRef.current = true;
    setIsThinking(true);
    try {
      const rawObs = await tauriInvoke<RawObservation[]>('get_recent_observations', { limit: 100 });
      setObservationCount(rawObs?.length ?? 0);
      if (!rawObs?.length) return;

      // Refresh core memory
      const mem = await loadCoreMemory();
      setCoreMemory(mem);

      // Phase 1: Local idea generation (instant)
      const ideas = await generateIdeas(mem);
      mergeThoughts(ideas);
      if (ideas.length) persistThoughts(ideas).catch(() => {});

      // Update user profile in core memory
      const appStats: Record<string, number> = {};
      const sites: string[] = [];
      for (const o of rawObs) {
        if (o.event_type === 'app-session') {
          const n = (o.payload.appName as string) || '';
          if (n && n !== 'WindowManager' && n !== 'Finder' && n !== 'loginwindow') {
            appStats[n] = (appStats[n] || 0) + ((o.payload.sessionDurationSeconds as number) || 0);
          }
        }
        if (o.event_type === 'browsing-session') {
          const s = o.payload.domainVisited as string;
          if (s && !sites.includes(s)) sites.push(s);
        }
      }
      const topApps = Object.entries(appStats).sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([n, s]) => `${n} (${Math.round(s/60)}m)`).join(', ');
      const h = new Date().getHours();
      const profile = [
        topApps && `Apps: ${topApps}`,
        sites.length && `Sites: ${sites.slice(0, 5).join(', ')}`,
        `Active: ${h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'}`,
      ].filter(Boolean).join('. ');
      if (profile) saveCoreMemory('user_profile', profile).catch(() => {});

      // Phase 2: AI (background)
      callAI(mem, thoughts.slice(0, 5)).then(ai => {
        if (ai.length) {
          mergeThoughts(ai);
          persistThoughts(ai).catch(() => {});
        }
      }).catch(() => {}).finally(() => {
        thinkingRef.current = false;
        setIsThinking(false);
      });
    } catch {
      thinkingRef.current = false;
      setIsThinking(false);
    }
  }, [mergeThoughts, thoughts]);

  // ── Setup ──
  useEffect(() => {
    // Check Ollama
    tauriInvoke<{ available: boolean }>('check_ai_status').then(r => setAiStatus(r?.available ? 'online' : 'offline'));

    // Load observers
    tauriInvoke<ObserverInfo[]>('get_observer_status').then(obs => { if (obs) setObservers(obs); });

    // Load core memory
    loadCoreMemory().then(setCoreMemory);

    // Load persisted thoughts from previous sessions
    loadPersistedThoughts().then(persisted => {
      if (persisted.length) {
        setThoughts(persisted);
        for (const t of persisted) shownTemplates.set(t.templateKey, { text: t.text, timestamp: t.timestamp });
        // Pin important ones
        setPinnedThoughts(persisted.filter(t => t.importance === 'important').slice(0, 3));
      }
    });

    // First think
    think();

    const t1 = setTimeout(() => {
      const localInt = setInterval(async () => {
        const mem = await loadCoreMemory();
        setCoreMemory(mem);
        const ideas = await generateIdeas(mem);
        mergeThoughts(ideas);
        if (ideas.length) persistThoughts(ideas).catch(() => {});
        const rawObs = await tauriInvoke<RawObservation[]>('get_recent_observations', { limit: 100 });
        setObservationCount(rawObs?.length ?? 0);
      }, 60_000);

      const aiInt = setInterval(async () => {
        if (thinkingRef.current) return;
        thinkingRef.current = true;
        setIsThinking(true);
        const mem = await loadCoreMemory();
        const ai = await callAI(mem, []);
        if (ai.length) { mergeThoughts(ai); persistThoughts(ai).catch(() => {}); }
        thinkingRef.current = false;
        setIsThinking(false);
      }, 120_000);

      const obsInt = setInterval(async () => {
        const obs = await tauriInvoke<ObserverInfo[]>('get_observer_status');
        if (obs) setObservers(obs);
      }, 15_000);

      return () => { clearInterval(localInt); clearInterval(aiInt); clearInterval(obsInt); };
    }, 3000);

    return () => clearTimeout(t1);
  }, []); // eslint-disable-line

  // Clear new flag
  useEffect(() => {
    if (thoughts.some(t => t.isNew)) {
      const tid = setTimeout(() => setThoughts(p => p.map(t => t.isNew ? { ...t, isNew: false } : t)), 2000);
      return () => clearTimeout(tid);
    }
  }, [thoughts]);

  const totalEvents = observers.reduce((s, o) => s + o.events_collected, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#080808', overflow: 'hidden' }}>

      {/* ── Header ── */}
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ position: 'relative', width: 7, height: 7 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: isThinking ? '#7b9aff' : '#2a2a26', transition: 'background 0.6s' }} />
            {isThinking && <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: '#7b9aff', animation: 'pulse-subtle 1.5s ease-in-out infinite' }} />}
          </div>
          <span style={{ color: '#e8e8e4', fontSize: 12, fontWeight: 600, letterSpacing: '0.15em' }}>PRE</span>
          {isThinking && <span className="fade-in" style={{ color: '#2a2a26', fontSize: 9, letterSpacing: '0.1em' }}>thinking</span>}
        </div>

        <button type="button" onClick={() => setShowStatus(!showStatus)}
          style={{ color: '#2a2a26', fontSize: 9, cursor: 'pointer', background: 'none', border: 'none', padding: '2px 4px', letterSpacing: '0.05em' }}>
          {totalEvents > 0 ? `${totalEvents}` : '···'}
        </button>
      </header>

      {/* ── Status panel ── */}
      {showStatus && (
        <div className="fade-in" style={{ padding: '8px 20px 10px', margin: '8px 0 0', borderTop: '1px solid rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.03)', background: '#0c0c0c' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px' }}>
            <StatusDot label="AI" value={aiStatus === 'online' ? 'llama 3.1' : 'offline'} ok={aiStatus === 'online'} />
            <StatusDot label="buffered" value={String(observationCount)} ok={observationCount > 0} />
            {observers.map(o => (
              <StatusDot key={o.name} label={o.name} value={o.events_collected > 0 ? String(o.events_collected) : o.enabled ? '–' : 'off'} ok={o.enabled && o.events_collected > 0} />
            ))}
          </div>
        </div>
      )}

      {/* ── Tab bar ── */}
      <div style={{ display: 'flex', padding: '10px 20px 0', gap: 20, flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.03)', marginTop: 8 }}>
        {(['stream', 'memory'] as Tab[]).map(t => (
          <button key={t} type="button" onClick={() => setTab(t)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 8px',
              fontSize: 10, letterSpacing: '0.1em',
              color: tab === t ? '#e8e8e4' : '#2a2a26',
              borderBottom: tab === t ? '1px solid #4a4a46' : '1px solid transparent',
              transition: 'color 0.2s',
            }}>
            {t === 'stream' ? 'stream' : 'memory'}
          </button>
        ))}
        {tab === 'stream' && thoughts.length > 0 && (
          <span style={{ marginLeft: 'auto', color: '#1a1a18', fontSize: 9, paddingBottom: 8 }}>
            {thoughts.length} thoughts
          </span>
        )}
      </div>

      {/* ── Pinned (stream tab only) ── */}
      {tab === 'stream' && pinnedThoughts.length > 0 && (
        <div style={{ padding: '8px 20px', flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.03)', background: 'rgba(123,154,255,0.02)' }}>
          {pinnedThoughts.map(t => (
            <div key={t.id} style={{ padding: '3px 0' }}>
              <p style={{ color: '#d4d4d0', fontSize: 12, lineHeight: 1.75, margin: 0, fontStyle: 'italic' }}>{t.text}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Stream tab ── */}
      {tab === 'stream' && (
        <div className="overflow-y-auto" style={{ flex: 1, padding: '4px 20px 40px' }}>
          {thoughts.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12 }}>
              <div className="glow-breathe" style={{ width: 8, height: 8, borderRadius: '50%', background: '#7b9aff' }} />
              <p style={{ color: '#2a2a26', fontSize: 11, textAlign: 'center', lineHeight: 1.9, maxWidth: 220 }}>
                Watching your patterns.<br />Ideas will surface soon.
              </p>
            </div>
          ) : (
            thoughts.map(t => <ThoughtRow key={t.id} thought={t} />)
          )}
        </div>
      )}

      {/* ── Memory tab ── */}
      {tab === 'memory' && (
        <MemoryTab coreMemory={coreMemory} thoughts={thoughts} />
      )}

      {/* ── Footer ── */}
      <footer style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 20px 8px', flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.02)' }}>
        <span style={{ color: '#1a1a18', fontSize: 9 }}>
          {thoughts.filter(t => t.source === 'ai').length > 0 ? `${thoughts.filter(t => t.source === 'ai').length} from ai` : ''}
        </span>
        <button type="button" onClick={() => { if (!thinkingRef.current) think(); }} disabled={isThinking}
          style={{ color: isThinking ? '#1a1a18' : '#2a2a26', fontSize: 9, cursor: isThinking ? 'default' : 'pointer', background: 'none', border: 'none', padding: '2px 6px' }}>
          {isThinking ? 'thinking' : 'think now'}
        </button>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory Tab
// ---------------------------------------------------------------------------

function MemoryTab({ coreMemory, thoughts }: { coreMemory: CoreMemoryBlock[]; thoughts: Thought[] }) {
  const byCategory = thoughts.reduce((acc, t) => {
    const key = t.source === 'ai' ? 'ai insights' : t.category;
    if (!acc[key]) acc[key] = [];
    acc[key].push(t);
    return acc;
  }, {} as Record<string, Thought[]>);

  const LABELS: Record<string, string> = {
    idea: 'Ideas', blindspot: 'Blind Spots', question: 'Open Questions',
    challenge: 'Challenges', insight: 'Insights', prediction: 'Predictions',
    pattern: 'Patterns', nudge: 'Nudges', reflection: 'Reflections',
    'ai insights': 'AI Insights', plan: 'Plans', memory: 'Memory',
  };

  return (
    <div className="overflow-y-auto" style={{ flex: 1, padding: '16px 20px 40px' }}>

      {/* Core Memory Blocks */}
      {coreMemory.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <SectionHeader label="What I know about you" />
          {coreMemory.map(block => (
            <div key={block.label} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 3 }}>
                <span style={{ color: '#4a4a46', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                  {block.label.replace(/_/g, ' ')}
                </span>
                <span style={{ color: '#1a1a18', fontSize: 8 }}>v{block.version} · {relativeTime(block.updatedAt)}</span>
              </div>
              <p style={{ color: '#6a6a66', fontSize: 11.5, lineHeight: 1.75, margin: 0 }}>{block.value}</p>
            </div>
          ))}
        </div>
      )}

      {coreMemory.length === 0 && (
        <div style={{ marginBottom: 28 }}>
          <SectionHeader label="What I know about you" />
          <p style={{ color: '#2a2a26', fontSize: 11 }}>Still building your profile. Keep using PRE.</p>
        </div>
      )}

      {/* Thoughts by category */}
      {Object.entries(byCategory)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([cat, items]) => (
          <div key={cat} style={{ marginBottom: 24 }}>
            <SectionHeader label={LABELS[cat] || cat} count={items.length} />
            {items.slice(0, 8).map(t => (
              <div key={t.id} style={{ marginBottom: 10, paddingLeft: 12, borderLeft: `1px solid ${CAT_ACCENT[t.category] || '#2a2a26'}18` }}>
                <p style={{ color: '#8a8a86', fontSize: 11.5, lineHeight: 1.75, margin: 0 }}>{t.text}</p>
                <span style={{ color: '#1a1a18', fontSize: 8 }}>{formatDate(t.timestamp)}</span>
              </div>
            ))}
          </div>
        ))}

      {thoughts.length === 0 && (
        <p style={{ color: '#2a2a26', fontSize: 11 }}>No thoughts stored yet. Start the stream first.</p>
      )}
    </div>
  );
}

function SectionHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <span style={{ color: '#2a2a26', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase' }}>{label}</span>
      {count !== undefined && <span style={{ color: '#1a1a18', fontSize: 9 }}>{count}</span>}
      <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.03)' }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ThoughtRow
// ---------------------------------------------------------------------------

const CAT_ACCENT: Record<string, string> = {
  idea: '#7b9aff',
  blindspot: '#f87171',
  question: '#fbbf24',
  challenge: '#fb923c',
  insight: '#a78bfa',
  prediction: '#34d399',
  pattern: '#818cf8',
  nudge: '#f472b6',
  reflection: '#5a5a56',
  plan: '#38bdf8',
  memory: '#94a3b8',
};

const CAT_LABEL: Record<string, string> = {
  idea: 'idea', blindspot: 'blind spot', question: 'question',
  challenge: 'challenge', insight: 'insight', prediction: 'prediction',
  pattern: 'pattern', nudge: 'nudge', reflection: 'reflection',
  plan: 'plan', memory: 'memory',
};

function ThoughtRow({ thought }: { thought: Thought }) {
  const accent = CAT_ACCENT[thought.category] || '#5a5a56';
  const notable = thought.importance !== 'ambient';

  return (
    <div className={thought.isNew ? 'thought-enter' : ''} style={{ padding: '11px 0 11px 14px', borderLeft: `1.5px solid ${notable ? accent + '22' : 'transparent'}`, marginBottom: 1 }}>
      <p style={{ color: notable ? '#c0c0bc' : '#6a6a66', fontSize: 12.5, lineHeight: 1.85, fontWeight: notable ? 400 : 300, margin: 0, letterSpacing: '-0.01em' }}>
        {thought.text}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
        <span style={{ color: '#1a1a18', fontSize: 8 }}>{relativeTime(thought.timestamp)}</span>
        <span style={{ color: `${accent}28`, fontSize: 8, letterSpacing: '0.06em' }}>{CAT_LABEL[thought.category] || thought.category}</span>
        {thought.source === 'ai' && <span style={{ color: '#7b9aff16', fontSize: 8 }}>ai</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusDot
// ---------------------------------------------------------------------------

function StatusDot({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
      <div style={{ width: 4, height: 4, borderRadius: '50%', flexShrink: 0, background: ok ? '#4ade8040' : '#1a1a18' }} />
      <span style={{ color: '#2a2a26', fontSize: 9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ color: '#1a1a18', fontSize: 9, marginLeft: 'auto', flexShrink: 0 }}>{value}</span>
    </div>
  );
}
