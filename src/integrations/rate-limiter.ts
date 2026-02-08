/**
 * Simple per-adapter rate limiter.
 */

import { componentLogger } from '../core/logger.js';

const logger = componentLogger('integration-rate-limiter');

export interface RateLimitConfig {
  requestsPerMinute: number;
  burst?: number;
}

interface BucketState {
  remaining: number;
  resetAt: number;
}

export class IntegrationRateLimiter {
  private limits = new Map<string, RateLimitConfig>();
  private buckets = new Map<string, BucketState>();

  configure(adapterId: string, config: RateLimitConfig): void {
    this.limits.set(adapterId, config);
  }

  allow(adapterId: string): boolean {
    const limit = this.limits.get(adapterId);
    if (!limit) return true;

    const now = Date.now();
    const windowMs = 60_000;
    let bucket = this.buckets.get(adapterId);

    if (!bucket || now >= bucket.resetAt) {
      bucket = {
        remaining: limit.burst ?? limit.requestsPerMinute,
        resetAt: now + windowMs,
      };
      this.buckets.set(adapterId, bucket);
    }

    if (bucket.remaining <= 0) {
      logger.warn({ adapterId }, 'Rate limit exceeded');
      return false;
    }

    bucket.remaining -= 1;
    return true;
  }
}

let limiter: IntegrationRateLimiter | null = null;

export function getIntegrationRateLimiter(): IntegrationRateLimiter {
  if (!limiter) {
    limiter = new IntegrationRateLimiter();
  }
  return limiter;
}
