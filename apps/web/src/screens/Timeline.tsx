import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LifeDomain, LifeEvent } from '@pre/shared';
import { DomainTag, useGateway } from '@repo/ui';

const DOMAINS: LifeDomain[] = ['body', 'money', 'people', 'time', 'mind', 'world'];

type DatePreset = '1d' | '7d' | '30d' | '90d' | 'custom';

const PRESET_LABELS: Record<DatePreset, string> = {
  '1d': 'Today',
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
  custom: 'Custom',
};

const PRESET_MS: Record<Exclude<DatePreset, 'custom'>, number> = {
  '1d': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
};

const PAGE_SIZE = 100;

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function EventRow({ event }: { event: LifeEvent }) {
  const [expanded, setExpanded] = useState(false);

  const DOMAIN_COLORS: Record<LifeDomain, string> = {
    body: '#1A7F4B',
    money: '#B07A00',
    people: '#7B3FC4',
    time: '#2D5BE3',
    mind: '#C0392B',
    world: '#5A5A56',
  };

  return (
    <div className="border-b border-border">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-raised"
        onClick={() => setExpanded((p) => !p)}
        aria-expanded={expanded}
      >
        <span
          className="inline-block h-2 w-2 flex-shrink-0 rounded-pill"
          style={{ backgroundColor: DOMAIN_COLORS[event.domain] }}
        />
        <span className="text-caption text-text-tertiary w-16 flex-shrink-0">
          {formatTime(event.timestamp)}
        </span>
        <span className="text-caption text-text-secondary w-28 flex-shrink-0">
          {event.eventType}
        </span>
        <span className="text-body text-text-primary">
          {truncate(event.summary ?? '', 80)}
        </span>
      </button>

      {expanded && (
        <div className="bg-surface-raised px-8 py-4">
          <table className="text-caption">
            <tbody>
              {Object.entries(event.payload).map(([key, val]) => (
                <tr key={key}>
                  <td className="pr-4 py-1 text-text-tertiary align-top">{key}</td>
                  <td className="py-1 text-text-primary">{String(val)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2">
            <span
              className={`rounded-pill px-2 py-0 text-micro font-medium ${
                event.privacyLevel === 'private'
                  ? 'bg-negative/10 text-negative'
                  : event.privacyLevel === 'summarizable'
                    ? 'bg-warning/10 text-warning'
                    : 'bg-positive/10 text-positive'
              }`}
            >
              {event.privacyLevel}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function Timeline() {
  const { connected, sendMessage, lastMessage } = useGateway();
  const [preset, setPreset] = useState<DatePreset>('7d');
  const [activeDomains, setActiveDomains] = useState<Set<LifeDomain | 'all'>>(new Set(['all']));
  const [searchQuery, setSearchQuery] = useState('');
  const [events, setEvents] = useState<LifeEvent[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);

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
    setPage(0);
    setEvents([]);
  };

  const fetchEvents = useCallback(() => {
    if (!connected) return;
    const now = Date.now();
    const sinceMs = preset !== 'custom' ? PRESET_MS[preset] : 90 * 86_400_000;
    const domains = activeDomains.has('all') ? undefined : [...activeDomains];
    sendMessage({
      type: 'query',
      payload: {
        kind: 'timeline-events',
        since: now - sinceMs,
        until: now,
        domains,
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
      },
    });
  }, [connected, sendMessage, preset, activeDomains, page]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  useEffect(() => {
    if (!lastMessage || lastMessage.type !== 'timeline-events') return;
    const incoming = lastMessage.payload as { events: LifeEvent[]; hasMore: boolean };
    if (page === 0) {
      setEvents(incoming.events);
    } else {
      setEvents((prev) => [...prev, ...incoming.events]);
    }
    setHasMore(incoming.hasMore);
  }, [lastMessage, page]);

  const filteredEvents = useMemo(() => {
    if (!searchQuery.trim()) return events;
    const q = searchQuery.toLowerCase();
    return events.filter((e) => (e.summary ?? '').toLowerCase().includes(q));
  }, [events, searchQuery]);

  const groupedByDay = useMemo(() => {
    const groups = new Map<string, LifeEvent[]>();
    for (const event of filteredEvents) {
      const dayKey = formatDate(event.timestamp);
      const existing = groups.get(dayKey);
      if (existing) {
        existing.push(event);
      } else {
        groups.set(dayKey, [event]);
      }
    }
    return groups;
  }, [filteredEvents]);

  return (
    <div>
      <h1 className="text-display text-text-primary">Timeline</h1>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {(Object.keys(PRESET_LABELS) as DatePreset[]).map((p) => (
          <button
            key={p}
            type="button"
            className={`rounded-pill px-3 py-1 text-label transition-colors ${
              preset === p
                ? 'bg-accent text-surface'
                : 'bg-surface-raised text-text-secondary hover:bg-surface-sunken'
            }`}
            onClick={() => {
              setPreset(p);
              setPage(0);
              setEvents([]);
            }}
          >
            {PRESET_LABELS[p]}
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
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
            <DomainTag
              domain={d}
              size={activeDomains.has(d) ? 'md' : 'sm'}
            />
          </button>
        ))}
      </div>

      <div className="mt-4">
        <input
          type="text"
          placeholder="Search events..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full rounded border border-border bg-surface-raised px-4 py-2 text-body text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
        />
      </div>

      <div className="mt-6">
        {filteredEvents.length === 0 ? (
          <p className="text-body text-text-tertiary">No events in this time range.</p>
        ) : (
          <>
            {[...groupedByDay.entries()].map(([day, dayEvents]) => (
              <div key={day}>
                <div className="sticky top-0 z-10 bg-surface py-2">
                  <h2 className="text-label text-text-secondary">{day}</h2>
                </div>
                {dayEvents.map((event) => (
                  <EventRow key={event.id} event={event} />
                ))}
              </div>
            ))}
            {hasMore && (
              <button
                type="button"
                className="mt-4 rounded bg-surface-raised px-6 py-2 text-label text-text-secondary hover:bg-surface-sunken"
                onClick={() => setPage((p) => p + 1)}
              >
                Load more
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
