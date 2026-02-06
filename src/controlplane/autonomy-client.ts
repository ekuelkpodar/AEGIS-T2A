/**
 * Autonomy Manager Client
 *
 * Client for the AEGIS-T2A Autonomy Manager microservice.
 * Manages time-limited autonomy leases with action and resource scoping.
 */

import { ControlPlaneClient, ControlPlaneConfig } from './client.js';
import { logger } from '../core/logger.js';

export enum AutonomyLevel {
  LEVEL_0 = 0, // No autonomy - all actions require approval
  LEVEL_1 = 1, // Read-only access
  LEVEL_2 = 2, // Read + safe write operations
  LEVEL_3 = 3, // Read + write + execute
  LEVEL_4 = 4, // Read + write + execute + delete
  LEVEL_5 = 5, // Full autonomy (use with extreme caution)
}

export interface AutonomyLease {
  leaseId: string;
  agentId: string;
  workflowId: string;
  level: AutonomyLevel;
  allowedActions: string[]; // Patterns: "aws:ec2:*", "database:read:*"
  allowedResources: string[]; // Resource ARNs or patterns
  deniedActions?: string[];
  deniedResources?: string[];
  maxActions?: number;
  maxResourcesPerAction?: number;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  renewalCount: number;
  metadata?: Record<string, unknown>;
}

export interface LeaseRequest {
  agentId: string;
  workflowId: string;
  level: AutonomyLevel;
  allowedActions: string[];
  allowedResources: string[];
  deniedActions?: string[];
  deniedResources?: string[];
  ttlSeconds: number;
  maxActions?: number;
  maxResourcesPerAction?: number;
  justification?: string;
  metadata?: Record<string, unknown>;
}

export interface LeaseRenewalRequest {
  leaseId: string;
  extensionSeconds: number;
  justification?: string;
}

export interface LeaseValidation {
  valid: boolean;
  leaseId?: string;
  reason?: string;
  remainingActions?: number;
  expiresIn?: number;
}

export class AutonomyManagerClient extends ControlPlaneClient {
  constructor(config?: Partial<ControlPlaneConfig>) {
    super({
      baseUrl:
        config?.baseUrl || process.env.AUTONOMY_SERVICE_URL || 'http://localhost:8003',
      ...config,
    });
  }

  /**
   * Request a new autonomy lease
   */
  async requestLease(request: LeaseRequest): Promise<AutonomyLease> {
    logger.info('Requesting autonomy lease', {
      agentId: request.agentId,
      workflowId: request.workflowId,
      level: request.level,
      ttlSeconds: request.ttlSeconds,
    });

    const response = await this.post<{ lease: AutonomyLease }>(
      '/api/v1/leases',
      request
    );

    return response.lease;
  }

  /**
   * Get lease details
   */
  async getLease(leaseId: string): Promise<AutonomyLease> {
    const response = await this.get<{ lease: AutonomyLease }>(
      `/api/v1/leases/${leaseId}`
    );

    return response.lease;
  }

  /**
   * Validate if an action is allowed under a lease
   */
  async validateAction(
    leaseId: string,
    action: string,
    resource: string
  ): Promise<LeaseValidation> {
    logger.debug('Validating action against lease', {
      leaseId,
      action,
      resource,
    });

    const response = await this.post<{ validation: LeaseValidation }>(
      `/api/v1/leases/${leaseId}/validate`,
      { action, resource }
    );

    return response.validation;
  }

  /**
   * Record action execution against a lease
   */
  async recordAction(
    leaseId: string,
    action: string,
    resource: string,
    success: boolean,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    logger.debug('Recording action execution', {
      leaseId,
      action,
      resource,
      success,
    });

    await this.post(`/api/v1/leases/${leaseId}/actions`, {
      action,
      resource,
      success,
      metadata,
      executed_at: new Date().toISOString(),
    });
  }

  /**
   * Renew an existing lease
   */
  async renewLease(request: LeaseRenewalRequest): Promise<AutonomyLease> {
    logger.info('Renewing autonomy lease', {
      leaseId: request.leaseId,
      extensionSeconds: request.extensionSeconds,
    });

    const response = await this.post<{ lease: AutonomyLease }>(
      `/api/v1/leases/${request.leaseId}/renew`,
      {
        extension_seconds: request.extensionSeconds,
        justification: request.justification,
      }
    );

    return response.lease;
  }

