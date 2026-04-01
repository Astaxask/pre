import { useCallback, useEffect, useRef, useState } from 'react';
import { InspirationTab } from './InspirationTab';

// ---------------------------------------------------------------------------
// Tauri interop
// ---------------------------------------------------------------------------

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
async function getInvoke() {
  if (_invoke) return _invoke;
  try { const m = await import('@tauri-apps/api/core'); _invoke = m.invoke; return _invoke; }
  catch { _invoke = async () => []; return _invoke!; }
}
async function inv<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try { return (await (await getInvoke())(cmd, args)) as T; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Category =
  | 'idea' | 'blindspot' | 'question' | 'challenge'
  | 'insight' | 'prediction' | 'pattern' | 'nudge'
  | 'reflection' | 'plan' | 'memory';

type Thought = {
  id: string;
  text: string;
  category: Category;
  importance: 'ambient' | 'notable' | 'important';
  timestamp: number;
  isNew?: boolean;
  source: 'ai' | 'local';
  templateKey: string;
};

type CoreMemoryBlock = { label: string; value: string; updatedAt: number; version: number };
type RawObs = { id: string; event_type: string; timestamp: number; payload: Record<string, unknown>; };
type ObserverInfo = { name: string; enabled: boolean; available: boolean; last_collection: number | null; events_collected: number; };
type Tab = 'stream' | 'memory' | 'you';

// ---------------------------------------------------------------------------
// Category metadata — vivid, clearly differentiated
// ---------------------------------------------------------------------------

const CAT: Record<Category, { label: string; color: string; bg: string }> = {
  idea:       { label: 'idea',       color: '#7c9fff', bg: 'rgba(124,159,255,0.13)' },
  blindspot:  { label: 'blind spot', color: '#ff6b6b', bg: 'rgba(255,107,107,0.13)' },
  question:   { label: 'question',   color: '#ffd93d', bg: 'rgba(255,217,61,0.13)'  },
  challenge:  { label: 'challenge',  color: '#ff9f43', bg: 'rgba(255,159,67,0.13)'  },
  insight:    { label: 'insight',    color: '#c084fc', bg: 'rgba(192,132,252,0.13)' },
  prediction: { label: 'prediction', color: '#4ade80', bg: 'rgba(74,222,128,0.13)'  },
  pattern:    { label: 'pattern',    color: '#a78bfa', bg: 'rgba(167,139,250,0.13)' },
  nudge:      { label: 'nudge',      color: '#f472b6', bg: 'rgba(244,114,182,0.13)' },
  reflection: { label: 'reflection', color: '#94a3b8', bg: 'rgba(148,163,184,0.11)' },
  plan:       { label: 'plan',       color: '#38bdf8', bg: 'rgba(56,189,248,0.13)'  },
  memory:     { label: 'memory',     color: '#e2e8f0', bg: 'rgba(226,232,240,0.08)' },
};

// ---------------------------------------------------------------------------
// Memory helpers
// ---------------------------------------------------------------------------

const seenKeys = new Map<string, { text: string; ts: number }>();

function canShow(key: string, text: string): boolean {
  const p = seenKeys.get(key);
  if (!p) return true;
  if (Date.now() - p.ts < 300_000) return false;
  const n = (s: string) => s.replace(/\d+/g, '#').toLowerCase().slice(0, 60);
  return n(text) !== n(p.text);
}
function markSeen(key: string, text: string) { seenKeys.set(key, { text, ts: Date.now() }); }

async function persistThoughts(ts: Thought[]) {
  if (!ts.length) return;
  await inv('save_thoughts', { thoughts: ts.map(t => ({ id: t.id, text: t.text, category: t.category, importance: t.importance, source: t.source, templateKey: t.templateKey })) });
}
async function loadSaved(): Promise<Thought[]> {
  const raw = await inv<Array<{ id: string; text: string; category: string; importance: string; source: string; templateKey: string; timestamp: number; }>>('load_thoughts', { limit: 40 });
  if (!raw?.length) return [];
  return raw.map(t => ({ id: t.id, text: t.text, category: (t.category as Category) || 'reflection', importance: (t.importance as Thought['importance']) || 'ambient', timestamp: t.timestamp, isNew: false, source: (t.source as Thought['source']) || 'local', templateKey: t.templateKey }));
}
async function loadMemory(): Promise<CoreMemoryBlock[]> { return (await inv<CoreMemoryBlock[]>('load_core_memory')) ?? []; }
async function saveMemory(label: string, value: string) { await inv('save_core_memory', { label, value }); }

// ---------------------------------------------------------------------------
// AI call
// ---------------------------------------------------------------------------

async function callAI(memory: CoreMemoryBlock[], prev: Thought[]): Promise<Thought[]> {
  const obs = await inv<RawObs[]>('get_recent_observations', { limit: 20 });
  if (!obs?.length) return [];

  const appStats: Record<string, number> = {};
  const sites: string[] = [];
  for (const o of obs) {
    if (o.event_type === 'app-session') {
      const n = (o.payload.appName as string) || '';
      if (n && !['WindowManager', 'Finder', 'loginwindow', 'UserNotificationCenter'].includes(n))
        appStats[n] = (appStats[n] || 0) + ((o.payload.sessionDurationSeconds as number) || 0);
    }
    if (o.event_type === 'browsing-session') {
      const s = o.payload.domainVisited as string;
      if (s && !sites.includes(s)) sites.push(s);
    }
  }
  const topApps = Object.entries(appStats).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, s]) => `${n} ${Math.round(s / 60)}m`).join(', ');
  const memCtx = memory.map(b => `${b.label}: ${b.value}`).join('\n');
  const prevCtx = prev.slice(0, 3).map(t => `- ${t.text.slice(0, 70)}`).join('\n');
  const h = new Date().getHours();
  const tod = h < 6 ? 'late night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';

  const prompt = `You are PRE — a brutally honest life strategist with full memory of this person.

WHAT YOU KNOW:
${memCtx || 'Still learning.'}

PREVIOUS THOUGHTS (don't repeat these):
${prevCtx || 'none'}

RIGHT NOW: ${tod}, apps: ${topApps || 'none'}, sites: ${sites.slice(0, 4).join(', ') || 'none'}

Your job: surface ideas they have NEVER thought of. Not "you're using Chrome" — what does their behavior MEAN? What are they avoiding? What leverage are they missing? What can they do TODAY that most people won't?

Be specific, direct, max 2 sentences per thought. If you see chess/kick/streaming — find the opportunity. If they're building — challenge them to ship.

Reply ONLY with valid JSON array, no markdown fences:
[{"text":"...","category":"idea","importance":"important"}]
Valid categories: idea, blindspot, question, challenge, insight, prediction
Valid importance: notable, important`;

  const raw = await inv<Array<{ text: string; category?: string; importance?: string }>>('generate_ai_thoughts', { limit: 20, customPrompt: prompt });
  return (raw ?? []).filter(t => t.text).map(t => ({
    id: crypto.randomUUID(), text: t.text,
    category: (t.category as Category) || 'insight',
    importance: (t.importance as Thought['importance']) || 'notable',
    timestamp: Date.now(), isNew: true, source: 'ai' as const,
    templateKey: `ai-${t.text.slice(0, 50).replace(/\d+/g, '#')}`,
  }));
}

