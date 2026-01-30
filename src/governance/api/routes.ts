/**
 * AEGIS-T2A Governance API Routes
 *
 * RESTful API endpoints for the governance control plane.
 * Includes endpoints for:
 * - Token management
 * - Policy evaluation
 * - Approval workflows
 * - Audit queries
 * - Budget management
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { TokenService } from '../token/TokenService';
import { PolicyEngine } from '../policy/PolicyEngine';
import { ApprovalService } from '../approval/ApprovalService';
import { AuditService } from '../audit/AuditService';
import { BudgetService } from '../budget/BudgetService';
import { EnforcementProxy, ActionRequest } from '../proxy/EnforcementProxy';
import { AgentRole, GovernanceError } from '../types';

/**
 * Create governance API routes
 */
export function createGovernanceRoutes(
  tokenService: TokenService,
  policyEngine: PolicyEngine,
  approvalService: ApprovalService,
  auditService: AuditService,
  budgetService: BudgetService,
  enforcementProxy: EnforcementProxy
): Router {
  const router = Router();

  // ===========================================================================
  // Health & Status
  // ===========================================================================

  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        token: 'up',
        policy: 'up',
        approval: 'up',
        audit: 'up',
        budget: 'up',
      },
    });
  });

  router.get('/ready', async (_req: Request, res: Response) => {
    try {
      // Check all services
      const policyStats = policyEngine.getStats();
      const auditStats = auditService.getStats();

      res.json({
        ready: true,
        policy_version: policyStats.version,
        policy_bundles: policyStats.bundles,
        opa_available: policyStats.opaAvailable,
      });
    } catch (error) {
      res.status(503).json({ ready: false, error: 'Service not ready' });
    }
  });

  router.get('/stats', async (_req: Request, res: Response) => {
    res.json({
      token: tokenService.getStats(),
      policy: policyEngine.getStats(),
      approval: approvalService.getStats(),
      audit: auditService.getStats(),
      budget: budgetService.getStats(),
      proxy: enforcementProxy.getStats(),
    });
  });

  // ===========================================================================
  // Token Management
  // ===========================================================================

  const TokenRequestSchema = z.object({
    agent_id: z.string().min(1),
    tenant_id: z.string().min(1),
    role: z.enum([
      'system_admin',
      'tenant_admin',
      'operator',
      'developer',
      'readonly',
      'restricted',
    ]),
    scopes: z.array(z.string()).default(['*']),
    ttl_seconds: z.number().optional(),
  });

  router.post('/tokens', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = TokenRequestSchema.parse(req.body);
      const response = await tokenService.issueToken(body);
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  });

  router.post('/tokens/validate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = req.body;
      if (!token) {
        res.status(400).json({ error: 'Token required' });
        return;
      }

      const result = await tokenService.validateToken(token);
      if (result.valid) {
        res.json({ valid: true, identity: result.identity });
      } else {
        res.status(401).json({ valid: false, error: result.error });
      }
    } catch (error) {
      next(error);
    }
  });

  router.post('/tokens/refresh', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { refresh_token } = req.body;
      if (!refresh_token) {
        res.status(400).json({ error: 'Refresh token required' });
        return;
      }

      const response = await tokenService.refreshAccessToken(refresh_token);
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  router.post('/tokens/:jti/revoke', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { jti } = req.params;
      const { reason } = req.body;
      await tokenService.revokeToken(jti!, reason || 'Revoked via API');
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  router.get('/tokens/:agentId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { agentId } = req.params;
      const tokens = tokenService.listAgentTokens(agentId!);
      res.json({ tokens });
    } catch (error) {
      next(error);
    }
  });

  router.get('/.well-known/jwks.json', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const jwks = await tokenService.getJWKS();
      res.json(jwks);
    } catch (error) {
      next(error);
    }
  });

  // ===========================================================================
  // Policy Evaluation
  // ===========================================================================

  const EvaluateRequestSchema = z.object({
    tool: z.string(),
    action: z.string(),
    parameters: z.record(z.unknown()).default({}),
    override_token: z.string().optional(),
  });

  router.post('/evaluate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = EvaluateRequestSchema.parse(req.body);

      const actionRequest: ActionRequest = {
        authorization: req.headers.authorization,
        tool: body.tool,
        action: body.action,
        parameters: body.parameters,
        override_token: body.override_token,
        metadata: {
          source_ip: req.ip,
          user_agent: req.headers['user-agent'],
          correlation_id: req.headers['x-correlation-id'] as string,
        },
      };

      const result = await enforcementProxy.processAction(actionRequest);

      if (result.allowed) {
        res.json({
          allowed: true,
          parameters: result.parameters,
          correlation_id: result.correlation_id,
          processing_ms: result.processing_ms,
        });
      } else if (result.decision === 'AWAIT_APPROVAL') {
        res.status(202).json({
          allowed: false,
          decision: 'AWAIT_APPROVAL',
          approval_request_id: result.approval_request_id,
          message: result.message,
          correlation_id: result.correlation_id,
        });
      } else {
        res.status(403).json({
          allowed: false,
          decision: result.decision,
          message: result.message,
          correlation_id: result.correlation_id,
        });
      }
    } catch (error) {
      next(error);
    }
  });

  // ===========================================================================
  // Policy Management
  // ===========================================================================

  router.get('/policies', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const bundles = policyEngine.listBundles();
      res.json({
        bundles: bundles.map((b) => ({
          id: b.id,
          name: b.name,
          version: b.version,
          tenant_id: b.tenant_id,
          rules_count: b.rules.length,
          default_decision: b.default_decision,
        })),
        version: policyEngine.getVersion(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/policies/:bundleId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bundle = policyEngine.getBundle(req.params.bundleId!);
      if (!bundle) {
        res.status(404).json({ error: 'Bundle not found' });
        return;
      }
      res.json(bundle);
    } catch (error) {
      next(error);
    }
  });

  router.post('/policies/reload', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await policyEngine.loadPolicies();
      res.json({
        success: true,
        version: policyEngine.getVersion(),
        stats: policyEngine.getStats(),
      });
    } catch (error) {
      next(error);
    }
  });

  // ===========================================================================
  // Approval Workflows
  // ===========================================================================

  router.get('/approvals', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, agent_id, tenant_id, limit, offset } = req.query;

      const result = approvalService.listRequests({
        status: status as any,
        agent_id: agent_id as string,
        tenant_id: tenant_id as string,
        limit: limit ? parseInt(limit as string) : undefined,
        offset: offset ? parseInt(offset as string) : undefined,
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/approvals/:requestId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const request = approvalService.getRequest(req.params.requestId!);
      if (!request) {
        res.status(404).json({ error: 'Approval request not found' });
        return;
      }
      res.json(request);
    } catch (error) {
      next(error);
    }
  });

  const ApprovalVoteSchema = z.object({
    approver_id: z.string(),
    approver_role: z.enum([
      'system_admin',
      'tenant_admin',
      'operator',
      'developer',
      'readonly',
      'restricted',
    ]),
    decision: z.enum(['approve', 'deny']),
    comment: z.string().optional(),
  });

  router.post(
    '/approvals/:requestId/vote',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = ApprovalVoteSchema.parse(req.body);

        const result = await approvalService.recordApproval(
          req.params.requestId!,
          body.approver_id,
          body.approver_role,
          body.decision,
          body.comment
        );

        res.json({
          status: result.status,
          override_token: result.override_token,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    '/approvals/:requestId/cancel',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { reason } = req.body;
        await approvalService.cancelRequest(req.params.requestId!, reason || 'Cancelled via API');
        res.json({ success: true });
      } catch (error) {
        next(error);
      }
    }
  );

  // Webhook callback endpoints for Slack/Teams
  router.post('/approvals/webhook/slack', async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Handle Slack interactive message
      const payload = JSON.parse(req.body.payload || '{}');
      const action = payload.actions?.[0];

      if (action) {
        const requestId = action.value;
        const decision = action.action_id === 'approve_action' ? 'approve' : 'deny';
        const userId = payload.user?.id || 'slack-user';

        await approvalService.recordApproval(
          requestId,
          userId,
          'operator',
          decision,
          `Approved via Slack by ${payload.user?.name || 'unknown'}`
        );
      }

      res.json({ response_type: 'in_channel', text: 'Vote recorded!' });
    } catch (error) {
      next(error);
    }
  });

  // ===========================================================================
  // Audit Queries
  // ===========================================================================

  router.get('/audit/events', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        start_time,
        end_time,
        agent_id,
        tenant_id,
        event_type,
        decision,
        tool,
        action,
        correlation_id,
        limit,
        offset,
      } = req.query;

      const result = await auditService.query({
        start_time: start_time ? new Date(start_time as string) : undefined,
        end_time: end_time ? new Date(end_time as string) : undefined,
        agent_id: agent_id as string,
        tenant_id: tenant_id as string,
        event_type: event_type as any,
        decision: decision as any,
        tool: tool as string,
        action: action as string,
        correlation_id: correlation_id as string,
        limit: limit ? parseInt(limit as string) : 100,
        offset: offset ? parseInt(offset as string) : 0,
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get(
    '/audit/events/:correlationId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const events = await auditService.getByCorrelationId(req.params.correlationId!);
        res.json({ events });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get('/audit/stats', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenant_id, start_time, end_time } = req.query;

      if (!tenant_id || !start_time || !end_time) {
        res.status(400).json({ error: 'tenant_id, start_time, and end_time required' });
        return;
      }

      const stats = await auditService.getDecisionStats(
        tenant_id as string,
        new Date(start_time as string),
        new Date(end_time as string)
      );

      res.json(stats);
    } catch (error) {
      next(error);
    }
  });

  router.get('/audit/export', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const format = req.query.format || 'jsonl';
      const query = {
        start_time: req.query.start_time
          ? new Date(req.query.start_time as string)
          : undefined,
        end_time: req.query.end_time
          ? new Date(req.query.end_time as string)
          : undefined,
        tenant_id: req.query.tenant_id as string,
        limit: 10000,
      };

      if (format === 'cef') {
        const cef = await auditService.exportCEF(query);
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', 'attachment; filename=audit.cef');
        res.send(cef);
      } else {
        const jsonl = await auditService.exportJSONL(query);
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Content-Disposition', 'attachment; filename=audit.jsonl');
        res.send(jsonl);
      }
    } catch (error) {
      next(error);
    }
  });

  // ===========================================================================
  // Budget Management
  // ===========================================================================

  const BudgetCreateSchema = z.object({
    id: z.string(),
    tenant_id: z.string(),
    agent_id: z.string().nullable().optional(),
    period: z.enum(['hourly', 'daily', 'weekly', 'monthly']),
    limit_units: z.number().positive(),
    warning_threshold: z.number().min(0).max(100).default(80),
    hard_limit: z.boolean().default(true),
  });

  router.post('/budgets', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = BudgetCreateSchema.parse(req.body);
      const budget = budgetService.createBudget(body as any);
      res.status(201).json(budget);
    } catch (error) {
      next(error);
    }
  });

  router.get('/budgets', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenant_id } = req.query;
      if (!tenant_id) {
        res.status(400).json({ error: 'tenant_id required' });
        return;
      }

      const budgets = budgetService.listBudgets(tenant_id as string);
      res.json({ budgets });
    } catch (error) {
      next(error);
    }
  });

  router.get(
    '/budgets/:tenantId/:agentId?',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, agentId } = req.params;
        const usage = budgetService.getBudgetUsage(tenantId!, agentId || null);

        if (!usage) {
          res.status(404).json({ error: 'Budget not found' });
          return;
        }

        res.json(usage);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    '/budgets/:tenantId/:agentId/history',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, agentId } = req.params;
        const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;

        const history = budgetService.getUsageHistory(tenantId!, agentId!, limit);
        res.json({ history });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post('/budgets/estimate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tool, action, parameters } = req.body;
      const estimate = budgetService.estimateCost(tool, action, parameters || {});
      res.json(estimate);
    } catch (error) {
      next(error);
    }
  });

  // ===========================================================================
  // Rate Limits
  // ===========================================================================

  const RateLimitCreateSchema = z.object({
    id: z.string(),
    tenant_id: z.string(),
    agent_id: z.string().nullable().optional(),
    tool: z.string().nullable().optional(),
    action: z.string().nullable().optional(),
    requests_per_window: z.number().positive(),
    window_seconds: z.number().positive(),
    burst_allowance: z.number().min(0).default(0),
    enabled: z.boolean().default(true),
  });

  router.post('/rate-limits', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = RateLimitCreateSchema.parse(req.body);
      budgetService.createRateLimit(body as any);
      res.status(201).json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  router.get('/rate-limits', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenant_id } = req.query;
      const limits = budgetService.listRateLimits(tenant_id as string);
      res.json({ rate_limits: limits });
    } catch (error) {
      next(error);
    }
  });

  router.get(
    '/rate-limits/status/:agentId/:tool/:action',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { agentId, tool, action } = req.params;
        const status = budgetService.getRateStatus(agentId!, tool!, action!);

        if (!status) {
          res.json({ rate_limited: false, message: 'No rate limit configured' });
          return;
        }

        res.json(status);
      } catch (error) {
        next(error);
      }
    }
  );

  // ===========================================================================
  // Error Handler
  // ===========================================================================

  router.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Governance API Error:', error);

    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors,
      });
      return;
    }

    if (error instanceof GovernanceError) {
      res.status(error.statusCode).json({
        error: error.message,
        code: error.code,
        details: error.details,
      });
      return;
    }

    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  });

  return router;
}

export default createGovernanceRoutes;
