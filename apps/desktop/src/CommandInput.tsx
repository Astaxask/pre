/**
 * CommandInput — the PRE action launcher.
 *
 * Appears when the user clicks the menu bar icon.
 * Type a natural-language command → PRE executes it on your Mac.
 *
 * Examples:
 *   "buy airpods pro on amazon"
 *   "youtube lofi hip hop"
 *   "open kick.com/adinross"
 *   "play tyler the creator on spotify"
 *   "volume 60"
 *   "search chess openings"
 *   "open cursor"
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Tauri interop
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Types / constants
// ---------------------------------------------------------------------------

type CmdResult = { ok: boolean; icon: string; message: string };

const HINTS = ['open', 'search', 'buy', 'youtube', 'play', 'volume', 'kick'];

// Rotating placeholder examples to show the range of what PRE can do
const EXAMPLES = [
  'buy airpods pro on amazon',
  'youtube lofi hip hop',
  'play tyler the creator',
  'open kick.com/adinross',
  'search chess openings',
  'volume 65',
  'open cursor',
  'go to reddit.com/r/chess',
  'search rust programming',
];

// ---------------------------------------------------------------------------
// CommandInput
// ---------------------------------------------------------------------------

export function CommandInput() {
  const [value, setValue]       = useState('');
  const [result, setResult]     = useState<CmdResult | null>(null);
  const [running, setRunning]   = useState(false);
  const [mounted, setMounted]   = useState(false);
  const inputRef                = useRef<HTMLInputElement>(null);
  const closeTimer              = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exIdx                   = useRef(Math.floor(Date.now() / 6000) % EXAMPLES.length);

  // Focus input whenever the window becomes focused (i.e. tray click)
  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('focus', focus);
    focus();
    requestAnimationFrame(() => requestAnimationFrame(() => setMounted(true)));
    return () => window.removeEventListener('focus', focus);
  }, []);

  // Close on Escape or blur
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') inv('close_command_input');
    };
    // Small delay on blur so a click on a child element doesn't close first
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
    const r = res ?? { ok: false, icon: '❌', message: 'No response from PRE' };
    setResult(r);
    setRunning(false);

    if (r.message === '__open_main__') {
      // Sentinel: open main window
      await inv('open_main_window');
      return;
    }

    if (r.ok) {
      // Auto-dismiss after success
      closeTimer.current = setTimeout(async () => {
        await inv('close_command_input');
        setValue('');
        setResult(null);
      }, 1800);
    }
  }, [value, running]);

  const placeholder = EXAMPLES[exIdx.current % EXAMPLES.length];

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#141416',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(-4px)',
        transition: 'opacity 0.12s ease, transform 0.12s ease',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        overflow: 'hidden',
      }}
    >
      {/* ── Input row ── */}
      <div
        data-tauri-drag-region
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 18px',
          height: 58,
          flexShrink: 0,
          borderBottom: (result || !value) ? '1px solid rgba(255,255,255,0.06)' : 'none',
        }}
      >
        {/* Icon: spinning when running, command symbol when idle */}
        <span style={{ fontSize: 14, flexShrink: 0, color: running ? '#7c9fff' : '#333330', transition: 'color 0.2s' }}>
          {running ? '◌' : '⌘'}
        </span>

        <input
          ref={inputRef}
          value={value}
          onChange={e => { setValue(e.target.value); setResult(null); }}
          onKeyDown={e => { if (e.key === 'Enter') run(); }}
          placeholder={placeholder}
          style={{
            flex: 1,
            background: 'none',
            border: 'none',
            outline: 'none',
            color: '#f2f2f0',
            fontSize: 14,
            fontWeight: 400,
            caretColor: '#7c9fff',
            letterSpacing: '0.01em',
          }}
        />

        {value && !running && (
          <span style={{ color: '#333330', fontSize: 10, flexShrink: 0, letterSpacing: '0.04em' }}>
            ↵ run
          </span>
        )}
        {running && (
          <span
            style={{
              color: '#7c9fff',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              animation: 'breathe 1.2s ease-in-out infinite',
            }}
          >
            executing
          </span>
        )}
      </div>

      {/* ── Result row ── */}
      {result && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 18px',
            height: 52,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 16, flexShrink: 0 }}>{result.icon}</span>
          <span
            style={{
              color: result.ok ? '#a0a09c' : '#ff6b6b',
              fontSize: 12.5,
              lineHeight: 1.5,
              fontWeight: result.ok ? 400 : 500,
            }}
          >
            {result.message}
          </span>
        </div>
      )}

      {/* ── Hints row (shown when input is empty and no result) ── */}
      {!result && !value && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 18px',
            height: 52,
            flexShrink: 0,
          }}
        >
          {HINTS.map(h => (
            <span
              key={h}
              onClick={() => { setValue(h + ' '); inputRef.current?.focus(); }}
              style={{
                color: '#585854',
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.07em',
                textTransform: 'uppercase',
                background: 'rgba(255,255,255,0.04)',
                borderRadius: 4,
                padding: '3px 8px',
                cursor: 'pointer',
                transition: 'background 0.15s, color 0.15s',
                userSelect: 'none',
              }}
            >
              {h}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
