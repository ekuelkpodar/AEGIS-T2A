/**
 * AEGIS-T2A Enforcement Proxy
 *
 * Runtime enforcement middleware that intercepts all agent actions,
 * validates tokens, evaluates policies, and enforces decisions.
 * Implements fail-closed behavior for security.
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import {
  AgentIdentity,
  PolicyRequest,
  PolicyResult,
  PolicyDecision,
  PolicyContext,
  ProxyConfig,
  GovernanceError,
  PolicyDeniedError,
  ApprovalRequiredError,
  TokenError,
  BudgetExceededError,
  RateLimitError,
} from '../types';
import { TokenService, TokenValidationResult } from '../token/TokenService';
import { PolicyEngine } from '../policy/PolicyEngine';

/**
 * Action request from an agent
 */
export interface ActionRequest {
  /** Authorization header value */
  authorization?: string;
  /** Tool being invoked */
  tool: string;
  /** Action within the tool */
  action: string;
  /** Action parameters */
  parameters: Record<string, unknown>;
  /** Optional override token */
  override_token?: string;
  /** Request metadata */
  metadata?: {
    source_ip?: string;
    user_agent?: string;
    correlation_id?: string;
  };
}

/**
 * Action response from proxy
 */
export interface ActionResponse {
  /** Whether action is allowed */
  allowed: boolean;
  /** Modified parameters (if MODIFY decision) */
  parameters?: Record<string, unknown>;
  /** Response message */
  message: string;
  /** Policy decision */
  decision: PolicyDecision;
  /** Approval request ID (if awaiting approval) */
  approval_request_id?: string;
  /** Correlation ID for tracking */
  correlation_id: string;
  /** Request processing time */
  processing_ms: number;
}

/**
 * Override token validation result
 */
interface OverrideValidation {
  valid: boolean;
  approval_request_id?: string;
  error?: string;
}

/**
 * Budget checker interface
 */
export interface BudgetChecker {
  checkBudget(agentId: string, tenantId: string): Promise<{
    allowed: boolean;
    usage?: { current: number; limit: number; remaining: number };
  }>;
  recordUsage(agentId: string, tenantId: string, units: number): Promise<void>;
}

/**
 * Rate limiter interface
 */
export interface RateLimiter {
  checkRate(agentId: string, tool: string, action: string): Promise<{
    allowed: boolean;
    remaining: number;
    reset_at: Date;
  }>;
  recordRequest(agentId: string, tool: string, action: string): Promise<void>;
}

/**
 * Audit logger interface
 */
export interface AuditLogger {
  log(event: Record<string, unknown>): Promise<void>;
}

/**
 * Approval service interface
 */
export interface ApprovalService {
  createApprovalRequest(
    request: PolicyRequest,
    result: PolicyResult
  ): Promise<string>;
  validateOverrideToken(token: string): Promise<OverrideValidation>;
}

/**
 * Runtime Enforcement Proxy
 */
export class EnforcementProxy extends EventEmitter {
  private config: ProxyConfig;
  private tokenService: TokenService;
  private policyEngine: PolicyEngine;
  private budgetChecker?: BudgetChecker;
  private rateLimiter?: RateLimiter;
  private auditLogger?: AuditLogger;
  private approvalService?: ApprovalService;
  private environment: string;

  constructor(
    config: ProxyConfig,
    tokenService: TokenService,
    policyEngine: PolicyEngine,
    options?: {
      budgetChecker?: BudgetChecker;
      rateLimiter?: RateLimiter;
      auditLogger?: AuditLogger;
      approvalService?: ApprovalService;
      environment?: string;
    }
  ) {
    super();
    this.config = config;
    this.tokenService = tokenService;
    this.policyEngine = policyEngine;
    this.budgetChecker = options?.budgetChecker;
    this.rateLimiter = options?.rateLimiter;
    this.auditLogger = options?.auditLogger;
    this.approvalService = options?.approvalService;
    this.environment = options?.environment || 'production';
  }

