import { View, Text, Pressable, StyleSheet } from 'react-native';
import { DomainTag } from './DomainTag';
import { ConfidenceBar } from './ConfidenceBar';

type Goal = {
  id: string;
  title: string;
  domain: string;
  targetDate: number | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  progressPercent?: number;
};

type GoalCardProps = {
  goal: Goal;
  onViewHistory?: () => void;
  onLogEvent?: () => void;
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

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function GoalCard({ goal, onViewHistory, onLogEvent }: GoalCardProps) {
  const progress = (goal.progressPercent ?? 0) / 100;

  return (
    <View style={styles.card} testID="goal-card">
      <View style={styles.titleRow}>
        <Text style={styles.title}>{goal.title}</Text>
        <DomainTag domain={goal.domain} size="sm" />
      </View>

      {goal.targetDate && (
        <Text style={styles.target}>Target: {formatDate(goal.targetDate)}</Text>
      )}

      <ConfidenceBar
        value={progress}
        label={`Progress: ${goal.progressPercent ?? 0}%`}
      />

      <Text style={styles.lastActivity}>
        Last activity: {formatRelativeTime(goal.updatedAt)}
      </Text>

      <View style={styles.actions}>
        <Pressable
          onPress={onViewHistory}
          style={styles.actionBtn}
          accessibilityRole="button"
        >
          <Text style={styles.actionText}>View history</Text>
        </Pressable>
        <Pressable
          onPress={onLogEvent}
          style={styles.actionBtn}
          accessibilityRole="button"
        >
          <Text style={styles.actionText}>Log event</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#F5F5F3',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)',
    padding: 16,
    gap: 8,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: 17,
    fontWeight: '500',
    color: '#1A1A1A',
    flex: 1,
    marginRight: 8,
  },
  target: {
    fontSize: 12,
    color: '#6B6B68',
  },
  lastActivity: {
    fontSize: 12,
    color: '#A8A8A4',
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    backgroundColor: '#EBEBEA',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  actionText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#6B6B68',
  },
});
