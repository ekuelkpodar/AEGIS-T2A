/**
 * Capability Tokens
 * 
 * Bearer tokens bound to SPIFFE IDs for fine-grained delegation.
 * Each capability grants specific permissions with constraints.
 * 
 * References:
 * - Object Capabilities
 * - SPIRE Attestor capabilities
 */

import { SPIFFEId } from './spiffe.js';
import { ScopeLevel } from './scopes.js';
import { createHash, randomBytes } from 'crypto';
import { logger } from '../core/logger.js';

export interface Capability {
  capabilityId: string;
  token: string;
  boundTo: string;
  resource: string;
  action: ScopeLevel;
  constraints?: {
    maxUses?: number;
    validUntil?: Date;
    ipWhitelist?: string[];
    metadata?: Record<string, unknown>;
  };
  grantedAt: Date;
  grantedBy: string;
  usageCount: number;
}

export interface CapabilityValidationResult {
  valid: boolean;
  capability?: Capability;
  reason?: string;
}

export class CapabilityManager {
  private capabilities: Map<string, Capability> = new Map();
  private tokenIndex: Map<string, string> = new Map();

  /**
   * Create a new capability token
   */
  createCapability(options: {
    spiffeId: SPIFFEId;
    resource: string;
    action: ScopeLevel;
    grantedBy: string;
    constraints?: Capability['constraints'];
  }): Capability {
    const token = this.generateToken();
    const capabilityId = createHash('sha256').update(token).digest('hex').substring(0, 16);

    const capability: Capability = {
      capabilityId,
      token,
      boundTo: options.spiffeId.toString(),
      resource: options.resource,
      action: options.action,
      constraints: options.constraints,
      grantedAt: new Date(),
      grantedBy: options.grantedBy,
      usageCount: 0
    };

    this.capabilities.set(capabilityId, capability);
    this.tokenIndex.set(token, capabilityId);

    logger.info('Created capability token', {
      capabilityId,
      boundTo: options.spiffeId.toString(),
      resource: options.resource,
      action: options.action
    });

    return capability;
  }

  /**
   * Validate and consume a capability token
   */
  validateCapability(
    token: string,
    spiffeId: SPIFFEId,
    context?: { ip?: string }
  ): CapabilityValidationResult {
    const capabilityId = this.tokenIndex.get(token);
    if (!capabilityId) {
      return { valid: false, reason: 'Invalid token' };
    }

    const capability = this.capabilities.get(capabilityId);
    if (!capability) {
      return { valid: false, reason: 'Capability not found' };
    }

    if (capability.boundTo !== spiffeId.toString()) {
      return { valid: false, reason: 'Token not bound to this identity' };
    }

    if (capability.constraints?.validUntil) {
      if (new Date() > capability.constraints.validUntil) {
        return { valid: false, reason: 'Token expired' };
      }
    }

    if (capability.constraints?.maxUses !== undefined) {
      if (capability.usageCount >= capability.constraints.maxUses) {
        return { valid: false, reason: 'Token usage limit exceeded' };
      }
    }

    if (capability.constraints?.ipWhitelist && context?.ip) {
      if (!capability.constraints.ipWhitelist.includes(context.ip)) {
        return { valid: false, reason: 'IP not whitelisted' };
      }
    }

    capability.usageCount++;

    return { valid: true, capability };
  }

  /**
   * Revoke a capability
   */
  revokeCapability(capabilityId: string): boolean {
    const capability = this.capabilities.get(capabilityId);
    if (capability) {
      this.tokenIndex.delete(capability.token);
      this.capabilities.delete(capabilityId);
      logger.info('Revoked capability', { capabilityId });
      return true;
    }
    return false;
  }

  /**
   * List capabilities for a SPIFFE ID
   */
  listCapabilities(spiffeId: SPIFFEId): Capability[] {
    const idStr = spiffeId.toString();
    return Array.from(this.capabilities.values()).filter(
      cap => cap.boundTo === idStr
    );
  }

  private generateToken(): string {
    return 'cap_' + randomBytes(32).toString('hex');
  }

  /**
   * Cleanup expired capabilities
   */
  cleanup(): number {
    const now = new Date();
    let cleaned = 0;

    for (const [id, capability] of this.capabilities.entries()) {
      const expired = capability.constraints?.validUntil && 
                     capability.constraints.validUntil < now;
      
      const usedUp = capability.constraints?.maxUses !== undefined && 
                     capability.usageCount >= capability.constraints.maxUses;

      if (expired || usedUp) {
        this.tokenIndex.delete(capability.token);
        this.capabilities.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info('Cleaned up capabilities', { count: cleaned });
    }

    return cleaned;
  }
}

let capabilityManager: CapabilityManager;

export function getCapabilityManager(): CapabilityManager {
  if (!capabilityManager) {
    capabilityManager = new CapabilityManager();
    setInterval(() => capabilityManager.cleanup(), 5 * 60 * 1000);
  }
  return capabilityManager;
}
