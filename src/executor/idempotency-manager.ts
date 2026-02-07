/**
 * Idempotency Manager
 *
 * Ensures operations execute exactly once even with retries/failures.
 * Critical for distributed systems and financial operations.
 *
 * Features:
 * - Content-addressed idempotency keys
 * - TTL-based key expiration
 * - Response caching
 * - Conflict detection
 *
 * References:
 * - Stripe Idempotency
 * - AWS Idempotent APIs
 */

import { EventEmitter } from 'events';
import { componentLogger } from '../core/logger.js';
import { hashObject } from '../core/crypto.js';
import type { PlanStep, StepExecutionResult } from '../core/types.js';

const logger = componentLogger('idempotency-manager');

// =============================================================================
// Types
// =============================================================================

export interface IdempotencyRecord {
  idempotencyKey: string;
  stepId: string;
  requestHash: string;
  result: StepExecutionResult;
  createdAt: Date;
  expiresAt: Date;
  executionCount: number;
  status: 'in_progress' | 'completed' | 'failed';
}

export interface IdempotencyConfig {
  enabled: boolean;
  ttlMs: number; // How long to cache results
  lockTimeoutMs: number; // How long to wait for in-progress operations
  useContentAddressing: boolean; // Hash parameters for key
}

export interface IdempotencyCheckResult {
  isIdempotent: boolean;
  existingResult?: StepExecutionResult;
  idempotencyKey: string;
  reason: string;
}

// =============================================================================
// Idempotency Manager
// =============================================================================

export class IdempotencyManager extends EventEmitter {
  private config: IdempotencyConfig;
  private records = new Map<string, IdempotencyRecord>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<IdempotencyConfig> = {}) {
    super();
    this.config = {
      enabled: true,
      ttlMs: 24 * 60 * 60 * 1000, // 24 hours default
      lockTimeoutMs: 30000, // 30 seconds
      useContentAddressing: true,
      ...config,
    };
  }

  /**
   * Start idempotency manager
   */
  start(): void {
    if (this.cleanupInterval) return;

    // Cleanup expired records every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 5 * 60 * 1000);

    logger.info('Idempotency manager started');
  }

  /**
   * Stop idempotency manager
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    logger.info('Idempotency manager stopped');
  }

  /**
   * Check if operation is idempotent (already executed)
   */
  async check(step: PlanStep): Promise<IdempotencyCheckResult> {
    if (!this.config.enabled) {
      return {
        isIdempotent: false,
        idempotencyKey: '',
        reason: 'Idempotency disabled',
      };
    }

    const idempotencyKey = this.generateKey(step);

    const record = this.records.get(idempotencyKey);

    if (!record) {
      return {
        isIdempotent: false,
        idempotencyKey,
        reason: 'No previous execution found',
      };
    }

    // Check if expired
    if (new Date() > record.expiresAt) {
      this.records.delete(idempotencyKey);
      return {
        isIdempotent: false,
        idempotencyKey,
        reason: 'Previous execution expired',
      };
    }

    // Check if still in progress
    if (record.status === 'in_progress') {
      // Wait for completion or timeout
      const completed = await this.waitForCompletion(idempotencyKey);

      if (completed) {
        return {
          isIdempotent: true,
          existingResult: record.result,
          idempotencyKey,
          reason: 'Returned cached result after waiting for in-progress operation',
        };
      } else {
        return {
          isIdempotent: false,
          idempotencyKey,
          reason: 'In-progress operation timed out',
        };
      }
    }

    // Return cached result
    return {
      isIdempotent: true,
      existingResult: record.result,
      idempotencyKey,
      reason: `Returned cached result from ${record.createdAt.toISOString()}`,
    };
  }

  /**
   * Mark operation as in-progress
   */
  async markInProgress(step: PlanStep): Promise<string> {
    const idempotencyKey = this.generateKey(step);

    const record: IdempotencyRecord = {
      idempotencyKey,
      stepId: step.stepId,
      requestHash: this.hashRequest(step),
      result: {
        stepId: step.stepId,
        status: 'failed', // Placeholder for in-progress, will be updated
        outputs: {},
        durationMs: 0,
        costIncurred: 0,
      },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + this.config.ttlMs),
      executionCount: 1,
      status: 'in_progress',
    };

    this.records.set(idempotencyKey, record);

    this.emit('marked_in_progress', { idempotencyKey, stepId: step.stepId });

    return idempotencyKey;
  }

  /**
   * Store successful result
   */
  async store(idempotencyKey: string, result: StepExecutionResult): Promise<void> {
    const record = this.records.get(idempotencyKey);

    if (!record) {
      logger.warn({ idempotencyKey }, 'Attempted to store result for unknown key');
      return;
    }

    record.result = result;
    record.status = result.status === 'completed' ? 'completed' : 'failed';

    this.emit('result_stored', {
      idempotencyKey,
      stepId: result.stepId,
      status: record.status,
    });

    logger.debug(
      { idempotencyKey, stepId: result.stepId, status: record.status },
      'Stored idempotent result'
    );
  }

  /**
   * Generate idempotency key
   */
  private generateKey(step: PlanStep): string {
    if (this.config.useContentAddressing) {
      // Content-addressed: hash of step definition
      const requestHash = this.hashRequest(step);
      return `idem_${step.stepId}_${requestHash.substring(0, 16)}`;
    } else {
      // Simple: just use step ID
      return `idem_${step.stepId}`;
    }
  }

  /**
   * Hash request for content addressing
   */
  private hashRequest(step: PlanStep): string {
    return hashObject({
      action: step.action,
      toolAdapter: step.toolAdapter,
      parameters: step.parameters,
      // Exclude stepId from hash so retries with same params match
    });
  }

  /**
   * Wait for in-progress operation to complete
   */
  private async waitForCompletion(idempotencyKey: string): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < this.config.lockTimeoutMs) {
      const record = this.records.get(idempotencyKey);

      if (!record || record.status !== 'in_progress') {
        return true; // Completed
      }

      // Wait 100ms before checking again
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return false; // Timed out
  }

  /**
   * Cleanup expired records
   */
  private cleanup(): void {
    const now = new Date();
    let cleaned = 0;

    for (const [key, record] of this.records.entries()) {
      if (now > record.expiresAt) {
        this.records.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up expired idempotency records');
    }
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalRecords: number;
    inProgress: number;
    completed: number;
    failed: number;
  } {
    let inProgress = 0;
    let completed = 0;
    let failed = 0;

    for (const record of this.records.values()) {
      if (record.status === 'in_progress') inProgress++;
      else if (record.status === 'completed') completed++;
      else if (record.status === 'failed') failed++;
    }

    return {
      totalRecords: this.records.size,
      inProgress,
      completed,
      failed,
    };
  }

  /**
   * Clear all records (for testing)
   */
  clear(): void {
    this.records.clear();
  }
}

// =============================================================================
// Singleton
// =============================================================================

let idempotencyManager: IdempotencyManager | null = null;

export function getIdempotencyManager(): IdempotencyManager {
  if (!idempotencyManager) {
    idempotencyManager = new IdempotencyManager();
    idempotencyManager.start();
  }
  return idempotencyManager;
}

export function initializeIdempotencyManager(
  config?: Partial<IdempotencyConfig>
): IdempotencyManager {
  if (!idempotencyManager) {
    idempotencyManager = new IdempotencyManager(config);
    idempotencyManager.start();
  }
  return idempotencyManager;
}
