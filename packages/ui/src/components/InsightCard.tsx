import { useState } from 'react';
import type { LifeInsight } from '../types.js';
import { DomainTag } from './DomainTag.js';
import { ConfidenceBar } from './ConfidenceBar.js';

type InsightCardProps = {
  insight: LifeInsight;
  expanded?: boolean;
};

function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function InsightCard({ insight, expanded: initialExpanded = false }: InsightCardProps) {
  const [expanded, setExpanded] = useState(initialExpanded);

  return (
    <div className="rounded-card border border-border bg-surface-raised p-4">
      <button
        type="button"
        className="w-full text-left"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {insight.domains.map((domain) => (
              <DomainTag key={domain} domain={domain} size="sm" />
            ))}
          </div>
          <span className="text-micro text-text-tertiary">
            {formatRelativeTime(insight.generatedAt)}
          </span>
        </div>
        <p className="mt-2 text-body text-text-primary line-clamp-1">
          {insight.payload.description}
        </p>
      </button>

      <div
        className="overflow-hidden transition-all duration-200"
        style={{ maxHeight: expanded ? '500px' : '0px' }}
      >
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-body text-text-secondary">
            {insight.payload.description}
          </p>
          <ConfidenceBar value={insight.confidence} />
          <div className="flex items-center gap-2 text-caption text-text-tertiary">
            <span>Type: {insight.insightType.replace(/-/g, ' ')}</span>
          </div>
          <button
            type="button"
            className="self-start rounded bg-surface-sunken px-3 py-1 text-caption text-text-secondary hover:text-text-primary"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
