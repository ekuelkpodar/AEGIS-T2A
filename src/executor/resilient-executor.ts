/**
 * Resilient Executor
 *
 * Enhanced executor with circuit breakers, retries, idempotency, and rate limiting.
 * Implements resilience patterns for production-grade execution.
 *
 * Features:
 * - Circuit breakers per resource type
 * - Exponential backoff retry with jitter
 * - Idempotency detection
 * - Per-resource rate limiting
 * - Graceful degradation
 *
 * References:
 * - Release It! (Michael Nygard)
 * - AWS SDK Retry Strategy
 * - Google SRE Book
 */

import { EventEmitter } from 'events';
import { componentLogger } from '../core/logger.js';
import type { PlanStep, StepExecutionResult } from '../core/types.js';
import type { ExecutionContext } from '../workflow/index.js';
import { getIdempotencyManager } from './idempotency-manager.js';

const logger = componentLogger('resilient-executor');

// =============================================================================
// Types
// =============================================================================

export interface CircuitBreakerState {
  state: 'closed' | 'open' | 'half_open';
  failureCount: number;
  lastFailureTime?: Date;
  nextRetryTime?: Date;
}

export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterFactor: number; // 0-1, amount of randomization
  retryableErrors: string[];
}

export interface RateLimitConfig {
  requestsPerSecond: number;
  burstSize: number;
}

export interface ResilientExecutorConfig {
  circuitBreaker: {
    enabled: boolean;
    failureThreshold: number;
    resetTimeoutMs: number;
    halfOpenRequests: number;
  };
  retry: RetryConfig;
  rateLimit: RateLimitConfig;
  idempotencyEnabled: boolean;
  degradationMode: 'fail_fast' | 'skip_optional' | 'use_cache';
}

// =============================================================================
// Circuit Breaker
// =============================================================================

class CircuitBreaker {
  private states = new Map<string, CircuitBreakerState>();

  constructor(
    private config: ResilientExecutorConfig['circuitBreaker']
  ) {}

  /**
   * Check if operation is allowed
   */
  isAllowed(resourceType: string): boolean {
    if (!this.config.enabled) return true;

    const state = this.getState(resourceType);

    if (state.state === 'open') {
      // Check if reset timeout has passed
      if (state.nextRetryTime && new Date() >= state.nextRetryTime) {
        // Transition to half-open
        state.state = 'half_open';
        state.failureCount = 0;
        logger.info({ resourceType }, 'Circuit breaker half-open');
        return true;
      }

      return false; // Still open
    }

    return true; // Closed or half-open
  }

  /**
   * Record success
   */
  recordSuccess(resourceType: string): void {
    const state = this.getState(resourceType);

    if (state.state === 'half_open') {
      // Transition to closed
      state.state = 'closed';
      state.failureCount = 0;
      logger.info({ resourceType }, 'Circuit breaker closed');
    } else if (state.state === 'closed') {
      // Reset failure count
      state.failureCount = 0;
    }
  }

  /**
   * Record failure
   */
  recordFailure(resourceType: string): void {
    const state = this.getState(resourceType);

    state.failureCount++;
    state.lastFailureTime = new Date();

    if (state.state === 'half_open') {
      // Transition back to open
      state.state = 'open';
      state.nextRetryTime = new Date(Date.now() + this.config.resetTimeoutMs);
      logger.warn({ resourceType }, 'Circuit breaker opened (half-open failure)');
    } else if (state.failureCount >= this.config.failureThreshold) {
      // Transition to open
      state.state = 'open';
      state.nextRetryTime = new Date(Date.now() + this.config.resetTimeoutMs);
      logger.warn(
        { resourceType, failureCount: state.failureCount },
        'Circuit breaker opened'
      );
    }
  }

  /**
   * Get state for resource type
   */
  private getState(resourceType: string): CircuitBreakerState {
    if (!this.states.has(resourceType)) {
      this.states.set(resourceType, {
        state: 'closed',
        failureCount: 0,
      });
    }
    return this.states.get(resourceType)!;
  }

  /**
   * Get all states
   */
  getAllStates(): Map<string, CircuitBreakerState> {
    return new Map(this.states);
  }
}

