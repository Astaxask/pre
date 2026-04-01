/**
 * TrayPopover — appears when the user clicks the PRE menu bar icon.
 *
 * Rendered in the "tray-popover" window (no decorations, transparent, always-on-top).
 * Shows one strategic insight derived from current activity with no LLM wait.
 * Hides itself when the window loses focus.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Tauri interop (same pattern as App.tsx)
// ---------------------------------------------------------------------------

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
async function getInv() {
  if (_invoke) return _invoke;
  try { const m = await import('@tauri-apps/api/core'); _invoke = m.invoke; return _invoke; }
  catch { _invoke = async () => null; return _invoke!; }
}
async function inv<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try { return (await (await getInv())(cmd, args)) as T; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Insight = {
  text: string;
  category: string;
  icon: string;
};

// ---------------------------------------------------------------------------
// Category → color map
// ---------------------------------------------------------------------------

const CAT_COLOR: Record<string, string> = {
  insight:    '#7c9fff',
  challenge:  '#ff6b6b',
  question:   '#ffd93d',
  blindspot:  '#ff9f43',
  idea:       '#4ade80',
  pattern:    '#c084fc',
  nudge:      '#f472b6',
};

// ---------------------------------------------------------------------------
// TrayPopover
// ---------------------------------------------------------------------------

export function TrayPopover() {
  const [insights, setInsights]   = useState<Insight[]>([]);
  const [index, setIndex]         = useState(0);
  const [loading, setLoading]     = useState(true);
  const [mounted, setMounted]     = useState(false);
  const didLoad                   = useRef(false);

  const loadInsights = useCallback(async () => {
    setLoading(true);
    const result = await inv<Insight[]>('get_tray_insight');
    setInsights(result ?? []);
    setIndex(0);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (didLoad.current) return;
    didLoad.current = true;
    loadInsights();

    // Fade-in after first paint
    requestAnimationFrame(() => requestAnimationFrame(() => setMounted(true)));

    // Close popover when this window loses focus
    const handleBlur = () => inv('close_tray_popover');
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, [loadInsights]);

  const current = insights[index] ?? null;
  const color   = current ? (CAT_COLOR[current.category] ?? '#7c9fff') : '#7c9fff';
  const hasNext = insights.length > 1;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      data-tauri-drag-region
      style={{
        width: '100vw',
        height: '100vh',
        background: '#141416',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(-4px)',
        transition: 'opacity 0.15s ease, transform 0.15s ease',
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
      }}
    >
        {/* ── Top accent bar ── */}
        <div style={{
          height: 2,
          flexShrink: 0,
          background: `linear-gradient(90deg, ${color}80 0%, ${color}20 100%)`,
          transition: 'background 0.4s ease',
        }} />

        {/* ── Content ── */}
        <div style={{ flex: 1, padding: '12px 15px 10px', overflow: 'hidden' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: '100%' }}>
              <div style={{
                width: 6, height: 6, borderRadius: '50%', background: '#7c9fff',
                animation: 'breathe 1.8s ease-in-out infinite',
              }} />
              <span style={{ color: '#585854', fontSize: 12 }}>reading your patterns…</span>
            </div>
          ) : current ? (
            <>
              {/* Category + icon row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
                <span style={{ fontSize: 15, lineHeight: 1 }}>{current.icon}</span>
                <span style={{
                  color,
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  background: `${color}18`,
                  borderRadius: 100,
                  padding: '2px 8px',
                }}>
                  {current.category}
                </span>
                {hasNext && (
                  <span style={{ marginLeft: 'auto', color: '#333330', fontSize: 9 }}>
                    {index + 1}/{insights.length}
                  </span>
                )}
              </div>

              {/* Insight text */}
              <p style={{
                color: '#e4e4e0',
                fontSize: 12.5,
                lineHeight: 1.75,
                margin: 0,
                fontWeight: 400,
                // Clamp to avoid overflow if text is long
                display: '-webkit-box',
                WebkitLineClamp: 4,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}>
                {current.text}
              </p>
            </>
          ) : (
            <p style={{ color: '#585854', fontSize: 12, margin: 0, lineHeight: 1.7 }}>
              Keep using your Mac normally — PRE will surface insights as it learns your patterns.
            </p>
          )}
        </div>

        {/* ── Footer buttons ── */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '7px 12px 9px',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          flexShrink: 0,
        }}>
          <button
            type="button"
            onClick={() => inv('open_main_window')}
            style={{
              background: 'rgba(124,159,255,0.1)',
              border: '1px solid rgba(124,159,255,0.2)',
              borderRadius: 6,
              padding: '4px 12px',
              color: '#7c9fff',
              fontSize: 10,
              fontWeight: 600,
              cursor: 'pointer',
              letterSpacing: '0.04em',
              transition: 'background 0.15s',
            }}
          >
            Open PRE
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              onClick={loadInsights}
              style={{
                background: 'none',
                border: 'none',
                color: '#585854',
                fontSize: 10,
                cursor: 'pointer',
                padding: '4px 6px',
                transition: 'color 0.15s',
              }}
              title="Refresh insights"
            >
              ↺
            </button>
            {hasNext && (
              <button
                type="button"
                onClick={() => setIndex(i => (i + 1) % insights.length)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#a0a09c',
                  fontSize: 10,
                  cursor: 'pointer',
                  padding: '4px 6px',
                  fontWeight: 600,
                  transition: 'color 0.15s',
                }}
              >
                next →
              </button>
            )}
          </div>
        </div>
    </div>
  );
}
