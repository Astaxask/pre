import { useCallback, useEffect, useRef, useState } from 'react';
import { useGateway, AlertCard } from '@repo/ui';
import type { Alert } from '@repo/ui';

// ---------------------------------------------------------------------------
// Tauri interop — wrapped so the app also runs in a plain browser
// ---------------------------------------------------------------------------

type TrayState = 'Idle' | 'Alert' | 'NeedsAttention' | 'Offline';

let invokeImpl: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

async function getInvoke() {
  if (invokeImpl !== null) return invokeImpl;
  try {
    const mod = await import('@tauri-apps/api/core');
    invokeImpl = mod.invoke;
    return invokeImpl;
  } catch {
    // Not running inside Tauri — provide a no-op
    invokeImpl = async () => {};
    return invokeImpl;
  }
}

async function setTrayState(state: TrayState): Promise<void> {
  try {
    const invoke = await getInvoke();
    await invoke('set_tray_state', { state });
  } catch {
    // Silently ignore if Tauri is unavailable
  }
}

async function openInBrowser(url: string) {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch {
    window.open(url, '_blank');
  }
}

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const WEB_PANEL_BASE = 'http://localhost:5173';

type AdapterStatus = {
  name: string;
  status: 'connected' | 'stale' | 'error' | 'needs-reauth';
  lastSync: number | null;
};

