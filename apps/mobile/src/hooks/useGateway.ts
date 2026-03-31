import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const DEFAULT_GATEWAY_URL = 'ws://localhost:18789';
const MAX_BACKOFF_MS = 30_000;
const CACHED_ALERTS_KEY = 'cached-alerts';
const GATEWAY_URL_KEY = 'gatewayUrl';

export type AlertSeverity = 'info' | 'warning' | 'intervention';

export type Alert = {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  domains: string[];
  createdAt: number;
  insightId: string;
  whyExplanation: string;
  dismissed?: boolean;
};

export type InsightType =
  | 'pattern-detected'
  | 'trend-change'
  | 'goal-drift'
  | 'conflict-detected'
  | 'anomaly'
  | 'correlation';

export type LifeInsight = {
  id: string;
  generatedAt: number;
  domains: string[];
  insightType: InsightType;
  confidence: number;
  payload: { description: string; metadata: Record<string, unknown> };
  expiresAt: number;
  privacyLevel: string;
};

type GatewayMessage = {
  type: string;
  payload?: unknown;
  requestId?: string;
  error?: string;
};

export function useGateway() {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<GatewayMessage | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [insights, setInsights] = useState<LifeInsight[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appStateRef = useRef<AppStateStatus>('active');
  const gatewayUrlRef = useRef<string>(DEFAULT_GATEWAY_URL);

  // Load cached alerts on mount
  useEffect(() => {
    AsyncStorage.getItem(CACHED_ALERTS_KEY).then((cached) => {
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as Alert[];
          setAlerts(parsed);
        } catch {
          // ignore
        }
      }
    });
    AsyncStorage.getItem(GATEWAY_URL_KEY).then((url) => {
      if (url) {
        gatewayUrlRef.current = url;
      }
    });
  }, []);

  // Persist alerts when they change
  useEffect(() => {
    if (alerts.length > 0) {
      AsyncStorage.setItem(
        CACHED_ALERTS_KEY,
        JSON.stringify(alerts.slice(0, 20)),
      ).catch(() => {});
    }
  }, [alerts]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket(gatewayUrlRef.current);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        retriesRef.current = 0;
      };

      ws.onmessage = (event: WebSocketMessageEvent) => {
        try {
          const data = JSON.parse(String(event.data)) as GatewayMessage;
          setLastMessage(data);

          if (data.type === 'alert') {
            setAlerts((prev) => [data.payload as Alert, ...prev]);
          } else if (data.type === 'insight-update') {
            setInsights(data.payload as LifeInsight[]);
          }
        } catch {
          // ignore malformed
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        scheduleReconnect();
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      scheduleReconnect();
    }
  }, []);

  function scheduleReconnect() {
    // Don't reconnect in background
    if (appStateRef.current !== 'active') return;

    const delay = Math.min(1000 * 2 ** retriesRef.current, MAX_BACKOFF_MS);
    retriesRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      connect();
    }, delay);
  }

  const sendMessage = useCallback((message: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  // AppState handling
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;

      if (nextState === 'active' && prev !== 'active') {
        // Foregrounding — immediately reconnect
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          retriesRef.current = 0;
          connect();
        }
      } else if (nextState === 'background') {
        // Backgrounding — pause reconnect
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
      }
    });

    return () => sub.remove();
  }, [connect]);

  // Initial connection
  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  const updateGatewayUrl = useCallback(async (url: string) => {
    gatewayUrlRef.current = url;
    await AsyncStorage.setItem(GATEWAY_URL_KEY, url);
    // Close existing and reconnect
    wsRef.current?.close();
    retriesRef.current = 0;
    setTimeout(() => connect(), 100);
  }, [connect]);

  const disconnect = useCallback(async () => {
    await AsyncStorage.removeItem(GATEWAY_URL_KEY);
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
  }, []);

  return {
    connected,
    lastMessage,
    sendMessage,
    alerts,
    insights,
    updateGatewayUrl,
    disconnect,
    gatewayUrl: gatewayUrlRef.current,
  };
}
