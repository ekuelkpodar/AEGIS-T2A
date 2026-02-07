/**
 * Policy Exception Management
 *
 * Handle temporary policy overrides with justification and approval.
 * Critical for emergency situations and planned maintenance.
 */

import { EventEmitter } from 'events';
import { componentLogger } from '../core/logger.js';

const logger = componentLogger('policy-exception-manager');

export interface PolicyException {
  exceptionId: string;
  ruleId: string;
  requestedBy: string;
  approvedBy?: string;
  reason: string;
  startTime: Date;
  endTime: Date;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  affectedUsers?: string[];
  affectedResources?: string[];
}

export class PolicyExceptionManager extends EventEmitter {
  private exceptions = new Map<string, PolicyException>();

  createException(
    ruleId: string,
    requestedBy: string,
    reason: string,
    durationHours: number,
    affectedUsers?: string[]
  ): PolicyException {
    const exception: PolicyException = {
      exceptionId: `exc_${Date.now()}`,
      ruleId,
      requestedBy,
      reason,
      startTime: new Date(),
      endTime: new Date(Date.now() + durationHours * 60 * 60 * 1000),
      status: 'pending',
      affectedUsers,
    };

    this.exceptions.set(exception.exceptionId, exception);

    this.emit('exception_created', exception);

    logger.info({ exceptionId: exception.exceptionId, ruleId }, 'Policy exception created');

    return exception;
  }

  approveException(exceptionId: string, approvedBy: string): void {
    const exception = this.exceptions.get(exceptionId);

    if (!exception) {
      throw new Error(`Exception not found: ${exceptionId}`);
    }

    exception.status = 'approved';
    exception.approvedBy = approvedBy;

    this.emit('exception_approved', exception);

    logger.info({ exceptionId, approvedBy }, 'Policy exception approved');
  }

  isExceptionActive(ruleId: string, userId?: string): boolean {
    const now = new Date();

    for (const exception of this.exceptions.values()) {
      if (
        exception.ruleId === ruleId &&
        exception.status === 'approved' &&
        exception.startTime <= now &&
        exception.endTime > now
      ) {
        // Check if user is affected
        if (!userId || !exception.affectedUsers || exception.affectedUsers.includes(userId)) {
          return true;
        }
      }
    }

    return false;
  }

  cleanupExpired(): number {
    const now = new Date();
    let cleaned = 0;

    for (const [id, exception] of this.exceptions.entries()) {
      if (exception.endTime <= now && exception.status !== 'expired') {
        exception.status = 'expired';
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, 'Expired policy exceptions cleaned up');
    }

    return cleaned;
  }

  getActiveExceptions(): PolicyException[] {
    return Array.from(this.exceptions.values()).filter(e => e.status === 'approved');
  }
}

let exceptionManager: PolicyExceptionManager | null = null;

export function getPolicyExceptionManager(): PolicyExceptionManager {
  if (!exceptionManager) {
    exceptionManager = new PolicyExceptionManager();
  }
  return exceptionManager;
}