function formatRelativeTime(timestamp: number | null): string {
  if (timestamp === null) return 'Never';
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function StatusDot({ status }: { status: AdapterStatus['status'] }) {
  const colorClass =
    status === 'connected'
      ? 'text-positive'
      : status === 'stale'
        ? 'text-warning'
        : 'text-negative';

  if (status === 'error' || status === 'needs-reauth') {
    return <span className={colorClass}>&#9888;</span>;
  }
  return <span className={colorClass}>&#9679;</span>;
}

function ShimmerLines() {
  return (
    <div className="flex flex-col gap-2">
      <div className="h-3 w-full animate-pulse rounded bg-surface-sunken" />
      <div className="h-3 w-4/5 animate-pulse rounded bg-surface-sunken" />
      <div className="h-3 w-3/5 animate-pulse rounded bg-surface-sunken" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tray state logic — compute desired state from app conditions
// Priority: Offline > Alert > NeedsAttention > Idle
// ---------------------------------------------------------------------------

function computeTrayState(
  connected: boolean,
  hasUnreadAlerts: boolean,
  hasAdapterNeedingAttention: boolean,
): TrayState {
  if (!connected) return 'Offline';
  if (hasUnreadAlerts) return 'Alert';
  if (hasAdapterNeedingAttention) return 'NeedsAttention';
  return 'Idle';
}

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------

export function App() {
  const { connected, alerts, sendMessage, lastMessage } = useGateway();
  const [dailySummary, setDailySummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [adapters, setAdapters] = useState<AdapterStatus[]>([]);
  const [alertsSeenCount, setAlertsSeenCount] = useState(0);

  // Track the last tray state we set to avoid redundant invocations
  const lastTrayStateRef = useRef<TrayState | null>(null);

  // -----------------------------------------------------------------------
  // Process gateway messages
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (lastMessage?.type === 'daily-summary' && lastMessage.payload) {
      const payload = lastMessage.payload as { text: string };
      setDailySummary(payload.text);
      setSummaryLoading(false);
    }
    if (lastMessage?.type === 'adapter-status' && lastMessage.payload) {
      setAdapters(lastMessage.payload as AdapterStatus[]);
    }
    // Handle sync-status updates for adapter state changes
    if (lastMessage?.type === 'sync-status' && lastMessage.payload) {
      const payload = lastMessage.payload as {
        source: string;
        status: string;
        lastSyncAt: number | null;
      };
      setAdapters((prev) => {
        const idx = prev.findIndex((a) => a.name === payload.source);
        const newStatus: AdapterStatus['status'] =
          payload.status === 'needs-reauth'
            ? 'needs-reauth'
            : payload.status === 'error'
              ? 'error'
              : payload.status === 'completed'
                ? 'connected'
                : prev[idx]?.status ?? 'connected';
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx]!,
            status: newStatus,
            lastSync: payload.lastSyncAt ?? updated[idx]!.lastSync,
          };
          return updated;
        }
        return prev;
      });
    }
  }, [lastMessage]);

  // -----------------------------------------------------------------------
  // Request data on connect
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (connected) {
      sendMessage({ type: 'request-daily-summary', payload: null });
      sendMessage({ type: 'request-adapter-status', payload: null });
    }
  }, [connected, sendMessage]);

  // After a timeout, stop showing shimmer even if no summary arrives
  useEffect(() => {
    const timer = setTimeout(() => {
      setSummaryLoading(false);
    }, 10_000);
    return () => clearTimeout(timer);
  }, []);

  // -----------------------------------------------------------------------
  // Tray state management
  // Re-evaluate whenever: connection, alerts, adapters change
  // -----------------------------------------------------------------------

  const hasUnreadAlerts = alerts.length > alertsSeenCount;
  const hasAdapterNeedingAttention = adapters.some(
    (a) => a.status === 'needs-reauth' || a.status === 'error',
  );

  useEffect(() => {
    const desired = computeTrayState(connected, hasUnreadAlerts, hasAdapterNeedingAttention);
    if (desired !== lastTrayStateRef.current) {
      lastTrayStateRef.current = desired;
      void setTrayState(desired);
    }
  }, [connected, hasUnreadAlerts, hasAdapterNeedingAttention]);

  // -----------------------------------------------------------------------
  // Window focus handler: when popover opens and state is Alert,
  // mark alerts as seen and re-evaluate tray state
  // -----------------------------------------------------------------------

  useEffect(() => {
    function handleFocus() {
      if (alerts.length > alertsSeenCount) {
        // Mark all current alerts as seen
        setAlertsSeenCount(alerts.length);
        sendMessage({ type: 'mark-alerts-seen', payload: null });

        // Re-evaluate tray state — alerts are now seen, so state drops
        const newState = computeTrayState(connected, false, hasAdapterNeedingAttention);
        if (newState !== lastTrayStateRef.current) {
          lastTrayStateRef.current = newState;
          void setTrayState(newState);
        }
      }
    }

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [alerts.length, alertsSeenCount, connected, hasAdapterNeedingAttention, sendMessage]);

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  const handleSyncAll = useCallback(() => {
    sendMessage({ type: 'trigger-sync', payload: { target: 'all' } });
  }, [sendMessage]);

  const handleQuit = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      await win.close();
    } catch {
      window.close();
    }
  }, []);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const visibleAlerts = alerts.slice(0, 3);
  const totalAlerts = alerts.length;

  return (
    <div className="flex h-screen w-[320px] flex-col overflow-y-auto bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h1 className="text-heading text-text-primary">Today</h1>
        <button
          type="button"
          className="text-title text-text-tertiary hover:text-text-primary"
          onClick={() => openInBrowser(`${WEB_PANEL_BASE}/settings`)}
          aria-label="Settings"
        >
          &#9881;
        </button>
      </div>

      {/* Connection status indicator */}
      {!connected && (
        <div className="bg-warning px-4 py-1 text-center text-micro text-surface">
          Connecting to gateway...
        </div>
      )}

      {/* Daily summary */}
      <div className="border-b border-border px-4 py-3">
        {summaryLoading ? (
          <ShimmerLines />
        ) : dailySummary ? (
          <p className="text-body text-text-secondary">{dailySummary}</p>
        ) : (
          <p className="text-body text-text-tertiary">
            No summary available yet.
          </p>
        )}
      </div>

      {/* Alerts */}
      {totalAlerts > 0 && (
        <div className="border-b border-border px-4 py-3">
          <h2 className="mb-2 text-label uppercase text-text-tertiary">
            Alerts
          </h2>
          <div className="flex flex-col gap-2">
            {visibleAlerts.map((alert: Alert) => (
              <AlertCard key={alert.id} alert={alert} />
            ))}
          </div>
          {totalAlerts > 3 && (
            <button
              type="button"
              className="mt-2 text-caption text-accent hover:underline"
              onClick={() => openInBrowser(`${WEB_PANEL_BASE}/alerts`)}
            >
              View all {totalAlerts} &rarr;
            </button>
          )}
        </div>
      )}

      {/* Action links */}
      <div className="flex flex-col gap-1 border-b border-border px-4 py-3">
        <button
          type="button"
          className="text-left text-body text-accent hover:underline"
          onClick={() => openInBrowser(`${WEB_PANEL_BASE}/simulation`)}
        >
          Run simulation...
        </button>
        <button
          type="button"
          className="text-left text-body text-accent hover:underline"
          onClick={() => openInBrowser(`${WEB_PANEL_BASE}/insights`)}
        >
          View all insights
        </button>
        <button
          type="button"
          className="text-left text-body text-accent hover:underline"
          onClick={() => openInBrowser(`${WEB_PANEL_BASE}/timeline`)}
        >
          Event timeline
        </button>
      </div>

      {/* Adapters */}
      {adapters.length > 0 && (
        <div className="border-b border-border px-4 py-3">
          <h2 className="mb-2 text-label uppercase text-text-tertiary">
            Adapters
          </h2>
          <div className="flex flex-col gap-1">
            {adapters.map((adapter) => (
              <div
                key={adapter.name}
                className="flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  <StatusDot status={adapter.status} />
                  <span className="text-body text-text-primary">
                    {adapter.name}
                  </span>
                </div>
                <span className="text-caption text-text-tertiary">
                  Synced {formatRelativeTime(adapter.lastSync)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="mt-auto flex items-center justify-between border-t border-border px-4 py-3">
        <button
          type="button"
          className="rounded bg-surface-sunken px-3 py-1 text-label text-text-primary hover:bg-border"
          onClick={handleSyncAll}
        >
          Sync now
        </button>
        <button
          type="button"
          className="text-label text-text-tertiary hover:text-negative"
          onClick={handleQuit}
        >
          Quit PRE
        </button>
      </div>
    </div>
  );
}
