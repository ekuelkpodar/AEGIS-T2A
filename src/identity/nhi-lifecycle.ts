/**
 * Non-Human Identity (NHI) Lifecycle Management
 *
 * Full lifecycle management for all agent identities: provisioning, rotation,
 * suspension, revocation, and decommissioning. Includes automated alerts for
 * identities approaching expiration.
 *
 * Reference: Gartner 2025 NHI management trend, Aembit NHI patterns
 */

import { logger } from '../core/logger.js';
import type { SPIFFEId, AgentIdentity, SVID } from './spiffe.js';

export enum IdentityLifecycleState {
  PROVISIONING = 'provisioning',
  ACTIVE = 'active',
  ROTATING = 'rotating',
  SUSPENDED = 'suspended',
  REVOKING = 'revoking',
  REVOKED = 'revoked',
  DECOMMISSIONED = 'decommissioned',
}

export interface IdentityLifecycleRecord {
  identityId: string;
  spiffeId: string;
  state: IdentityLifecycleState;
  previousState?: IdentityLifecycleState;

  // Lifecycle timestamps
  provisionedAt: Date;
  activatedAt?: Date;
  lastRotatedAt?: Date;
  suspendedAt?: Date;
  revokedAt?: Date;
  decommissionedAt?: Date;

  // Expiration tracking
  currentSVIDExpiresAt?: Date;
  nextRotationDue?: Date;
  expirationWarningsSent: number;

  // Rotation tracking
  rotationCount: number;
  rotationPolicy: RotationPolicy;

  // Metadata
  reason?: string; // Reason for current state
  initiatedBy?: string;
  metadata: Record<string, unknown>;
}

export interface RotationPolicy {
  rotateAtFraction: number; // Rotate at this fraction of TTL (e.g., 0.66 = 66%)
  minTTL: number; // Minimum seconds between rotations
  maxTTL: number; // Maximum seconds between rotations
  alertBeforeExpiry: number[]; // Alert N seconds before expiry
  autoRotate: boolean;
}

export interface LifecycleAlert {
  alertId: string;
  identityId: string;
  spiffeId: string;
  alertType: 'rotation_due' | 'expiring_soon' | 'rotation_failed' | 'suspended' | 'revoked';
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  triggeredAt: Date;
  acknowledged: boolean;
}

export class NHILifecycleManager {
  private readonly identities: Map<string, IdentityLifecycleRecord>;
  private readonly alerts: Map<string, LifecycleAlert>;
  private readonly alertCallbacks: ((alert: LifecycleAlert) => void)[];
  private monitoringInterval?: NodeJS.Timeout;

  constructor() {
    this.identities = new Map();
    this.alerts = new Map();
    this.alertCallbacks = [];
  }

  /**
   * Provision a new agent identity
   */
  async provisionIdentity(
    spiffeId: SPIFFEId,
    rotationPolicy?: Partial<RotationPolicy>,
    metadata: Record<string, unknown> = {}
  ): Promise<IdentityLifecycleRecord> {
    const identityId = this.generateIdentityId();

    const record: IdentityLifecycleRecord = {
      identityId,
      spiffeId: spiffeId.fullId,
      state: IdentityLifecycleState.PROVISIONING,
      provisionedAt: new Date(),
      expirationWarningsSent: 0,
      rotationCount: 0,
      rotationPolicy: {
        rotateAtFraction: rotationPolicy?.rotateAtFraction ?? 0.66,
        minTTL: rotationPolicy?.minTTL ?? 300, // 5 minutes
        maxTTL: rotationPolicy?.maxTTL ?? 3600, // 1 hour
        alertBeforeExpiry: rotationPolicy?.alertBeforeExpiry ?? [86400, 3600, 300], // 24h, 1h, 5m
        autoRotate: rotationPolicy?.autoRotate ?? true,
      },
      metadata,
    };

    this.identities.set(identityId, record);

    logger.info('Identity provisioned', {
      identityId,
      spiffeId: spiffeId.fullId,
      rotationPolicy: record.rotationPolicy,
    });

    return record;
  }

