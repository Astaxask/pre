import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { LifeDomain, LifeEvent } from '@pre/shared';

const SOCKET_PATH = process.env['PRE_SIDECAR_SOCK'] ?? '/tmp/pre-sidecar.sock';
const DEFAULT_TIMEOUT_MS = 30_000;

export class SidecarTimeoutError extends Error {
  constructor(method: string) {
    super(`Sidecar request timed out after ${DEFAULT_TIMEOUT_MS}ms: ${method}`);
    this.name = 'SidecarTimeoutError';
  }
}

export class SidecarNotAvailableError extends Error {
  constructor(reason: string) {
    super(`Sidecar not available: ${reason}`);
    this.name = 'SidecarNotAvailableError';
  }
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type JSONRPCResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

export class SidecarClient {
  private socket: Socket | null = null;
  private pending = new Map<string, PendingRequest>();
  private buffer = '';
  private socketPath: string;

  constructor(socketPath?: string) {
    this.socketPath = socketPath ?? SOCKET_PATH;
  }

  private async connect(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) {
      return this.socket;
    }

    return new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(this.socketPath, () => {
        this.socket = socket;
        resolve(socket);
      });

      socket.on('error', (err) => {
        this.socket = null;
        reject(new SidecarNotAvailableError(err.message));
      });

      socket.on('close', () => {
        this.socket = null;
      });

      socket.on('data', (data) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new SidecarNotAvailableError('Connection timeout'));
      });
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const response = JSON.parse(line) as JSONRPCResponse;
        const id = String(response.id);
        const pending = this.pending.get(id);
        if (!pending) continue;

        this.pending.delete(id);
        clearTimeout(pending.timer);

        if (response.error) {
          pending.reject(new Error(`Sidecar RPC error: ${response.error.message}`));
        } else {
          pending.resolve(response.result);
        }
      } catch {
        // Ignore malformed responses
      }
    }
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const socket = await this.connect();
    const id = randomUUID();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SidecarTimeoutError(method));
      }, DEFAULT_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      const request = JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        id,
      });

      socket.write(request + '\n');
    });
  }

  /**
   * Check if the sidecar is alive by sending a ping.
   */
  async isReady(): Promise<boolean> {
    try {
      const result = await this.call<string>('ping', {});
      return result === 'pong';
    } catch {
      return false;
    }
  }

  /**
   * Generate a 768-dim embedding for the given text.
   */
  async embed(text: string): Promise<number[]> {
    return this.call<number[]>('embed', { text });
  }

  /**
   * Search for similar events by embedding vector.
   */
  async similaritySearch(
    queryEmbedding: number[],
    topK: number,
    domains?: LifeDomain[],
  ): Promise<Array<{
    id: string;
    domain: string;
    eventType: string;
    timestamp: number;
    summary: string;
  }>> {
    return this.call('similarity_search', {
      query_embedding: queryEmbedding,
      top_k: topK,
      ...(domains ? { domains } : {}),
    });
  }

  /**
   * Insert or update a vector in LanceDB.
   */
  async upsertVector(
    id: string,
    embedding: number[],
    metadata: {
      domain: string;
      eventType: string;
      timestamp: number;
      summary: string;
    },
  ): Promise<void> {
    await this.call<null>('upsert_vector', { id, embedding, metadata });
  }

  /**
   * Detect cross-domain patterns in event data.
   */
  async detectPatterns(
    events: Array<Record<string, unknown>>,
  ): Promise<Array<{
    type: string;
    domains: string[];
    confidence: number;
    metadata: Record<string, unknown>;
  }>> {
    return this.call('detect_patterns', { events });
  }

  /**
   * Forecast a domain's primary metric forward using Prophet.
   */
  async forecastDomain(
    domain: string,
    events: Array<Record<string, unknown>>,
    horizonDays: number,
  ): Promise<{
    insufficient_data: boolean;
    metric: string;
    unit: string;
    p10_final: number;
    p50_final: number;
    p90_final: number;
    confidence: number;
  }> {
    return this.call('forecast_domain', { domain, events, horizon_days: horizonDays });
  }

  /**
   * Estimate the impact of a decision on a domain.
   */
  async estimateImpact(
    decisionType: string,
    domain: string,
    events: Array<Record<string, unknown>>,
    horizonDays: number,
  ): Promise<{
    source: 'empirical' | 'generic-prior';
    analog_count: number;
    delta_p10: number;
    delta_p50: number;
    delta_p90: number;
    confidence: number;
  }> {
    return this.call('estimate_impact', {
      decision_type: decisionType,
      domain,
      events,
      horizon_days: horizonDays,
    });
  }

  /**
   * Run Monte Carlo simulation combining baselines and impact estimates.
   */
  async runMonteCarlo(
    baselines: Array<Record<string, unknown>>,
    impacts: Array<Record<string, unknown>>,
    nSamples: number = 1000,
  ): Promise<Array<{
    domain: string;
    metric: string;
    unit: string;
    baseline_p10: number;
    baseline_p50: number;
    baseline_p90: number;
    projected_p10: number;
    projected_p50: number;
    projected_p90: number;
    confidence: number;
    impact_source: string;
    analog_count: number;
  }>> {
    return this.call('run_simulation', {
      baselines,
      impacts,
      n_samples: nSamples,
    });
  }

  /**
   * Close the socket connection.
   */
  close(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Client closed'));
    }
    this.pending.clear();
  }
}