// ---------------------------------------------------------------------------
// Local idea engine
// ---------------------------------------------------------------------------

async function generateIdeas(memory: CoreMemoryBlock[]): Promise<Thought[]> {
  const obs = await inv<RawObs[]>('get_recent_observations', { limit: 100 });
  if (!obs?.length) return [];

  const thoughts: Thought[] = [];
  const now = Date.now();
  const hour = new Date().getHours();
  const dow = new Date().getDay();

  const apps = obs.filter(o => o.event_type === 'app-session');
  const browsing = obs.filter(o => o.event_type === 'browsing-session');

  const appStats: Record<string, { sec: number; count: number }> = {};
  for (const s of apps) {
    const n = (s.payload.appName as string) || '';
    if (!n || ['WindowManager', 'Finder', 'loginwindow', 'UserNotificationCenter'].includes(n)) continue;
    const sec = (s.payload.sessionDurationSeconds as number) || 0;
    if (!appStats[n]) appStats[n] = { sec: 0, count: 0 };
    appStats[n].sec += sec; appStats[n].count++;
  }

  const sorted = Object.entries(appStats).sort((a, b) => b[1].sec - a[1].sec);
  const totalMins = sorted.reduce((s, [, d]) => s + d.sec, 0) / 60;
  const devApps = ['Cursor', 'VS Code', 'Code', 'Terminal', 'iTerm2', 'Xcode'];
  const isBuilder = sorted.some(([n]) => devApps.some(d => n.includes(d)));
  const devMins = sorted.filter(([n]) => devApps.some(d => n.includes(d))).reduce((s, [, d]) => s + d.sec, 0) / 60;
  const chromeMins = (appStats['Google Chrome']?.sec || 0) / 60;
  const claudeMins = (appStats['Claude']?.sec || 0) / 60;

  const siteV: Record<string, number> = {};
  for (const b of browsing) {
    const s = (b.payload.domainVisited as string) || '';
    if (s) siteV[s] = (siteV[s] || 0) + ((b.payload.visitCount as number) || 1);
  }
  const topSites = Object.entries(siteV).sort((a, b) => b[1] - a[1]);
  const profile = memory.find(b => b.label === 'user_profile')?.value || '';

  // ── Ideas ──
  if (chromeMins > 30 && devMins < 10)
    push(thoughts, 'consume-create', `${Math.round(chromeMins)}m browsing, ${Math.round(devMins)}m building. The internet is a read-only view of the world. You want write access.`, 'blindspot', 'important');

  if (siteV['www.chess.com'] >= 3 || siteV['chess.com'] >= 3)
    push(thoughts, 'chess-opp', `You keep coming back to chess. People who are obsessed with a domain AND technical are exactly who builds the tools that domain relies on — Lichess, Chess Tempo. You're already positioned.`, 'idea', 'important');

  if (siteV['kick.com'] >= 2 || siteV['www.kick.com'] >= 2)
    push(thoughts, 'kick-angle', `You watch builders on Kick. A developer who streams their own build process already has the hardest part solved — authenticity. The audience is there for people who actually ship.`, 'idea', 'notable');

  if (claudeMins > 10)
    push(thoughts, 'claude-depth', `You use Claude but most people treat it like Google — one question, move on. The real leverage is as a thinking partner that holds your context across an entire problem. Are you doing that?`, 'question', 'notable');

  if (isBuilder && devMins > 20)
    push(thoughts, 'ship-signal', `You're writing code. The most dangerous phase is having something real but not yet in front of real users. Every day in stealth is a day without signal.`, 'challenge', 'important');

  if (hour >= 6 && hour < 10 && totalMins > 5)
    push(thoughts, 'morning-window', `You have the highest cognitive bandwidth of your day right now. Protect the next 2 hours like they're your scarcest resource — because they are.`, 'idea', 'important');

  if ((dow === 0 || dow === 6) && isBuilder)
    push(thoughts, 'weekend-edge', `Building on a weekend puts you in a category most people aren't in. That asymmetry is the actual moat — not the code.`, 'insight', 'notable');

  const recent = apps.filter(a => now - a.timestamp < 600_000);
  if (recent.length > 10)
    push(thoughts, 'scattered', `${recent.length} context switches in 10 minutes. Rapid switching is almost always a symptom of an unmade decision. What are you circling around?`, 'question', 'notable');
  else if (recent.length <= 3 && totalMins > 20)
    push(thoughts, 'rare-focus', `You've been in deep focus for a while. The ability to sustain concentration is genuinely becoming rare and economically valuable. Treat it like a compounding asset.`, 'insight', 'notable');

  const fixated = topSites.find(([, v]) => v >= 8);
  if (fixated)
    push(thoughts, 'fixation', `${fixated[1]} visits to ${fixated[0].replace('www.', '')} today. Obsessive return-visits usually mean one thing: a question you haven't articulated yet. What is it?`, 'blindspot', 'notable');

  if (hour >= 23 || hour < 4)
    push(thoughts, 'late-cost', `Every hour past midnight compounds into tomorrow's deficit. Sleep deprivation reduces effective reasoning by ~20%. Your best decisions aren't happening tonight.`, 'challenge', 'important');

  if (totalMins > 60 && !isBuilder)
    push(thoughts, 'skill-compound', `One focused hour per day compounds to a full university semester of skill in a year. What would change everything if you had it?`, 'idea', 'notable');

  if (Object.keys(siteV).length >= 6)
    push(thoughts, 'research-capture', `${Object.keys(siteV).length} sites browsed. Without capture, you'll retain about 10% by tomorrow. Two sentences of notes would 10x that.`, 'nudge', 'notable');

  if (profile.includes('chess') && isBuilder)
    push(thoughts, 'chess-builder', `Chess obsession + software skills is a rare combination. The best tools in any domain are built by people who are both passionate users AND technical. That's you.`, 'idea', 'important');

  return thoughts;
}