  /**
   * Activate a provisioned identity
   */
  async activateIdentity(
    identityId: string,
    svid: SVID
  ): Promise<IdentityLifecycleRecord> {
    const record = this.identities.get(identityId);
    if (!record) {
      throw new Error(`Identity not found: ${identityId}`);
    }

    if (record.state !== IdentityLifecycleState.PROVISIONING) {
      throw new Error(`Identity not in provisioning state: ${record.state}`);
    }

    record.previousState = record.state;
    record.state = IdentityLifecycleState.ACTIVE;
    record.activatedAt = new Date();
    record.currentSVIDExpiresAt = svid.expiresAt;
    record.nextRotationDue = this.calculateNextRotation(
      svid.expiresAt,
      record.rotationPolicy
    );

    logger.info('Identity activated', {
      identityId,
      spiffeId: record.spiffeId,
      expiresAt: svid.expiresAt.toISOString(),
      nextRotationDue: record.nextRotationDue.toISOString(),
    });

    return record;
  }

  /**
   * Rotate an identity's SVID
   */
  async rotateIdentity(
    identityId: string,
    newSVID: SVID,
    initiatedBy: string = 'system'
  ): Promise<IdentityLifecycleRecord> {
    const record = this.identities.get(identityId);
    if (!record) {
      throw new Error(`Identity not found: ${identityId}`);
    }

    if (record.state !== IdentityLifecycleState.ACTIVE) {
      throw new Error(`Identity not active: ${record.state}`);
    }

    record.previousState = record.state;
    record.state = IdentityLifecycleState.ROTATING;

    try {
      // Update SVID information
      record.currentSVIDExpiresAt = newSVID.expiresAt;
      record.lastRotatedAt = new Date();
      record.rotationCount++;
      record.nextRotationDue = this.calculateNextRotation(
        newSVID.expiresAt,
        record.rotationPolicy
      );
      record.expirationWarningsSent = 0; // Reset warnings

      record.state = IdentityLifecycleState.ACTIVE;

      logger.info('Identity rotated', {
        identityId,
        spiffeId: record.spiffeId,
        rotationCount: record.rotationCount,
        newExpiresAt: newSVID.expiresAt.toISOString(),
        nextRotationDue: record.nextRotationDue.toISOString(),
        initiatedBy,
      });

      return record;
    } catch (error) {
      // Rotation failed - create alert
      this.createAlert(identityId, 'rotation_failed', 'error', `Rotation failed: ${error}`);

      record.state = record.previousState || IdentityLifecycleState.ACTIVE;
      throw error;
    }
  }

  /**
   * Suspend an identity
   */
  async suspendIdentity(
    identityId: string,
    reason: string,
    suspendedBy: string
  ): Promise<IdentityLifecycleRecord> {
    const record = this.identities.get(identityId);
    if (!record) {
      throw new Error(`Identity not found: ${identityId}`);
    }

    if (record.state === IdentityLifecycleState.REVOKED ||
        record.state === IdentityLifecycleState.DECOMMISSIONED) {
      throw new Error(`Cannot suspend identity in ${record.state} state`);
    }

    record.previousState = record.state;
    record.state = IdentityLifecycleState.SUSPENDED;
    record.suspendedAt = new Date();
    record.reason = reason;
    record.initiatedBy = suspendedBy;

    this.createAlert(identityId, 'suspended', 'warning', `Identity suspended: ${reason}`);

    logger.warn('Identity suspended', {
      identityId,
      spiffeId: record.spiffeId,
      reason,
      suspendedBy,
    });

    return record;
  }

  /**
   * Resume a suspended identity
   */
  async resumeIdentity(
    identityId: string,
    resumedBy: string
  ): Promise<IdentityLifecycleRecord> {
    const record = this.identities.get(identityId);
    if (!record) {
      throw new Error(`Identity not found: ${identityId}`);
    }

    if (record.state !== IdentityLifecycleState.SUSPENDED) {
      throw new Error(`Identity not suspended: ${record.state}`);
    }

    record.state = record.previousState || IdentityLifecycleState.ACTIVE;
    record.previousState = IdentityLifecycleState.SUSPENDED;
    record.initiatedBy = resumedBy;

    logger.info('Identity resumed', {
      identityId,
      spiffeId: record.spiffeId,
      resumedBy,
    });

    return record;
  }

