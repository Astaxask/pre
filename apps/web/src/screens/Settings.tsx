import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useGateway } from '@repo/ui';

type SettingsData = {
  localModel: string;
  cloudEnabled: boolean;
  cloudBudgetUsd: number;
  proactiveEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  encryptionEnabled: boolean;
  eventCount: number;
  storageUsedMb: number;
  daysTracked: number;
  version: string;
};

export function Settings() {
  const { connected, sendMessage, lastMessage } = useGateway();
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  useEffect(() => {
    if (!connected) return;
    sendMessage({ type: 'query', payload: { kind: 'settings' } });
  }, [connected, sendMessage]);

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === 'settings') {
      setSettings(lastMessage.payload as SettingsData);
    }
  }, [lastMessage]);

  const handleDeleteAll = () => {
    if (deleteConfirm !== 'delete') return;
    sendMessage({ type: 'delete-all-data', payload: {} });
    setDeleteConfirm('');
  };

  const handleExport = () => {
    sendMessage({ type: 'export-data', payload: {} });
  };

  return (
    <div className="max-w-2xl">
      <h1 className="text-display text-text-primary">Settings</h1>

      {/* Integrations */}
      <section className="mt-8">
        <h2 className="text-title text-text-primary">Integrations</h2>
        <p className="mt-2 text-body text-text-secondary">
          Manage your connected data sources.
        </p>
        <Link
          to="/adapters"
          className="mt-2 inline-block text-body text-accent hover:underline"
        >
          Go to Adapters
        </Link>
      </section>

      <div className="my-8 border-t border-border" />

      {/* Model Preferences */}
      <section>
        <h2 className="text-title text-text-primary">Model Preferences</h2>
        <div className="mt-4 flex flex-col gap-4">
          <div>
            <p className="text-label text-text-secondary">Local model</p>
            <div className="mt-2 flex gap-3">
              {['llama3.1:8b', 'mistral:7b', 'phi3:mini'].map((model) => (
                <label
                  key={model}
                  className={`flex cursor-pointer items-center gap-2 rounded-pill px-3 py-1 text-label ${
                    settings?.localModel === model
                      ? 'bg-accent/10 text-accent'
                      : 'bg-surface-raised text-text-secondary'
                  }`}
                >
                  <input
                    type="radio"
                    name="local-model"
                    value={model}
                    checked={settings?.localModel === model}
                    onChange={() => {
                      sendMessage({
                        type: 'update-setting',
                        payload: { key: 'localModel', value: model },
                      });
                    }}
                    className="sr-only"
                  />
                  {model}
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-label text-text-secondary">Cloud reasoning (Claude)</p>
              <p className="text-caption text-text-tertiary">
                Only for non-sensitive, summarized data
              </p>
            </div>
            <button
              type="button"
              className={`relative inline-flex h-6 w-12 items-center rounded-pill transition-colors ${
                settings?.cloudEnabled ? 'bg-accent' : 'bg-surface-sunken'
              }`}
              onClick={() => {
                sendMessage({
                  type: 'update-setting',
                  payload: { key: 'cloudEnabled', value: !settings?.cloudEnabled },
                });
              }}
            >
              <span
                className={`inline-block h-4 w-4 rounded-pill bg-surface transition-transform ${
                  settings?.cloudEnabled ? 'translate-x-7' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {settings?.cloudEnabled && (
            <div>
              <label htmlFor="cloud-budget" className="text-label text-text-secondary">
                Monthly cloud budget (USD)
              </label>
              <input
                id="cloud-budget"
                type="number"
                min={0}
                step={1}
                value={settings.cloudBudgetUsd}
                onChange={(e) => {
                  sendMessage({
                    type: 'update-setting',
                    payload: { key: 'cloudBudgetUsd', value: Number(e.target.value) },
                  });
                }}
                className="mt-1 w-32 rounded border border-border bg-surface-raised px-3 py-1 text-body text-text-primary focus:border-accent focus:outline-none"
              />
            </div>
          )}
        </div>
      </section>

      <div className="my-8 border-t border-border" />

      {/* Proactive Agent */}
      <section>
        <h2 className="text-title text-text-primary">Proactive Agent</h2>
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <p className="text-label text-text-secondary">Enable proactive monitoring</p>
            <button
              type="button"
              className={`relative inline-flex h-6 w-12 items-center rounded-pill transition-colors ${
                settings?.proactiveEnabled ? 'bg-accent' : 'bg-surface-sunken'
              }`}
              onClick={() => {
                sendMessage({
                  type: 'update-setting',
                  payload: { key: 'proactiveEnabled', value: !settings?.proactiveEnabled },
                });
              }}
            >
              <span
                className={`inline-block h-4 w-4 rounded-pill bg-surface transition-transform ${
                  settings?.proactiveEnabled ? 'translate-x-7' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          <div>
            <p className="text-label text-text-secondary">Quiet hours</p>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="time"
                value={settings?.quietHoursStart ?? '22:00'}
                onChange={(e) => {
                  sendMessage({
                    type: 'update-setting',
                    payload: { key: 'quietHoursStart', value: e.target.value },
                  });
                }}
                className="rounded border border-border bg-surface-raised px-2 py-1 text-body text-text-primary focus:border-accent focus:outline-none"
              />
              <span className="text-body text-text-tertiary">to</span>
              <input
                type="time"
                value={settings?.quietHoursEnd ?? '08:00'}
                onChange={(e) => {
                  sendMessage({
                    type: 'update-setting',
                    payload: { key: 'quietHoursEnd', value: e.target.value },
                  });
                }}
                className="rounded border border-border bg-surface-raised px-2 py-1 text-body text-text-primary focus:border-accent focus:outline-none"
              />
            </div>
          </div>
        </div>
      </section>

      <div className="my-8 border-t border-border" />

      {/* Privacy */}
      <section>
        <h2 className="text-title text-text-primary">Privacy</h2>
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2 w-2 rounded-pill ${
                settings?.encryptionEnabled ? 'bg-positive' : 'bg-negative'
              }`}
            />
            <span className="text-body text-text-primary">
              Encryption at rest: {settings?.encryptionEnabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>

          <button
            type="button"
            className="self-start rounded bg-surface-raised px-4 py-2 text-label text-text-secondary hover:bg-surface-sunken"
            onClick={handleExport}
          >
            Export all data
          </button>

          <div>
            <p className="text-label text-negative">Delete all data</p>
            <p className="mt-1 text-caption text-text-tertiary">
              This action is irreversible. Type &quot;delete&quot; to confirm.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder='Type "delete"'
                className="w-40 rounded border border-border bg-surface-raised px-3 py-1 text-body text-text-primary placeholder:text-text-tertiary focus:border-negative focus:outline-none"
                data-testid="delete-confirm-input"
              />
              <button
                type="button"
                disabled={deleteConfirm !== 'delete'}
                className="rounded bg-negative px-4 py-1 text-label text-surface disabled:opacity-40"
                onClick={handleDeleteAll}
                data-testid="delete-all-button"
              >
                Delete all data
              </button>
            </div>
          </div>
        </div>
      </section>

      <div className="my-8 border-t border-border" />

      {/* About */}
      <section>
        <h2 className="text-title text-text-primary">About</h2>
        <div className="mt-4 flex flex-col gap-2 text-body text-text-secondary">
          <p>Version: {settings?.version ?? '...'}</p>
          <p>Events stored: {settings?.eventCount?.toLocaleString() ?? '...'}</p>
          <p>Storage used: {settings?.storageUsedMb != null ? `${settings.storageUsedMb} MB` : '...'}</p>
          <p>Days tracked: {settings?.daysTracked ?? '...'}</p>
        </div>
      </section>
    </div>
  );
}
