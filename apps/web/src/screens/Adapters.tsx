import { useEffect, useState } from 'react';
import { useGateway } from '@repo/ui';

type AdapterInfo = {
  id: string;
  name: string;
  status: 'connected' | 'needs-attention' | 'disconnected';
  lastSync: string;
  eventCount: number;
  daysTracked: number;
  collectedData: string[];
};

const STATUS_DOTS: Record<AdapterInfo['status'], string> = {
  connected: 'bg-positive',
  'needs-attention': 'bg-warning',
  disconnected: 'bg-negative',
};

const STATUS_LABELS: Record<AdapterInfo['status'], string> = {
  connected: 'Connected',
  'needs-attention': 'Needs attention',
  disconnected: 'Disconnected',
};

function AdapterCard({
  adapter,
  onDelete,
  onReconnect,
}: {
  adapter: AdapterInfo;
  onDelete: () => void;
  onReconnect: () => void;
}) {
  const [showCollected, setShowCollected] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="rounded-card border border-border bg-surface-raised p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-pill ${STATUS_DOTS[adapter.status]}`} />
          <h3 className="text-heading text-text-primary">{adapter.name}</h3>
        </div>
        <span className="text-caption text-text-tertiary">
          {STATUS_LABELS[adapter.status]}
        </span>
      </div>

      <div className="mt-3 flex gap-6 text-caption text-text-secondary">
        <span>Last sync: {adapter.lastSync}</span>
        <span>{adapter.eventCount.toLocaleString()} events</span>
        <span>{adapter.daysTracked} days tracked</span>
      </div>

      <div className="mt-3">
        <button
          type="button"
          className="text-caption text-text-tertiary underline hover:text-text-secondary"
          onClick={() => setShowCollected((p) => !p)}
        >
          What is collected
        </button>
        {showCollected && (
          <ul className="mt-2 ml-4 list-disc text-caption text-text-secondary">
            {adapter.collectedData.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4 flex items-center gap-2">
        {adapter.status === 'needs-attention' && (
          <button
            type="button"
            className="rounded bg-accent px-3 py-1 text-label text-surface hover:opacity-90"
            onClick={onReconnect}
          >
            Reconnect
          </button>
        )}

        {!confirmDelete ? (
          <button
            type="button"
            className="rounded bg-surface-sunken px-3 py-1 text-label text-negative hover:bg-negative/10"
            onClick={() => setConfirmDelete(true)}
          >
            Delete all data
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-caption text-negative">Are you sure?</span>
            <button
              type="button"
              className="rounded bg-negative px-3 py-1 text-label text-surface"
              onClick={() => {
                onDelete();
                setConfirmDelete(false);
              }}
            >
              Yes, delete
            </button>
            <button
              type="button"
              className="rounded bg-surface-sunken px-3 py-1 text-label text-text-secondary"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Adapters() {
  const { connected, sendMessage, lastMessage } = useGateway();
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);

  useEffect(() => {
    if (!connected) return;
    sendMessage({ type: 'query', payload: { kind: 'adapters' } });
  }, [connected, sendMessage]);

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === 'adapters') {
      setAdapters(lastMessage.payload as AdapterInfo[]);
    }
  }, [lastMessage]);

  const handleDelete = (adapterId: string) => {
    sendMessage({ type: 'delete-adapter-data', payload: { adapterId } });
  };

  const handleReconnect = (adapterId: string) => {
    sendMessage({ type: 'reconnect-adapter', payload: { adapterId } });
  };

  return (
    <div>
      <h1 className="text-display text-text-primary">Adapters</h1>

      <div className="mt-6 flex flex-col gap-4">
        {adapters.length === 0 ? (
          <p className="text-body text-text-tertiary">No adapters configured.</p>
        ) : (
          adapters.map((adapter) => (
            <AdapterCard
              key={adapter.id}
              adapter={adapter}
              onDelete={() => handleDelete(adapter.id)}
              onReconnect={() => handleReconnect(adapter.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