  /**
   * Revoke an identity
   */
  async revokeIdentity(
    identityId: string,
    reason: string,
    revokedBy: string
  ): Promise<IdentityLifecycleRecord> {
    const record = this.identities.get(identityId);
    if (!record) {
      throw new Error(`Identity not found: ${identityId}`);
    }

    if (record.state === IdentityLifecycleState.DECOMMISSIONED) {
      throw new Error('Cannot revoke decommissioned identity');
    }

    record.previousState = record.state;
    record.state = IdentityLifecycleState.REVOKING;

    try {
      // Perform revocation (would integrate with SPIRE Agent)
      // For now, just update state

      record.state = IdentityLifecycleState.REVOKED;
      record.revokedAt = new Date();
      record.reason = reason;
      record.initiatedBy = revokedBy;

      this.createAlert(identityId, 'revoked', 'critical', `Identity revoked: ${reason}`);

      logger.warn('Identity revoked', {
        identityId,
        spiffeId: record.spiffeId,
        reason,
        revokedBy,
      });

      return record;
    } catch (error) {
      record.state = record.previousState || IdentityLifecycleState.ACTIVE;
      throw error;
    }
  }

  /**
   * Decommission an identity (final state)
   */
  async decommissionIdentity(
    identityId: string,
    reason: string,
    decommissionedBy: string
  ): Promise<IdentityLifecycleRecord> {
    const record = this.identities.get(identityId);
    if (!record) {
      throw new Error(`Identity not found: ${identityId}`);
    }

    // Must be revoked first
    if (record.state !== IdentityLifecycleState.REVOKED) {
      await this.revokeIdentity(identityId, 'Decommissioning', decommissionedBy);
    }

    record.state = IdentityLifecycleState.DECOMMISSIONED;
    record.decommissionedAt = new Date();
    record.reason = reason;
    record.initiatedBy = decommissionedBy;

    logger.info('Identity decommissioned', {
      identityId,
      spiffeId: record.spiffeId,
      reason,
      decommissionedBy,
    });

    return record;
  }

  /**
   * Start lifecycle monitoring
   */
  startMonitoring(intervalSeconds: number = 60): void {
    if (this.monitoringInterval) {
      return; // Already monitoring
    }

    this.monitoringInterval = setInterval(() => {
      this.checkRotations();
      this.checkExpirations();
    }, intervalSeconds * 1000);

    logger.info('NHI lifecycle monitoring started', { intervalSeconds });
  }

  /**
   * Stop lifecycle monitoring
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
      logger.info('NHI lifecycle monitoring stopped');
    }
  }

  /**
   * Register alert callback
   */
  onAlert(callback: (alert: LifecycleAlert) => void): void {
    this.alertCallbacks.push(callback);
  }

  /**
   * Get identity record
   */
  getIdentity(identityId: string): IdentityLifecycleRecord | undefined {
    return this.identities.get(identityId);
  }

  /**
   * Get all identities in a specific state
   */
  getIdentitiesByState(state: IdentityLifecycleState): IdentityLifecycleRecord[] {
    return Array.from(this.identities.values()).filter(r => r.state === state);
  }

  /**
   * Get all active alerts
   */
  getActiveAlerts(): LifecycleAlert[] {
    return Array.from(this.alerts.values()).filter(a => !a.acknowledged);
  }

  /**
   * Acknowledge an alert
   */
  acknowledgeAlert(alertId: string): boolean {
    const alert = this.alerts.get(alertId);
    if (!alert) return false;

    alert.acknowledged = true;
    return true;
  }

