/**
 * Non-Human Identity (NHI) Lifecycle Management
 *
 * Manages the complete lifecycle of machine identities:
 * provision → active → rotate → suspend → revoke → decommission
 *
 * Includes:
 * - Automated provisioning
 * - Certificate rotation
 * - Expiration monitoring
 * - Emergency revocation
 * - Audit trail
 *
 * References:
 * - Gartner 2025 NHI Security Report
 * - Aembit.io NHI Lifecycle
 * - SPIFFE/SPIRE identity management
 */

import { SPIFFEId, createSPIFFEId } from './spiffe.js';
import { ScopeManager, ResourceScope } from './scopes.js';
import { logger } from '../core/logger.js';
import { randomUUID } from 'crypto';

/**
 * NHI lifecycle states
 */
export enum NHIState {
  PROVISIONING = 'provisioning',
  ACTIVE = 'active',
  ROTATING = 'rotating',
  SUSPENDED = 'suspended',
  REVOKED = 'revoked',
  DECOMMISSIONED = 'decommissioned',
}

/**
 * NHI record
 */
export interface NHIRecord {
  id: string;
  spiffeId: SPIFFEId;
  state: NHIState;
  createdAt: Date;
  createdBy: string;
  lastRotatedAt?: Date;
  expiresAt?: Date;
  suspendedAt?: Date;
  revokedAt?: Date;
  decommissionedAt?: Date;
  rotationPolicyDays?: number; // Auto-rotate every N days
  metadata: {
    purpose: string;
    owner: string;
    environment: string;
    tags?: Record<string, string>;
  };
  scopes: ResourceScope[];
  auditLog: NHIAuditEvent[];
}

/**
 * NHI audit event
 */
export interface NHIAuditEvent {
  timestamp: Date;
  action: string;
  actor: string;
  details?: Record<string, unknown>;
}

/**
 * NHI lifecycle alert
 */
export interface NHIAlert {
  alertType: 'expiration' | 'rotation_due' | 'rotation_failed' | 'revocation' | 'state_change';
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  identityId: string;
  spiffeId: string;
  metadata?: Record<string, unknown>;
}

/**
 * NHI lifecycle manager
 */
export class NHILifecycleManager {
  private identities: Map<string, NHIRecord> = new Map();
  private scopeManager: ScopeManager;

  constructor(scopeManager: ScopeManager) {
    this.scopeManager = scopeManager;
    
    // Start background tasks
    this.startMonitoring();
  }

  /**
   * Provision a new NHI
   */
  async provision(options: {
    agentType: 'agent' | 'service' | 'workflow';
    agentId?: string;
    namespace?: string;
    purpose: string;
    owner: string;
    environment: string;
    scopes: ResourceScope[];
    rotationPolicyDays?: number;
    expiresAt?: Date;
    createdBy: string;
    tags?: Record<string, string>;
  }): Promise<NHIRecord> {
    // Create SPIFFE ID
    const spiffeId = createSPIFFEId({
      agentType: options.agentType,
      agentId: options.agentId,
      namespace: options.namespace,
    });

    const record: NHIRecord = {
      id: randomUUID(),
      spiffeId,
      state: NHIState.PROVISIONING,
      createdAt: new Date(),
      createdBy: options.createdBy,
      rotationPolicyDays: options.rotationPolicyDays || 30,
      expiresAt: options.expiresAt,
      metadata: {
        purpose: options.purpose,
        owner: options.owner,
        environment: options.environment,
        tags: options.tags,
      },
      scopes: options.scopes,
      auditLog: [
        {
          timestamp: new Date(),
          action: 'provision',
          actor: options.createdBy,
          details: { purpose: options.purpose },
        },
      ],
    };

    this.identities.set(record.id, record);

    // Grant scopes
    this.scopeManager.grantScopes(spiffeId, options.scopes, {
      grantedBy: options.createdBy,
      expiresAt: options.expiresAt,
      reason: options.purpose,
    });

    // Transition to active
    await this.transitionState(record.id, NHIState.ACTIVE, options.createdBy);

    logger.info('Provisioned NHI', {
      id: record.id,
      spiffeId: spiffeId.toString(),
      owner: options.owner,
      environment: options.environment,
    });

    return record;
  }

