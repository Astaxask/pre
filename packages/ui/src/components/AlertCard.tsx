import { useState } from 'react';
import type { Alert, AlertSeverity } from '../types.js';
import { DomainTag } from './DomainTag.js';

type AlertCardProps = {
  alert: Alert;
  onDismiss?: () => void;
  onSnooze?: () => void;
  onAct?: () => void;
};

const SEVERITY_BORDER: Record<AlertSeverity, string> = {
  info: 'border-l-accent',
  warning: 'border-l-warning',
  intervention: 'border-l-negative',
};

const SEVERITY_BADGE_BG: Record<AlertSeverity, string> = {
  info: 'bg-accent',
  warning: 'bg-warning',
  intervention: 'bg-negative',
};

const SEVERITY_LABELS: Record<AlertSeverity, string> = {
  info: 'Info',
  warning: 'Warning',
  intervention: 'Intervention',
};

export function AlertCard({ alert, onDismiss, onSnooze, onAct }: AlertCardProps) {
  const [showWhy, setShowWhy] = useState(false);

  return (
    <div
      className={`rounded-card border border-border border-l-4 ${SEVERITY_BORDER[alert.severity]} bg-surface-raised p-4`}
      data-testid="alert-card"
    >
      <div className="flex items-center gap-2">
        <span
          className={`rounded-pill px-2 py-0 text-micro font-medium text-surface ${SEVERITY_BADGE_BG[alert.severity]}`}
        >
          {SEVERITY_LABELS[alert.severity]}
        </span>
        <div className="flex gap-1">
          {alert.domains.map((domain) => (
            <DomainTag key={domain} domain={domain} size="sm" />
          ))}
        </div>
      </div>

      <h3 className="mt-2 text-heading text-text-primary">{alert.title}</h3>
      <p className="mt-1 text-body text-text-secondary">{alert.body}</p>

      <button
        type="button"
        className="mt-2 text-caption text-text-tertiary underline hover:text-text-secondary"
        onClick={() => setShowWhy((prev) => !prev)}
        aria-expanded={showWhy}
      >
        Why am I seeing this?
      </button>

      {showWhy && (
        <p className="mt-1 text-caption text-text-tertiary">
          {alert.whyExplanation}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          className="rounded bg-surface-sunken px-4 py-2 text-label text-text-primary hover:bg-border"
          onClick={onDismiss}
          data-testid="alert-dismiss"
        >
          Dismiss
        </button>
        <button
          type="button"
          className="rounded bg-surface-sunken px-3 py-2 text-label text-text-secondary hover:text-text-primary"
          onClick={onSnooze}
        >
          Snooze 1d
        </button>
        <button
          type="button"
          className="rounded bg-accent px-3 py-2 text-label text-surface hover:opacity-90"
          onClick={onAct}
        >
          Act on it
        </button>
      </div>
    </div>
  );
}
