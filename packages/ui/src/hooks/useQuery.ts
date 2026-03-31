import { useCallback, useRef, useState } from 'react';
import type { LifeEvent } from '@pre/shared';
import { useGateway } from './useGateway.js';

export class QueryTimeoutError extends Error {
  constructor(requestId: string) {
    super(`Query timed out: ${requestId}`);
    this.name = 'QueryTimeoutError';
  }
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

const QUERY_TIMEOUT_MS = 10_000;

type QueryRequest = Record<string, unknown>;

export function useQuery() {
  const { connected, lastMessage, sendMessage } = useGateway();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const pendingRef = useRef<
    Map<string, { resolve: (events: LifeEvent[]) => void; reject: (err: Error) => void }>
  >(new Map());

  // Process incoming query results
  if (lastMessage?.type === 'query-result') {
    const result = lastMessage.payload as { requestId: string; events: LifeEvent[] };
    const pending = pendingRef.current.get(result.requestId);
    if (pending) {
      pending.resolve(result.events);
      pendingRef.current.delete(result.requestId);
    }
  }

  const sendQuery = useCallback(
    (request: QueryRequest): Promise<LifeEvent[]> => {
      if (!connected) {
        return Promise.reject(new Error('Not connected to gateway'));
      }

      const requestId = generateId();
      setLoading(true);
      setError(null);

      return new Promise<LifeEvent[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRef.current.delete(requestId);
          const err = new QueryTimeoutError(requestId);
          setError(err);
          setLoading(false);
          reject(err);
        }, QUERY_TIMEOUT_MS);

        pendingRef.current.set(requestId, {
          resolve: (events) => {
            clearTimeout(timer);
            setLoading(false);
            resolve(events);
          },
          reject: (err) => {
            clearTimeout(timer);
            setLoading(false);
            setError(err);
            reject(err);
          },
        });

        sendMessage({ type: 'query', payload: { requestId, ...request } });
      });
    },
    [connected, sendMessage],
  );

  return { sendQuery, loading, error };
}