  /**
   * Rotate credentials for an NHI
   */
  async rotate(
    id: string,
    actor: string,
    options?: { newExpiresAt?: Date }
  ): Promise<NHIRecord> {
    const record = this.identities.get(id);
    if (!record) {
      throw new Error(`NHI not found: ${id}`);
    }

    if (record.state !== NHIState.ACTIVE) {
      throw new Error(`Cannot rotate NHI in state: ${record.state}`);
    }

    // Transition to rotating
    await this.transitionState(id, NHIState.ROTATING, actor);

    // Re-grant scopes (simulates certificate rotation)
    this.scopeManager.revokeScopes(record.spiffeId);
    this.scopeManager.grantScopes(record.spiffeId, record.scopes, {
      grantedBy: actor,
      expiresAt: options?.newExpiresAt || record.expiresAt,
      reason: 'Certificate rotation',
    });

    record.lastRotatedAt = new Date();
    if (options?.newExpiresAt) {
      record.expiresAt = options.newExpiresAt;
    }

    record.auditLog.push({
      timestamp: new Date(),
      action: 'rotate',
      actor,
      details: { newExpiresAt: record.expiresAt?.toISOString() },
    });

    // Transition back to active
    await this.transitionState(id, NHIState.ACTIVE, actor);

    logger.info('Rotated NHI credentials', {
      id,
      spiffeId: record.spiffeId.toString(),
      actor,
    });

    return record;
  }

  /**
   * Suspend an NHI (temporary)
   */
  async suspend(id: string, actor: string, reason: string): Promise<NHIRecord> {
    const record = this.identities.get(id);
    if (!record) {
      throw new Error(`NHI not found: ${id}`);
    }

    // Revoke scopes temporarily
    this.scopeManager.revokeScopes(record.spiffeId);

    record.suspendedAt = new Date();
    record.auditLog.push({
      timestamp: new Date(),
      action: 'suspend',
      actor,
      details: { reason },
    });

    await this.transitionState(id, NHIState.SUSPENDED, actor);

    logger.warn('Suspended NHI', {
      id,
      spiffeId: record.spiffeId.toString(),
      actor,
      reason,
    });

    return record;
  }

  /**
   * Resume a suspended NHI
   */
  async resume(id: string, actor: string): Promise<NHIRecord> {
    const record = this.identities.get(id);
    if (!record) {
      throw new Error(`NHI not found: ${id}`);
    }

    if (record.state !== NHIState.SUSPENDED) {
      throw new Error(`Cannot resume NHI in state: ${record.state}`);
    }

    // Re-grant scopes
    this.scopeManager.grantScopes(record.spiffeId, record.scopes, {
      grantedBy: actor,
      expiresAt: record.expiresAt,
      reason: 'Resume from suspension',
    });

    record.auditLog.push({
      timestamp: new Date(),
      action: 'resume',
      actor,
    });

    await this.transitionState(id, NHIState.ACTIVE, actor);

    logger.info('Resumed NHI', {
      id,
      spiffeId: record.spiffeId.toString(),
      actor,
    });

    return record;
  }

  /**
   * Revoke an NHI (permanent, but not deleted)
   */
  async revoke(id: string, actor: string, reason: string): Promise<NHIRecord> {
    const record = this.identities.get(id);
    if (!record) {
      throw new Error(`NHI not found: ${id}`);
    }

    // Revoke all scopes
    this.scopeManager.revokeScopes(record.spiffeId);

    record.revokedAt = new Date();
    record.auditLog.push({
      timestamp: new Date(),
      action: 'revoke',
      actor,
      details: { reason },
    });

    await this.transitionState(id, NHIState.REVOKED, actor);

    logger.error('Revoked NHI', {
      id,
      spiffeId: record.spiffeId.toString(),
      actor,
      reason,
    });

    return record;
  }

  /**
   * Decommission an NHI (mark for deletion)
   */
  async decommission(id: string, actor: string): Promise<NHIRecord> {
    const record = this.identities.get(id);
    if (!record) {
      throw new Error(`NHI not found: ${id}`);
    }

    // Ensure revoked first
    if (record.state !== NHIState.REVOKED) {
      await this.revoke(id, actor, 'Decommissioning');
    }

    record.decommissionedAt = new Date();
    record.auditLog.push({
      timestamp: new Date(),
      action: 'decommission',
      actor,
    });

    await this.transitionState(id, NHIState.DECOMMISSIONED, actor);

    logger.info('Decommissioned NHI', {
      id,
      spiffeId: record.spiffeId.toString(),
      actor,
    });

    return record;
  }

  /**
   * Get NHI by ID
   */
  get(id: string): NHIRecord | undefined {
    return this.identities.get(id);
  }

  /**
   * Get NHI by SPIFFE ID
   */
  getBySpiffeId(spiffeId: SPIFFEId): NHIRecord | undefined {
    return Array.from(this.identities.values()).find(
      record => record.spiffeId.toString() === spiffeId.toString()
    );
  }

