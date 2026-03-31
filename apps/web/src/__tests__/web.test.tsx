import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@repo/ui', async () => {
  const actual = await vi.importActual('@repo/ui');
  return {
    ...actual,
    useGateway: vi.fn().mockReturnValue({
      connected: true,
      lastMessage: null,
      sendMessage: vi.fn(),
      alerts: [],
      insights: [],
    }),
    useQuery: vi.fn().mockReturnValue({
      sendQuery: vi.fn().mockResolvedValue([]),
      loading: false,
      error: null,
    }),
  };
});

function withRouter(ui: React.ReactElement) {
  return <MemoryRouter>{ui}</MemoryRouter>;
}

describe('Dashboard', () => {
  it('renders 4 metric skeleton cards initially', async () => {
    const { Dashboard } = await import('../screens/Dashboard.js');
    render(withRouter(<Dashboard />));

    const skeletons = screen.getAllByTestId('metric-skeleton');
    expect(skeletons).toHaveLength(4);
  });
});

describe('Simulation', () => {
  it('Run button is disabled when decision text is shorter than 20 characters', async () => {
    const { Simulation } = await import('../screens/Simulation.js');
    render(withRouter(<Simulation />));

    const runButton = screen.getByTestId('run-simulation');
    expect(runButton).toBeDisabled();

    const textarea = screen.getByTestId('decision-input');
    fireEvent.change(textarea, { target: { value: 'short text' } });
    expect(runButton).toBeDisabled();
  });

  it('Run button is enabled when decision text is 20 or more characters', async () => {
    const { Simulation } = await import('../screens/Simulation.js');
    render(withRouter(<Simulation />));

    const textarea = screen.getByTestId('decision-input');
    fireEvent.change(textarea, {
      target: { value: 'This is a decision that is long enough to pass validation' },
    });

    const runButton = screen.getByTestId('run-simulation');
    expect(runButton).toBeEnabled();
  });
});

describe('Settings', () => {
  it('Delete all data button is disabled until user types "delete"', async () => {
    const { Settings } = await import('../screens/Settings.js');
    render(withRouter(<Settings />));

    const deleteButton = screen.getByTestId('delete-all-button');
    expect(deleteButton).toBeDisabled();
  });

  it('Delete all data button is enabled after typing "delete"', async () => {
    const { Settings } = await import('../screens/Settings.js');
    render(withRouter(<Settings />));

    const input = screen.getByTestId('delete-confirm-input');
    fireEvent.change(input, { target: { value: 'delete' } });

    const deleteButton = screen.getByTestId('delete-all-button');
    expect(deleteButton).toBeEnabled();
  });
});
