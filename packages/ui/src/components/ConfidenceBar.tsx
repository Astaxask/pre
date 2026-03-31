type ConfidenceBarProps = {
  value: number;
  label?: string;
};

function getConfidenceTier(value: number): {
  colorClass: string;
  label: string;
} {
  if (value >= 0.7) {
    return { colorClass: 'bg-accent', label: 'Good confidence' };
  }
  if (value >= 0.4) {
    return { colorClass: 'bg-warning', label: 'Moderate confidence' };
  }
  return { colorClass: 'bg-text-tertiary', label: 'Low confidence' };
}

export function ConfidenceBar({ value, label }: ConfidenceBarProps) {
  const clamped = Math.max(0, Math.min(1, value));
  const tier = getConfidenceTier(clamped);
  const displayLabel = label ?? tier.label;
  const percent = Math.round(clamped * 100);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-caption text-text-secondary">{displayLabel}</span>
        <span className="text-caption text-text-tertiary">{percent}%</span>
      </div>
      <div
        className="h-1 w-full rounded-sm bg-surface-sunken"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={displayLabel}
      >
        <div
          className={`h-full rounded-sm ${tier.colorClass}`}
          style={{ width: `${percent}%` }}
          data-testid="confidence-fill"
        />
      </div>
    </div>
  );
}