  /**
   * Process an action request through the enforcement pipeline
   */
  async processAction(request: ActionRequest): Promise<ActionResponse> {
    const startTime = Date.now();
    const correlationId = request.metadata?.correlation_id || crypto.randomUUID();

    try {
      // Step 1: Validate authentication token
      const identity = await this.validateAuthentication(request.authorization);

      // Step 2: Check for override token
      if (request.override_token) {
        const overrideResult = await this.validateOverrideToken(
          request.override_token,
          identity,
          request
        );
        if (overrideResult.valid) {
          return this.createAllowedResponse(
            request.parameters,
            'Action approved via override token',
            correlationId,
            startTime
          );
        }
      }

      // Step 3: Check rate limits (if configured)
      if (this.rateLimiter) {
        const rateCheck = await this.rateLimiter.checkRate(
          identity.agent_id,
          request.tool,
          request.action
        );
        if (!rateCheck.allowed) {
          throw new RateLimitError(rateCheck.reset_at);
        }
      }

      // Step 4: Check budget (if configured)
      let budgetUsage;
      if (this.budgetChecker) {
        const budgetCheck = await this.budgetChecker.checkBudget(
          identity.agent_id,
          identity.tenant_id
        );
        if (!budgetCheck.allowed) {
          throw new BudgetExceededError(
            identity.agent_id,
            budgetCheck.usage!.current,
            budgetCheck.usage!.limit
          );
        }
        budgetUsage = budgetCheck.usage;
      }

      // Step 5: Build policy request
      const policyRequest: PolicyRequest = {
        agent: identity,
        tool: request.tool,
        action: request.action,
        parameters: request.parameters,
        context: this.buildContext(request, correlationId, budgetUsage),
      };

      // Step 6: Evaluate policy
      const policyResult = await this.policyEngine.evaluate(policyRequest);

      // Step 7: Handle policy decision
      const response = await this.handleDecision(
        policyResult,
        policyRequest,
        correlationId,
        startTime
      );

      // Step 8: Record rate limit usage (if allowed)
      if (response.allowed && this.rateLimiter) {
        await this.rateLimiter.recordRequest(
          identity.agent_id,
          request.tool,
          request.action
        );
      }

      // Step 9: Log audit event
      await this.logAuditEvent(
        policyRequest,
        policyResult,
        response,
        correlationId,
        request.metadata
      );

      return response;
    } catch (error) {
      return this.handleError(error, correlationId, startTime);
    }
  }

  /**
   * Validate authentication token
   */
  private async validateAuthentication(authorization?: string): Promise<AgentIdentity> {
    if (!authorization) {
      throw new TokenError('No authorization header provided', 'NO_AUTH');
    }

    // Extract token from Bearer scheme
    const parts = authorization.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      throw new TokenError('Invalid authorization format', 'INVALID_AUTH_FORMAT');
    }

    const token = parts[1];
    const result = await this.tokenService.validateToken(token);

    if (!result.valid || !result.identity) {
      throw new TokenError(result.error || 'Token validation failed', result.error_code || 'INVALID_TOKEN');
    }

