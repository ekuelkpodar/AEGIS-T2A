/**
 * Per-SPIFFE-ID Rate Limiter
 * 
 * Prevents abuse by limiting requests per identity using token bucket algorithm.
 * Configurable per-identity and global limits.
 * 
 * References:
 * - Aembit.io Rate Limiting
 * - Token Bucket Algorithm
 */

import { SPIFFEId } from './spiffe.js';
import { logger } from '../core/logger.js';

export interface RateLimitConfig {
  requestsPerSecond: number;
  burstSize: number;
  enabled: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfter?: number;
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private capacity: number,
    private refillRate: number
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  tryConsume(tokens: number = 1): boolean {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  getRemaining(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  getResetTime(): Date {
    const tokensNeeded = this.capacity - this.tokens;
    const msUntilFull = (tokensNeeded / this.refillRate) * 1000;
    return new Date(Date.now() + msUntilFull);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsed * this.refillRate;
    
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
}

export class SPIFFERateLimiter {
  private buckets: Map<string, TokenBucket> = new Map();
  private config: RateLimitConfig;

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = {
      requestsPerSecond: config?.requestsPerSecond || 100,
      burstSize: config?.burstSize || 200,
      enabled: config?.enabled !== false
    };

    setInterval(() => this.cleanup(), 60000);
  }

  checkLimit(spiffeId: SPIFFEId, tokens: number = 1): RateLimitResult {
    if (!this.config.enabled) {
      return { allowed: true, remaining: Infinity, resetAt: new Date(Date.now() + 1000) };
    }

    const key = spiffeId.toString();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = new TokenBucket(this.config.burstSize, this.config.requestsPerSecond);
      this.buckets.set(key, bucket);
    }

    const allowed = bucket.tryConsume(tokens);
    const remaining = bucket.getRemaining();
    const resetAt = bucket.getResetTime();

    if (!allowed) {
      logger.warn('Rate limit exceeded', {
        spiffeId: key,
        remaining,
        resetAt: resetAt.toISOString()
      });

      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfter: Math.ceil((resetAt.getTime() - Date.now()) / 1000)
      };
    }

    return { allowed, remaining, resetAt };
  }

  setLimit(spiffeId: SPIFFEId, config: Partial<RateLimitConfig>): void {
    const key = spiffeId.toString();
    const rps = config.requestsPerSecond || this.config.requestsPerSecond;
    const burst = config.burstSize || this.config.burstSize;
    
    this.buckets.set(key, new TokenBucket(burst, rps));
    logger.info('Updated rate limit', { spiffeId: key, requestsPerSecond: rps, burstSize: burst });
  }

  reset(spiffeId: SPIFFEId): void {
    this.buckets.delete(spiffeId.toString());
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.getRemaining() === this.config.burstSize) {
        const resetTime = bucket.getResetTime().getTime();
        if (now - resetTime > 300000) {
          this.buckets.delete(key);
          cleaned++;
        }
      }
    }

    if (cleaned > 0) {
      logger.debug('Cleaned up idle rate limit buckets', { count: cleaned });
    }
  }

  getStats(): { totalIdentities: number; config: RateLimitConfig } {
    return {
      totalIdentities: this.buckets.size,
      config: this.config
    };
  }
}

let rateLimiter: SPIFFERateLimiter;

export function getSPIFFERateLimiter(config?: Partial<RateLimitConfig>): SPIFFERateLimiter {
  if (!rateLimiter) {
    rateLimiter = new SPIFFERateLimiter(config);
  }
  return rateLimiter;
}
