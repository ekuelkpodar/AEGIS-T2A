/**
 * Simple feature flag service (in-memory).
 */

import { componentLogger } from '../core/logger.js';
import { getConfig } from '../core/config.js';

const logger = componentLogger('feature-flags');

export interface FeatureFlag {
  name: string;
  enabled: boolean;
  description?: string;
  updatedAt: string;
}

export class FeatureFlagService {
  private flags = new Map<string, FeatureFlag>();
  private initialized = false;

  initialize(): void {
    if (this.initialized) return;

    const config = getConfig();
    if (config.featureFlagsJson) {
      try {
        const parsed = JSON.parse(config.featureFlagsJson) as Record<string, boolean>;
        for (const [name, enabled] of Object.entries(parsed)) {
          this.flags.set(name, {
            name,
            enabled: Boolean(enabled),
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (error) {
        logger.warn({ error }, 'Failed to parse FEATURE_FLAGS_JSON');
      }
    }

    this.initialized = true;
    logger.info({ count: this.flags.size }, 'Feature flags initialized');
  }

  isEnabled(name: string, defaultValue: boolean = false): boolean {
    return this.flags.get(name)?.enabled ?? defaultValue;
  }

  setFlag(name: string, enabled: boolean, description?: string): FeatureFlag {
    const flag: FeatureFlag = {
      name,
      enabled,
      description,
      updatedAt: new Date().toISOString(),
    };
    this.flags.set(name, flag);
    logger.info({ name, enabled }, 'Feature flag updated');
    return flag;
  }

  listFlags(): FeatureFlag[] {
    return Array.from(this.flags.values()).sort((a, b) => a.name.localeCompare(b.name));
  }
}

let store: FeatureFlagService | null = null;

export function initializeFeatureFlags(): void {
  if (!store) {
    store = new FeatureFlagService();
  }
  store.initialize();
}

export function getFeatureFlags(): FeatureFlagService {
  if (!store) {
    store = new FeatureFlagService();
    store.initialize();
  }
  return store;
}
