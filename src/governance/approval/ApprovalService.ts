/**
 * AEGIS-T2A Approval Service
 *
 * Manages human-in-the-loop approval workflows for high-risk actions.
 * Handles approval requests, notifications, voting, and override tokens.
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import {
  ApprovalRequest,
  ApprovalStatus,
  Approval,
  OverrideToken,
  PolicyRequest,
  PolicyResult,
  ApprovalServiceConfig,
  AgentRole,
  NotificationRecord,
  ApprovalConfig,
  GovernanceError,
} from '../types';

/**
 * Notification channel interface
 */
export interface NotificationChannel {
  name: string;
  send(request: ApprovalRequest): Promise<NotificationRecord>;
}

/**
 * Slack notification channel
 */
export class SlackNotificationChannel implements NotificationChannel {
  name = 'slack';
  private webhookUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  async send(request: ApprovalRequest): Promise<NotificationRecord> {
    const payload = {
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🔐 Action Approval Required',
            emoji: true,
          },
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Agent:*\n${request.policy_request.agent.agent_id}`,
            },
            {
              type: 'mrkdwn',
              text: `*Tenant:*\n${request.policy_request.agent.tenant_id}`,
            },
            {
              type: 'mrkdwn',
              text: `*Tool:*\n${request.policy_request.tool}`,
            },
            {
              type: 'mrkdwn',
              text: `*Action:*\n${request.policy_request.action}`,
            },
          ],
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Reason:*\n${request.policy_result.reason}`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Request ID:*\n\`${request.id}\``,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Expires: ${request.expires_at.toISOString()}`,
            },
          ],
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve', emoji: true },
              style: 'primary',
              value: request.id,
              action_id: 'approve_action',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Deny', emoji: true },
              style: 'danger',
              value: request.id,
              action_id: 'deny_action',
            },
          ],
        },
      ],
    };

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      return {
        channel: 'slack',
        sent_at: new Date(),
        status: response.ok ? 'sent' : 'failed',
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        channel: 'slack',
        sent_at: new Date(),
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

/**
 * Teams notification channel
 */
export class TeamsNotificationChannel implements NotificationChannel {
  name = 'teams';
  private webhookUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  async send(request: ApprovalRequest): Promise<NotificationRecord> {
    const payload = {
      '@type': 'MessageCard',
      '@context': 'http://schema.org/extensions',
      themeColor: 'FF9900',
      summary: 'Action Approval Required',
      sections: [
        {
          activityTitle: '🔐 Action Approval Required',
          facts: [
            { name: 'Agent', value: request.policy_request.agent.agent_id },
            { name: 'Tenant', value: request.policy_request.agent.tenant_id },
            { name: 'Tool', value: request.policy_request.tool },
            { name: 'Action', value: request.policy_request.action },
            { name: 'Request ID', value: request.id },
          ],
          text: request.policy_result.reason,
        },
      ],
      potentialAction: [
        {
          '@type': 'ActionCard',
          name: 'Approve',
          inputs: [
            {
              '@type': 'TextInput',
              id: 'comment',
              title: 'Comment (optional)',
            },
          ],
          actions: [
            {
              '@type': 'HttpPOST',
              name: 'Approve',
              target: `${process.env.APPROVAL_CALLBACK_URL}/approve/${request.id}`,
            },
          ],
        },
        {
          '@type': 'ActionCard',
          name: 'Deny',
          inputs: [
            {
              '@type': 'TextInput',
              id: 'reason',
              title: 'Reason for denial',
            },
          ],
          actions: [
            {
              '@type': 'HttpPOST',
              name: 'Deny',
              target: `${process.env.APPROVAL_CALLBACK_URL}/deny/${request.id}`,
            },
          ],
        },
      ],
    };

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      return {
        channel: 'teams',
        sent_at: new Date(),
        status: response.ok ? 'sent' : 'failed',
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        channel: 'teams',
        sent_at: new Date(),
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

/**
 * Generic webhook notification channel
 */
export class WebhookNotificationChannel implements NotificationChannel {
  name = 'webhook';
  private webhookUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  async send(request: ApprovalRequest): Promise<NotificationRecord> {
    const payload = {
      type: 'approval_request',
      request_id: request.id,
      agent_id: request.policy_request.agent.agent_id,
      tenant_id: request.policy_request.agent.tenant_id,
      tool: request.policy_request.tool,
      action: request.policy_request.action,
      reason: request.policy_result.reason,
      expires_at: request.expires_at.toISOString(),
      created_at: request.created_at.toISOString(),
    };

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      return {
        channel: 'webhook',
        sent_at: new Date(),
        status: response.ok ? 'sent' : 'failed',
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        channel: 'webhook',
        sent_at: new Date(),
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

/**
 * Approval Service
 */
export class ApprovalService extends EventEmitter {
  private config: ApprovalServiceConfig;
  private requests: Map<string, ApprovalRequest> = new Map();
  private overrideTokens: Map<string, OverrideToken> = new Map();
  private notificationChannels: Map<string, NotificationChannel> = new Map();
  private timeoutTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: ApprovalServiceConfig) {
    super();
    this.config = config;

    // Initialize notification channels
    if (config.slack_webhook_url) {
      this.notificationChannels.set(
        'slack',
        new SlackNotificationChannel(config.slack_webhook_url)
      );
    }
    if (config.teams_webhook_url) {
      this.notificationChannels.set(
        'teams',
        new TeamsNotificationChannel(config.teams_webhook_url)
      );
    }
    if (config.webhook_url) {
      this.notificationChannels.set(
        'webhook',
        new WebhookNotificationChannel(config.webhook_url)
      );
    }

    // Cleanup expired requests periodically
    setInterval(() => this.cleanupExpired(), 60000);
  }

  /**
   * Create a new approval request
   */
  async createApprovalRequest(
    policyRequest: PolicyRequest,
    policyResult: PolicyResult
  ): Promise<string> {
    const requestId = crypto.randomUUID();
    const now = new Date();
    const timeout = this.config.default_timeout_seconds;

    // Check pending requests limit
    const pendingCount = this.countPendingForAgent(policyRequest.agent.agent_id);
    if (pendingCount >= this.config.max_pending_per_agent) {
      throw new GovernanceError(
        `Maximum pending approvals (${this.config.max_pending_per_agent}) reached for agent`,
        'MAX_PENDING_REACHED',
        429
      );
    }

    const request: ApprovalRequest = {
      id: requestId,
      policy_request: policyRequest,
      policy_result: policyResult,
      status: 'pending',
      approvals: [],
      created_at: now,
      expires_at: new Date(now.getTime() + timeout * 1000),
      notifications_sent: [],
    };

    this.requests.set(requestId, request);

    // Set timeout timer
    const timer = setTimeout(() => {
      this.handleTimeout(requestId);
    }, timeout * 1000);
    this.timeoutTimers.set(requestId, timer);

    // Send notifications
    await this.sendNotifications(request);

    this.emit('request_created', { request_id: requestId, agent_id: policyRequest.agent.agent_id });

    return requestId;
  }

  /**
   * Record an approval vote
   */
  async recordApproval(
    requestId: string,
    approverId: string,
    approverRole: AgentRole,
    decision: 'approve' | 'deny',
    comment?: string
  ): Promise<{ status: ApprovalStatus; override_token?: string }> {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new GovernanceError('Approval request not found', 'NOT_FOUND', 404);
    }

    if (request.status !== 'pending') {
      throw new GovernanceError(
        `Request is already ${request.status}`,
        'INVALID_STATUS',
        400
      );
    }

    // Check if approver already voted
    const existingVote = request.approvals.find((a) => a.approver_id === approverId);
    if (existingVote) {
      throw new GovernanceError('Approver has already voted', 'ALREADY_VOTED', 400);
    }

    // Record the approval
    const approval: Approval = {
      approver_id: approverId,
      approver_role: approverRole,
      decision,
      comment,
      timestamp: new Date(),
      verification_method: 'token',
    };
    request.approvals.push(approval);

    this.emit('vote_recorded', {
      request_id: requestId,
      approver_id: approverId,
      decision,
    });

    // Check if we have enough approvals or any denials
    if (decision === 'deny') {
      return this.finalizeRequest(requestId, 'denied');
    }

    // Count approvals from required roles
    const approvalConfig = request.policy_result.metadata?.approval_config as
      | ApprovalConfig
      | undefined;
    const minApprovals = approvalConfig?.min_approvals || 1;
    const approveCount = request.approvals.filter((a) => a.decision === 'approve').length;

    if (approveCount >= minApprovals) {
      return this.finalizeRequest(requestId, 'approved');
    }

    return { status: 'pending' };
  }

  /**
   * Finalize an approval request
   */
  private async finalizeRequest(
    requestId: string,
    status: 'approved' | 'denied'
  ): Promise<{ status: ApprovalStatus; override_token?: string }> {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new GovernanceError('Approval request not found', 'NOT_FOUND', 404);
    }

    request.status = status;

    // Clear timeout timer
    const timer = this.timeoutTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(requestId);
    }

    if (status === 'approved') {
      // Generate override token
      const overrideToken = await this.generateOverrideToken(request);
      request.override_token = overrideToken.token;
      request.override_expires_at = overrideToken.expires_at;

      this.emit('request_approved', {
        request_id: requestId,
        override_token: overrideToken.token,
      });

      return { status: 'approved', override_token: overrideToken.token };
    } else {
      this.emit('request_denied', { request_id: requestId });
      return { status: 'denied' };
    }
  }

  /**
   * Handle request timeout
   */
  private handleTimeout(requestId: string): void {
    const request = this.requests.get(requestId);
    if (!request || request.status !== 'pending') return;

    request.status = 'expired';
    this.timeoutTimers.delete(requestId);

    this.emit('request_expired', { request_id: requestId });
  }

  /**
   * Generate an override token for approved requests
   */
  private async generateOverrideToken(request: ApprovalRequest): Promise<OverrideToken> {
    const tokenId = crypto.randomUUID();
    const tokenValue = crypto.randomBytes(32).toString('hex');
    const now = new Date();

    // Create action signature for validation
    const actionSignature = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          tool: request.policy_request.tool,
          action: request.policy_request.action,
          agent_id: request.policy_request.agent.agent_id,
        })
      )
      .digest('hex');

    const overrideToken: OverrideToken = {
      id: tokenId,
      approval_request_id: request.id,
      token: tokenValue,
      action_signature: actionSignature,
      single_use: true,
      used_count: 0,
      max_uses: 1,
      created_at: now,
      expires_at: new Date(now.getTime() + 3600 * 1000), // 1 hour
      revoked: false,
    };

    this.overrideTokens.set(tokenValue, overrideToken);

    return overrideToken;
  }

  /**
   * Validate an override token
   */
  async validateOverrideToken(
    token: string
  ): Promise<{ valid: boolean; approval_request_id?: string; error?: string }> {
    const overrideToken = this.overrideTokens.get(token);

    if (!overrideToken) {
      return { valid: false, error: 'Override token not found' };
    }

    if (overrideToken.revoked) {
      return { valid: false, error: 'Override token has been revoked' };
    }

    if (overrideToken.expires_at < new Date()) {
      return { valid: false, error: 'Override token has expired' };
    }

    if (overrideToken.single_use && overrideToken.used_count >= overrideToken.max_uses) {
      return { valid: false, error: 'Override token has already been used' };
    }

    // Mark token as used
    overrideToken.used_count++;

    this.emit('override_token_used', {
      token_id: overrideToken.id,
      approval_request_id: overrideToken.approval_request_id,
    });

    return {
      valid: true,
      approval_request_id: overrideToken.approval_request_id,
    };
  }

  /**
   * Revoke an override token
   */
  async revokeOverrideToken(token: string, reason: string): Promise<void> {
    const overrideToken = this.overrideTokens.get(token);
    if (overrideToken) {
      overrideToken.revoked = true;
      this.emit('override_token_revoked', {
        token_id: overrideToken.id,
        reason,
      });
    }
  }

  /**
   * Send notifications for an approval request
   */
  private async sendNotifications(request: ApprovalRequest): Promise<void> {
    const approvalConfig = request.policy_result.metadata?.approval_config as
      | ApprovalConfig
      | undefined;
    const channels = approvalConfig?.notify_channels || ['webhook'];

    for (const channelName of channels) {
      const channel = this.notificationChannels.get(channelName);
      if (channel) {
        try {
          const record = await channel.send(request);
          request.notifications_sent.push(record);
        } catch (error) {
          request.notifications_sent.push({
            channel: channelName,
            sent_at: new Date(),
            status: 'failed',
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }
  }

  /**
   * Get an approval request
   */
  getRequest(requestId: string): ApprovalRequest | undefined {
    return this.requests.get(requestId);
  }

  /**
   * List approval requests
   */
  listRequests(options?: {
    status?: ApprovalStatus;
    agent_id?: string;
    tenant_id?: string;
    limit?: number;
    offset?: number;
  }): { requests: ApprovalRequest[]; total: number } {
    let results = Array.from(this.requests.values());

    if (options?.status) {
      results = results.filter((r) => r.status === options.status);
    }
    if (options?.agent_id) {
      results = results.filter((r) => r.policy_request.agent.agent_id === options.agent_id);
    }
    if (options?.tenant_id) {
      results = results.filter((r) => r.policy_request.agent.tenant_id === options.tenant_id);
    }

    // Sort by created_at descending
    results.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

    const total = results.length;
    const offset = options?.offset || 0;
    const limit = options?.limit || 50;

    return {
      requests: results.slice(offset, offset + limit),
      total,
    };
  }

  /**
   * Cancel an approval request
   */
  async cancelRequest(requestId: string, reason: string): Promise<void> {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new GovernanceError('Approval request not found', 'NOT_FOUND', 404);
    }

    if (request.status !== 'pending') {
      throw new GovernanceError(
        `Cannot cancel request with status: ${request.status}`,
        'INVALID_STATUS',
        400
      );
    }

    request.status = 'cancelled';

    // Clear timeout timer
    const timer = this.timeoutTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(requestId);
    }

    this.emit('request_cancelled', { request_id: requestId, reason });
  }

  /**
   * Count pending requests for an agent
   */
  private countPendingForAgent(agentId: string): number {
    let count = 0;
    for (const request of this.requests.values()) {
      if (
        request.policy_request.agent.agent_id === agentId &&
        request.status === 'pending'
      ) {
        count++;
      }
    }
    return count;
  }

  /**
   * Cleanup expired requests
   */
  private cleanupExpired(): void {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago

    for (const [id, request] of this.requests) {
      if (request.status !== 'pending' && request.created_at < cutoff) {
        this.requests.delete(id);
      }
    }

    // Cleanup expired override tokens
    for (const [token, data] of this.overrideTokens) {
      if (data.expires_at < new Date() || data.revoked) {
        this.overrideTokens.delete(token);
      }
    }
  }

  /**
   * Add a notification channel
   */
  addNotificationChannel(channel: NotificationChannel): void {
    this.notificationChannels.set(channel.name, channel);
  }

  /**
   * Get service statistics
   */
  getStats(): {
    pendingRequests: number;
    approvedRequests: number;
    deniedRequests: number;
    expiredRequests: number;
    activeOverrideTokens: number;
  } {
    let pending = 0;
    let approved = 0;
    let denied = 0;
    let expired = 0;

    for (const request of this.requests.values()) {
      switch (request.status) {
        case 'pending':
          pending++;
          break;
        case 'approved':
          approved++;
          break;
        case 'denied':
          denied++;
          break;
        case 'expired':
          expired++;
          break;
      }
    }

    let activeTokens = 0;
    const now = new Date();
    for (const token of this.overrideTokens.values()) {
      if (!token.revoked && token.expires_at > now) {
        activeTokens++;
      }
    }

    return {
      pendingRequests: pending,
      approvedRequests: approved,
      deniedRequests: denied,
      expiredRequests: expired,
      activeOverrideTokens: activeTokens,
    };
  }
}

export default ApprovalService;
