import { useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { DomainTag } from './DomainTag';
import { ConfidenceBar } from './ConfidenceBar';

type LifeInsight = {
  id: string;
  generatedAt: number;
  domains: string[];
  insightType: string;
  confidence: number;
  payload: { description: string; metadata: Record<string, unknown> };
  expiresAt: number;
  privacyLevel: string;
};

type InsightCardProps = {
  insight: LifeInsight;
  expanded?: boolean;
  onDismiss?: () => void;
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

export function InsightCard({ insight, expanded: initialExpanded = false, onDismiss }: InsightCardProps) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const animHeight = useSharedValue(initialExpanded ? 1 : 0);

  const toggleExpand = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    animHeight.value = withTiming(next ? 1 : 0, { duration: 200 });
  }, [expanded, animHeight]);

  const animatedStyle = useAnimatedStyle(() => ({
    maxHeight: animHeight.value * 300,
    opacity: animHeight.value,
  }));

  const isExpired = insight.expiresAt < Date.now();

  return (
    <View
      style={[styles.card, isExpired && styles.expired]}
      testID="insight-card"
    >
      <Pressable
        onPress={toggleExpand}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        style={styles.header}
      >
        <View style={styles.topRow}>
          <View style={styles.tags}>
            {insight.domains.map((domain) => (
              <DomainTag key={domain} domain={domain} size="sm" />
            ))}
          </View>
          <View style={styles.timeRow}>
            {isExpired && <Text style={styles.expiredText}>Expired</Text>}
            <Text style={styles.time}>{formatRelativeTime(insight.generatedAt)}</Text>
          </View>
        </View>
        <Text style={styles.summary} numberOfLines={expanded ? undefined : 2}>
          {insight.payload.description}
        </Text>
      </Pressable>

      <Animated.View style={[styles.expandedContent, animatedStyle]}>
        <View style={styles.expandedInner}>
          <Text style={styles.description}>{insight.payload.description}</Text>
          <ConfidenceBar value={insight.confidence} />
          <Text style={styles.basis}>
            Type: {insight.insightType.replace(/-/g, ' ')}
          </Text>
          {onDismiss && (
            <Pressable
              onPress={onDismiss}
              style={styles.dismissBtn}
              accessibilityRole="button"
              accessibilityLabel="Dismiss insight"
            >
              <Text style={styles.dismissText}>Dismiss</Text>
            </Pressable>
          )}
        </View>
      </Animated.View>
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
  },
  expired: {
    opacity: 0.4,
  },
  header: {
    gap: 8,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  tags: {
    flexDirection: 'row',
    gap: 4,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  expiredText: {
    fontSize: 12,
    color: '#C0392B',
    fontWeight: '400',
  },
  time: {
    fontSize: 11,
    color: '#A8A8A4',
  },
  summary: {
    fontSize: 15,
    lineHeight: 24,
    color: '#1A1A1A',
  },
  expandedContent: {
    overflow: 'hidden',
  },
  expandedInner: {
    marginTop: 12,
    gap: 12,
  },
  description: {
    fontSize: 15,
    lineHeight: 24,
    color: '#6B6B68',
  },
  basis: {
    fontSize: 12,
    color: '#A8A8A4',
  },
  dismissBtn: {
    backgroundColor: '#EBEBEA',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  dismissText: {
    fontSize: 12,
    color: '#6B6B68',
    fontWeight: '500',
  },
});
