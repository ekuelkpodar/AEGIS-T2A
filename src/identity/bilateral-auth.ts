/**
 * Bilateral Agent Authorization
 * Agent A→B requires BOTH A authorized AND B accepts
 */

import { SPIFFEId } from './spiffe.js';
import { logger } from '../core/logger.js';

export interface AuthorizationRule {
  ruleId: string;
  caller: string;
  target: string;
  allowed: boolean;
  createdAt: Date;
  expiresAt?: Date;
}

export interface BilateralAuthResult {
  allowed: boolean;
  callerAuthorized: boolean;
  targetAccepts: boolean;
  matchedRules: string[];
  reason?: string;
}

export class BilateralAuthorizationManager {
  private callerRules: Map<string, AuthorizationRule[]> = new Map();
  private targetRules: Map<string, AuthorizationRule[]> = new Map();

  grantBilateral(caller: SPIFFEId, target: SPIFFEId): void {
    const callerRule: AuthorizationRule = {
      ruleId: 'caller-' + Date.now(),
      caller: caller.toString(),
      target: target.toString(),
      allowed: true,
      createdAt: new Date()
    };
    
    const targetRule: AuthorizationRule = {
      ruleId: 'target-' + Date.now(),
      caller: caller.toString(),
      target: target.toString(),
      allowed: true,
      createdAt: new Date()
    };

    const callerRules = this.callerRules.get(caller.toString()) || [];
    callerRules.push(callerRule);
    this.callerRules.set(caller.toString(), callerRules);

    const targetRules = this.targetRules.get(target.toString()) || [];
    targetRules.push(targetRule);
    this.targetRules.set(target.toString(), targetRules);

    logger.info('Granted bilateral authorization', {
      caller: caller.toString(),
      target: target.toString()
    });
  }

  checkAuthorization(caller: SPIFFEId, target: SPIFFEId): BilateralAuthResult {
    const callerStr = caller.toString();
    const targetStr = target.toString();

    const callerAuthorized = (this.callerRules.get(callerStr) || []).some(
      r => r.target === targetStr && r.allowed
    );
    
    const targetAccepts = (this.targetRules.get(targetStr) || []).some(
      r => r.caller === callerStr && r.allowed
    );

    const allowed = callerAuthorized && targetAccepts;

    return {
      allowed,
      callerAuthorized,
      targetAccepts,
      matchedRules: [],
      reason: allowed ? undefined : 'Bilateral authorization failed'
    };
  }
}

let bilateralAuthManager: BilateralAuthorizationManager;

export function getBilateralAuthManager(): BilateralAuthorizationManager {
  if (!bilateralAuthManager) {
    bilateralAuthManager = new BilateralAuthorizationManager();
  }
  return bilateralAuthManager;
}
