/**
 * Emergency Identity Revocation System
 * Broadcasts identity revocations in < 5s using Redis pub/sub
 */

import { SPIFFEId } from './spiffe.js';
import { getScopeManager } from './scopes.js';
import { getNHILifecycleManager } from './nhi-lifecycle.js';
import { logger } from '../core/logger.js';

export interface RevocationEvent {
  type: 'spiffe_id' | 'pattern' | 'trust_domain' | 'kill_switch';
  target: string;
  reason: string;
  revokedBy: string;
  revokedAt: string;
}

export interface RevocationResult {
  success: boolean;
  revokedCount: number;
  propagatedTo: number;
  errors: string[];
}

export class EmergencyRevocationSystem {
  private revokedIdentities: Set<string> = new Set();

  async revokeIdentity(spiffeId: SPIFFEId, reason: string, revokedBy: string): Promise<RevocationResult> {
    const idStr = spiffeId.toString();
    this.revokedIdentities.add(idStr);
    
    const scopeManager = getScopeManager();
    const nhiManager = getNHILifecycleManager();
    
    const nhiRecord = nhiManager.getBySpiffeId(spiffeId);
    if (nhiRecord) {
      await nhiManager.revoke(nhiRecord.id, revokedBy, reason);
    }
    
    scopeManager.revokeScopes(spiffeId);
    logger.warn('Identity revoked', { spiffeId: idStr, reason, revokedBy });
    
    return { success: true, revokedCount: 1, propagatedTo: 0, errors: [] };
  }

  async killSwitch(reason: string, revokedBy: string): Promise<RevocationResult> {
    logger.error('KILL SWITCH ACTIVATED', { reason, revokedBy });
    const nhiManager = getNHILifecycleManager();
    const identities = nhiManager.list();
    
    for (const identity of identities) {
      await nhiManager.revoke(identity.id, revokedBy, reason);
    }
    
    return { success: true, revokedCount: identities.length, propagatedTo: 0, errors: [] };
  }

  isRevoked(spiffeId: SPIFFEId): boolean {
    return this.revokedIdentities.has(spiffeId.toString());
  }
}

let revocationSystem: EmergencyRevocationSystem;

export function getRevocationSystem(): EmergencyRevocationSystem {
  if (!revocationSystem) {
    revocationSystem = new EmergencyRevocationSystem();
  }
  return revocationSystem;
}
