/**
 * Integration health monitoring (in-memory).
 */

import { componentLogger } from '../core/logger.js';

const logger = componentLogger('integration-health');

export type IntegrationStatus = 'healthy' | 'degraded' | 'down';

export interface IntegrationHealth {
  adapterId: string;
  status: IntegrationStatus;
  lastCheckedAt: string;
  lastError?: string;
}

export class IntegrationHealthService {
  private health = new Map<string, IntegrationHealth>();

  update(adapterId: string, status: IntegrationStatus, error?: string): void {
    const entry: IntegrationHealth = {
      adapterId,
      status,
      lastCheckedAt: new Date().toISOString(),
      lastError: error,
    };
    this.health.set(adapterId, entry);
    logger.info({ adapterId, status }, 'Integration health updated');
  }

  get(adapterId: string): IntegrationHealth | null {
    return this.health.get(adapterId) ?? null;
  }

  list(): IntegrationHealth[] {
    return Array.from(this.health.values()).sort((a, b) => a.adapterId.localeCompare(b.adapterId));
  }
}

let store: IntegrationHealthService | null = null;

export function getIntegrationHealth(): IntegrationHealthService {
  if (!store) {
    store = new IntegrationHealthService();
  }
  return store;
}