  /**
   * Get lifecycle statistics
   */
  getStats(): {
    totalIdentities: number;
    byState: Record<string, number>;
    activeAlerts: number;
    avgRotationCount: number;
    identitiesNearExpiry: number;
    timestamp: string;
  } {
    const identities = Array.from(this.identities.values());

    const byState: Record<string, number> = {};
    Object.values(IdentityLifecycleState).forEach(state => {
      byState[state] = identities.filter(i => i.state === state).length;
    });

    const avgRotationCount =
      identities.reduce((sum, i) => sum + i.rotationCount, 0) / identities.length || 0;

    const now = new Date();
    const identitiesNearExpiry = identities.filter(i =>
      i.currentSVIDExpiresAt &&
      i.currentSVIDExpiresAt.getTime() - now.getTime() < 86400000 // 24 hours
    ).length;

    return {
      totalIdentities: identities.length,
      byState,
      activeAlerts: this.getActiveAlerts().length,
      avgRotationCount,
      identitiesNearExpiry,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Check if identities need rotation
   */
  private checkRotations(): void {
    const now = new Date();

    for (const record of this.identities.values()) {
      if (record.state !== IdentityLifecycleState.ACTIVE) continue;
      if (!record.rotationPolicy.autoRotate) continue;
      if (!record.nextRotationDue) continue;

      if (now >= record.nextRotationDue) {
        this.createAlert(
          record.identityId,
          'rotation_due',
          'warning',
          'Identity rotation is due'
        );
      }
    }
  }

  /**
   * Check for expiring identities
   */
  private checkExpirations(): void {
    const now = new Date();

    for (const record of this.identities.values()) {
      if (!record.currentSVIDExpiresAt) continue;

      const timeUntilExpiry =
        (record.currentSVIDExpiresAt.getTime() - now.getTime()) / 1000;

      for (const alertSeconds of record.rotationPolicy.alertBeforeExpiry) {
        if (timeUntilExpiry <= alertSeconds && timeUntilExpiry > 0) {
          // Check if we already sent this warning level
          const warningsSent = record.expirationWarningsSent;
          const alertIndex = record.rotationPolicy.alertBeforeExpiry.indexOf(alertSeconds);

          if (alertIndex >= warningsSent) {
            this.createAlert(
              record.identityId,
              'expiring_soon',
              this.getSeverityForExpiry(timeUntilExpiry),
              `Identity expires in ${Math.round(timeUntilExpiry)} seconds`
            );

            record.expirationWarningsSent = alertIndex + 1;
          }
        }
      }
    }
  }

  /**
   * Calculate next rotation time
   */
  private calculateNextRotation(expiresAt: Date, policy: RotationPolicy): Date {
    const now = new Date();
    const ttl = expiresAt.getTime() - now.getTime();
    const rotationTime = now.getTime() + ttl * policy.rotateAtFraction;
    return new Date(rotationTime);
  }

  /**
   * Create and dispatch alert
   */
  private createAlert(
    identityId: string,
    alertType: LifecycleAlert['alertType'],
    severity: LifecycleAlert['severity'],
    message: string
  ): void {
    const record = this.identities.get(identityId);
    if (!record) return;

    const alert: LifecycleAlert = {
      alertId: this.generateAlertId(),
      identityId,
      spiffeId: record.spiffeId,
      alertType,
      severity,
      message,
      triggeredAt: new Date(),
      acknowledged: false,
    };

    this.alerts.set(alert.alertId, alert);

    // Dispatch to callbacks
    this.alertCallbacks.forEach(callback => {
      try {
        callback(alert);
      } catch (error) {
        logger.error('Alert callback failed', { error });
      }
    });

    logger.warn('Lifecycle alert created', {
      alertId: alert.alertId,
      identityId,
      alertType,
      severity,
      message,
    });
  }

  /**
   * Get severity based on time until expiry
   */
  private getSeverityForExpiry(seconds: number): LifecycleAlert['severity'] {
    if (seconds < 300) return 'critical'; // < 5 minutes
    if (seconds < 3600) return 'error'; // < 1 hour
    if (seconds < 86400) return 'warning'; // < 24 hours
    return 'info';
  }

  /**
   * Generate unique identity ID
   */
  private generateIdentityId(): string {
    return `nhi-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  /**
   * Generate unique alert ID
   */
  private generateAlertId(): string {
    return `alert-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }
}

// Singleton instance
let nhiLifecycleManager: NHILifecycleManager;

export function getNHILifecycleManager(): NHILifecycleManager {
  if (!nhiLifecycleManager) {
    nhiLifecycleManager = new NHILifecycleManager();
  }
  return nhiLifecycleManager;
}
