import { useEffect, useState } from 'react';
import type { LifeDomain } from '@pre/shared';
import { DomainTag, useGateway } from '@repo/ui';

const DOMAINS: LifeDomain[] = ['body', 'money', 'people', 'time', 'mind', 'world'];

type Goal = {
  id: string;
  title: string;
  domain: LifeDomain;
  targetDate: number | null;
  status: 'active' | 'completed' | 'abandoned' | 'paused';
  progressPercent: number;
};

function GoalCard({ goal }: { goal: Goal }) {
  const statusColors: Record<Goal['status'], string> = {
    active: 'text-accent',
    completed: 'text-positive',
    abandoned: 'text-text-tertiary',
    paused: 'text-warning',
  };

  return (
    <div className="rounded-card border border-border bg-surface-raised p-4">
      <div className="flex items-center justify-between">
        <DomainTag domain={goal.domain} size="sm" />
        <span className={`text-caption font-medium ${statusColors[goal.status]}`}>
          {goal.status}
        </span>
      </div>
      <h3 className="mt-2 text-heading text-text-primary">{goal.title}</h3>
      {goal.targetDate && (
        <p className="mt-1 text-caption text-text-tertiary">
          Target: {new Date(goal.targetDate).toLocaleDateString()}
        </p>
      )}
      <div className="mt-3">
        <div className="flex items-center justify-between text-caption">
          <span className="text-text-secondary">Progress</span>
          <span className="text-text-tertiary">{goal.progressPercent}%</span>
        </div>
        <div className="mt-1 h-1 w-full rounded-sm bg-surface-sunken">
          <div
            className="h-full rounded-sm bg-accent"
            style={{ width: `${goal.progressPercent}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function AddGoalPanel({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (title: string, domain: LifeDomain, targetDate: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [domain, setDomain] = useState<LifeDomain>('mind');
  const [targetDate, setTargetDate] = useState('');

  const handleSave = () => {
    if (!title.trim()) return;
    onSave(title.trim(), domain, targetDate);
    setTitle('');
    setDomain('mind');
    setTargetDate('');
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex">
      <div className="w-80 border-l border-border bg-surface p-6 shadow-lg">
        <div className="flex items-center justify-between">
          <h2 className="text-title text-text-primary">Add Goal</h2>
          <button
            type="button"
            className="text-body text-text-tertiary hover:text-text-primary"
            onClick={onClose}
          >
            X
          </button>
        </div>

        <div className="mt-6 flex flex-col gap-4">
          <div>
            <label htmlFor="goal-title" className="text-label text-text-secondary">
              Goal
            </label>
            <input
              id="goal-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What do you want to achieve?"
              className="mt-1 w-full rounded border border-border bg-surface-raised px-3 py-2 text-body text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
            />
          </div>

          <div>
            <p className="text-label text-text-secondary">Domain</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {DOMAINS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDomain(d)}
                  className={`cursor-pointer rounded-pill border-2 ${
                    domain === d ? 'border-accent' : 'border-transparent'
                  }`}
                >
                  <DomainTag domain={d} size="sm" />
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="goal-date" className="text-label text-text-secondary">
              Target date (optional)
            </label>
            <input
              id="goal-date"
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="mt-1 w-full rounded border border-border bg-surface-raised px-3 py-2 text-body text-text-primary focus:border-accent focus:outline-none"
            />
          </div>

          <button
            type="button"
            disabled={!title.trim()}
            className="mt-2 rounded bg-accent px-4 py-2 text-label text-surface hover:opacity-90 disabled:opacity-40"
            onClick={handleSave}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export function Goals() {
  const { connected, sendMessage, lastMessage } = useGateway();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    if (!connected) return;
    sendMessage({ type: 'query', payload: { kind: 'goals' } });
  }, [connected, sendMessage]);

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === 'goals') {
      setGoals(lastMessage.payload as Goal[]);
    }
  }, [lastMessage]);

  const handleSave = (title: string, domain: LifeDomain, targetDate: string) => {
    sendMessage({
      type: 'create-goal',
      payload: {
        title,
        domain,
        targetDate: targetDate ? new Date(targetDate).getTime() : null,
      },
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-display text-text-primary">Goals</h1>
        <button
          type="button"
          className="rounded bg-accent px-4 py-2 text-label text-surface hover:opacity-90"
          onClick={() => setPanelOpen(true)}
        >
          Add goal
        </button>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {goals.length === 0 ? (
          <p className="text-body text-text-tertiary col-span-full">
            No active goals. Add one to start tracking.
          </p>
        ) : (
          goals.map((goal) => <GoalCard key={goal.id} goal={goal} />)
        )}
      </div>

      <AddGoalPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        onSave={handleSave}
      />
    </div>
  );
}
