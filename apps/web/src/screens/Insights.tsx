import { useMemo, useState } from 'react';
import type { LifeDomain } from '@pre/shared';
import { DomainTag, InsightCard, useGateway } from '@repo/ui';
import type { InsightType, LifeInsight } from '@repo/ui';

const DOMAINS: LifeDomain[] = ['body', 'money', 'people', 'time', 'mind', 'world'];

const INSIGHT_TYPES: { value: InsightType | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pattern-detected', label: 'Pattern' },
  { value: 'trend-change', label: 'Trend' },
  { value: 'goal-drift', label: 'Goal drift' },
  { value: 'conflict-detected', label: 'Conflict' },
  { value: 'anomaly', label: 'Anomaly' },
  { value: 'correlation', label: 'Correlation' },
];

export function Insights() {
  const { insights } = useGateway();
  const [activeDomains, setActiveDomains] = useState<Set<LifeDomain | 'all'>>(new Set(['all']));
  const [typeFilter, setTypeFilter] = useState<InsightType | 'all'>('all');

  const toggleDomain = (domain: LifeDomain | 'all') => {
    if (domain === 'all') {
      setActiveDomains(new Set(['all']));
    } else {
      setActiveDomains((prev) => {
        const next = new Set(prev);
        next.delete('all');
        if (next.has(domain)) {
          next.delete(domain);
          if (next.size === 0) next.add('all');
        } else {
          next.add(domain);
        }
        return next;
      });
    }
  };

  const filtered = useMemo(() => {
    let items = [...insights];

    if (!activeDomains.has('all')) {
      items = items.filter((i) =>
        i.domains.some((d) => activeDomains.has(d)),
      );
    }

    if (typeFilter !== 'all') {
      items = items.filter((i) => i.insightType === typeFilter);
    }

    items.sort((a, b) => b.generatedAt - a.generatedAt);
    return items;
  }, [insights, activeDomains, typeFilter]);

  const now = Date.now();

  return (
    <div>
      <h1 className="text-display text-text-primary">Insights</h1>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`rounded-pill px-3 py-1 text-label transition-colors ${
            activeDomains.has('all')
              ? 'bg-accent text-surface'
              : 'bg-surface-raised text-text-secondary hover:bg-surface-sunken'
          }`}
          onClick={() => toggleDomain('all')}
        >
          All
        </button>
        {DOMAINS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => toggleDomain(d)}
            className="cursor-pointer"
          >
            <DomainTag domain={d} size={activeDomains.has(d) ? 'md' : 'sm'} />
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {INSIGHT_TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            className={`rounded-pill px-3 py-1 text-label transition-colors ${
              typeFilter === t.value
                ? 'bg-accent text-surface'
                : 'bg-surface-raised text-text-secondary hover:bg-surface-sunken'
            }`}
            onClick={() => setTypeFilter(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-6 flex flex-col gap-3">
        {filtered.length === 0 ? (
          <p className="text-body text-text-tertiary">
            No insights yet. Keep collecting data for a few more days.
          </p>
        ) : (
          filtered.map((insight: LifeInsight) => {
            const isExpired = insight.expiresAt < now;
            return (
              <div
                key={insight.id}
                className={isExpired ? 'opacity-50' : ''}
              >
                {isExpired && (
                  <span className="mb-1 inline-block rounded-pill bg-surface-sunken px-2 py-0 text-micro text-text-tertiary">
                    Expired
                  </span>
                )}
                <InsightCard insight={insight} />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
