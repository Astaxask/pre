import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { CommandInput } from './CommandInput.js';
import './styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

// Detect which Tauri window is rendering this page — synchronously available.
type TauriInternals = { metadata?: { currentWindow?: { label?: string } } };
const windowLabel =
  ((window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__)
    ?.metadata?.currentWindow?.label ?? 'main';

createRoot(rootEl).render(
  windowLabel === 'command-input' ? <CommandInput /> : <App />
);
