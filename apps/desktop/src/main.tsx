import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { TrayPopover } from './TrayPopover.js';
import './styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

// Detect which Tauri window we are rendering in — synchronously available
// via the runtime metadata injected before the JS bundle loads.
type TauriInternals = { metadata?: { currentWindow?: { label?: string } } };
const windowLabel =
  ((window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__)
    ?.metadata?.currentWindow?.label ?? 'main';

createRoot(rootEl).render(
  windowLabel === 'tray-popover' ? <TrayPopover /> : <App />
);
