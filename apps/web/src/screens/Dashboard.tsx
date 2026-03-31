import { useEffect, useState, useCallback } from 'react';
import { useGateway, AlertCard } from '@repo/ui';
import type { Alert } from '@repo/ui';

type TrendDirection = 'up' | 'down' | 'flat';

type MetricData = {
  label: string;
  value: string;
  unit: string;
  trend: TrendDirection;
  trendValue: string;
};

type AdapterStatus = {
  name: string;
  status: 'connected' | 'needs-attention' | 'disconnected';
  lastSync: string;
};

function trendArrow(trend: TrendDirection): string {
  if (trend === 'up') return '\u2191';
  if (trend === 'down') return '\u2193';
  return '\u2192';
}

function trendColor(trend: TrendDirection): string {
  if (trend === 'up') return 'text-positive';
  if (trend === 'down') return 'text-negative';
  return 'text-neutral-trend';
}

function MetricCardSkeleton() {
  return (
    <div className="rounded-card border border-border bg-surface-raised p-4" data-testid="metric-skeleton">
      <div className="h-3 w-20 animate-pulse rounded bg-surface-sunken" />
      <div className="mt-3 h-8 w-24 animate-pulse rounded bg-surface-sunken" />
      <div className="mt-2 h-3 w-16 animate-pulse rounded bg-surface-sunken" />
    </div>
  );
}

function MetricCard({ metric }: { metric: MetricData }) {
  return (
    <div className="rounded-card border border-border bg-surface-raised p-4" data-testid="metric-card">
      <p className="text-caption text-text-secondary">{metric.label}</p>
      <p className="mt-1 text-display text-text-primary">
        {metric.value}
        <span className="ml-1 text-body text-text-tertiary">{metric.unit}</span>
      </p>
      <p className={`mt-1 text-caption font-medium ${trendColor(metric.trend)}`}>
        {trendArrow(metric.trend)} {metric.trendValue}
      </p>
    </div>
  );
}

function AdapterStatusDot({ status }: { status: AdapterStatus['status'] }) {
  const color =
    status === 'connected'
      ? 'bg-positive'
      : status === 'needs-attention'
        ? 'bg-warning'
        : 'bg-negative';
  return <span className={`inline-block h-2 w-2 rounded-pill ${color}`} />;
}

function AdapterStatusList({ adapters }: { adapters: AdapterStatus[] }) {
  return (
    <div className="rounded-card border border-border bg-surface-raised p-4">
      <h3 className="text-heading text-text-primary">Adapter Health</h3>
      {adapters.length === 0 ? (
        <p className="mt-3 text-body text-text-tertiary">No adapters configured.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {adapters.map((adapter) => (
            <li key={adapter.name} className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AdapterStatusDot status={adapter.status} />
                <span className="text-body text-text-primary">{adapter.name}</span>
              </div>
              <span className="text-caption text-text-tertiary">{adapter.lastSync}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const AUTO_REFRESH_MS = 5 * 60 * 1000;

export function Dashboard() {
  const { connected, sendMessage, alerts, lastMessage } = useGateway();
  const [metrics, setMetrics] = useState<MetricData[] | null>(null);
  const [adapters, setAdapters] = useState<AdapterStatus[]>([]);

  const fetchDashboard = useCallback(() => {
    if (!connected) return;
    sendMessage({ type: 'query', payload: { kind: 'dashboard-metrics' } });
    sendMessage({ type: 'query', payload: { kind: 'adapter-status' } });
  }, [connected, sendMessage]);

  useEffect(() => {
    fetchDashboard();
    const interval = setInterval(fetchDashboard, AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [fetchDashboard]);

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === 'dashboard-metrics') {
      setMetrics(lastMessage.payload as MetricData[]);
    } else if (lastMessage.type === 'adapter-status') {
      setAdapters(lastMessage.payload as AdapterStatus[]);
    }
  }, [lastMessage]);

  return (
    <div>
      <h1 className="text-display text-text-primary">Dashboard</h1>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="metric-grid">
        {metrics === null ? (
          <>
            <MetricCardSkeleton />
            <MetricCardSkeleton />
            <MetricCardSkeleton />
            <MetricCardSkeleton />
          </>
        ) : (
          metrics.map((m) => <MetricCard key={m.label} metric={m} />)
        )}
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h2 className="text-heading text-text-primary">Recent Alerts</h2>
          <div className="mt-3 flex flex-col gap-3">
            {alerts.length === 0 ? (
              <p className="text-body text-text-tertiary">
                No alerts right now. PRE is watching.
              </p>
            ) : (
              alerts.slice(0, 5).map((alert: Alert) => (
                <AlertCard key={alert.id} alert={alert} />
              ))
            )}
          </div>
        </div>

        <div>
          <h2 className="text-heading text-text-primary">Adapters</h2>
          <div className="mt-3">
            <AdapterStatusList adapters={adapters} />
          </div>
        </div>
      </div>
    </div>
  );
}
