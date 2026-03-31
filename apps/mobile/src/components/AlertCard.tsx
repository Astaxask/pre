import { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { DomainTag } from './DomainTag';

type AlertSeverity = 'info' | 'warning' | 'intervention';

type Alert = {
  id: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  domains: string[];
  createdAt: number;
  whyExplanation: string;
  dismissed?: boolean;
};

type AlertCardProps = {
  alert: Alert;
  onDismiss?: () => void;
  onSnooze?: () => void;
  onAct?: () => void;
};

const SEVERITY_COLORS: Record<AlertSeverity, string> = {
  info: '#2D5BE3',
  warning: '#B07A00',
  intervention: '#C0392B',
};

const SEVERITY_LABELS: Record<AlertSeverity, string> = {
  info: 'Info',
  warning: 'Warning',
  intervention: 'Intervention',
};

export function AlertCard({ alert, onDismiss, onSnooze, onAct }: AlertCardProps) {
  const [showWhy, setShowWhy] = useState(false);
  const borderColor = SEVERITY_COLORS[alert.severity];

  return (
    <View
      style={[styles.card, { borderLeftColor: borderColor }]}
      testID="alert-card"
    >
      {/* Header row */}
      <View style={styles.headerRow}>
        <View
          style={[styles.badge, { backgroundColor: borderColor }]}
        >
          <Text style={styles.badgeText}>
            {SEVERITY_LABELS[alert.severity]}
          </Text>
        </View>
        <View style={styles.domainTags}>
          {alert.domains.map((d) => (
            <DomainTag key={d} domain={d} size="sm" />
          ))}
        </View>
      </View>

      {/* Content */}
      <Text style={styles.headline}>{alert.title}</Text>
      <Text style={styles.explanation} numberOfLines={3}>
        {alert.body}
      </Text>

      {/* Why section */}
      <Pressable
        onPress={() => setShowWhy((prev) => !prev)}
        accessibilityRole="button"
        accessibilityState={{ expanded: showWhy }}
        testID="why-toggle"
      >
        <Text style={styles.whyLink}>Why am I seeing this?</Text>
      </Pressable>
      {showWhy && (
        <Text style={styles.whyText} testID="why-explanation">
          {alert.whyExplanation}
        </Text>
      )}

      {/* Action buttons */}
      <View style={styles.actions}>
        <Pressable
          onPress={onDismiss}
          style={[styles.actionBtn, styles.dismissBtn]}
          accessibilityRole="button"
          accessibilityLabel="Dismiss alert"
          testID="alert-dismiss"
        >
          <Text style={styles.actionText}>Dismiss</Text>
        </Pressable>
        <Pressable
          onPress={onSnooze}
          style={styles.actionBtn}
          accessibilityRole="button"
          accessibilityLabel="Snooze for one day"
        >
          <Text style={styles.actionText}>Snooze 1d</Text>
        </Pressable>
        <Pressable
          onPress={onAct}
          style={[styles.actionBtn, styles.actBtn]}
          accessibilityRole="button"
          accessibilityLabel="Act on this alert"
        >
          <Text style={styles.actBtnText}>Act on it</Text>
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
    borderLeftWidth: 4,
    padding: 16,
    gap: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 9999,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '500',
    color: '#FFFFFF',
  },
  domainTags: {
    flexDirection: 'row',
    gap: 4,
  },
  headline: {
    fontSize: 17,
    fontWeight: '500',
    lineHeight: 24,
    color: '#1A1A1A',
  },
  explanation: {
    fontSize: 15,
    lineHeight: 24,
    color: '#6B6B68',
  },
  whyLink: {
    fontSize: 12,
    color: '#A8A8A4',
    textDecorationLine: 'underline',
  },
  whyText: {
    fontSize: 12,
    color: '#A8A8A4',
    lineHeight: 18,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  actionBtn: {
    backgroundColor: '#EBEBEA',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    minHeight: 44,
    justifyContent: 'center',
  },
  dismissBtn: {
    paddingHorizontal: 16,
    flex: 1,
  },
  actionText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#1A1A1A',
    textAlign: 'center',
  },
  actBtn: {
    backgroundColor: '#2D5BE3',
  },
  actBtnText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#FFFFFF',
    textAlign: 'center',
  },
});