  /**
   * Revoke a lease
   */
  async revokeLease(leaseId: string, reason: string): Promise<void> {
    logger.warn('Revoking autonomy lease', { leaseId, reason });

    await this.post(`/api/v1/leases/${leaseId}/revoke`, { reason });
  }

  /**
   * Get active leases for an agent
   */
  async getAgentLeases(agentId: string, includeRevoked = false): Promise<AutonomyLease[]> {
    const params: Record<string, string> = {
      agent_id: agentId,
    };

    if (includeRevoked) {
      params.include_revoked = 'true';
    }

    const response = await this.get<{ leases: AutonomyLease[] }>(
      '/api/v1/leases',
      params
    );

    return response.leases;
  }

  /**
   * Get leases for a workflow
   */
  async getWorkflowLeases(workflowId: string): Promise<AutonomyLease[]> {
    const response = await this.get<{ leases: AutonomyLease[] }>('/api/v1/leases', {
      workflow_id: workflowId,
    });

    return response.leases;
  }

  /**
   * Revoke all leases for an agent (emergency stop)
   */
  async revokeAllAgentLeases(agentId: string, reason: string): Promise<number> {
    logger.warn('Revoking all agent leases', { agentId, reason });

    const response = await this.post<{ revoked_count: number }>(
      `/api/v1/leases/revoke-all`,
      {
        agent_id: agentId,
        reason,
      }
    );

    return response.revoked_count;
  }

  /**
   * Revoke all leases for a workflow
   */
  async revokeAllWorkflowLeases(workflowId: string, reason: string): Promise<number> {
    logger.warn('Revoking all workflow leases', { workflowId, reason });

    const response = await this.post<{ revoked_count: number }>(
      `/api/v1/leases/revoke-all`,
      {
        workflow_id: workflowId,
        reason,
      }
    );

    return response.revoked_count;
  }

  /**
   * Get autonomy statistics
   */
  async getAutonomyStats(): Promise<{
    activeLeases: number;
    revokedLeases: number;
    byLevel: Record<AutonomyLevel, number>;
    avgTTL: number;
    avgActionsPerLease: number;
  }> {
    const response = await this.get<{
      stats: {
        active_leases: number;
        revoked_leases: number;
        by_level: Record<AutonomyLevel, number>;
        avg_ttl: number;
        avg_actions_per_lease: number;
      };
    }>('/api/v1/leases/stats');

    return {
      activeLeases: response.stats.active_leases,
      revokedLeases: response.stats.revoked_leases,
      byLevel: response.stats.by_level,
      avgTTL: response.stats.avg_ttl,
      avgActionsPerLease: response.stats.avg_actions_per_lease,
    };
  }

  /**
   * Check if lease is about to expire
   */
  isLeaseExpiringSoon(lease: AutonomyLease, thresholdSeconds = 300): boolean {
    const expiresAt = new Date(lease.expiresAt).getTime();
    const now = Date.now();
    const timeRemaining = expiresAt - now;

    return timeRemaining > 0 && timeRemaining < thresholdSeconds * 1000;
  }

  /**
   * Get recommended autonomy level based on workflow risk
   */
  getRecommendedLevel(blastRadiusScore: number): AutonomyLevel {
    if (blastRadiusScore <= 20) return AutonomyLevel.LEVEL_4;
    if (blastRadiusScore <= 40) return AutonomyLevel.LEVEL_3;
    if (blastRadiusScore <= 60) return AutonomyLevel.LEVEL_2;
    if (blastRadiusScore <= 80) return AutonomyLevel.LEVEL_1;
    return AutonomyLevel.LEVEL_0;
  }
}

// Singleton instance
let autonomyClient: AutonomyManagerClient;

export function getAutonomyClient(
  config?: Partial<ControlPlaneConfig>
): AutonomyManagerClient {
  if (!autonomyClient) {
    autonomyClient = new AutonomyManagerClient(config);
  }
  return autonomyClient;
}
