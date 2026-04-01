/**
 * CommandInput — PRE's face.
 *
 * This is the singular interface between the user and their autonomous
 * second brain. It's not a command launcher — it's how you talk to an
 * intelligence that already knows about your life.
 *
 * Design principles:
 *   1. PRE is alive — the status line proves the system is working
 *   2. Zero chrome — the input IS the interface
 *   3. Context, not hints — show what PRE knows, not what verbs exist
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/* ── Tauri bridge ────────────────────────────────────────────────── */

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
async function getInv() {
  if (_invoke) return _invoke;
  try { const m = await import('@tauri-apps/api/core'); _invoke = m.invoke; return _invoke; }
  catch { _invoke = async () => null; return _invoke!; }
}
async function inv<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try { return (await (await getInv())(cmd, args)) as T; }
  catch { return null; }
}

type CmdResult = { ok: boolean; icon: string; message: string };

/* ── Ambient status ──────────────────────────────────────────────── */

function getStatusLine(): string {
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  const h = now.getHours();
  const period = h < 6 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  return `${day} ${period}  · observing`;
}

/* ── Rotating placeholder ────────────────────────────────────────── */

const PLACEHOLDERS = [
  'ask me anything, or tell me what to do',
  'open an app, search the web, play music…',
  'what should I focus on today?',
  'play something on spotify',
  'search for something on google',
];

function getPlaceholder(): string {
  return PLACEHOLDERS[Math.floor(Date.now() / 8000) % PLACEHOLDERS.length];
}

/* ── Component ───────────────────────────────────────────────────── */

export function CommandInput() {
  const [value, setValue]     = useState('');
  const [result, setResult]   = useState<CmdResult | null>(null);
  const [running, setRunning] = useState(false);
  const [show, setShow]       = useState(false);
  const inputRef              = useRef<HTMLInputElement>(null);
  const closeTimer            = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Make the command-input window transparent
  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
  }, []);

  useEffect(() => {
    const focus = () => { inputRef.current?.focus(); inputRef.current?.select(); };
    window.addEventListener('focus', focus);
    focus();
    requestAnimationFrame(() => requestAnimationFrame(() => setShow(true)));
    return () => window.removeEventListener('focus', focus);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') inv('close_command_input');
    };
    const onBlur = () => setTimeout(() => inv('close_command_input'), 120);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const run = useCallback(async () => {
    const cmd = value.trim();
    if (!cmd || running) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setRunning(true);
    setResult(null);

    const res = await inv<CmdResult>('execute_command', { text: cmd });
    const r = res ?? { ok: false, icon: '❌', message: 'No response' };
    setResult(r);
    setRunning(false);

    if (r.message === '__open_main__') { await inv('open_main_window'); return; }
    if (r.ok) {
      closeTimer.current = setTimeout(async () => {
        await inv('close_command_input');
        setValue(''); setResult(null);
      }, 2400);
    }
  }, [value, running]);

  const hasContent = result !== null || running;
  const showStatus = !value && !hasContent;

  return (
    <div style={{
      width: '100vw', height: '100vh',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      background: 'transparent',
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
    }}>
      {/* ── Floating card ── */}
      <div style={{
        width: '100%',
        background: 'rgba(22, 22, 26, 0.88)',
        WebkitBackdropFilter: 'blur(72px) saturate(180%)',
        backdropFilter: 'blur(72px) saturate(180%)',
        borderRadius: 16,
        border: '1px solid rgba(255, 255, 255, 0.1)',
        boxShadow: '0 32px 80px rgba(0, 0, 0, 0.55), 0 0 0 0.5px rgba(0, 0, 0, 0.3)',
        overflow: 'hidden',
        opacity: show ? 1 : 0,
        transform: show ? 'scale(1)' : 'scale(0.97)',
        transition: 'opacity 0.14s ease-out, transform 0.14s ease-out',
      }}>

        {/* ── Input row ── */}
        <div data-tauri-drag-region style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '0 20px', height: 56,
        }}>
          {/* PRE glyph */}
          <span style={{
            fontSize: 18, lineHeight: 1, flexShrink: 0,
            color: running ? '#7c9fff' : 'rgba(255, 255, 255, 0.22)',
            transition: 'color 0.3s',
          }}>
            ✦
          </span>

          <input
            ref={inputRef}
            value={value}
            onChange={e => { setValue(e.target.value); setResult(null); }}
            onKeyDown={e => { if (e.key === 'Enter') run(); }}
            placeholder={getPlaceholder()}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            style={{
              flex: 1, background: 'none', border: 'none', outline: 'none',
              color: '#f0f0ec', fontSize: 17, fontWeight: 400,
              caretColor: '#7c9fff', letterSpacing: '-0.01em',
              lineHeight: 1,
            }}
          />

          {/* Action badge */}
          <span style={{
            fontSize: 11, fontWeight: 500, flexShrink: 0,
            color: 'rgba(255, 255, 255, 0.2)',
            letterSpacing: '0.02em',
          }}>
            {running ? (
              <span style={{ color: '#7c9fff' }}>running</span>
            ) : value ? (
              '↵'
            ) : (
              'esc'
            )}
          </span>
        </div>

        {/* ── Separator ── */}
        {(hasContent || showStatus) && (
          <div style={{
            height: 1,
            margin: '0 20px',
            background: 'rgba(255, 255, 255, 0.06)',
          }} />
        )}

        {/* ── Result row ── */}
        {result && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '14px 20px',
          }}>
            <span style={{ fontSize: 18, flexShrink: 0 }}>
              {result.icon}
            </span>
            <span style={{
              color: result.ok ? 'rgba(255, 255, 255, 0.7)' : '#ff6b6b',
              fontSize: 14, fontWeight: 400, lineHeight: 1.4,
            }}>
              {result.message}
            </span>
          </div>
        )}

        {/* ── Running indicator ── */}
        {!result && running && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '14px 20px',
          }}>
            <div style={{
              width: 5, height: 5, borderRadius: '50%',
              background: '#7c9fff',
              animation: 'ci-pulse 1.2s ease-in-out infinite',
            }} />
            <span style={{ color: 'rgba(255, 255, 255, 0.35)', fontSize: 13 }}>
              {value}
            </span>
          </div>
        )}

        {/* ── Status line (PRE is alive) ── */}
        {showStatus && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '12px 20px',
          }}>
            <div style={{
              width: 4, height: 4, borderRadius: '50%',
              background: '#4ade80',
              opacity: 0.7,
              animation: 'ci-breathe 3s ease-in-out infinite',
            }} />
            <span style={{
              color: 'rgba(255, 255, 255, 0.2)',
              fontSize: 12, fontWeight: 400,
              letterSpacing: '0.01em',
            }}>
              {getStatusLine()}
            </span>
          </div>
        )}
      </div>

      <style>{`
        @keyframes ci-pulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1.1); }
        }
        @keyframes ci-breathe {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.9; }
        }
        input::placeholder {
          color: rgba(255, 255, 255, 0.18) !important;
        }
      `}</style>
    </div>
  );
}
