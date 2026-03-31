import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GoalCard } from '../components/GoalCard';
import { DomainTag } from '../components/DomainTag';
import { GatewayStatusBanner } from '../components/GatewayStatusBanner';
import { useGatewayContext } from '../context/GatewayContext';
import { useTheme } from '../theme/useTheme';
import type { Goal, LifeDomain } from '../types';

const ALL_DOMAINS: LifeDomain[] = ['body', 'money', 'people', 'time', 'mind', 'world'];

export function GoalsScreen() {
  const tokens = useTheme();
  const insets = useSafeAreaInsets();
  const { connected, sendMessage, lastMessage } = useGatewayContext();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [showAddSheet, setShowAddSheet] = useState(false);
  const [showLogSheet, setShowLogSheet] = useState(false);
  const [logGoalDomain, setLogGoalDomain] = useState<string>('mind');
  const [historyGoal, setHistoryGoal] = useState<Goal | null>(null);

  // Fetch goals on mount
  useEffect(() => {
    sendMessage({
      type: 'query',
      requestId: 'goals-fetch',
      payload: { method: 'goals' },
    });
  }, [sendMessage]);

  // Listen for goal query results
  useEffect(() => {
    if (
      lastMessage?.type === 'query-result' &&
      (lastMessage as Record<string, unknown>).requestId === 'goals-fetch'
    ) {
      const payload = (lastMessage as Record<string, unknown>).payload;
      if (Array.isArray(payload)) {
        setGoals(payload as Goal[]);
      }
    }
  }, [lastMessage]);

  const handleLogEvent = useCallback(
    (domain: string) => {
      setLogGoalDomain(domain);
      setShowLogSheet(true);
    },
    [],
  );

  const renderItem = useCallback(
    ({ item }: { item: Goal }) => (
      <View style={styles.cardWrapper}>
        <GoalCard
          goal={item}
          onViewHistory={() => setHistoryGoal(item)}
          onLogEvent={() => handleLogEvent(item.domain)}
        />
      </View>
    ),
    [handleLogEvent],
  );

  const keyExtractor = useCallback((item: Goal) => item.id, []);

  return (
    <View
      style={[styles.container, { backgroundColor: tokens.surface, paddingTop: insets.top }]}
    >
      <GatewayStatusBanner connected={connected} />

      <FlatList
        data={goals}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={
          goals.length === 0 ? styles.emptyContainer : styles.listContent
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={[styles.emptyText, { color: tokens.textSecondary }]}>
              No goals yet. Tap + to create one.
            </Text>
          </View>
        }
        testID="goals-list"
      />

      {/* FAB */}
      <Pressable
        onPress={() => setShowAddSheet(true)}
        style={[styles.fab, { backgroundColor: tokens.accent }]}
        accessibilityRole="button"
        accessibilityLabel="Add new goal"
        testID="add-goal-fab"
      >
        <Text style={styles.fabText}>+</Text>
      </Pressable>

      <AddGoalSheet
        visible={showAddSheet}
        onClose={() => setShowAddSheet(false)}
        onSave={(title, domain, targetDate) => {
          sendMessage({
            type: 'create-goal',
            payload: { title, domain, targetDate },
          });
          setShowAddSheet(false);
          // Re-fetch goals
          setTimeout(() => {
            sendMessage({
              type: 'query',
              requestId: 'goals-fetch',
              payload: { method: 'goals' },
            });
          }, 500);
        }}
        tokens={tokens}
      />

      <GoalHistorySheet
        visible={historyGoal !== null}
        goal={historyGoal}
        onClose={() => setHistoryGoal(null)}
        sendMessage={sendMessage}
        lastMessage={lastMessage}
        tokens={tokens}
      />

      <LogEventSheet
        visible={showLogSheet}
        domain={logGoalDomain}
        onClose={() => setShowLogSheet(false)}
        onLog={(text, domain) => {
          const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
          // Hash the text on device — only hash + wordCount travel
          sendMessage({
            type: 'log-event',
            payload: {
              id: `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              source: 'manual',
              sourceId: `manual-${Date.now()}`,
              domain,
              eventType: `${domain}.manual-log`,
              timestamp: Date.now(),
              ingestedAt: Date.now(),
              payload: {
                domain,
                subtype: 'manual-log',
                contentHash: 'device-only',
                wordCount,
              },
              embedding: null,
              summary: null,
              privacyLevel: 'private',
              confidence: 1.0,
            },
          });
          setShowLogSheet(false);
        }}
        tokens={tokens}
      />
    </View>
  );
}

function AddGoalSheet({
  visible,
  onClose,
  onSave,
  tokens,
}: {
  visible: boolean;
  onClose: () => void;
  onSave: (title: string, domain: string, targetDate: number | null) => void;
  tokens: ReturnType<typeof useTheme>;
}) {
  const [title, setTitle] = useState('');
  const [selectedDomain, setSelectedDomain] = useState<LifeDomain>('mind');

  const canSave = title.trim().length >= 5;

  const handleSave = () => {
    onSave(title.trim(), selectedDomain, null);
    setTitle('');
    setSelectedDomain('mind');
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[sheetStyles.container, { backgroundColor: tokens.surface }]}
      >
        <View style={sheetStyles.handle} />
        <Text style={[sheetStyles.sheetTitle, { color: tokens.textPrimary }]}>
          New Goal
        </Text>

        <TextInput
          placeholder="What's the goal?"
          placeholderTextColor={tokens.textTertiary}
          value={title}
          onChangeText={setTitle}
          autoFocus
          style={[
            sheetStyles.input,
            {
              color: tokens.textPrimary,
              backgroundColor: tokens.surfaceRaised,
              borderColor: tokens.border,
            },
          ]}
          testID="goal-title-input"
        />

        <Text style={[sheetStyles.label, { color: tokens.textSecondary }]}>
          Domain
        </Text>
        <View style={sheetStyles.domainGrid}>
          {ALL_DOMAINS.map((d) => (
            <DomainTag
              key={d}
              domain={d}
              size="md"
              onPress={() => setSelectedDomain(d)}
            />
          ))}
        </View>

        <Pressable
          onPress={handleSave}
          disabled={!canSave}
          style={[
            sheetStyles.saveBtn,
            {
              backgroundColor: canSave ? tokens.accent : tokens.surfaceSunken,
            },
          ]}
          accessibilityRole="button"
          testID="save-goal-btn"
        >
          <Text
            style={[
              sheetStyles.saveBtnText,
              { color: canSave ? '#FFFFFF' : tokens.textTertiary },
            ]}
          >
            Save
          </Text>
        </Pressable>

        <Pressable onPress={onClose} style={sheetStyles.cancelBtn}>
          <Text style={[sheetStyles.cancelText, { color: tokens.textSecondary }]}>
            Cancel
          </Text>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function LogEventSheet({
  visible,
  domain,
  onClose,
  onLog,
  tokens,
}: {
  visible: boolean;
  domain: string;
  onClose: () => void;
  onLog: (text: string, domain: string) => void;
  tokens: ReturnType<typeof useTheme>;
}) {
  const [text, setText] = useState('');

  const handleLog = () => {
    onLog(text, domain);
    setText('');
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[sheetStyles.container, { backgroundColor: tokens.surface }]}
      >
        <View style={sheetStyles.handle} />
        <Text style={[sheetStyles.sheetTitle, { color: tokens.textPrimary }]}>
          Log Event
        </Text>

        <TextInput
          placeholder="What happened?"
          placeholderTextColor={tokens.textTertiary}
          value={text}
          onChangeText={setText}
          multiline
          autoFocus
          style={[
            sheetStyles.input,
            sheetStyles.multilineInput,
            {
              color: tokens.textPrimary,
              backgroundColor: tokens.surfaceRaised,
              borderColor: tokens.border,
            },
          ]}
        />

        <Pressable
          onPress={handleLog}
          disabled={text.trim().length < 3}
          style={[
            sheetStyles.saveBtn,
            {
              backgroundColor:
                text.trim().length >= 3 ? tokens.accent : tokens.surfaceSunken,
            },
          ]}
          accessibilityRole="button"
        >
          <Text
            style={[
              sheetStyles.saveBtnText,
              {
                color:
                  text.trim().length >= 3 ? '#FFFFFF' : tokens.textTertiary,
              },
            ]}
          >
            Log it
          </Text>
        </Pressable>

        <Pressable onPress={onClose} style={sheetStyles.cancelBtn}>
          <Text style={[sheetStyles.cancelText, { color: tokens.textSecondary }]}>
            Cancel
          </Text>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

type HistoryEvent = {
  id: string;
  eventType: string;
  timestamp: number;
  payload: { progressPercent?: number; progressNote?: string; wordCount?: number };
};

function GoalHistorySheet({
  visible,
  goal,
  onClose,
  sendMessage,
  lastMessage,
  tokens,
}: {
  visible: boolean;
  goal: Goal | null;
  onClose: () => void;
  sendMessage: (msg: Record<string, unknown>) => void;
  lastMessage: Record<string, unknown> | null;
  tokens: ReturnType<typeof useTheme>;
}) {
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const requestIdRef = useRef(`goal-history-${Date.now()}`);

  useEffect(() => {
    if (visible && goal) {
      setLoading(true);
      setEvents([]);
      const rid = `goal-history-${Date.now()}`;
      requestIdRef.current = rid;
      sendMessage({
        type: 'query',
        requestId: rid,
        payload: { method: 'goal-events', goalId: goal.id, days: 90 },
      });
    }
  }, [visible, goal, sendMessage]);

  useEffect(() => {
    if (
      lastMessage?.type === 'query-result' &&
      lastMessage.requestId === requestIdRef.current
    ) {
      const payload = lastMessage.payload;
      if (Array.isArray(payload)) {
        setEvents(payload as HistoryEvent[]);
      }
      setLoading(false);
    }
  }, [lastMessage]);

  if (!goal) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[sheetStyles.container, { backgroundColor: tokens.surface }]}>
        <View style={sheetStyles.handle} />
        <Text style={[sheetStyles.sheetTitle, { color: tokens.textPrimary }]}>
          {goal.title}
        </Text>
        <Text style={[{ color: tokens.textSecondary, fontSize: 13, marginBottom: 16 }]}>
          Last 90 days of activity
        </Text>

        {loading ? (
          <Text style={{ color: tokens.textTertiary, textAlign: 'center', marginTop: 32 }}>
            Loading...
          </Text>
        ) : events.length === 0 ? (
          <Text
            style={{ color: tokens.textTertiary, textAlign: 'center', marginTop: 32 }}
            testID="goal-history-empty"
          >
            No events logged for this goal yet.
          </Text>
        ) : (
          <FlatList
            data={events}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <View style={{
                paddingVertical: 12,
                borderBottomWidth: 0.5,
                borderBottomColor: tokens.border,
              }}>
                <Text style={{ color: tokens.textPrimary, fontSize: 15 }}>
                  {item.eventType}
                </Text>
                {item.payload.progressPercent !== undefined && (
                  <Text style={{ color: tokens.textSecondary, fontSize: 13, marginTop: 2 }}>
                    Progress: {item.payload.progressPercent}%
                  </Text>
                )}
                <Text style={{ color: tokens.textTertiary, fontSize: 12, marginTop: 2 }}>
                  {new Date(item.timestamp).toLocaleDateString()}
                </Text>
              </View>
            )}
            testID="goal-history-list"
          />
        )}

        <Pressable onPress={onClose} style={sheetStyles.cancelBtn}>
          <Text style={[sheetStyles.cancelText, { color: tokens.textSecondary }]}>
            Close
          </Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  listContent: {
    padding: 16,
  },
  emptyContainer: {
    flex: 1,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    fontSize: 15,
    lineHeight: 24,
  },
  cardWrapper: {
    marginBottom: 12,
  },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  fabText: {
    fontSize: 28,
    color: '#FFFFFF',
    lineHeight: 30,
  },
});

const sheetStyles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    paddingTop: 12,
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: 'rgba(0,0,0,0.15)',
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 16,
  },
  sheetTitle: {
    fontSize: 20,
    fontWeight: '500',
    marginBottom: 20,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    marginTop: 16,
    marginBottom: 8,
  },
  input: {
    fontSize: 17,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  multilineInput: {
    minHeight: 100,
    textAlignVertical: 'top',
  },
  domainGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  saveBtn: {
    marginTop: 24,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  saveBtnText: {
    fontSize: 15,
    fontWeight: '600',
  },
  cancelBtn: {
    marginTop: 12,
    alignItems: 'center',
    paddingVertical: 10,
  },
  cancelText: {
    fontSize: 15,
  },
});
