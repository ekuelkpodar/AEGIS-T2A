/**
 * Policy Versioning & History
 *
 * Track policy changes over time with full audit trail and rollback capability.
 *
 * Features:
 * - Semantic versioning for policies
 * - Full change history with diffs
 * - Rollback to any previous version
 * - Policy approval workflows
 * - Change impact tracking
 *
 * References:
 * - GitOps for policy management
 * - HashiCorp Sentinel versioning
 * - AWS IAM Policy versions
 */

import { EventEmitter } from 'events';
import { componentLogger } from '../core/logger.js';
import { hashObject } from '../core/crypto.js';
import type { PolicyRule } from '../core/types.js';

const logger = componentLogger('policy-versioning');

// =============================================================================
// Types
// =============================================================================

export interface PolicyVersion {
  versionId: string;
  ruleId: string;
  version: string; // Semantic version: 1.0.0
  rule: PolicyRule;
  contentHash: string; // SHA-256 hash of rule content
  changeType: 'created' | 'updated' | 'deleted' | 'rollback';
  changedBy: string;
  changeReason: string;
  approvedBy?: string;
  approvedAt?: Date;
  diff?: PolicyDiff;
  createdAt: Date;
  tags: string[];
}

export interface PolicyDiff {
  previous?: Partial<PolicyRule>;
  current: Partial<PolicyRule>;
  changes: Array<{
    field: string;
    oldValue: unknown;
    newValue: unknown;
  }>;
}

export interface PolicyVersionHistory {
  ruleId: string;
  versions: PolicyVersion[];
  currentVersion: string;
  totalVersions: number;
}

export interface RollbackRequest {
  ruleId: string;
  targetVersion: string;
  requestedBy: string;
  reason: string;
}

export interface PolicyApproval {
  versionId: string;
  approver: string;
  approved: boolean;
  reason: string;
  approvedAt: Date;
}

// =============================================================================
// Policy Versioning Manager
// =============================================================================

export class PolicyVersioningManager extends EventEmitter {
  private versions = new Map<string, PolicyVersion[]>();
  private currentVersions = new Map<string, string>();

  /**
   * Create a new policy version
   */
  async createVersion(
    rule: PolicyRule,
    changeType: PolicyVersion['changeType'],
    changedBy: string,
    changeReason: string,
    previousRule?: PolicyRule
  ): Promise<PolicyVersion> {
    const ruleId = rule.ruleId;
    const existingVersions = this.versions.get(ruleId) || [];

    // Calculate next version number
    const nextVersion = this.calculateNextVersion(existingVersions, changeType);

    // Calculate content hash
    const contentHash = hashObject({
      name: rule.name,
      description: rule.description,
      condition: rule.condition,
      action: rule.action,
      riskLevel: rule.riskLevel,
      priority: rule.priority,
    });

    // Calculate diff if updating
    const diff = previousRule ? this.calculateDiff(previousRule, rule) : undefined;

    const version: PolicyVersion = {
      versionId: `${ruleId}_v${nextVersion}`,
      ruleId,
      version: nextVersion,
      rule: { ...rule },
      contentHash,
      changeType,
      changedBy,
      changeReason,
      diff,
      createdAt: new Date(),
      tags: [],
    };

    // Store version
    existingVersions.push(version);
    this.versions.set(ruleId, existingVersions);
    this.currentVersions.set(ruleId, nextVersion);

    this.emit('version_created', {
      ruleId,
      version: nextVersion,
      changeType,
      changedBy,
    });

    logger.info(
      { ruleId, version: nextVersion, changeType },
      'Policy version created'
    );

    return version;
  }

  /**
   * Get version history for a policy
   */
  getHistory(ruleId: string): PolicyVersionHistory | null {
    const versions = this.versions.get(ruleId);

    if (!versions || versions.length === 0) {
      return null;
    }

    const currentVersion = this.currentVersions.get(ruleId) || versions[versions.length - 1].version;

    return {
      ruleId,
      versions: [...versions],
      currentVersion,
      totalVersions: versions.length,
    };
  }

  /**
   * Get a specific policy version
   */
  getVersion(ruleId: string, version: string): PolicyVersion | null {
    const versions = this.versions.get(ruleId);

    if (!versions) {
      return null;
    }

    return versions.find(v => v.version === version) || null;
  }

  /**
   * Get current policy version
   */
  getCurrentVersion(ruleId: string): PolicyVersion | null {
    const versions = this.versions.get(ruleId);
    const currentVersion = this.currentVersions.get(ruleId);

    if (!versions || !currentVersion) {
      return null;
    }

    return versions.find(v => v.version === currentVersion) || null;
  }

