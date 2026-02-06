/**
 * SPIFFE-based Agent Identity System
 *
 * Assigns each MCP Action Worker a cryptographically verifiable SPIFFE ID
 * following the pattern: spiffe://aegis-t2a.local/ns/{namespace}/agent/{agent-type}/{instance-id}
 *
 * Reference: CNCF SPIFFE spec, arxiv:2504.14760
 */

import { randomBytes, createHash } from 'crypto';
import { logger } from '../core/logger.js';

export interface SPIFFEId {
  trustDomain: string;
  namespace: string;
  agentType: string;
  instanceId: string;
  fullId: string;
}

export interface AgentIdentity {
  spiffeId: SPIFFEId;
  svid?: SVID;
  capabilities: Set<string>;
  scopes: Set<string>;
  metadata: Record<string, string>;
  createdAt: Date;
  expiresAt?: Date;
}

export interface SVID {
  serialNumber: string;
  certificate: string;
  privateKey: string;
  issuedAt: Date;
  expiresAt: Date;
  trustBundle: string[];
}

export interface WorkloadAttestation {
  workloadPid?: number;
  workloadUid?: number;
  containerImageHash?: string;
  k8sServiceAccount?: string;
  k8sNamespace?: string;
  binaryHash?: string;
  metadata: Record<string, string>;
}

export class SPIFFEIdentityManager {
  private readonly trustDomain: string;
  private readonly identities: Map<string, AgentIdentity>;

  constructor(trustDomain: string = 'aegis-t2a.local') {
    this.trustDomain = trustDomain;
    this.identities = new Map();
  }

  /**
   * Generate a SPIFFE ID for an agent
   *
   * Format: spiffe://{trustDomain}/ns/{namespace}/agent/{agentType}/{instanceId}
   */
  generateSPIFFEId(
    namespace: string,
    agentType: string,
    instanceId?: string
  ): SPIFFEId {
    const id = instanceId || this.generateInstanceId();
    const fullId = `spiffe://${this.trustDomain}/ns/${namespace}/agent/${agentType}/${id}`;

    return {
      trustDomain: this.trustDomain,
      namespace,
      agentType,
      instanceId: id,
      fullId,
    };
  }

  /**
   * Register a new agent identity with attestation
   */
  async registerAgent(
    namespace: string,
    agentType: string,
    attestation: WorkloadAttestation,
    capabilities: string[] = [],
    scopes: string[] = [],
    metadata: Record<string, string> = {}
  ): Promise<AgentIdentity> {
    // Generate SPIFFE ID
    const spiffeId = this.generateSPIFFEId(namespace, agentType);

    // Validate attestation (would integrate with SPIRE Agent in production)
    await this.validateAttestation(attestation);

    // Create identity
    const identity: AgentIdentity = {
      spiffeId,
      capabilities: new Set(capabilities),
      scopes: new Set(scopes),
      metadata: {
        ...metadata,
        registeredAt: new Date().toISOString(),
      },
      createdAt: new Date(),
    };

    // Store identity
    this.identities.set(spiffeId.fullId, identity);

    logger.info('Agent identity registered', {
      spiffeId: spiffeId.fullId,
      agentType,
      namespace,
      capabilities: capabilities.length,
      scopes: scopes.length,
    });

    return identity;
  }

  /**
   * Get agent identity by SPIFFE ID
   */
  getIdentity(spiffeId: string): AgentIdentity | undefined {
    return this.identities.get(spiffeId);
  }

  /**
   * Verify if an identity has a specific capability
   */
  hasCapability(spiffeId: string, capability: string): boolean {
    const identity = this.identities.get(spiffeId);
    return identity ? identity.capabilities.has(capability) : false;
  }

  /**
   * Verify if an identity has a specific scope
   */
  hasScope(spiffeId: string, scope: string): boolean {
    const identity = this.identities.get(spiffeId);
    if (!identity) return false;

    // Check exact scope match
    if (identity.scopes.has(scope)) return true;

    // Check hierarchical scope inheritance
    // e.g., "action:execute" inherits from "action:*"
    const scopeParts = scope.split(':');
    for (let i = scopeParts.length; i > 0; i--) {
      const parentScope = scopeParts.slice(0, i).join(':') + ':*';
      if (identity.scopes.has(parentScope)) return true;
    }

    return false;
  }