  /**
   * List all NHIs matching criteria
   */
  list(filters?: {
    state?: NHIState;
    owner?: string;
    environment?: string;
    tag?: { key: string; value: string };
  }): NHIRecord[] {
    let records = Array.from(this.identities.values());

    if (filters?.state) {
      records = records.filter(r => r.state === filters.state);
    }
    if (filters?.owner) {
      records = records.filter(r => r.metadata.owner === filters.owner);
    }
    if (filters?.environment) {
      records = records.filter(r => r.metadata.environment === filters.environment);
    }
    if (filters?.tag) {
      records = records.filter(
        r => r.metadata.tags?.[filters.tag!.key] === filters.tag!.value
      );
    }

    return records;
  }

  /**
   * Transition state and audit
   */
  private async transitionState(
    id: string,
    newState: NHIState,
    actor: string
  ): Promise<void> {
    const record = this.identities.get(id);
    if (!record) {
      throw new Error(`NHI not found: ${id}`);
    }

    const oldState = record.state;
    record.state = newState;

    logger.debug('NHI state transition', {
      id,
      spiffeId: record.spiffeId.toString(),
      oldState,
      newState,
      actor,
    });
  }

  private monitoringInterval: NodeJS.Timeout | null = null;
  private alertHandlers: Array<(alert: NHIAlert) => void> = [];

  /**
   * Start background monitoring
   */
  startMonitoring(intervalSeconds: number = 3600): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }

    this.monitoringInterval = setInterval(() => {
      this.checkExpirations();
      this.checkRotations();
    }, intervalSeconds * 1000);

    logger.info('Started NHI lifecycle monitoring', { intervalSeconds });
  }

  /**
   * Stop background monitoring
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      logger.info('Stopped NHI lifecycle monitoring');
    }
  }

  /**
   * Register alert handler
   */
  onAlert(handler: (alert: NHIAlert) => void): void {
    this.alertHandlers.push(handler);
  }

  /**
   * Emit alert to all handlers
   */
  private emitAlert(alert: NHIAlert): void {
    for (const handler of this.alertHandlers) {
      try {
        handler(alert);
      } catch (error) {
        logger.error('Alert handler failed', { error });
      }
    }
  }

  /**
   * Check for expired identities
   */
  private checkExpirations(): void {
    const now = new Date();
    let expiredCount = 0;

    for (const record of this.identities.values()) {
      if (
        record.state === NHIState.ACTIVE &&
        record.expiresAt &&
        record.expiresAt < now
      ) {
        this.emitAlert({
          alertType: 'expiration',
          severity: 'warning',
          message: `Identity expired and is being revoked`,
          identityId: record.id,
          spiffeId: record.spiffeId.toString(),
          metadata: { expiresAt: record.expiresAt.toISOString() },
        });

        this.revoke(record.id, 'system', 'Expired').catch(err => {
          logger.error('Failed to revoke expired NHI', {
            id: record.id,
            error: err.message,
          });
        });
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      logger.warn('Revoked expired NHIs', { count: expiredCount });
    }
  }

  /**
   * Check for identities needing rotation
   */
  private checkRotations(): void {
    const now = new Date();
    let rotatedCount = 0;

    for (const record of this.identities.values()) {
      if (record.state !== NHIState.ACTIVE || !record.rotationPolicyDays) {
        continue;
      }

      const lastRotation = record.lastRotatedAt || record.createdAt;
      const rotationDue = new Date(
        lastRotation.getTime() + record.rotationPolicyDays * 24 * 60 * 60 * 1000
      );

      if (rotationDue < now) {
        this.emitAlert({
          alertType: 'rotation_due',
          severity: 'info',
          message: `Identity rotation due`,
          identityId: record.id,
          spiffeId: record.spiffeId.toString(),
          metadata: { lastRotatedAt: lastRotation.toISOString() },
        });

        this.rotate(record.id, 'system').catch(err => {
          logger.error('Failed to auto-rotate NHI', {
            id: record.id,
            error: err.message,
          });

          this.emitAlert({
            alertType: 'rotation_failed',
            severity: 'error',
            message: `Failed to auto-rotate identity: ${err.message}`,
            identityId: record.id,
            spiffeId: record.spiffeId.toString(),
          });
        });
        rotatedCount++;
      }
    }

    if (rotatedCount > 0) {
      logger.info('Auto-rotated NHIs', { count: rotatedCount });
    }
  }
}

/**
 * Singleton instance
 */
let nhiLifecycleManager: NHILifecycleManager;

export function getNHILifecycleManager(): NHILifecycleManager {
  if (!nhiLifecycleManager) {
    nhiLifecycleManager = new NHILifecycleManager(require("./scopes.js").getScopeManager());
  }
  return nhiLifecycleManager;
}
