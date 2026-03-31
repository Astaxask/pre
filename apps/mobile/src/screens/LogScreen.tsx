import { useCallback, useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Crypto from 'expo-crypto';
import { DomainTag } from '../components/DomainTag';
import { GatewayStatusBanner } from '../components/GatewayStatusBanner';
import { useGatewayContext } from '../context/GatewayContext';
import { useTheme } from '../theme/useTheme';
import type { LifeDomain } from '../types';

const ALL_DOMAINS: LifeDomain[] = ['body', 'money', 'people', 'time', 'mind', 'world'];

export function LogScreen() {
  const tokens = useTheme();
  const insets = useSafeAreaInsets();
  const { connected, sendMessage, lastMessage } = useGatewayContext();
  const [text, setText] = useState('');
  const [selectedDomain, setSelectedDomain] = useState<LifeDomain>('mind');
  const [toast, setToast] = useState<'success' | 'error' | null>(null);
  const toastOpacity = useRef(new Animated.Value(0)).current;

  const canLog = text.trim().length >= 3 && selectedDomain !== undefined;

  const showToast = useCallback(
    (type: 'success' | 'error') => {
      setToast(type);
      Animated.sequence([
        Animated.timing(toastOpacity, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.delay(1300),
        Animated.timing(toastOpacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start(() => setToast(null));
    },
    [toastOpacity],
  );

  // Listen for sync-status responses to our log-event
  useEffect(() => {
    if (!lastMessage) return;
    const msg = lastMessage as Record<string, unknown>;
    if (msg.type === 'sync-status') {
      const payload = msg.payload as Record<string, unknown> | undefined;
      if (payload?.source === 'manual') {
        if (payload.status === 'logged') {
          showToast('success');
          setText('');
        } else if (typeof payload.status === 'string' && payload.status.startsWith('log-failed')) {
          showToast('error');
        }
      }
    } else if (msg.type === 'error') {
      showToast('error');
    }
  }, [lastMessage, showToast]);

  const handleLog = useCallback(async () => {
    if (!canLog) return;

    const trimmed = text.trim();
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;

    // PRIVACY: Only the SHA-256 hash and word count leave the device.
    // Raw note text NEVER travels over the WebSocket.
    const contentHash = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      trimmed,
    );

    const eventId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    sendMessage({
      type: 'log-event',
      payload: {
        id: eventId,
        source: 'manual',
        sourceId: eventId,
        domain: selectedDomain,
        eventType: `${selectedDomain}.manual-log`,
        timestamp: Date.now(),
        ingestedAt: Date.now(),
        payload: {
          domain: selectedDomain,
          subtype: 'manual-log',
          contentHash,
          wordCount,
        },
        embedding: null,
        summary: null,
        privacyLevel: 'private',
        confidence: 1.0,
      },
    });
  }, [canLog, text, selectedDomain, sendMessage]);

  return (
    <View
      style={[styles.container, { backgroundColor: tokens.surface, paddingTop: insets.top }]}
    >
      <GatewayStatusBanner connected={connected} />

      <View style={styles.content}>
        <TextInput
          placeholder="What's happening?"
          placeholderTextColor={tokens.textTertiary}
          value={text}
          onChangeText={setText}
          multiline
          maxLength={500}
          style={[
            styles.textInput,
            {
              color: tokens.textPrimary,
              backgroundColor: tokens.surfaceRaised,
              borderColor: tokens.border,
            },
          ]}
          testID="log-text-input"
        />

        <Text style={[styles.sectionLabel, { color: tokens.textSecondary }]}>
          Domain
        </Text>
        <View style={styles.domainGrid}>
          {ALL_DOMAINS.map((d) => (
            <Pressable
              key={d}
              onPress={() => setSelectedDomain(d)}
              style={[
                styles.domainCell,
                selectedDomain === d && {
                  borderColor: tokens.accent,
                  borderWidth: 2,
                  borderRadius: 12,
                },
              ]}
              testID={`log-domain-${d}`}
            >
              <DomainTag domain={d} size="md" />
            </Pressable>
          ))}
        </View>

        <Pressable
          onPress={handleLog}
          disabled={!canLog}
          style={[
            styles.logBtn,
            {
              backgroundColor: canLog ? tokens.accent : tokens.surfaceSunken,
            },
          ]}
          accessibilityRole="button"
          testID="log-submit-btn"
        >
          <Text
            style={[
              styles.logBtnText,
              { color: canLog ? '#FFFFFF' : tokens.textTertiary },
            ]}
          >
            Log it →
          </Text>
        </Pressable>

        {/* Recent logs */}
        <View style={styles.recentSection}>
          <Text style={[styles.recentTitle, { color: tokens.textSecondary }]}>
            Recent logs
          </Text>
          <Text style={[styles.recentHint, { color: tokens.textTertiary }]}>
            Manual logs appear here after syncing.
          </Text>
        </View>
      </View>

      {/* Toast */}
      {toast && (
        <Animated.View
          style={[
            styles.toast,
            {
              opacity: toastOpacity,
              backgroundColor:
                toast === 'success' ? tokens.positive : tokens.negative,
            },
          ]}
          testID="log-toast"
        >
          <Text style={styles.toastText}>
            {toast === 'success' ? 'Logged' : 'Failed to log'}
          </Text>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    padding: 16,
  },
  textInput: {
    fontSize: 17,
    lineHeight: 24,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    minHeight: 120,
    textAlignVertical: 'top',
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '500',
    marginTop: 20,
    marginBottom: 12,
  },
  domainGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  domainCell: {
    padding: 4,
  },
  logBtn: {
    marginTop: 24,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  logBtnText: {
    fontSize: 17,
    fontWeight: '600',
  },
  recentSection: {
    marginTop: 32,
  },
  recentTitle: {
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 8,
  },
  recentHint: {
    fontSize: 13,
  },
  toast: {
    position: 'absolute',
    bottom: 100,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  toastText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '500',
  },
});