  /**
   * Rollback to a previous version
   */
  async rollback(request: RollbackRequest): Promise<PolicyVersion> {
    const targetVersion = this.getVersion(request.ruleId, request.targetVersion);

    if (!targetVersion) {
      throw new Error(`Version ${request.targetVersion} not found for rule ${request.ruleId}`);
    }

    // Create a new version that's a copy of the target
    const newVersion = await this.createVersion(
      targetVersion.rule,
      'rollback',
      request.requestedBy,
      `Rollback to version ${request.targetVersion}: ${request.reason}`,
      this.getCurrentVersion(request.ruleId)?.rule
    );

    this.emit('policy_rollback', {
      ruleId: request.ruleId,
      fromVersion: this.currentVersions.get(request.ruleId),
      toVersion: request.targetVersion,
      newVersion: newVersion.version,
      requestedBy: request.requestedBy,
    });

    logger.info(
      { ruleId: request.ruleId, targetVersion: request.targetVersion },
      'Policy rolled back'
    );

    return newVersion;
  }

  /**
   * Approve a policy version
   */
  async approveVersion(approval: Omit<PolicyApproval, 'approvedAt'>): Promise<void> {
    const versions = this.versions.get(approval.versionId.split('_v')[0]);

    if (!versions) {
      throw new Error(`Version ${approval.versionId} not found`);
    }

    const version = versions.find(v => v.versionId === approval.versionId);

    if (!version) {
      throw new Error(`Version ${approval.versionId} not found`);
    }

    if (!approval.approved) {
      // Rejected - rollback to previous version if available
      const previousVersion = versions[versions.length - 2];
      if (previousVersion) {
        await this.rollback({
          ruleId: version.ruleId,
          targetVersion: previousVersion.version,
          requestedBy: approval.approver,
          reason: `Rejected: ${approval.reason}`,
        });
      }
    } else {
      version.approvedBy = approval.approver;
      version.approvedAt = new Date();
    }

    this.emit('version_approved', {
      versionId: approval.versionId,
      approved: approval.approved,
      approver: approval.approver,
    });

    logger.info(
      { versionId: approval.versionId, approved: approval.approved },
      'Policy version approval processed'
    );
  }

  /**
   * Tag a policy version
   */
  tagVersion(ruleId: string, version: string, tags: string[]): void {
    const versionObj = this.getVersion(ruleId, version);

    if (!versionObj) {
      throw new Error(`Version ${version} not found for rule ${ruleId}`);
    }

    versionObj.tags = [...new Set([...versionObj.tags, ...tags])];

    logger.debug({ ruleId, version, tags }, 'Policy version tagged');
  }

  /**
   * Compare two versions
   */
  compareVersions(
    ruleId: string,
    version1: string,
    version2: string
  ): PolicyDiff | null {
    const v1 = this.getVersion(ruleId, version1);
    const v2 = this.getVersion(ruleId, version2);

    if (!v1 || !v2) {
      return null;
    }

    return this.calculateDiff(v1.rule, v2.rule);
  }

  /**
   * Calculate diff between two policy rules
   */
  private calculateDiff(previous: PolicyRule, current: PolicyRule): PolicyDiff {
    const changes: PolicyDiff['changes'] = [];

    const fields: Array<keyof PolicyRule> = [
      'name',
      'description',
      'condition',
      'action',
      'riskLevel',
      'priority',
      'enabled',
    ];

    for (const field of fields) {
      const oldValue = previous[field];
      const newValue = current[field];

      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        changes.push({
          field,
          oldValue,
          newValue,
        });
      }
    }

    return {
      previous: { ...previous },
      current: { ...current },
      changes,
    };
  }

  /**
   * Calculate next version number (semantic versioning)
   */
  private calculateNextVersion(
    existingVersions: PolicyVersion[],
    changeType: PolicyVersion['changeType']
  ): string {
    if (existingVersions.length === 0) {
      return '1.0.0';
    }

    const lastVersion = existingVersions[existingVersions.length - 1].version;
    const parts = lastVersion.split('.').map(Number);

    switch (changeType) {
      case 'created':
        return '1.0.0';

      case 'updated':
        // Minor version bump
        parts[1]++;
        parts[2] = 0;
        break;

      case 'rollback':
        // Patch version bump
        parts[2]++;
        break;

      case 'deleted':
        // Major version bump
        parts[0]++;
        parts[1] = 0;
        parts[2] = 0;
        break;
    }

    return parts.join('.');
  }

  /**
   * Get all policies with versions
   */
  getAllVersions(): Map<string, PolicyVersion[]> {
    return new Map(this.versions);
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalPolicies: number;
    totalVersions: number;
    avgVersionsPerPolicy: number;
    unapprovedVersions: number;
  } {
    const totalPolicies = this.versions.size;
    let totalVersions = 0;
    let unapprovedVersions = 0;

    for (const versions of this.versions.values()) {
      totalVersions += versions.length;
      unapprovedVersions += versions.filter(v => !v.approvedBy).length;
    }

    return {
      totalPolicies,
      totalVersions,
      avgVersionsPerPolicy: totalPolicies > 0 ? totalVersions / totalPolicies : 0,
      unapprovedVersions,
    };
  }

  /**
   * Clear all versions (for testing)
   */
  clear(): void {
    this.versions.clear();
    this.currentVersions.clear();
  }
}

// =============================================================================
// Singleton
// =============================================================================

let versioningManager: PolicyVersioningManager | null = null;

export function getPolicyVersioningManager(): PolicyVersioningManager {
  if (!versioningManager) {
    versioningManager = new PolicyVersioningManager();
  }
  return versioningManager;
}
