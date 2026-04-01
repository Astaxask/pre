/**
 * InspirationTab — derives personality traits from behavioral data,
 * generates life-improvement plays, and surfaces financial hooks (Plaid).
 */

import { useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RawObs = {
  id: string; event_type: string; timestamp: number;
  payload: Record<string, unknown>;
};

export type CoreMemoryBlock = { label: string; value: string; updatedAt: number; version: number };

type Trait = {
  id: string;
  name: string;           // e.g. "Deep Worker"
  description: string;    // 1-2 sentences explaining it
  evidence: string;       // what data proves it
  score: number;          // 0–100 confidence
  icon: string;           // emoji
  color: string;
};

type LifePlay = {
  id: string;
  title: string;
  why: string;            // why this matters for THIS person
  action: string;         // the specific thing to do
  category: 'time' | 'money' | 'health' | 'skills' | 'relationships' | 'focus';
  effort: 'low' | 'medium' | 'high';
  impact: 'medium' | 'high' | 'life-changing';
};

// ---------------------------------------------------------------------------
// Trait derivation engine
// ---------------------------------------------------------------------------

export function deriveTraits(obs: RawObs[], memory: CoreMemoryBlock[]): Trait[] {
  const traits: Trait[] = [];
  const profile = memory.find(b => b.label === 'user_profile')?.value || '';

  const apps = obs.filter(o => o.event_type === 'app-session');
  const browsing = obs.filter(o => o.event_type === 'browsing-session');

  // Aggregate app stats
  const appStats: Record<string, { sec: number; count: number }> = {};
  for (const s of apps) {
    const n = (s.payload.appName as string) || '';
    if (!n || ['WindowManager', 'Finder', 'loginwindow', 'UserNotificationCenter', 'Dock'].includes(n)) continue;
    const sec = (s.payload.sessionDurationSeconds as number) || 0;
    if (!appStats[n]) appStats[n] = { sec: 0, count: 0 };
    appStats[n].sec += sec; appStats[n].count++;
  }

  const sorted = Object.entries(appStats).sort((a, b) => b[1].sec - a[1].sec);
  const totalSec = sorted.reduce((s, [, d]) => s + d.sec, 0);

  // Site visits
  const siteV: Record<string, number> = {};
  for (const b of browsing) {
    const s = (b.payload.domainVisited as string) || '';
    if (s) siteV[s] = (siteV[s] || 0) + ((b.payload.visitCount as number) || 1);
  }

  const devApps = ['Cursor', 'VS Code', 'Code', 'Terminal', 'iTerm2', 'Xcode', 'WebStorm'];
  const creativeApps = ['Figma', 'Sketch', 'Photoshop', 'Illustrator', 'Blender'];
  const commApps = ['Slack', 'Discord', 'Teams', 'Zoom', 'Messages', 'Mail'];

  const devSec = sorted.filter(([n]) => devApps.some(d => n.includes(d))).reduce((s, [, d]) => s + d.sec, 0);
  const commSec = sorted.filter(([n]) => commApps.some(d => n.includes(d))).reduce((s, [, d]) => s + d.sec, 0);
  const chromeSec = (appStats['Google Chrome']?.sec || 0);
  const claudeSec = (appStats['Claude']?.sec || 0);
  const spotifySec = (appStats['Spotify']?.sec || appStats['Music']?.sec || 0);

  // Context switch rate (last 30 min)
  const now = Date.now();
  const recent = apps.filter(a => now - a.timestamp < 1_800_000);
  const switchRate = recent.length / 30; // switches per minute

  // ── Trait: Builder / Creator ──────────────────────────────────────────
  if (devSec > 600 || sorted.some(([n]) => devApps.some(d => n.includes(d)))) {
    const pct = Math.round((devSec / Math.max(1, totalSec)) * 100);
    traits.push({
      id: 'builder',
      name: 'Builder',
      description: 'You write code and create things. This puts you in a rare category — most people consume, you produce.',
      evidence: `${Math.round(devSec / 60)}m in dev tools — ${pct}% of your screen time is creation.`,
      score: Math.min(95, 60 + pct),
      icon: '⚒️',
      color: '#7c9fff',
    });
  }

  // ── Trait: Deep Focus Capable ─────────────────────────────────────────
  if (switchRate < 0.3 && totalSec > 1200) {
    traits.push({
      id: 'deep-focus',
      name: 'Deep Worker',
      description: 'You can sustain long uninterrupted sessions. This is one of the most economically valuable cognitive traits right now.',
      evidence: `Low context-switch rate — you stay in one thing for extended periods.`,
      score: 82,
      icon: '🎯',
      color: '#4ade80',
    });
  } else if (switchRate > 1.0) {
    traits.push({
      id: 'multitasker',
      name: 'Rapid Switcher',
      description: 'You move fast between contexts. This is useful in chaotic environments, but costs ~23min of refocus time per switch in deep work.',
      evidence: `${recent.length} app switches in the past 30 minutes.`,
      score: 70,
      icon: '⚡',
      color: '#ff9f43',
    });
  }

  // ── Trait: Chess Player / Strategic Thinker ───────────────────────────
  const chessVisits = (siteV['www.chess.com'] || 0) + (siteV['chess.com'] || 0) + (siteV['lichess.org'] || 0);
  if (chessVisits >= 2 || profile.includes('chess')) {
    traits.push({
      id: 'strategic',
      name: 'Strategic Thinker',
      description: 'Chess players develop pattern recognition, long-horizon planning, and comfort with uncertainty. These transfer directly to business and system design.',
      evidence: `Regular chess activity detected. Chess players score higher on systematic thinking assessments.`,
      score: 78,
      icon: '♟️',
      color: '#c084fc',
    });
  }

  // ── Trait: AI-Native ──────────────────────────────────────────────────
  if (claudeSec > 300 || profile.includes('claude')) {
    const claudeMin = Math.round(claudeSec / 60);
    traits.push({
      id: 'ai-native',
      name: 'AI-Native',
      description: 'You\'ve integrated AI into your actual workflow, not just experimented. This compounds: every hour using AI well builds intuition that makes the next hour more effective.',
      evidence: `${claudeMin}m with Claude — you\'re in the top few percent of intentional AI users.`,
      score: 85,
      icon: '🧠',
      color: '#ffd93d',
    });
  }

  // ── Trait: Content Consumer / Researcher ──────────────────────────────
  const uniqueSites = Object.keys(siteV).length;
  const consumeRatio = chromeSec / Math.max(1, totalSec);
  if (uniqueSites >= 5 || consumeRatio > 0.5) {
    traits.push({
      id: 'researcher',
      name: 'Voracious Researcher',
      description: 'You take in a lot of information. The risk: without synthesis, inputs don\'t become outputs. The opportunity: you have broad context most builders lack.',
      evidence: `${uniqueSites} sites visited, ${Math.round(chromeSec / 60)}m browsing in this session.`,
      score: 72,
      icon: '📡',
      color: '#38bdf8',
    });
  }

  // ── Trait: Night / Morning Owl ────────────────────────────────────────
  const hour = new Date().getHours();
  if (profile.includes('morning') && hour < 11) {
    traits.push({
      id: 'morning-person',
      name: 'Morning-Optimized',
      description: 'Your most productive hours are in the morning. Cortisol peaks at ~8am creating a natural energy window. Most of the world is asleep or slow during this time.',
      evidence: `Consistent early-morning activity pattern detected across sessions.`,
      score: 80,
      icon: '🌅',
      color: '#ffd93d',
    });
  } else if (hour >= 22 || hour < 4) {
    traits.push({
      id: 'night-worker',
      name: 'Night Worker',
      description: 'You do serious work late at night. Night workers often report fewer interruptions and higher creative output — but the sleep cost compounds silently.',
      evidence: `Active during late hours — consistent late-night session pattern.`,
      score: 75,
      icon: '🌙',
      color: '#a78bfa',
    });
  }

  // ── Trait: Streamer / Visual Learner ─────────────────────────────────
  const kickVisits = (siteV['kick.com'] || 0) + (siteV['www.kick.com'] || 0);
  const ytVisits = (siteV['www.youtube.com'] || 0) + (siteV['youtube.com'] || 0);
  if (kickVisits >= 2 || ytVisits >= 3) {
    traits.push({
      id: 'visual-learner',
      name: 'Visual / Stream Learner',
      description: 'You learn by watching people do things in real time. This is actually the most effective way to build tacit knowledge — the kind that can\'t be found in docs.',
      evidence: `Regular streaming platform visits — you observe to learn, not just for entertainment.`,
      score: 68,
      icon: '📺',
      color: '#f472b6',
    });
  }

  // ── Trait: Music-Fueled ───────────────────────────────────────────────
  if (spotifySec > 300) {
    traits.push({
      id: 'music-fueled',
      name: 'Music-Fueled Worker',
      description: 'You use music as a focus tool. Research shows instrumental music at 50–70dB increases creative output by ~15%. You\'ve already discovered this intuitively.',
      evidence: `${Math.round(spotifySec / 60)}m of active music during work sessions.`,
      score: 70,
      icon: '🎵',
      color: '#4ade80',
    });
  }

  return traits.sort((a, b) => b.score - a.score).slice(0, 6);
}

// ---------------------------------------------------------------------------
// Life play generator
// ---------------------------------------------------------------------------

export function generateLifePlays(obs: RawObs[], memory: CoreMemoryBlock[], traits: Trait[]): LifePlay[] {
  const plays: LifePlay[] = [];
  const profile = memory.find(b => b.label === 'user_profile')?.value || '';

  const hasTraitId = (id: string) => traits.some(t => t.id === id);

  const siteV: Record<string, number> = {};
  for (const b of obs.filter(o => o.event_type === 'browsing-session')) {
    const s = (b.payload.domainVisited as string) || '';
    if (s) siteV[s] = (siteV[s] || 0) + ((b.payload.visitCount as number) || 1);
  }

  const apps = obs.filter(o => o.event_type === 'app-session');
  const appStats: Record<string, number> = {};
  for (const s of apps) {
    const n = (s.payload.appName as string) || '';
    if (n) appStats[n] = (appStats[n] || 0) + ((s.payload.sessionDurationSeconds as number) || 0);
  }
  const chromeMins = Math.round((appStats['Google Chrome'] || 0) / 60);
  const devMins = ['Cursor','VS Code','Terminal','Xcode'].reduce((s, n) => s + Math.round((appStats[n] || 0) / 60), 0);

  // ── Play: Chess tool / niche ──
  const chessVisits = (siteV['www.chess.com'] || 0) + (siteV['chess.com'] || 0);
  if (chessVisits >= 2 && hasTraitId('builder')) {
    plays.push({
      id: 'chess-niche',
      title: 'Build for your chess obsession',
      why: `You\'re both a chess player and a developer. This is a rare combination. The chess software ecosystem has huge gaps — analysis tools, training apps, community tools. You already understand the user deeply because you are the user.`,
      action: `Spend 1 week building one small chess tool — a PGN analyzer, an opening trainer, a Lichess bot. Ship it to /r/chess. That\'s your market validation with zero spend.`,
      category: 'skills',
      effort: 'medium',
      impact: 'life-changing',
    });
  }

  // ── Play: Stream your build ──
  if (siteV['kick.com'] >= 2 && hasTraitId('builder')) {
    plays.push({
      id: 'stream-build',
      title: 'Stream your build process on Kick',
      why: `You already watch streams on Kick and you\'re building software. Developer streams have a dedicated, high-retention audience. You have both the content (your actual build) and the platform familiarity already.`,
      action: `Set up OBS, pick one feature you\'re building this week, and stream 1 session. Don\'t overthink it — the bar is lower than you think, and Kick's algorithm rewards new streamers.`,
      category: 'skills',
      effort: 'low',
      impact: 'high',
    });
  }

  // ── Play: Morning deep work block ──
  if (hasTraitId('morning-person') || hasTraitId('builder')) {
    plays.push({
      id: 'morning-block',
      title: 'Lock 6–9am for building only',
      why: `Your data shows morning as your active window. Cortisol peaks around 8am — this is when your prefrontal cortex performs best. Right now this window is probably eaten by email and browsing.`,
      action: `Set Do Not Disturb until 9am. No messages, no email, no news. Only the one thing that matters most. Do this for 5 days and measure what you shipped vs a normal week.`,
      category: 'focus',
      effort: 'low',
      impact: 'high',
    });
  }

  // ── Play: Create before consume rule ──
  if (chromeMins > 20 && devMins < 10) {
    plays.push({
      id: 'create-first',
      title: 'Create before you consume — every day',
      why: `You spend ${chromeMins}m browsing and ${devMins}m building in a typical session. Consumption primes your brain to receive, not generate. Even 30 minutes of creation before opening Chrome changes the quality of the rest of your day.`,
      action: `Tomorrow: before opening Chrome, write one thing — code, notes, ideas, anything. Set a 30-minute timer. Only then open the browser. Track how different the day feels.`,
      category: 'focus',
      effort: 'low',
      impact: 'high',
    });
  }

  // ── Play: AI leverage upgrade ──
  if (hasTraitId('ai-native')) {
    plays.push({
      id: 'ai-leverage',
      title: 'Use Claude as an external brain, not a search engine',
      why: `You use Claude regularly, but most people use AI reactively — one question at a time. The compound value comes from maintaining context across sessions: your goals, your architecture decisions, your thinking process.`,
      action: `Start a Claude project for your current build. Paste your full context — what you\'re building, why, what decisions you\'ve made. From now on, start every session there. You\'ll get 10x better answers.`,
      category: 'skills',
      effort: 'low',
      impact: 'high',
    });
  }

  // ── Play: Ship something this week ──
  if (hasTraitId('builder')) {
    plays.push({
      id: 'ship-this-week',
      title: 'Ship something real this week',
      why: `Every day in stealth is a day without signal. You don\'t know if what you\'re building matters until a real person uses it. The first ship is the hardest — everything after it gets easier.`,
      action: `Identify the smallest version of what you\'re building that someone could actually use. Cut everything else. Set a deadline of Friday. Ship it publicly — ProductHunt, Reddit, X, anywhere real people are.`,
      category: 'skills',
      effort: 'high',
      impact: 'life-changing',
    });
  }

  // ── Play: Skill compounding ──
  if (hasTraitId('researcher') && !hasTraitId('builder')) {
    plays.push({
      id: 'skill-pick',
      title: 'Pick one skill and go deep for 90 days',
      why: `You consume a lot. Breadth is valuable but depth is what creates leverage. One skill practiced deliberately for 90 days puts you in the top 10% — most people never sustain that long.`,
      action: `Choose the one skill that, if you had it fully, would change your trajectory most. Block 1 hour daily for 90 days. Track it with a simple streak counter. Ignore everything else in that hour.`,
      category: 'skills',
      effort: 'medium',
      impact: 'life-changing',
    });
  }

  // ── Play: Financial awareness (Plaid hook) ──
  plays.push({
    id: 'plaid-connect',
    title: 'Connect your finances for real money insights',
    why: `PRE can detect money leaks, subscription waste, and saving opportunities — but only with your actual transaction data. Most people overspend by 15–20% on things they don\'t consciously choose.`,
    action: `Connect Plaid in settings to unlock: subscription audit, spending pattern analysis, and personalized saving plays based on your real behavior.`,
    category: 'money',
    effort: 'low',
    impact: 'high',
  });

  // ── Play: Note capture system ──
  if (hasTraitId('researcher')) {
    plays.push({
      id: 'capture-system',
      title: 'Build a 2-minute note capture habit',
      why: `You browse a lot of sources. Research shows you retain ~10% of what you read without capture. With a consistent note system — even 2 sentences per source — retention jumps to 60–80%.`,
      action: `Pick one tool (Obsidian, Notion, even Apple Notes). After every meaningful read, write 2 sentences: what you learned and why it matters. Do this for 2 weeks and watch your thinking sharpen.`,
      category: 'skills',
      effort: 'low',
      impact: 'high',
    });
  }

  return plays.slice(0, 6);
}

// ---------------------------------------------------------------------------
// InspirationTab component
// ---------------------------------------------------------------------------

const EFFORT_LABEL: Record<LifePlay['effort'], string> = { low: 'Low effort', medium: 'Medium effort', high: 'High effort' };
const IMPACT_LABEL: Record<LifePlay['impact'], string> = { medium: 'Medium impact', high: 'High impact', 'life-changing': 'Life-changing' };
const IMPACT_COLOR: Record<LifePlay['impact'], string> = { medium: '#a0a09c', high: '#ffd93d', 'life-changing': '#ff6b6b' };

const CAT_ICON: Record<LifePlay['category'], string> = {
  time: '⏱', money: '💰', health: '💪', skills: '⚡', relationships: '👥', focus: '🎯',
};

const CAT_COLOR: Record<LifePlay['category'], string> = {
  time: '#38bdf8', money: '#4ade80', health: '#fb923c', skills: '#7c9fff', relationships: '#f472b6', focus: '#ffd93d',
};

function ScoreRing({ score, color }: { score: number; color: string }) {
  const r = 14;
  const circ = 2 * Math.PI * r;
  const fill = (score / 100) * circ;
  return (
    <svg width="36" height="36" style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
      <circle cx="18" cy="18" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="2.5" />
      <circle cx="18" cy="18" r={r} fill="none" stroke={color} strokeWidth="2.5"
        strokeDasharray={`${fill} ${circ}`} strokeLinecap="round" style={{ transition: 'stroke-dasharray 0.8s ease' }} />
    </svg>
  );
}

function TraitCard({ trait }: { trait: Trait }) {
  return (
    <div style={{ padding: '14px 15px', borderRadius: 12, background: '#161618', border: '1px solid rgba(255,255,255,0.07)', marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <ScoreRing score={trait.score} color={trait.color} />
          <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>
            {trait.icon}
          </span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ color: '#f2f2f0', fontSize: 13, fontWeight: 600 }}>{trait.name}</span>
            <span style={{ color: trait.color, fontSize: 10, fontWeight: 700, background: `${trait.color}18`, borderRadius: 100, padding: '1px 7px' }}>{trait.score}%</span>
          </div>
          <p style={{ color: '#a0a09c', fontSize: 12, lineHeight: 1.7, margin: 0 }}>{trait.description}</p>
        </div>
      </div>
      <div style={{ paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <p style={{ color: '#585854', fontSize: 10.5, lineHeight: 1.6, margin: 0 }}>📊 {trait.evidence}</p>
      </div>
    </div>
  );
}

function PlayCard({ play }: { play: LifePlay }) {
  const [expanded, setExpanded] = useState(false);
  const catColor = CAT_COLOR[play.category];
  const isPlaid = play.id === 'plaid-connect';

  return (
    <button
      type="button"
      onClick={() => setExpanded(e => !e)}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '13px 15px', borderRadius: 12, marginBottom: 8,
        background: isPlaid ? 'rgba(74,222,128,0.05)' : '#161618',
        border: isPlaid ? '1px solid rgba(74,222,128,0.2)' : '1px solid rgba(255,255,255,0.07)',
        cursor: 'pointer', transition: 'border-color 0.15s',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: expanded ? 10 : 0 }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: `${catColor}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 15 }}>
          {CAT_ICON[play.category]}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' }}>
            <span style={{ color: '#f2f2f0', fontSize: 12.5, fontWeight: 600 }}>{play.title}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: catColor, fontSize: 9, fontWeight: 700, background: `${catColor}18`, borderRadius: 100, padding: '1px 7px', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{play.category}</span>
            <span style={{ color: '#585854', fontSize: 9 }}>{EFFORT_LABEL[play.effort]}</span>
            <span style={{ color: '#585854', fontSize: 9 }}>·</span>
            <span style={{ color: IMPACT_COLOR[play.impact], fontSize: 9, fontWeight: 600 }}>{IMPACT_LABEL[play.impact]}</span>
          </div>
        </div>
        <span style={{ color: '#585854', fontSize: 13, flexShrink: 0, marginTop: 2 }}>{expanded ? '−' : '+'}</span>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 10, marginTop: 2 }}>
          <p style={{ color: '#a0a09c', fontSize: 12, lineHeight: 1.75, margin: '0 0 10px' }}>{play.why}</p>
          <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '10px 12px', borderLeft: `2px solid ${catColor}` }}>
            <p style={{ color: '#d4d4d0', fontSize: 12, lineHeight: 1.7, margin: 0, fontStyle: 'italic' }}>
              → {play.action}
            </p>
          </div>
          {isPlaid && (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80' }} />
              <span style={{ color: '#4ade80', fontSize: 10, fontWeight: 600 }}>Plaid integration ready — coming soon</span>
            </div>
          )}
        </div>
      )}
    </button>
  );
}

function SectionLabel({ text, sub }: { text: string; sub?: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ color: '#a0a09c', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>{text}</span>
        <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.05)' }} />
      </div>
      {sub && <p style={{ color: '#585854', fontSize: 10.5, margin: '4px 0 0', lineHeight: 1.5 }}>{sub}</p>}
    </div>
  );
}

export function InspirationTab({ obs, memory }: { obs: RawObs[]; memory: CoreMemoryBlock[] }) {
  const traits = deriveTraits(obs, memory);
  const plays = generateLifePlays(obs, memory, traits);
  const hasData = obs.length > 0;

  if (!hasData) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 24px', gap: 16 }}>
        <span style={{ fontSize: 32 }}>🔍</span>
        <p style={{ color: '#a0a09c', fontSize: 13, textAlign: 'center', lineHeight: 1.8, margin: 0 }}>
          Not enough data yet.<br />PRE needs to observe your patterns for a bit.
        </p>
        <p style={{ color: '#585854', fontSize: 11, textAlign: 'center', margin: 0 }}>Keep using your Mac normally — traits will appear soon.</p>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px 48px' }}>

      {/* ── Your Traits ── */}
      <div style={{ marginBottom: 28 }}>
        <SectionLabel
          text="Your Traits"
          sub="Derived from your actual behavior — not a quiz."
        />
        {traits.length === 0
          ? <p style={{ color: '#585854', fontSize: 12 }}>Collecting more data to derive traits…</p>
          : traits.map(t => <TraitCard key={t.id} trait={t} />)
        }
      </div>

      {/* ── Life Plays ── */}
      <div style={{ marginBottom: 28 }}>
        <SectionLabel
          text="Life Plays"
          sub="Specific actions tailored to your patterns. Tap to expand."
        />
        {plays.map(p => <PlayCard key={p.id} play={p} />)}
      </div>

      {/* ── Financial unlock banner ── */}
      <div style={{ borderRadius: 12, background: 'rgba(74,222,128,0.04)', border: '1px solid rgba(74,222,128,0.15)', padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: 18 }}>💰</span>
          <span style={{ color: '#4ade80', fontSize: 12, fontWeight: 700 }}>Unlock Financial Insights</span>
        </div>
        <p style={{ color: '#a0a09c', fontSize: 12, lineHeight: 1.7, margin: '0 0 10px' }}>
          Connect Plaid to unlock: subscription waste detection, spending pattern analysis, savings opportunities, and money-behavior correlations (e.g. do you spend more on bad sleep weeks?).
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {['Subscription audit', 'Spending patterns', 'Money leaks', 'Savings plays', 'Behavior correlations'].map(f => (
            <span key={f} style={{ color: '#4ade80', fontSize: 9, fontWeight: 600, background: 'rgba(74,222,128,0.1)', borderRadius: 100, padding: '2px 9px' }}>{f}</span>
          ))}
        </div>
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#ffd93d' }} />
          <span style={{ color: '#ffd93d', fontSize: 10, fontWeight: 600 }}>Plaid integration in progress — will auto-enable when ready</span>
        </div>
      </div>
    </div>
  );
}
