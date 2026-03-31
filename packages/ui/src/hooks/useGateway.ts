import { useCallback, useEffect, useRef, useState } from "react";
import type { Alert, LifeInsight } from "../types.js";

type GatewayMessage = {
  type: string;
  payload: unknown;
};

const GATEWAY_URL = "ws://localhost:18789";
const MAX_BACKOFF_MS = 30_000;

export function useGateway() {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<GatewayMessage | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [insights, setInsights] = useState<LifeInsight[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(GATEWAY_URL);
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      setConnected(true);
      retriesRef.current = 0;
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data)) as GatewayMessage;
        setLastMessage(data);

        if (data.type === "alert") {
          setAlerts((prev) => [data.payload as Alert, ...prev]);
        } else if (data.type === "alert-dismissed") {
          const dismissedId = (data as unknown as { alertId: string }).alertId;
          setAlerts((prev) => prev.filter((a) => a.id !== dismissedId));
        } else if (data.type === "insight-update") {
          setInsights(data.payload as LifeInsight[]);
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.addEventListener("close", () => {
      setConnected(false);
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      ws.close();
    });
  }, []);

  function scheduleReconnect() {
    const delay = Math.min(1000 * 2 ** retriesRef.current, MAX_BACKOFF_MS);
    retriesRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      connect();
    }, delay);
  }

  const sendMessage = useCallback((message: GatewayMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  return { connected, lastMessage, sendMessage, alerts, insights };
}