function push(arr: Thought[], key: string, text: string, cat: Category, imp: Thought['importance']) {
  if (!canShow(key, text)) return;
  markSeen(key, text);
  arr.push({ id: crypto.randomUUID(), text, category: cat, importance: imp, timestamp: Date.now(), isNew: true, source: 'local', templateKey: key });
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function ago(ts: number): string {
  const d = Date.now() - ts, s = Math.floor(d / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}
function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const [tab, setTab]           = useState<Tab>('stream');
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [pinned, setPinned]     = useState<Thought[]>([]);
  const [memory, setMemory]     = useState<CoreMemoryBlock[]>([]);
  const [thinking, setThinking] = useState(false);
  const [observers, setObservers] = useState<ObserverInfo[]>([]);
  const [obsCount, setObsCount] = useState(0);
  const [aiOk, setAiOk]         = useState<boolean | null>(null);
  const [showStatus, setShowStatus] = useState(false);
  const [rawObs, setRawObs]         = useState<RawObs[]>([]);
  const thinkingRef = useRef(false);

  const merge = useCallback((incoming: Thought[]) => {
    if (!incoming.length) return;
    setThoughts(prev => {
      const byKey = new Map(prev.map(t => [t.templateKey, t]));
      const result = [...prev];
      const fresh: Thought[] = [];
      for (const t of incoming) {
        const ex = byKey.get(t.templateKey);
        if (ex) { const i = result.indexOf(ex); if (i >= 0) result[i] = { ...t, isNew: false }; }
        else { fresh.push(t); byKey.set(t.templateKey, t); }
      }
      const imp = fresh.filter(t => t.importance === 'important');
      if (imp.length) setPinned(pp => {
        const keys = new Set(pp.map(p => p.templateKey));
        return [...imp.filter(i => !keys.has(i.templateKey)), ...pp].slice(0, 3);
      });
      return [...fresh, ...result].slice(0, 50);
    });
  }, []);

  const think = useCallback(async () => {
    if (thinkingRef.current) return;
    thinkingRef.current = true; setThinking(true);
    try {
      const rawObs = await inv<RawObs[]>('get_recent_observations', { limit: 100 });
      setObsCount(rawObs?.length ?? 0);
      setRawObs(rawObs ?? []);
      if (!rawObs?.length) return;

      const mem = await loadMemory(); setMemory(mem);
      const ideas = await generateIdeas(mem);
      merge(ideas);
      if (ideas.length) persistThoughts(ideas).catch(() => {});

      // Update user profile
      const appS: Record<string, number> = {}; const sites: string[] = [];
      for (const o of rawObs) {
        if (o.event_type === 'app-session') {
          const n = (o.payload.appName as string) || '';
          if (n && !['WindowManager', 'Finder', 'loginwindow'].includes(n))
            appS[n] = (appS[n] || 0) + ((o.payload.sessionDurationSeconds as number) || 0);
        }
        if (o.event_type === 'browsing-session') {
          const s = o.payload.domainVisited as string;
          if (s && !sites.includes(s)) sites.push(s);
        }
      }
      const topApps = Object.entries(appS).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, s]) => `${n} (${Math.round(s / 60)}m)`).join(', ');
      const h = new Date().getHours();
      const profile = [topApps && `Apps: ${topApps}`, sites.length && `Sites: ${sites.slice(0, 5).join(', ')}`, `Active: ${h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'}`].filter(Boolean).join('. ');
      if (profile) saveMemory('user_profile', profile).catch(() => {});

      callAI(mem, thoughts.slice(0, 5)).then(ai => {
        if (ai.length) { merge(ai); persistThoughts(ai).catch(() => {}); }
      }).catch(() => {}).finally(() => { thinkingRef.current = false; setThinking(false); });
    } catch { thinkingRef.current = false; setThinking(false); }
  }, [merge, thoughts]);

  useEffect(() => {
    inv<{ available: boolean }>('check_ai_status').then(r => setAiOk(r?.available ?? false));
    inv<ObserverInfo[]>('get_observer_status').then(obs => { if (obs) setObservers(obs); });
    loadMemory().then(setMemory);
    loadSaved().then(saved => {
      if (saved.length) {
        setThoughts(saved);
        for (const t of saved) seenKeys.set(t.templateKey, { text: t.text, ts: t.timestamp });
        setPinned(saved.filter(t => t.importance === 'important').slice(0, 3));
      }
    });
    think();

    const tid = setTimeout(() => {
      const i1 = setInterval(async () => {
        const mem = await loadMemory(); setMemory(mem);
        const ideas = await generateIdeas(mem); merge(ideas);
        if (ideas.length) persistThoughts(ideas).catch(() => {});
        const r = await inv<RawObs[]>('get_recent_observations', { limit: 100 }); setObsCount(r?.length ?? 0);
      }, 60_000);
      const i2 = setInterval(async () => {
        if (thinkingRef.current) return;
        thinkingRef.current = true; setThinking(true);
        const mem = await loadMemory();
        const ai = await callAI(mem, []);
        if (ai.length) { merge(ai); persistThoughts(ai).catch(() => {}); }
        thinkingRef.current = false; setThinking(false);
      }, 120_000);
      const i3 = setInterval(async () => {
        const obs = await inv<ObserverInfo[]>('get_observer_status'); if (obs) setObservers(obs);
      }, 15_000);
      return () => { clearInterval(i1); clearInterval(i2); clearInterval(i3); };
    }, 3000);
    return () => clearTimeout(tid);
  }, []); // eslint-disable-line

  useEffect(() => {
    if (!thoughts.some(t => t.isNew)) return;
    const tid = setTimeout(() => setThoughts(p => p.map(t => t.isNew ? { ...t, isNew: false } : t)), 1800);
    return () => clearTimeout(tid);
  }, [thoughts]);

  const totalEvents = observers.reduce((s, o) => s + o.events_collected, 0);
  const activeObs = observers.filter(o => o.enabled);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f0f10', color: '#f2f2f0', overflow: 'hidden', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}>

      {/* ── Header ── */}
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ position: 'relative', width: 8, height: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: thinking ? '#7c9fff' : thoughts.length > 0 ? '#4ade80' : '#333330', transition: 'background 0.5s' }} />
            {thinking && <div className="pulse-dot" style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: '#7c9fff' }} />}
          </div>
          <span style={{ color: '#f2f2f0', fontSize: 12, fontWeight: 700, letterSpacing: '0.18em' }}>PRE</span>
          {thinking && <span className="fade-in" style={{ color: '#585854', fontSize: 10 }}>thinking…</span>}
        </div>
        <button type="button" onClick={() => setShowStatus(!showStatus)} style={{ background: showStatus ? '#1c1c1f' : 'none', border: showStatus ? '1px solid rgba(255,255,255,0.07)' : 'none', borderRadius: 6, padding: '3px 8px', color: '#585854', fontSize: 10, cursor: 'pointer' }}>
          {totalEvents > 0 ? `${totalEvents} signals` : '···'}
        </button>
      </header>

      {/* ── Status panel ── */}
      {showStatus && (
        <div className="fade-in" style={{ margin: '8px 18px 0', borderRadius: 10, background: '#161618', border: '1px solid rgba(255,255,255,0.07)', padding: '10px 14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 12px' }}>
            <StatusRow label="AI Engine" value={aiOk === true ? 'llama 3.1 8b' : aiOk === false ? 'offline' : '…'} ok={aiOk === true} />
            <StatusRow label="Buffered" value={`${obsCount} obs`} ok={obsCount > 0} />
            <StatusRow label="Observers" value={`${activeObs.length} active`} ok={activeObs.length > 0} />
            {observers.map(o => (
              <StatusRow key={o.name} label={o.name} value={o.events_collected > 0 ? String(o.events_collected) : o.enabled ? '–' : 'off'} ok={o.enabled && o.events_collected > 0} />
            ))}
          </div>
        </div>
      )}

      {/* ── Tab bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', margin: '12px 18px 0', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        {(['stream', 'memory', 'you'] as Tab[]).map(t => (
          <button key={t} type="button" onClick={() => setTab(t)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 16px 9px', fontSize: 11, fontWeight: tab === t ? 600 : 400, color: tab === t ? '#f2f2f0' : '#585854', borderBottom: tab === t ? '2px solid #7c9fff' : '2px solid transparent', marginBottom: -1, transition: 'color 0.15s', letterSpacing: '0.05em' }}>
            {t}
          </button>
        ))}
        {tab === 'stream' && thoughts.length > 0 && (
          <span style={{ marginLeft: 'auto', color: '#333330', fontSize: 10, paddingBottom: 8 }}>{thoughts.length}</span>
        )}
      </div>

      {/* ── Pinned (stream only) ── */}
      {tab === 'stream' && pinned.length > 0 && (
        <div style={{ margin: '10px 18px 0', borderRadius: 10, background: 'rgba(124,159,255,0.06)', border: '1px solid rgba(124,159,255,0.18)', padding: '10px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#7c9fff' }} />
            <span style={{ color: '#7c9fff', fontSize: 9, fontWeight: 700, letterSpacing: '0.14em' }}>PINNED</span>
          </div>
          {pinned.map(t => <p key={t.id} style={{ color: '#a0a09c', fontSize: 12.5, lineHeight: 1.7, margin: '0 0 4px', fontStyle: 'italic' }}>{t.text}</p>)}
        </div>
      )}

      {/* ── Stream ── */}
      {tab === 'stream' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 18px 40px' }}>
          {thoughts.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16 }}>
              <div className="breathe" style={{ width: 10, height: 10, borderRadius: '50%', background: '#7c9fff' }} />
              <div style={{ textAlign: 'center' }}>
                <p style={{ color: '#a0a09c', fontSize: 13, margin: '0 0 6px' }}>Watching your patterns.</p>
                <p style={{ color: '#585854', fontSize: 11, margin: 0 }}>Ideas will surface as I learn what you do.</p>
              </div>
            </div>
          ) : (
            thoughts.map(t => <ThoughtCard key={t.id} thought={t} />)
          )}
        </div>
      )}

      {/* ── Memory ── */}
      {tab === 'memory' && <MemoryTab memory={memory} thoughts={thoughts} />}

      {/* ── You (Inspiration) ── */}
      {tab === 'you' && <InspirationTab obs={rawObs} memory={memory} />}

      {/* ── Footer ── */}
      <footer style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 18px 10px', flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <span style={{ color: '#333330', fontSize: 10 }}>
          {thoughts.filter(t => t.source === 'ai').length > 0
            ? `${thoughts.filter(t => t.source === 'ai').length} ai · ${thoughts.filter(t => t.source === 'local').length} local`
            : thoughts.length > 0 ? `${thoughts.length} thoughts` : ''}
        </span>
        <button type="button" onClick={() => { if (!thinkingRef.current) think(); }} disabled={thinking}
          style={{ background: thinking ? 'none' : '#161618', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 6, padding: '4px 12px', color: thinking ? '#333330' : '#a0a09c', fontSize: 10, cursor: thinking ? 'default' : 'pointer', transition: 'all 0.15s' }}>
          {thinking ? 'thinking…' : 'think now'}
        </button>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ThoughtCard
