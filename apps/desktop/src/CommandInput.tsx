/**
 * CommandInput — PRE action launcher.
 * Appears at bottom-center on tray click. Type a command, hit Enter.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

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

const HINTS = ['open', 'search', 'buy', 'youtube', 'play', 'volume', 'kick'];

const EXAMPLES = [
  'buy airpods pro on amazon',
  'youtube lofi hip hop',
  'play tyler the creator',
  'open kick.com/adinross',
  'search chess openings',
  'volume 65',
  'open cursor',
  'go to reddit.com/r/chess',
];

export function CommandInput() {
  const [value, setValue]     = useState('');
  const [result, setResult]   = useState<CmdResult | null>(null);
  const [running, setRunning] = useState(false);
  const [show, setShow]       = useState(false);
  const inputRef              = useRef<HTMLInputElement>(null);
  const closeTimer            = useRef<ReturnType<typeof setTimeout> | null>(null);
  const placeholder           = EXAMPLES[Math.floor(Date.now() / 6000) % EXAMPLES.length];

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
      }, 1800);
    }
  }, [value, running]);

  const hasResult = result !== null;

  return (
    /* The card IS the window — no outer wrapper, no black rectangle */
    <div style={{
      width: '100vw', height: '100vh',
      background: 'linear-gradient(145deg, #1a1a20 0%, #141418 100%)',
      borderRadius: 22,
      border: '1px solid rgba(255,255,255,0.12)',
      boxShadow: '0 24px 64px rgba(0,0,0,0.8), 0 2px 12px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)',
      overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      opacity: show ? 1 : 0,
      transform: show ? 'translateY(0) scale(1)' : 'translateY(8px) scale(0.98)',
      transition: 'opacity 0.16s ease, transform 0.16s ease',
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
    }}>

        {/* Subtle top glow line */}
        <div style={{
          height: 1,
          background: 'linear-gradient(90deg, transparent 0%, rgba(124,159,255,0.5) 40%, rgba(124,159,255,0.5) 60%, transparent 100%)',
        }} />

        {/* ── Input row ── */}
        <div data-tauri-drag-region style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '0 22px', height: 66,
          borderBottom: (hasResult || !value) ? '1px solid rgba(255,255,255,0.06)' : 'none',
        }}>
          {/* Left icon */}
          <div style={{
            width: 32, height: 32, borderRadius: 8, flexShrink: 0,
            background: running ? 'rgba(124,159,255,0.15)' : 'rgba(255,255,255,0.05)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 0.2s',
          }}>
            <span style={{
              fontSize: 15, lineHeight: 1,
              color: running ? '#7c9fff' : '#585854',
              animation: running ? 'breathe 1s ease-in-out infinite' : 'none',
            }}>
              {running ? '◌' : '⌘'}
            </span>
          </div>

          <input
            ref={inputRef}
            value={value}
            onChange={e => { setValue(e.target.value); setResult(null); }}
            onKeyDown={e => { if (e.key === 'Enter') run(); }}
            placeholder={placeholder}
            style={{
              flex: 1, background: 'none', border: 'none', outline: 'none',
              color: '#f0f0ec', fontSize: 16, fontWeight: 400,
              caretColor: '#7c9fff', letterSpacing: '0.01em',
              lineHeight: 1,
            }}
          />

          {value && !running && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: 'rgba(255,255,255,0.05)', borderRadius: 7,
              padding: '4px 10px', flexShrink: 0,
            }}>
              <span style={{ color: '#585854', fontSize: 10, letterSpacing: '0.04em' }}>return</span>
              <span style={{ color: '#7c9fff', fontSize: 11 }}>↵</span>
            </div>
          )}

          {running && (
            <span style={{
              color: '#7c9fff', fontSize: 9, fontWeight: 700,
              letterSpacing: '0.12em', textTransform: 'uppercase', flexShrink: 0,
            }}>
              running…
            </span>
          )}
        </div>

        {/* ── Result row ── */}
        {hasResult && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '0 22px', height: 54,
          }}>
            <span style={{
              fontSize: 20, flexShrink: 0,
              filter: result!.ok ? 'none' : 'grayscale(50%)',
            }}>
              {result!.icon}
            </span>
            <span style={{
              color: result!.ok ? '#c8c8c4' : '#ff7070',
              fontSize: 13.5, lineHeight: 1.5, fontWeight: 400,
            }}>
              {result!.message}
            </span>
          </div>
        )}

        {/* ── Hint chips (empty + no result) ── */}
        {!hasResult && !value && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '0 22px', height: 54,
          }}>
            {HINTS.map(h => (
              <button
                key={h}
                type="button"
                onClick={() => { setValue(h + ' '); inputRef.current?.focus(); }}
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: 8, padding: '4px 11px',
                  color: '#585854', fontSize: 10, fontWeight: 600,
                  letterSpacing: '0.07em', textTransform: 'uppercase',
                  cursor: 'pointer', transition: 'background 0.12s, color 0.12s',
                }}
                onMouseEnter={e => {
                  (e.target as HTMLButtonElement).style.background = 'rgba(124,159,255,0.1)';
                  (e.target as HTMLButtonElement).style.color = '#7c9fff';
                }}
                onMouseLeave={e => {
                  (e.target as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)';
                  (e.target as HTMLButtonElement).style.color = '#585854';
                }}
              >
                {h}
              </button>
            ))}
          </div>
        )}

        {/* ── Running state — replaces hint row ── */}
        {!hasResult && running && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '0 22px', height: 54,
          }}>
            <div style={{
              width: 6, height: 6, borderRadius: '50%', background: '#7c9fff',
              animation: 'breathe 1s ease-in-out infinite',
            }} />
            <span style={{ color: '#585854', fontSize: 12 }}>
              executing <span style={{ color: '#a0a09c', fontStyle: 'italic' }}>"{value}"</span>
            </span>
          </div>
        )}
    </div>
  );
}
