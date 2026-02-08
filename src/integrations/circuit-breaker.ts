/**
 * Basic circuit breaker for integration adapters.
 */

import { componentLogger } from '../core/logger.js';

const logger = componentLogger('integration-circuit');

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
}

interface CircuitRecord {
  state: CircuitState;
  failures: number;
  lastFailureAt: number;
}

export class IntegrationCircuitBreaker {
  private circuits = new Map<string, CircuitRecord>();
  private config: CircuitConfig;

  constructor(config: CircuitConfig = { failureThreshold: 5, resetTimeoutMs: 60_000 }) {
    this.config = config;
  }

  canExecute(adapterId: string): boolean {
    const record = this.circuits.get(adapterId);
    if (!record) return true;

    if (record.state === 'open') {
      const now = Date.now();
      if (now - record.lastFailureAt > this.config.resetTimeoutMs) {
        record.state = 'half_open';
        return true;
      }
      return false;
    }

    return true;
  }

  recordSuccess(adapterId: string): void {
    const record = this.circuits.get(adapterId);
    if (!record) return;
    record.failures = 0;
    record.state = 'closed';
  }

  recordFailure(adapterId: string): void {
    const now = Date.now();
    const record = this.circuits.get(adapterId) ?? {
      state: 'closed',
      failures: 0,
      lastFailureAt: now,
    };

    record.failures += 1;
    record.lastFailureAt = now;

    if (record.failures >= this.config.failureThreshold) {
      record.state = 'open';
      logger.warn({ adapterId }, 'Circuit opened for adapter');
    }

    this.circuits.set(adapterId, record);
  }

  getState(adapterId: string): CircuitState {
    return this.circuits.get(adapterId)?.state ?? 'closed';
  }
}

let breaker: IntegrationCircuitBreaker | null = null;

export function getIntegrationCircuitBreaker(): IntegrationCircuitBreaker {
  if (!breaker) {
    breaker = new IntegrationCircuitBreaker();
  }
  return breaker;
}
