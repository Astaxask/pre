type DistributionRangeProps = {
  p10: number;
  p50: number;
  p90: number;
  unit: string;
  baseline?: { p10: number; p50: number; p90: number };
  label?: string;
};

function RangeBar({
  p10,
  p50,
  p90,
  min,
  max,
  barLabel,
}: {
  p10: number;
  p50: number;
  p90: number;
  min: number;
  max: number;
  barLabel: string;
}) {
  const range = max - min || 1;
  const leftPct = ((p10 - min) / range) * 100;
  const widthPct = ((p90 - p10) / range) * 100;
  const medianPct = ((p50 - min) / range) * 100;

  return (
    <div className="flex flex-col gap-1">
      <span className="text-micro text-text-tertiary">{barLabel}</span>
      <div className="relative h-2 w-full rounded-sm bg-surface-sunken">
        <div
          className="absolute top-0 h-full rounded-sm bg-accent opacity-30"
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
        />
        <div
          className="absolute top-0 h-full w-[2px] rounded-sm bg-accent"
          style={{ left: `${medianPct}%` }}
        />
        <div
          className="absolute top-0 h-full w-[1px] bg-text-tertiary opacity-60"
          style={{ left: `${leftPct}%` }}
          data-testid="marker-p10"
        />
        <div
          className="absolute top-0 h-full w-[1px] bg-text-tertiary opacity-60"
          style={{ left: `${leftPct + widthPct}%` }}
          data-testid="marker-p90"
        />
      </div>
    </div>
  );
}

function getDeltaColor(projected: number, baseline: number): string {
  if (projected > baseline) return 'text-positive';
  if (projected < baseline) return 'text-negative';
  return 'text-neutral-trend';
}

export function DistributionRange({
  p10,
  p50,
  p90,
  unit,
  baseline,
  label,
}: DistributionRangeProps) {
  const ariaLabel = `between ${p10} and ${p90} ${unit}, likely ${p50} ${unit}`;

  if (!baseline) {
    return (
      <div className="flex flex-col gap-1" aria-label={ariaLabel} role="figure">
        {label && <span className="text-caption text-text-secondary">{label}</span>}
        <RangeBar p10={p10} p50={p50} p90={p90} min={p10} max={p90} barLabel="Range" />
        <div className="flex justify-between text-micro text-text-tertiary">
          <span>{p10} {unit}</span>
          <span>{p50} {unit}</span>
          <span>{p90} {unit}</span>
        </div>
      </div>
    );
  }

  const allValues = [p10, p90, baseline.p10, baseline.p90];
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const delta = p50 - baseline.p50;
  const deltaColor = getDeltaColor(p50, baseline.p50);
  const sign = delta > 0 ? '+' : '';

  return (
    <div className="flex flex-col gap-2" aria-label={ariaLabel} role="figure">
      {label && <span className="text-caption text-text-secondary">{label}</span>}
      <RangeBar
        p10={baseline.p10}
        p50={baseline.p50}
        p90={baseline.p90}
        min={min}
        max={max}
        barLabel="Before"
      />
      <RangeBar p10={p10} p50={p50} p90={p90} min={min} max={max} barLabel="After" />
      <div className="flex items-center gap-2">
        <span className={`text-caption font-medium ${deltaColor}`}>
          {sign}{delta} {unit}
        </span>
        <span className="text-micro text-text-tertiary">median change</span>
      </div>
    </div>
  );
}