  /**
   * Grant additional capabilities to an identity
   */
  grantCapabilities(spiffeId: string, capabilities: string[]): boolean {
    const identity = this.identities.get(spiffeId);
    if (!identity) return false;

    capabilities.forEach(cap => identity.capabilities.add(cap));

    logger.info('Capabilities granted', {
      spiffeId,
      newCapabilities: capabilities,
      totalCapabilities: identity.capabilities.size,
    });

    return true;
  }

  /**
   * Revoke capabilities from an identity
   */
  revokeCapabilities(spiffeId: string, capabilities: string[]): boolean {
    const identity = this.identities.get(spiffeId);
    if (!identity) return false;

    capabilities.forEach(cap => identity.capabilities.delete(cap));

    logger.info('Capabilities revoked', {
      spiffeId,
      revokedCapabilities: capabilities,
      remainingCapabilities: identity.capabilities.size,
    });

    return true;
  }

  /**
   * Revoke an agent identity
   */
  revokeIdentity(spiffeId: string, reason: string): boolean {
    const identity = this.identities.get(spiffeId);
    if (!identity) return false;

    // Mark as expired
    identity.expiresAt = new Date();
    identity.metadata.revocationReason = reason;
    identity.metadata.revokedAt = new Date().toISOString();

    logger.warn('Agent identity revoked', {
      spiffeId,
      reason,
      agentType: identity.spiffeId.agentType,
    });

    return true;
  }

  /**
   * Get all identities in a namespace
   */
  getIdentitiesByNamespace(namespace: string): AgentIdentity[] {
    return Array.from(this.identities.values())
      .filter(id => id.spiffeId.namespace === namespace);
  }

  /**
   * Get all identities of a specific type
   */
  getIdentitiesByType(agentType: string): AgentIdentity[] {
    return Array.from(this.identities.values())
      .filter(id => id.spiffeId.agentType === agentType);
  }

  /**
   * Generate a unique instance ID
   */
  private generateInstanceId(): string {
    return randomBytes(16).toString('hex');
  }

  /**
   * Validate workload attestation (stub - would integrate with SPIRE Agent)
   */
  private async validateAttestation(attestation: WorkloadAttestation): Promise<boolean> {
    // In production, this would call the SPIRE Workload API to verify:
    // - Process attributes (PID, UID)
    // - Container image hash
    // - Kubernetes service account
    // - Binary hash

    // For now, just log the attestation
    logger.debug('Workload attestation received', {
      pid: attestation.workloadPid,
      uid: attestation.workloadUid,
      containerImage: attestation.containerImageHash,
      k8sServiceAccount: attestation.k8sServiceAccount,
    });

    return true;
  }

  /**
   * Parse a SPIFFE ID string into components
   */
  static parseSpiffeId(fullId: string): SPIFFEId | null {
    const match = fullId.match(/^spiffe:\/\/([^/]+)\/ns\/([^/]+)\/agent\/([^/]+)\/([^/]+)$/);
    if (!match) return null;

    return {
      trustDomain: match[1],
      namespace: match[2],
      agentType: match[3],
      instanceId: match[4],
      fullId,
    };
  }

  /**
   * Generate compliance report for agent identities
   */
  generateComplianceReport(): {
    totalIdentities: number;
    activeIdentities: number;
    revokedIdentities: number;
    identitiesByType: Record<string, number>;
    identitiesByNamespace: Record<string, number>;
    timestamp: string;
  } {
    const now = new Date();
    const identities = Array.from(this.identities.values());

    const active = identities.filter(id => !id.expiresAt || id.expiresAt > now);
    const revoked = identities.filter(id => id.expiresAt && id.expiresAt <= now);

    const byType: Record<string, number> = {};
    const byNamespace: Record<string, number> = {};

    identities.forEach(id => {
      byType[id.spiffeId.agentType] = (byType[id.spiffeId.agentType] || 0) + 1;
      byNamespace[id.spiffeId.namespace] = (byNamespace[id.spiffeId.namespace] || 0) + 1;
    });

    return {
      totalIdentities: identities.length,
      activeIdentities: active.length,
      revokedIdentities: revoked.length,
      identitiesByType: byType,
      identitiesByNamespace: byNamespace,
      timestamp: new Date().toISOString(),
    };
  }
}

// Singleton instance
let spiffeManager: SPIFFEIdentityManager;

export function getSPIFFEManager(trustDomain?: string): SPIFFEIdentityManager {
  if (!spiffeManager) {
    spiffeManager = new SPIFFEIdentityManager(trustDomain);
  }
  return spiffeManager;
}