// =============================================================================
// Token Bucket Rate Limiter
// =============================================================================

class TokenBucketRateLimiter {
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();

  constructor(private config: RateLimitConfig) {}

  /**
   * Try to acquire a token
   */
  tryAcquire(resourceId: string): boolean {
    const bucket = this.getBucket(resourceId);
    const now = Date.now();

    // Refill tokens based on time elapsed
    const elapsedSec = (now - bucket.lastRefill) / 1000;
    const tokensToAdd = elapsedSec * this.config.requestsPerSecond;
    bucket.tokens = Math.min(this.config.burstSize, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    // Try to consume a token
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Get bucket for resource
   */
  private getBucket(resourceId: string): { tokens: number; lastRefill: number } {
    if (!this.buckets.has(resourceId)) {
      this.buckets.set(resourceId, {
        tokens: this.config.burstSize,
        lastRefill: Date.now(),
      });
    }
    return this.buckets.get(resourceId)!;
  }
}

// =============================================================================
// Resilient Executor
// =============================================================================

export class ResilientExecutor extends EventEmitter {
  private config: ResilientExecutorConfig;
  private circuitBreaker: CircuitBreaker;
  private rateLimiter: TokenBucketRateLimiter;
  private idempotencyManager = getIdempotencyManager();

  constructor(config: Partial<ResilientExecutorConfig> = {}) {
    super();
    this.config = {
      circuitBreaker: {
        enabled: true,
        failureThreshold: 5,
        resetTimeoutMs: 60000, // 1 minute
        halfOpenRequests: 3,
      },
      retry: {
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 30000,
        backoffMultiplier: 2,
        jitterFactor: 0.1,
        retryableErrors: ['TIMEOUT', 'NETWORK', 'RATE_LIMIT', 'SERVER_ERROR'],
      },
      rateLimit: {
        requestsPerSecond: 10,
        burstSize: 20,
      },
      idempotencyEnabled: true,
      degradationMode: 'fail_fast',
      ...config,
    };

    this.circuitBreaker = new CircuitBreaker(this.config.circuitBreaker);
    this.rateLimiter = new TokenBucketRateLimiter(this.config.rateLimit);
  }

  /**
   * Execute step with resilience patterns
   */
  async execute(
    step: PlanStep,
    executor: (step: PlanStep, context: ExecutionContext) => Promise<StepExecutionResult>,
    context: ExecutionContext
  ): Promise<StepExecutionResult> {
    const resourceType = step.toolAdapter;

    // Check idempotency
    if (this.config.idempotencyEnabled) {
      const idempotencyCheck = await this.idempotencyManager.check(step);

      if (idempotencyCheck.isIdempotent && idempotencyCheck.existingResult) {
        logger.info(
          { stepId: step.stepId, reason: idempotencyCheck.reason },
          'Returned idempotent result'
        );

        this.emit('idempotent_hit', {
          stepId: step.stepId,
          idempotencyKey: idempotencyCheck.idempotencyKey,
        });

        return idempotencyCheck.existingResult;
      }

      // Mark as in-progress
      await this.idempotencyManager.markInProgress(step);
    }

    // Check circuit breaker
    if (!this.circuitBreaker.isAllowed(resourceType)) {
      logger.warn({ stepId: step.stepId, resourceType }, 'Circuit breaker open, rejecting');

      this.emit('circuit_breaker_open', { stepId: step.stepId, resourceType });

      return {
        stepId: step.stepId,
        status: 'failed',
        outputs: {},
        error: `Circuit breaker open for ${resourceType}`,
        durationMs: 0,
        costIncurred: 0,
      };
    }

    // Execute with retry
    const result = await this.executeWithRetry(step, executor, context, resourceType);

    // Store in idempotency cache
    if (this.config.idempotencyEnabled) {
      const idempotencyKey = await this.idempotencyManager.check(step);
      if (idempotencyKey.idempotencyKey) {
        await this.idempotencyManager.store(idempotencyKey.idempotencyKey, result);
      }
    }

    return result;
  }

  /**
   * Execute with retry logic
   */
  private async executeWithRetry(
    step: PlanStep,
    executor: (step: PlanStep, context: ExecutionContext) => Promise<StepExecutionResult>,
    context: ExecutionContext,
    resourceType: string
  ): Promise<StepExecutionResult> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.retry.maxAttempts; attempt++) {
      // Rate limiting
      if (!this.rateLimiter.tryAcquire(resourceType)) {
        logger.warn({ stepId: step.stepId, resourceType }, 'Rate limit exceeded, waiting');
        await this.sleep(1000); // Wait 1 second
        continue;
      }

      try {
        logger.debug({ stepId: step.stepId, attempt }, 'Executing step');

        const result = await executor(step, context);

        if (result.status === 'completed') {
          // Success
          this.circuitBreaker.recordSuccess(resourceType);

          this.emit('execution_success', {
            stepId: step.stepId,
            attempt,
            resourceType,
          });

          return result;
        } else {
          // Step reported failure
          lastError = new Error(result.error || 'Step failed');

          if (!this.isRetryable(result.error)) {
            // Non-retryable error
            this.circuitBreaker.recordFailure(resourceType);

            this.emit('non_retryable_error', {
              stepId: step.stepId,
              error: result.error,
            });

            return result;
          }
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');

        if (!this.isRetryable(lastError.message)) {
          this.circuitBreaker.recordFailure(resourceType);

          this.emit('non_retryable_error', {
            stepId: step.stepId,
            error: lastError.message,
          });

          return {
            stepId: step.stepId,
            status: 'failed',
            outputs: {},
            error: lastError.message,
            durationMs: 0,
            costIncurred: 0,
          };
        }
      }

      // Retry with backoff
      if (attempt < this.config.retry.maxAttempts) {
        const delay = this.calculateBackoff(attempt);

        logger.info(
          { stepId: step.stepId, attempt, delay, error: lastError?.message },
          'Retrying after failure'
        );

        this.emit('retry_scheduled', {
          stepId: step.stepId,
          attempt,
          delay,
        });

        await this.sleep(delay);
      }
    }

    // All retries exhausted
    this.circuitBreaker.recordFailure(resourceType);

    this.emit('retries_exhausted', {
      stepId: step.stepId,
      attempts: this.config.retry.maxAttempts,
    });

    return {
      stepId: step.stepId,
      status: 'failed',
      outputs: {},
      error: lastError?.message || 'Max retries exceeded',
      durationMs: 0,
      costIncurred: 0,
    };
  }

  /**
   * Check if error is retryable
   */
  private isRetryable(errorMessage?: string): boolean {
    if (!errorMessage) return false;

    return this.config.retry.retryableErrors.some(err =>
      errorMessage.toUpperCase().includes(err)
    );
  }

  /**
   * Calculate backoff delay with jitter
   */
  private calculateBackoff(attempt: number): number {
    const baseDelay =
      this.config.retry.initialDelayMs *
      Math.pow(this.config.retry.backoffMultiplier, attempt - 1);

    const cappedDelay = Math.min(baseDelay, this.config.retry.maxDelayMs);

    // Add jitter
    const jitter = cappedDelay * this.config.retry.jitterFactor * Math.random();

    return Math.floor(cappedDelay + jitter);
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get circuit breaker states
   */
  getCircuitBreakerStates(): Map<string, CircuitBreakerState> {
    return this.circuitBreaker.getAllStates();
  }

  /**
   * Get statistics
   */
  getStats(): {
    circuitBreakers: Map<string, CircuitBreakerState>;
    idempotency: ReturnType<typeof this.idempotencyManager.getStats>;
  } {
    return {
      circuitBreakers: this.getCircuitBreakerStates(),
      idempotency: this.idempotencyManager.getStats(),
    };
  }
}

// =============================================================================
// Singleton
// =============================================================================

let resilientExecutor: ResilientExecutor | null = null;

export function getResilientExecutor(): ResilientExecutor {
  if (!resilientExecutor) {
    resilientExecutor = new ResilientExecutor();
  }
  return resilientExecutor;
}

export function initializeResilientExecutor(
  config?: Partial<ResilientExecutorConfig>
): ResilientExecutor {
  if (!resilientExecutor) {
    resilientExecutor = new ResilientExecutor(config);
  }
  return resilientExecutor;
}
