import { EventEmitter } from 'node:events';
import type { LifeDomain } from '@pre/shared';

export type GatewayEvents = {
  'gateway-ready': { timestamp: number };
  'events-ingested': { source: string; count: number; domains: LifeDomain[] };
  'sync-started': { source: string };
  'sync-completed': { source: string; eventsCount: number };
  'sync-failed': { source: string; error: string };
  'adapter-needs-reauth': { source: string; error: string };
  'insight-generated': { insightId: string; type: string };
  'alert-fired': { alertId: string; severity: string; title: string };
};

export class EventBus {
  private emitter = new EventEmitter();

  emit<K extends keyof GatewayEvents>(
    event: K,
    payload: GatewayEvents[K],
  ): void {
    this.emitter.emit(event, payload);
  }

  on<K extends keyof GatewayEvents>(
    event: K,
    handler: (payload: GatewayEvents[K]) => void,
  ): void {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
  }

  off<K extends keyof GatewayEvents>(
    event: K,
    handler: (payload: GatewayEvents[K]) => void,
  ): void {
    this.emitter.off(event, handler as (...args: unknown[]) => void);
  }

  once<K extends keyof GatewayEvents>(
    event: K,
    handler: (payload: GatewayEvents[K]) => void,
  ): void {
    this.emitter.once(event, handler as (...args: unknown[]) => void);
  }
}