    return result.identity;
  }

  /**
   * Validate an override token
   */
  private async validateOverrideToken(
    overrideToken: string,
    identity: AgentIdentity,
    request: ActionRequest
  ): Promise<{ valid: boolean; error?: string }> {
    if (!this.approvalService) {
      return { valid: false, error: 'Approval service not configured' };
    }

    const validation = await this.approvalService.validateOverrideToken(overrideToken);
    if (!validation.valid) {
      return { valid: false, error: validation.error };
    }

    // Override token is valid
    this.emit('override_used', {
      approval_request_id: validation.approval_request_id,
      agent_id: identity.agent_id,
      tool: request.tool,
      action: request.action,
    });

    return { valid: true };
  }

  /**
   * Build policy evaluation context
   */
  private buildContext(
    request: ActionRequest,
    correlationId: string,
    budgetUsage?: { current: number; limit: number; remaining: number }
  ): PolicyContext {
    return {
      timestamp: new Date(),
      source_ip: request.metadata?.source_ip,
      correlation_id: correlationId,
      environment: this.environment,
      budget_usage: budgetUsage
        ? {
            budget_id: '',
            current_usage: budgetUsage.current,
            limit: budgetUsage.limit,
            usage_percentage: (budgetUsage.current / budgetUsage.limit) * 100,
            remaining: budgetUsage.remaining,
            period_start: new Date(),
            period_end: new Date(),
            warning_triggered: budgetUsage.current / budgetUsage.limit > 0.8,
            limit_exceeded: budgetUsage.current >= budgetUsage.limit,
          }
        : undefined,
      metadata: {
        user_agent: request.metadata?.user_agent,
      },
    };
  }

  /**
   * Handle policy decision
   */
  private async handleDecision(
    result: PolicyResult,
    request: PolicyRequest,
    correlationId: string,
    startTime: number
  ): Promise<ActionResponse> {
    // In shadow mode, always allow but record what would have happened
    if (this.config.shadow_mode && result.decision !== 'ALLOW') {
      this.emit('shadow_decision', {
        would_be: result.decision,
        reason: result.reason,
        correlation_id: correlationId,
      });
      return this.createAllowedResponse(
        request.parameters,
        `Shadow mode: would have been ${result.decision}`,
        correlationId,
        startTime
      );
    }

    switch (result.decision) {
      case 'ALLOW':
        return this.createAllowedResponse(
          request.parameters,
          result.reason,
          correlationId,
          startTime
        );

      case 'DENY':
        throw new PolicyDeniedError(result.reason, result.matched_policy);

      case 'MODIFY':
        return this.createAllowedResponse(
          result.modified_parameters || request.parameters,
          `Action allowed with modifications: ${result.reason}`,
          correlationId,
          startTime
        );

      case 'AWAIT_APPROVAL':
        return this.handleApprovalRequired(result, request, correlationId, startTime);

      default:
        // Fail-closed: unknown decision = deny
        if (this.config.fail_closed) {
          throw new PolicyDeniedError(
            'Unknown policy decision - fail-closed',
            result.matched_policy
          );
        }
        return this.createAllowedResponse(
          request.parameters,
          'Unknown decision - allowing (fail-open)',
          correlationId,
          startTime
        );
    }
  }

  /**
   * Handle approval required decision
   */
  private async handleApprovalRequired(
    result: PolicyResult,
    request: PolicyRequest,
    correlationId: string,
    startTime: number
  ): Promise<ActionResponse> {
    if (!this.approvalService) {
      throw new PolicyDeniedError(
        'Approval required but no approval service configured',
        result.matched_policy
      );
    }

    // Create approval request
    const approvalRequestId = await this.approvalService.createApprovalRequest(
      request,
      result
    );

    return {
      allowed: false,
      message: result.reason,
      decision: 'AWAIT_APPROVAL',
      approval_request_id: approvalRequestId,
      correlation_id: correlationId,
      processing_ms: Date.now() - startTime,
    };
  }

  /**
   * Create an allowed response
   */
  private createAllowedResponse(
    parameters: Record<string, unknown>,
    message: string,
    correlationId: string,
    startTime: number
  ): ActionResponse {
    return {
      allowed: true,
      parameters,
      message,
      decision: 'ALLOW',
      correlation_id: correlationId,
      processing_ms: Date.now() - startTime,
    };
  }

  /**
   * Handle errors and create appropriate response
   */
  private handleError(
    error: unknown,
    correlationId: string,
    startTime: number
  ): ActionResponse {
    const processingMs = Date.now() - startTime;

    if (error instanceof PolicyDeniedError) {
      return {
        allowed: false,
        message: error.message,
        decision: 'DENY',
        correlation_id: correlationId,
        processing_ms: processingMs,
      };
    }

    if (error instanceof ApprovalRequiredError) {
      return {
        allowed: false,
        message: error.message,
        decision: 'AWAIT_APPROVAL',
        approval_request_id: error.details?.approval_request_id as string,
        correlation_id: correlationId,
        processing_ms: processingMs,
      };
    }

    if (error instanceof TokenError) {
      return {
        allowed: false,
        message: error.message,
        decision: 'DENY',
        correlation_id: correlationId,
        processing_ms: processingMs,
      };
    }

    if (error instanceof BudgetExceededError) {
      return {
        allowed: false,
        message: error.message,
        decision: 'DENY',
        correlation_id: correlationId,
        processing_ms: processingMs,
      };
    }

    if (error instanceof RateLimitError) {
      return {
        allowed: false,
        message: error.message,
        decision: 'DENY',
        correlation_id: correlationId,
        processing_ms: processingMs,
      };
    }

    // Unknown error - fail-closed
    this.emit('error', { error, correlation_id: correlationId });

    if (this.config.fail_closed) {
      return {
        allowed: false,
        message: 'Internal error - request denied (fail-closed)',
        decision: 'DENY',
        correlation_id: correlationId,
        processing_ms: processingMs,
      };
    }

    // Fail-open (not recommended)
    return {
      allowed: true,
      message: 'Internal error - allowing (fail-open)',
      decision: 'ALLOW',
      correlation_id: correlationId,
      processing_ms: processingMs,
    };
  }

  /**
   * Log audit event
   */
  private async logAuditEvent(
    request: PolicyRequest,
    result: PolicyResult,
    response: ActionResponse,
    correlationId: string,
    metadata?: ActionRequest['metadata']
  ): Promise<void> {
    if (!this.auditLogger) return;

    const event = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      event_type: this.getAuditEventType(result.decision),
      agent_id: request.agent.agent_id,
      tenant_id: request.agent.tenant_id,
      role: request.agent.role,
      tool: request.tool,
      action: request.action,
      parameters: this.sanitizeParameters(request.parameters),
      policy_version: result.policy_version,
      decision: result.decision,
      decision_reason: result.reason,
      matched_policy_id: result.matched_policy,
      approval_id: response.approval_request_id,
      correlation_id: correlationId,
      source_ip: metadata?.source_ip,
      user_agent: metadata?.user_agent,
      environment: this.environment,
      evaluation_ms: result.evaluation_ms,
      shadow_mode: this.config.shadow_mode,
    };

    try {
      await this.auditLogger.log(event);
    } catch (error) {
      this.emit('audit_error', { error, event });
    }
  }

  /**
   * Get audit event type from decision
   */
  private getAuditEventType(
    decision: PolicyDecision
  ): 'action_allowed' | 'action_denied' | 'action_modified' | 'approval_requested' {
    switch (decision) {
      case 'ALLOW':
        return 'action_allowed';
      case 'DENY':
        return 'action_denied';
      case 'MODIFY':
        return 'action_modified';
      case 'AWAIT_APPROVAL':
        return 'approval_requested';
    }
  }

  /**
   * Sanitize parameters for audit logging
   */
  private sanitizeParameters(
    parameters: Record<string, unknown>
  ): Record<string, unknown> {
    const sensitiveKeys = [
      'password',
      'secret',
      'token',
      'api_key',
      'apikey',
      'api-key',
      'authorization',
      'auth',
      'credentials',
      'private_key',
      'privatekey',
    ];

    const sanitized = { ...parameters };

    for (const key of Object.keys(sanitized)) {
      const lowerKey = key.toLowerCase();
      if (sensitiveKeys.some((k) => lowerKey.includes(k))) {
        sanitized[key] = '[REDACTED]';
      }
    }

    return sanitized;
  }

  /**
   * Create Express/Fastify middleware
   */
  createMiddleware(): (req: any, res: any, next: any) => Promise<void> {
    return async (req, res, next) => {
      // Extract action request from HTTP request
      const actionRequest: ActionRequest = {
        authorization: req.headers.authorization,
        tool: req.body?.tool || req.params?.tool || 'unknown',
        action: req.body?.action || req.params?.action || req.method.toLowerCase(),
        parameters: req.body?.parameters || req.body || {},
        override_token: req.headers['x-override-token'] as string | undefined,
        metadata: {
          source_ip: req.ip || req.connection?.remoteAddress,
          user_agent: req.headers['user-agent'],
          correlation_id: req.headers['x-correlation-id'] as string | undefined,
        },
      };

      const response = await this.processAction(actionRequest);

      if (!response.allowed) {
        if (response.decision === 'AWAIT_APPROVAL') {
          res.status(202).json({
            status: 'pending_approval',
            approval_request_id: response.approval_request_id,
            message: response.message,
            correlation_id: response.correlation_id,
          });
          return;
        }

        res.status(403).json({
          error: response.message,
          decision: response.decision,
          correlation_id: response.correlation_id,
        });
        return;
      }

      // Attach modified parameters to request
      if (response.parameters) {
        req.body = response.parameters;
      }

      // Attach correlation ID for downstream tracking
      req.correlationId = response.correlation_id;

      next();
    };
  }

  /**
   * Get proxy statistics
   */
  getStats(): {
    shadowMode: boolean;
    failClosed: boolean;
    environment: string;
  } {
    return {
      shadowMode: this.config.shadow_mode,
      failClosed: this.config.fail_closed,
      environment: this.environment,
    };
  }
}

export default EnforcementProxy;