// ---------------------------------------------------------------------------

function ThoughtCard({ thought }: { thought: Thought }) {
  const cat = CAT[thought.category] || CAT.reflection;
  const notable = thought.importance !== 'ambient';

  return (
    <div className={thought.isNew ? 'thought-enter' : ''} style={{
      padding: '13px 15px', margin: '5px 0', borderRadius: 12,
      background: notable ? '#161618' : 'transparent',
      border: notable ? '1px solid rgba(255,255,255,0.07)' : '1px solid transparent',
      transition: 'background 0.2s',
    }}>
      {/* Category chip */}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginBottom: 8, background: cat.bg, borderRadius: 100, padding: '3px 9px' }}>
        <div style={{ width: 5, height: 5, borderRadius: '50%', background: cat.color, flexShrink: 0 }} />
        <span style={{ color: cat.color, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{cat.label}</span>
      </div>

      {/* Text — full contrast for notable, dimmed for ambient */}
      <p style={{ color: notable ? '#f2f2f0' : '#a0a09c', fontSize: 13, lineHeight: 1.8, margin: '0 0 9px', fontWeight: notable ? 400 : 350 }}>
        {thought.text}
      </p>

      {/* Meta */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: '#585854', fontSize: 10 }}>{ago(thought.timestamp)}</span>
        {thought.source === 'ai' && (
          <span style={{ color: '#7c9fff', fontSize: 9, fontWeight: 600, background: 'rgba(124,159,255,0.1)', borderRadius: 100, padding: '1px 7px', letterSpacing: '0.06em' }}>AI</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MemoryTab
// ---------------------------------------------------------------------------

function MemoryTab({ memory, thoughts }: { memory: CoreMemoryBlock[]; thoughts: Thought[] }) {
  const groups = thoughts.reduce((acc, t) => {
    const k = t.source === 'ai' ? 'ai' : t.category;
    if (!acc[k]) acc[k] = [];
    acc[k].push(t);
    return acc;
  }, {} as Record<string, Thought[]>);

  const LABELS: Record<string, string> = { idea: 'Ideas', blindspot: 'Blind Spots', question: 'Open Questions', challenge: 'Challenges', insight: 'Insights', prediction: 'Predictions', pattern: 'Patterns', nudge: 'Nudges', reflection: 'Reflections', ai: 'AI Insights', plan: 'Plans', memory: 'Memory' };

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px 40px' }}>
      {/* Core memory */}
      <div style={{ marginBottom: 28 }}>
        <SectionLabel text="What I know about you" />
        {memory.length === 0
          ? <p style={{ color: '#585854', fontSize: 12, margin: 0 }}>Still building your profile. Keep using PRE.</p>
          : memory.map(b => (
            <div key={b.label} style={{ marginBottom: 12, padding: '12px 14px', borderRadius: 10, background: '#161618', border: '1px solid rgba(255,255,255,0.07)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ color: '#a0a09c', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{b.label.replace(/_/g, ' ')}</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <span style={{ color: '#585854', fontSize: 10 }}>v{b.version}</span>
                  <span style={{ color: '#585854', fontSize: 10 }}>{ago(b.updatedAt)}</span>
                </div>
              </div>
              <p style={{ color: '#a0a09c', fontSize: 12.5, lineHeight: 1.75, margin: 0 }}>{b.value}</p>
            </div>
          ))}
      </div>

      {/* Thought groups */}
      {Object.entries(groups).sort((a, b) => b[1].length - a[1].length).map(([key, items]) => {
        const c = key === 'ai' ? null : CAT[key as Category];
        return (
          <div key={key} style={{ marginBottom: 24 }}>
            <SectionLabel text={LABELS[key] || key} count={items.length} color={c?.color} />
            {items.slice(0, 6).map(t => (
              <div key={t.id} style={{ marginBottom: 8, padding: '10px 13px', borderRadius: 9, background: '#161618', border: '1px solid rgba(255,255,255,0.06)' }}>
                {c && (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 5, background: c.bg, borderRadius: 100, padding: '2px 8px' }}>
                    <div style={{ width: 4, height: 4, borderRadius: '50%', background: c.color }} />
                    <span style={{ color: c.color, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{c.label}</span>
                  </div>
                )}
                <p style={{ color: '#a0a09c', fontSize: 12.5, lineHeight: 1.7, margin: '0 0 5px' }}>{t.text}</p>
                <span style={{ color: '#585854', fontSize: 10 }}>{fmtDate(t.timestamp)}</span>
              </div>
            ))}
          </div>
        );
      })}

      {thoughts.length === 0 && <p style={{ color: '#585854', fontSize: 12 }}>No thoughts stored yet. Open the stream tab first.</p>}
    </div>
  );
}

function SectionLabel({ text, count, color }: { text: string; count?: number; color?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      {color && <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />}
      <span style={{ color: '#a0a09c', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>{text}</span>
      {count !== undefined && <span style={{ color: '#585854', fontSize: 10 }}>{count}</span>}
      <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.05)' }} />
    </div>
  );
}

function StatusRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
      <div style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, background: ok ? '#4ade80' : '#333330' }} />
      <span style={{ color: '#a0a09c', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ color: ok ? '#4ade80' : '#585854', fontSize: 10, marginLeft: 'auto', flexShrink: 0 }}>{value}</span>
    </div>
  );
}
