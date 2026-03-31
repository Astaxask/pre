import { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  ToastAndroid,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlertCard } from '../components/AlertCard';
import { GatewayStatusBanner } from '../components/GatewayStatusBanner';
import { useGatewayContext } from '../context/GatewayContext';
import { useTheme } from '../theme/useTheme';
import type { Alert, AlertSeverity } from '../types';

const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  intervention: 0,
  warning: 1,
  info: 2,
};

function sortAlerts(alerts: Alert[]): Alert[] {
  return [...alerts].sort((a, b) => {
    const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return b.createdAt - a.createdAt;
  });
}

function SwipeableAlertCard({
  alert,
  onDismiss,
  onSnooze,
  onAct,
}: {
  alert: Alert;
  onDismiss: () => void;
  onSnooze: () => void;
  onAct: () => void;
}) {
  const translateX = useRef(new Animated.Value(0)).current;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) =>
        Math.abs(gestureState.dx) > 10 && gestureState.dx < 0,
      onPanResponderMove: (_, gestureState) => {
        if (gestureState.dx < 0) {
          translateX.setValue(gestureState.dx);
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dx < -120) {
          Animated.timing(translateX, {
            toValue: -400,
            duration: 200,
            useNativeDriver: true,
          }).start(onDismiss);
        } else {
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
          }).start();
        }
      },
    }),
  ).current;

  return (
    <View style={swipeStyles.wrapper}>
      <View style={swipeStyles.behindCard}>
        <Pressable onPress={onDismiss} style={swipeStyles.dismissBg}>
          <Text style={swipeStyles.dismissText}>Dismiss</Text>
        </Pressable>
      </View>
      <Animated.View
        style={{ transform: [{ translateX }] }}
        {...panResponder.panHandlers}
      >
        <AlertCard
          alert={alert}
          onDismiss={onDismiss}
          onSnooze={onSnooze}
          onAct={onAct}
        />
      </Animated.View>
    </View>
  );
}

export function AlertsScreen() {
  const tokens = useTheme();
  const insets = useSafeAreaInsets();
  const { connected, alerts, sendMessage } = useGatewayContext();
  const [refreshing, setRefreshing] = useState(false);

  const sorted = sortAlerts(alerts);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    sendMessage({ type: 'trigger-sync', source: 'plaid' });
    sendMessage({ type: 'trigger-sync', source: 'google-calendar' });
    setTimeout(() => setRefreshing(false), 2000);
  }, [sendMessage]);

  const handleDismiss = useCallback(
    (alertId: string) => {
      sendMessage({ type: 'dismiss-alert', alertId });
    },
    [sendMessage],
  );

  const handleSnooze = useCallback(
    (alert: Alert) => {
      sendMessage({
        type: 'snooze-alert',
        alertId: alert.id,
        durationHours: 24,
        alert,
      });
      if (Platform.OS === 'android') {
        ToastAndroid.show('Snoozed for 24 hours', ToastAndroid.SHORT);
      }
    },
    [sendMessage],
  );

  const renderItem = useCallback(
    ({ item }: { item: Alert }) => (
      <View style={styles.cardWrapper}>
        <SwipeableAlertCard
          alert={item}
          onDismiss={() => handleDismiss(item.id)}
          onSnooze={() => handleSnooze(item)}
          onAct={() => {}}
        />
      </View>
    ),
    [handleDismiss, handleSnooze],
  );

  const keyExtractor = useCallback((item: Alert) => item.id, []);

  return (
    <View
      style={[styles.container, { backgroundColor: tokens.surface, paddingTop: insets.top }]}
    >
      <GatewayStatusBanner connected={connected} />
      <FlatList
        data={sorted}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={sorted.length === 0 ? styles.emptyContainer : styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={
          <View style={styles.emptyState} testID="alerts-empty">
            <Text style={[styles.emptyTitle, { color: tokens.textPrimary }]}>
              No alerts right now.
            </Text>
            <Text style={[styles.emptySubtext, { color: tokens.textSecondary }]}>
              PRE is watching.
            </Text>
          </View>
        }
        testID="alerts-list"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  listContent: {
    padding: 16,
    gap: 12,
  },
  emptyContainer: {
    flex: 1,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '500',
    lineHeight: 24,
  },
  emptySubtext: {
    fontSize: 15,
    lineHeight: 24,
    marginTop: 4,
  },
  cardWrapper: {
    marginBottom: 12,
  },
});

const swipeStyles = StyleSheet.create({
  wrapper: {
    position: 'relative',
  },
  behindCard: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingRight: 16,
  },
  dismissBg: {
    backgroundColor: '#C0392B',
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
    minHeight: 44,
    justifyContent: 'center',
  },
  dismissText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 14,
  },
});
