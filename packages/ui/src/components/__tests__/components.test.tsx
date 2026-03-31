import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DomainTag } from '../DomainTag.js';
import { ConfidenceBar } from '../ConfidenceBar.js';
import { DistributionRange } from '../DistributionRange.js';
import { AlertCard } from '../AlertCard.js';
import type { Alert } from '../../types.js';
import type { LifeDomain } from '@pre/shared';

describe('DomainTag', () => {
  const domains: LifeDomain[] = ['body', 'money', 'people', 'time', 'mind', 'world'];

  it.each(domains)('renders correct domain color for %s', (domain) => {
    render(<DomainTag domain={domain} size="md" />);
    const tag = screen.getByTestId(`domain-tag-${domain}`);
    expect(tag).toBeInTheDocument();
    expect(tag.style.color).toBeTruthy();
    expect(tag.style.backgroundColor).toBeTruthy();
  });

  it('renders domain name in sentence case', () => {
    render(<DomainTag domain="body" size="md" />);
    expect(screen.getByText('Body')).toBeInTheDocument();
  });

  it('applies sm size classes', () => {
    render(<DomainTag domain="money" size="sm" />);
    const tag = screen.getByTestId('domain-tag-money');
    expect(tag.className).toContain('text-micro');
  });
});

describe('ConfidenceBar', () => {
  it('renders accent color for high confidence (>= 0.7)', () => {
    render(<ConfidenceBar value={0.85} />);
    const fill = screen.getByTestId('confidence-fill');
    expect(fill.className).toContain('bg-accent');
  });

  it('renders warning color for moderate confidence (>= 0.4)', () => {
    render(<ConfidenceBar value={0.5} />);
    const fill = screen.getByTestId('confidence-fill');
    expect(fill.className).toContain('bg-warning');
  });

  it('renders tertiary color for low confidence (< 0.4)', () => {
    render(<ConfidenceBar value={0.2} />);
    const fill = screen.getByTestId('confidence-fill');
    expect(fill.className).toContain('bg-text-tertiary');
  });

  it('renders at boundary value 0.7 as accent', () => {
    render(<ConfidenceBar value={0.7} />);
    const fill = screen.getByTestId('confidence-fill');
    expect(fill.className).toContain('bg-accent');
  });

  it('renders at boundary value 0.4 as warning', () => {
    render(<ConfidenceBar value={0.4} />);
    const fill = screen.getByTestId('confidence-fill');
    expect(fill.className).toContain('bg-warning');
  });

  it('renders correct aria attributes', () => {
    render(<ConfidenceBar value={0.75} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '75');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });
});

describe('DistributionRange', () => {
  it('always renders p10 and p90 markers', () => {
    render(<DistributionRange p10={10} p50={50} p90={90} unit="bpm" />);
    expect(screen.getByText('10 bpm')).toBeInTheDocument();
    expect(screen.getByText('90 bpm')).toBeInTheDocument();
  });

  it('renders p50 as well', () => {
    render(<DistributionRange p10={10} p50={50} p90={90} unit="bpm" />);
    expect(screen.getByText('50 bpm')).toBeInTheDocument();
  });

  it('renders comparison mode with baseline', () => {
    render(
      <DistributionRange
        p10={15}
        p50={55}
        p90={95}
        unit="bpm"
        baseline={{ p10: 10, p50: 50, p90: 90 }}
      />,
    );
    expect(screen.getByText('Before')).toBeInTheDocument();
    expect(screen.getByText('After')).toBeInTheDocument();
    expect(screen.getByText('median change')).toBeInTheDocument();
  });
});

describe('AlertCard', () => {
  const mockAlert: Alert = {
    id: 'alert-1',
    ruleId: 'rule-1',
    ruleName: 'Test Rule',
    severity: 'warning',
    title: 'Test Alert',
    body: 'This is a test alert body.',
    domains: ['money', 'time'],
    createdAt: Date.now(),
    insightId: 'insight-1',
    whyExplanation: 'Because of test reasons.',
  };

  it('calls onDismiss when dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(<AlertCard alert={mockAlert} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('alert-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders alert title and body', () => {
    render(<AlertCard alert={mockAlert} />);
    expect(screen.getByText('Test Alert')).toBeInTheDocument();
    expect(screen.getByText('This is a test alert body.')).toBeInTheDocument();
  });

  it('shows why explanation when clicked', () => {
    render(<AlertCard alert={mockAlert} />);
    fireEvent.click(screen.getByText('Why am I seeing this?'));
    expect(screen.getByText('Because of test reasons.')).toBeInTheDocument();
  });

  it('renders severity badge', () => {
    render(<AlertCard alert={mockAlert} />);
    expect(screen.getByText('Warning')).toBeInTheDocument();
  });
});
