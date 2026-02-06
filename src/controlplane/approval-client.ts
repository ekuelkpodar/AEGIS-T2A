/**
 * Approval System Client
 *
 * Client for the AEGIS-T2A Approval System microservice.
 * Handles human-in-the-loop approval workflows with multi-level escalation.
 */

import { ControlPlaneClient, ControlPlaneConfig } from './client.js';
import { logger } from '../core/logger.js';

export enum ApprovalStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  TIMEOUT = 'timeout',
  ESCALATED = 'escalated',
}

export enum RiskLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export interface ApprovalRequest {
  workflowId: string;
  actionSummary: string;
  riskLevel: RiskLevel;
  blastRadiusScore?: number;
  affectedResources: string[];
  requester: string;
  metadata?: Record<string, unknown>;
  timeoutSeconds?: number;
  requiredApprovers?: number;
  escalationChain?: string[];
}

export interface ApprovalResponse {
  approvalId: string;
  workflowId: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt?: string;
  approvers: ApproverInfo[];
  decisions: ApprovalDecision[];
}

export interface ApproverInfo {
  approverId: string;
  approverName?: string;
  level: number;
  notifiedAt?: string;
}

export interface ApprovalDecision {
  approverId: string;
  decision: 'approved' | 'rejected';
  rationale?: string;
  decidedAt: string;
  ipAddress?: string;
}

export interface ApprovalQuery {
  workflowId?: string;
  status?: ApprovalStatus;
  riskLevel?: RiskLevel;
  limit?: number;
  offset?: number;
}

export class ApprovalSystemClient extends ControlPlaneClient {
  constructor(config?: Partial<ControlPlaneConfig>) {
    super({
      baseUrl: config?.baseUrl || process.env.APPROVAL_SERVICE_URL || 'http://localhost:8004',
      ...config,
    });
  }

  /**
   * Create a new approval request
   */
  async createApprovalRequest(request: ApprovalRequest): Promise<ApprovalResponse> {
    logger.info('Creating approval request', {
      workflowId: request.workflowId,
      riskLevel: request.riskLevel,
      requester: request.requester,
    });

    const response = await this.post<{ approval: ApprovalResponse }>(
      '/api/v1/approvals',
      request
    );

    return response.approval;
  }

  /**
   * Get approval request status
   */
  async getApproval(approvalId: string): Promise<ApprovalResponse> {
    const response = await this.get<{ approval: ApprovalResponse }>(
      `/api/v1/approvals/${approvalId}`
    );

    return response.approval;
  }

  /**
   * Submit approval decision
   */
  async submitDecision(
    approvalId: string,
    decision: {
      approverId: string;
      decision: 'approved' | 'rejected';
      rationale?: string;
    }
  ): Promise<ApprovalResponse> {
    logger.info('Submitting approval decision', {
      approvalId,
      approverId: decision.approverId,
      decision: decision.decision,
    });

    const response = await this.post<{ approval: ApprovalResponse }>(
      `/api/v1/approvals/${approvalId}/decisions`,
      decision
    );

    return response.approval;
  }

  /**
   * Query approval requests
   */
  async queryApprovals(query: ApprovalQuery): Promise<{
    approvals: ApprovalResponse[];
    total: number;
  }> {
    const params: Record<string, string> = {};

    if (query.workflowId) params.workflow_id = query.workflowId;
    if (query.status) params.status = query.status;
    if (query.riskLevel) params.risk_level = query.riskLevel;
    if (query.limit) params.limit = query.limit.toString();
    if (query.offset) params.offset = query.offset.toString();

    const response = await this.get<{
      approvals: ApprovalResponse[];
      total: number;
    }>('/api/v1/approvals', params);

    return response;
  }

  /**
   * Cancel an approval request
   */
  async cancelApproval(approvalId: string, reason: string): Promise<void> {
    logger.info('Cancelling approval request', { approvalId, reason });

    await this.delete(`/api/v1/approvals/${approvalId}`);
  }

  /**
   * Wait for approval decision with polling
   */
  async waitForDecision(
    approvalId: string,
    options: {
      pollInterval?: number;
      maxWaitTime?: number;
    } = {}
  ): Promise<ApprovalResponse> {
    const pollInterval = options.pollInterval || 5000; // 5 seconds
    const maxWaitTime = options.maxWaitTime || 3600000; // 1 hour
    const startTime = Date.now();

    logger.debug('Waiting for approval decision', {
      approvalId,
      pollInterval,
      maxWaitTime,
    });

    while (Date.now() - startTime < maxWaitTime) {
      const approval = await this.getApproval(approvalId);

      if (
        approval.status === ApprovalStatus.APPROVED ||
        approval.status === ApprovalStatus.REJECTED ||
        approval.status === ApprovalStatus.TIMEOUT
      ) {
        logger.info('Approval decision received', {
          approvalId,
          status: approval.status,
          waitTime: Date.now() - startTime,
        });

        return approval;
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    logger.warn('Approval decision timeout', {
      approvalId,
      maxWaitTime,
    });

    throw new Error('Approval decision timeout');
  }

  /**
   * Get pending approvals for a specific approver
   */
  async getPendingApprovals(approverId: string): Promise<ApprovalResponse[]> {
    const response = await this.get<{ approvals: ApprovalResponse[] }>(
      '/api/v1/approvals/pending',
      { approver_id: approverId }
    );

    return response.approvals;
  }

  /**
   * Get approval statistics
   */
  async getApprovalStats(timeRange?: { start: Date; end: Date }): Promise<{
    total: number;
    byStatus: Record<ApprovalStatus, number>;
    byRiskLevel: Record<RiskLevel, number>;
    avgResponseTime: number;
    timeoutRate: number;
  }> {
    const params: Record<string, string> = {};

    if (timeRange) {
      params.start = timeRange.start.toISOString();
      params.end = timeRange.end.toISOString();
    }

    const response = await this.get<{
      stats: {
        total: number;
        by_status: Record<ApprovalStatus, number>;
        by_risk_level: Record<RiskLevel, number>;
        avg_response_time: number;
        timeout_rate: number;
      };
    }>('/api/v1/approvals/stats', params);

    return {
      total: response.stats.total,
      byStatus: response.stats.by_status,
      byRiskLevel: response.stats.by_risk_level,
      avgResponseTime: response.stats.avg_response_time,
      timeoutRate: response.stats.timeout_rate,
    };
  }
}

// Singleton instance
let approvalClient: ApprovalSystemClient;

export function getApprovalClient(config?: Partial<ControlPlaneConfig>): ApprovalSystemClient {
  if (!approvalClient) {
    approvalClient = new ApprovalSystemClient(config);
  }
  return approvalClient;
}
