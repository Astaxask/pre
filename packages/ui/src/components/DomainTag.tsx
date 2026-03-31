import type { LifeDomain } from '@pre/shared';

const DOMAIN_COLORS: Record<LifeDomain, string> = {
  body: '#1A7F4B',
  money: '#B07A00',
  people: '#7B3FC4',
  time: '#2D5BE3',
  mind: '#C0392B',
  world: '#5A5A56',
};

const DOMAIN_LABELS: Record<LifeDomain, string> = {
  body: 'Body',
  money: 'Money',
  people: 'People',
  time: 'Time',
  mind: 'Mind',
  world: 'World',
};

type DomainTagProps = {
  domain: LifeDomain;
  size: 'sm' | 'md';
};

export function DomainTag({ domain, size }: DomainTagProps) {
  const color = DOMAIN_COLORS[domain];
  const label = DOMAIN_LABELS[domain];

  const sizeClasses = size === 'sm' ? 'px-2 py-0 text-micro' : 'px-3 py-1 text-caption';

  return (
    <span
      className={`inline-flex items-center rounded-pill font-medium ${sizeClasses}`}
      style={{
        backgroundColor: `${color}1F`,
        color: color,
      }}
      data-testid={`domain-tag-${domain}`}
    >
      {label}
    </span>
  );
}
