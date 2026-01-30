/**
 * AEGIS-T2A Governance Tests
 *
 * Comprehensive test suite for the governance control plane.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TokenService,
  PolicyEngine,
  ApprovalService,
  AuditService,
  BudgetService,
  EnforcementProxy,
  MemoryAuditBackend,
  PolicyBundle,
  AgentIdentity,
  PolicyRequest,
  PolicyDecision,
} from '../../src/governance';

// =============================================================================
// Token Service Tests
// =============================================================================

describe('TokenService', () => {
  let tokenService: TokenService;

  beforeEach(async () => {
    tokenService = await TokenService.createWithGeneratedKeys({
      algorithm: 'RS256',
      token_ttl_seconds: 3600,
      refresh_ttl_seconds: 86400,
      issuer: 'test-issuer',
      audience: 'test-audience',
    });
  });

  describe('Token Issuance', () => {
    it('should issue a valid token', async () => {
      const response = await tokenService.issueToken({
        agent_id: 'agent-1',
        tenant_id: 'tenant-1',
        role: 'operator',
        scopes: ['*'],
      });

      expect(response.access_token).toBeDefined();
      expect(response.token_type).toBe('Bearer');
      expect(response.expires_in).toBe(3600);
      expect(response.refresh_token).toBeDefined();
    });

    it('should include correct claims in token', async () => {
      const response = await tokenService.issueToken({
        agent_id: 'agent-1',
        tenant_id: 'tenant-1',
        role: 'developer',
        scopes: ['read', 'write'],
      });

      const validation = await tokenService.validateToken(response.access_token);
      expect(validation.valid).toBe(true);
      expect(validation.identity?.agent_id).toBe('agent-1');
      expect(validation.identity?.tenant_id).toBe('tenant-1');
      expect(validation.identity?.role).toBe('developer');
      expect(validation.identity?.scopes).toEqual(['read', 'write']);
    });
  });

  describe('Token Validation', () => {
    it('should validate a valid token', async () => {
      const response = await tokenService.issueToken({
        agent_id: 'agent-1',
        tenant_id: 'tenant-1',
        role: 'operator',
        scopes: ['*'],
      });

      const validation = await tokenService.validateToken(response.access_token);
      expect(validation.valid).toBe(true);
      expect(validation.identity).toBeDefined();
    });

    it('should reject an invalid token', async () => {
      const validation = await tokenService.validateToken('invalid-token');
      expect(validation.valid).toBe(false);
      expect(validation.error).toBeDefined();
    });

    it('should reject a revoked token', async () => {
      const response = await tokenService.issueToken({
        agent_id: 'agent-1',
        tenant_id: 'tenant-1',
        role: 'operator',
        scopes: ['*'],
      });

      // Validate first (get jti)
      const firstValidation = await tokenService.validateToken(response.access_token);
      expect(firstValidation.valid).toBe(true);

      // Revoke the token
      await tokenService.revokeToken(firstValidation.identity!.jti, 'Test revocation');

      // Should now be invalid
      const secondValidation = await tokenService.validateToken(response.access_token);
      expect(secondValidation.valid).toBe(false);
      expect(secondValidation.error_code).toBe('TOKEN_REVOKED');
    });
  });

  describe('Token Refresh', () => {
    it('should refresh an access token', async () => {
      const response = await tokenService.issueToken({
        agent_id: 'agent-1',
        tenant_id: 'tenant-1',
        role: 'operator',
        scopes: ['*'],
      });

      const refreshed = await tokenService.refreshAccessToken(response.refresh_token!);
      expect(refreshed.access_token).toBeDefined();
      expect(refreshed.access_token).not.toBe(response.access_token);
    });
  });
});

// =============================================================================
// Policy Engine Tests
// =============================================================================

describe('PolicyEngine', () => {
  let policyEngine: PolicyEngine;

  beforeEach(async () => {
    policyEngine = new PolicyEngine({
      opa_url: 'http://localhost:8181', // May not be available in tests
      bundle_path: './policies/examples',
      hot_reload: false,
      reload_interval_seconds: 60,
      cache_ttl_seconds: 10,
    });

    // Add a test bundle
    const testBundle: PolicyBundle = {
      id: 'test-bundle',
      version: '1.0.0',
      name: 'Test Bundle',
      description: 'Test policy bundle',
      tenant_id: null,
      rules: [
        {
          id: 'allow-read',
          name: 'Allow Read',
          description: 'Allow read operations',
          priority: 100,
          enabled: true,
          conditions: [
            { field: 'action', operator: 'in', value: ['get', 'list', 'read'] },
          ],
          effect: { decision: 'ALLOW', reason_template: 'Read allowed' },
        },
        {
          id: 'deny-delete',
          name: 'Deny Delete',
          description: 'Deny delete operations',
          priority: 50,
          enabled: true,
          conditions: [
            { field: 'action', operator: 'equals', value: 'delete' },
          ],
          effect: { decision: 'DENY', reason_template: 'Delete denied' },
        },
        {
          id: 'require-approval-destroy',
          name: 'Require Approval for Destroy',
          description: 'Require approval for destroy',
          priority: 51,
          enabled: true,
          conditions: [
            { field: 'action', operator: 'equals', value: 'destroy' },
          ],
          effect: { decision: 'AWAIT_APPROVAL', reason_template: 'Destroy requires approval' },
        },
      ],
      default_decision: 'DENY',
      metadata: {
        created_at: new Date(),
        updated_at: new Date(),
        created_by: 'test',
        checksum: '',
        tags: ['test'],
      },
    };

    policyEngine.addBundle(testBundle);
  });

  afterEach(async () => {
    await policyEngine.shutdown();
  });

  describe('Policy Evaluation', () => {
    it('should allow read operations', async () => {
      const request: PolicyRequest = {
        agent: {
          agent_id: 'agent-1',
          tenant_id: 'tenant-1',
          role: 'operator',
          scopes: ['*'],
          iat: Date.now() / 1000,
          exp: Date.now() / 1000 + 3600,
          jti: 'test-jti',
        },
        tool: 'database',
        action: 'get',
        parameters: {},
        context: {
          timestamp: new Date(),
          correlation_id: 'test-correlation',
          environment: 'test',
        },
      };

      const result = await policyEngine.evaluate(request);
      expect(result.decision).toBe('ALLOW');
      expect(result.matched_policy).toBe('allow-read');
    });

    it('should deny delete operations', async () => {
      const request: PolicyRequest = {
        agent: {
          agent_id: 'agent-1',
          tenant_id: 'tenant-1',
          role: 'operator',
          scopes: ['*'],
          iat: Date.now() / 1000,
          exp: Date.now() / 1000 + 3600,
          jti: 'test-jti',
        },
        tool: 'database',
        action: 'delete',
        parameters: {},
        context: {
          timestamp: new Date(),
          correlation_id: 'test-correlation',
          environment: 'test',
        },
      };

      const result = await policyEngine.evaluate(request);
      expect(result.decision).toBe('DENY');
      expect(result.matched_policy).toBe('deny-delete');
    });

    it('should require approval for destroy operations', async () => {
      const request: PolicyRequest = {
        agent: {
          agent_id: 'agent-1',
          tenant_id: 'tenant-1',
          role: 'operator',
          scopes: ['*'],
          iat: Date.now() / 1000,
          exp: Date.now() / 1000 + 3600,
          jti: 'test-jti',
        },
        tool: 'aws',
        action: 'destroy',
        parameters: {},
        context: {
          timestamp: new Date(),
          correlation_id: 'test-correlation',
          environment: 'test',
        },
      };

      const result = await policyEngine.evaluate(request);
      expect(result.decision).toBe('AWAIT_APPROVAL');
    });

    it('should deny by default for unknown actions', async () => {
      const request: PolicyRequest = {
        agent: {
          agent_id: 'agent-1',
          tenant_id: 'tenant-1',
          role: 'operator',
          scopes: ['*'],
          iat: Date.now() / 1000,
          exp: Date.now() / 1000 + 3600,
          jti: 'test-jti',
        },
        tool: 'unknown',
        action: 'unknown',
        parameters: {},
        context: {
          timestamp: new Date(),
          correlation_id: 'test-correlation',
          environment: 'test',
        },
      };

      const result = await policyEngine.evaluate(request);
      expect(result.decision).toBe('DENY');
    });
  });

  describe('Policy Caching', () => {
    it('should cache policy decisions', async () => {
      const request: PolicyRequest = {
        agent: {
          agent_id: 'agent-1',
          tenant_id: 'tenant-1',
          role: 'operator',
          scopes: ['*'],
          iat: Date.now() / 1000,
          exp: Date.now() / 1000 + 3600,
          jti: 'test-jti',
        },
        tool: 'database',
        action: 'get',
        parameters: {},
        context: {
          timestamp: new Date(),
          correlation_id: 'test-correlation',
          environment: 'test',
        },
      };

      // First evaluation
      const result1 = await policyEngine.evaluate(request);

      // Second evaluation (should be cached)
      const result2 = await policyEngine.evaluate(request);

      expect(result1.decision).toBe(result2.decision);
      expect(result2.evaluation_ms).toBeLessThan(result1.evaluation_ms + 1);
    });
  });
});

// =============================================================================
// Approval Service Tests
// =============================================================================

describe('ApprovalService', () => {
  let approvalService: ApprovalService;

  beforeEach(() => {
    approvalService = new ApprovalService({
      default_timeout_seconds: 60,
      max_pending_per_agent: 5,
    });
  });

  describe('Approval Request Creation', () => {
    it('should create an approval request', async () => {
      const policyRequest: PolicyRequest = {
        agent: {
          agent_id: 'agent-1',
          tenant_id: 'tenant-1',
          role: 'operator',
          scopes: ['*'],
          iat: Date.now() / 1000,
          exp: Date.now() / 1000 + 3600,
          jti: 'test-jti',
        },
        tool: 'aws',
        action: 'delete',
        parameters: { instance_id: 'i-123' },
        context: {
          timestamp: new Date(),
          correlation_id: 'test-correlation',
          environment: 'test',
        },
      };

      const requestId = await approvalService.createApprovalRequest(policyRequest, {
        decision: 'AWAIT_APPROVAL',
        reason: 'Test approval',
        policy_version: '1.0.0',
        evaluation_ms: 10,
      });

      expect(requestId).toBeDefined();
      const request = approvalService.getRequest(requestId);
      expect(request).toBeDefined();
      expect(request?.status).toBe('pending');
    });
  });

  describe('Approval Voting', () => {
    it('should approve when minimum approvals met', async () => {
      const policyRequest: PolicyRequest = {
        agent: {
          agent_id: 'agent-1',
          tenant_id: 'tenant-1',
          role: 'operator',
          scopes: ['*'],
          iat: Date.now() / 1000,
          exp: Date.now() / 1000 + 3600,
          jti: 'test-jti',
        },
        tool: 'aws',
        action: 'delete',
        parameters: {},
        context: {
          timestamp: new Date(),
          correlation_id: 'test-correlation',
          environment: 'test',
        },
      };

      const requestId = await approvalService.createApprovalRequest(policyRequest, {
        decision: 'AWAIT_APPROVAL',
        reason: 'Test',
        policy_version: '1.0.0',
        evaluation_ms: 10,
      });

      const result = await approvalService.recordApproval(
        requestId,
        'approver-1',
        'tenant_admin',
        'approve',
        'LGTM'
      );

      expect(result.status).toBe('approved');
      expect(result.override_token).toBeDefined();
    });

    it('should deny on any denial vote', async () => {
      const policyRequest: PolicyRequest = {
        agent: {
          agent_id: 'agent-1',
          tenant_id: 'tenant-1',
          role: 'operator',
          scopes: ['*'],
          iat: Date.now() / 1000,
          exp: Date.now() / 1000 + 3600,
          jti: 'test-jti',
        },
        tool: 'aws',
        action: 'delete',
        parameters: {},
        context: {
          timestamp: new Date(),
          correlation_id: 'test-correlation',
          environment: 'test',
        },
      };

      const requestId = await approvalService.createApprovalRequest(policyRequest, {
        decision: 'AWAIT_APPROVAL',
        reason: 'Test',
        policy_version: '1.0.0',
        evaluation_ms: 10,
      });

      const result = await approvalService.recordApproval(
        requestId,
        'approver-1',
        'tenant_admin',
        'deny',
        'Not allowed'
      );

      expect(result.status).toBe('denied');
      expect(result.override_token).toBeUndefined();
    });
  });

  describe('Override Tokens', () => {
    it('should validate a valid override token', async () => {
      const policyRequest: PolicyRequest = {
        agent: {
          agent_id: 'agent-1',
          tenant_id: 'tenant-1',
          role: 'operator',
          scopes: ['*'],
          iat: Date.now() / 1000,
          exp: Date.now() / 1000 + 3600,
          jti: 'test-jti',
        },
        tool: 'aws',
        action: 'delete',
        parameters: {},
        context: {
          timestamp: new Date(),
          correlation_id: 'test-correlation',
          environment: 'test',
        },
      };

      const requestId = await approvalService.createApprovalRequest(policyRequest, {
        decision: 'AWAIT_APPROVAL',
        reason: 'Test',
        policy_version: '1.0.0',
        evaluation_ms: 10,
      });

      const approvalResult = await approvalService.recordApproval(
        requestId,
        'approver-1',
        'tenant_admin',
        'approve'
      );

      const validation = await approvalService.validateOverrideToken(
        approvalResult.override_token!
      );

      expect(validation.valid).toBe(true);
      expect(validation.approval_request_id).toBe(requestId);
    });

    it('should invalidate token after use', async () => {
      const policyRequest: PolicyRequest = {
        agent: {
          agent_id: 'agent-1',
          tenant_id: 'tenant-1',
          role: 'operator',
          scopes: ['*'],
          iat: Date.now() / 1000,
          exp: Date.now() / 1000 + 3600,
          jti: 'test-jti',
        },
        tool: 'aws',
        action: 'delete',
        parameters: {},
        context: {
          timestamp: new Date(),
          correlation_id: 'test-correlation',
          environment: 'test',
        },
      };

      const requestId = await approvalService.createApprovalRequest(policyRequest, {
        decision: 'AWAIT_APPROVAL',
        reason: 'Test',
        policy_version: '1.0.0',
        evaluation_ms: 10,
      });

      const approvalResult = await approvalService.recordApproval(
        requestId,
        'approver-1',
        'tenant_admin',
        'approve'
      );

      // First use
      const firstValidation = await approvalService.validateOverrideToken(
        approvalResult.override_token!
      );
      expect(firstValidation.valid).toBe(true);

      // Second use should fail (single-use token)
      const secondValidation = await approvalService.validateOverrideToken(
        approvalResult.override_token!
      );
      expect(secondValidation.valid).toBe(false);
    });
  });
});

// =============================================================================
// Budget Service Tests
// =============================================================================

describe('BudgetService', () => {
  let budgetService: BudgetService;

  beforeEach(() => {
    budgetService = new BudgetService();
  });

  describe('Budget Management', () => {
    it('should create a budget', () => {
      const budget = budgetService.createBudget({
        id: 'budget-1',
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        period: 'daily',
        limit_units: 1000,
        warning_threshold: 80,
        hard_limit: true,
      });

      expect(budget.id).toBe('budget-1');
      expect(budget.limit_units).toBe(1000);
      expect(budget.current_usage).toBe(0);
    });

    it('should track usage', async () => {
      budgetService.createBudget({
        id: 'budget-1',
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        period: 'daily',
        limit_units: 1000,
        warning_threshold: 80,
        hard_limit: true,
      });

      await budgetService.recordUsage('agent-1', 'tenant-1', 100, 'test-action');

      const usage = budgetService.getBudgetUsage('tenant-1', 'agent-1');
      expect(usage?.current_usage).toBe(100);
      expect(usage?.remaining).toBe(900);
    });

    it('should deny when budget exceeded', async () => {
      budgetService.createBudget({
        id: 'budget-1',
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        period: 'daily',
        limit_units: 100,
        warning_threshold: 80,
        hard_limit: true,
      });

      // Use all budget
      await budgetService.recordUsage('agent-1', 'tenant-1', 100, 'test-action');

      const check = await budgetService.checkBudget('agent-1', 'tenant-1');
      expect(check.allowed).toBe(false);
    });
  });

  describe('Cost Estimation', () => {
    it('should estimate costs for LLM operations', () => {
      const estimate = budgetService.estimateCost('llm', 'complete', {
        max_tokens: 1000,
      });

      expect(estimate.estimated_units).toBeGreaterThan(0);
      expect(estimate.breakdown.length).toBeGreaterThan(0);
    });
  });

  describe('Rate Limiting', () => {
    it('should allow requests within rate limit', async () => {
      budgetService.createRateLimit({
        id: 'rate-1',
        tenant_id: '*',
        agent_id: 'agent-1',
        tool: null,
        action: null,
        requests_per_window: 10,
        window_seconds: 60,
        burst_allowance: 0,
        enabled: true,
      });

      const check = await budgetService.checkRate('agent-1', 'any', 'any');
      expect(check.allowed).toBe(true);
      expect(check.remaining).toBe(10);
    });

    it('should block requests when rate limited', async () => {
      budgetService.createRateLimit({
        id: 'rate-1',
        tenant_id: '*',
        agent_id: 'agent-1',
        tool: null,
        action: null,
        requests_per_window: 2,
        window_seconds: 60,
        burst_allowance: 0,
        enabled: true,
      });

      // Make requests up to limit
      await budgetService.recordRequest('agent-1', 'any', 'any');
      await budgetService.recordRequest('agent-1', 'any', 'any');

      const check = await budgetService.checkRate('agent-1', 'any', 'any');
      expect(check.allowed).toBe(false);
    });
  });
});

// =============================================================================
// Audit Service Tests
// =============================================================================

describe('AuditService', () => {
  let auditService: AuditService;

  beforeEach(async () => {
    auditService = new AuditService(
      {
        backend: 'file',
        file_path: './test-audit.log',
        retention_days: 90,
        batch_size: 10,
        flush_interval_seconds: 1,
      },
      new MemoryAuditBackend()
    );
    await auditService.initialize();
  });

  afterEach(async () => {
    await auditService.shutdown();
  });

  describe('Event Logging', () => {
    it('should log an audit event', async () => {
      await auditService.log({
        event_type: 'action_allowed',
        agent_id: 'agent-1',
        tenant_id: 'tenant-1',
        role: 'operator',
        tool: 'database',
        action: 'get',
        parameters: { table: 'users' },
        policy_version: '1.0.0',
        decision: 'ALLOW',
        decision_reason: 'Allowed by policy',
        correlation_id: 'test-correlation',
        environment: 'test',
        evaluation_ms: 5,
      });

      // Flush to ensure event is written
      await auditService.flush();

      const result = await auditService.query({ agent_id: 'agent-1' });
      expect(result.events.length).toBe(1);
      expect(result.events[0].action).toBe('get');
    });
  });

  describe('Event Querying', () => {
    it('should filter events by criteria', async () => {
      await auditService.log({
        event_type: 'action_allowed',
        agent_id: 'agent-1',
        tenant_id: 'tenant-1',
        decision: 'ALLOW',
      });

      await auditService.log({
        event_type: 'action_denied',
        agent_id: 'agent-2',
        tenant_id: 'tenant-1',
        decision: 'DENY',
      });

      await auditService.flush();

      const allowed = await auditService.query({ decision: 'ALLOW' });
      expect(allowed.events.length).toBe(1);

      const denied = await auditService.query({ decision: 'DENY' });
      expect(denied.events.length).toBe(1);
    });
  });

  describe('Export Formats', () => {
    it('should export in JSONL format', async () => {
      await auditService.log({
        event_type: 'action_allowed',
        agent_id: 'agent-1',
        tenant_id: 'tenant-1',
      });
      await auditService.flush();

      const jsonl = await auditService.exportJSONL({});
      expect(jsonl).toContain('agent_id');
      expect(jsonl.split('\n').filter((l) => l.trim()).length).toBeGreaterThan(0);
    });

    it('should export in CEF format', async () => {
      await auditService.log({
        event_type: 'action_allowed',
        agent_id: 'agent-1',
        tenant_id: 'tenant-1',
        decision: 'ALLOW',
      });
      await auditService.flush();

      const cef = await auditService.exportCEF({});
      expect(cef).toContain('CEF:0|AEGIS|T2A|');
    });
  });
});

// =============================================================================
// Enforcement Proxy Integration Tests
// =============================================================================

describe('EnforcementProxy', () => {
  let tokenService: TokenService;
  let policyEngine: PolicyEngine;
  let approvalService: ApprovalService;
  let auditService: AuditService;
  let budgetService: BudgetService;
  let proxy: EnforcementProxy;

  beforeEach(async () => {
    tokenService = await TokenService.createWithGeneratedKeys({
      algorithm: 'RS256',
      token_ttl_seconds: 3600,
      refresh_ttl_seconds: 86400,
      issuer: 'test-issuer',
      audience: 'test-audience',
    });

    policyEngine = new PolicyEngine({
      opa_url: 'http://localhost:8181',
      bundle_path: './policies/examples',
      hot_reload: false,
      reload_interval_seconds: 60,
      cache_ttl_seconds: 10,
    });

    // Add test bundle
    policyEngine.addBundle({
      id: 'test-bundle',
      version: '1.0.0',
      name: 'Test Bundle',
      description: 'Test',
      tenant_id: null,
      rules: [
        {
          id: 'allow-read',
          name: 'Allow Read',
          description: 'Allow read',
          priority: 100,
          enabled: true,
          conditions: [{ field: 'action', operator: 'equals', value: 'get' }],
          effect: { decision: 'ALLOW', reason_template: 'Read allowed' },
        },
        {
          id: 'deny-delete',
          name: 'Deny Delete',
          description: 'Deny delete',
          priority: 50,
          enabled: true,
          conditions: [{ field: 'action', operator: 'equals', value: 'delete' }],
          effect: { decision: 'DENY', reason_template: 'Delete denied' },
        },
      ],
      default_decision: 'DENY',
      metadata: {
        created_at: new Date(),
        updated_at: new Date(),
        created_by: 'test',
        checksum: '',
        tags: [],
      },
    });

    approvalService = new ApprovalService({
      default_timeout_seconds: 60,
      max_pending_per_agent: 5,
    });

    auditService = new AuditService(
      {
        backend: 'file',
        file_path: './test-audit.log',
        retention_days: 90,
        batch_size: 10,
        flush_interval_seconds: 1,
      },
      new MemoryAuditBackend()
    );
    await auditService.initialize();

    budgetService = new BudgetService();

    proxy = new EnforcementProxy(
      {
        port: 8080,
        host: '0.0.0.0',
        timeout_ms: 30000,
        max_body_size: '10mb',
        shadow_mode: false,
        fail_closed: true,
      },
      tokenService,
      policyEngine,
      {
        auditLogger: {
          log: async (event) => auditService.log(event as any),
        },
        environment: 'test',
      }
    );
  });

  afterEach(async () => {
    await policyEngine.shutdown();
    await auditService.shutdown();
  });

  describe('Action Processing', () => {
    it('should allow actions with valid token and policy', async () => {
      const tokenResponse = await tokenService.issueToken({
        agent_id: 'agent-1',
        tenant_id: 'tenant-1',
        role: 'operator',
        scopes: ['*'],
      });

      const result = await proxy.processAction({
        authorization: `Bearer ${tokenResponse.access_token}`,
        tool: 'database',
        action: 'get',
        parameters: { id: '123' },
      });

      expect(result.allowed).toBe(true);
      expect(result.decision).toBe('ALLOW');
    });

    it('should deny actions without token', async () => {
      const result = await proxy.processAction({
        tool: 'database',
        action: 'get',
        parameters: {},
      });

      expect(result.allowed).toBe(false);
    });

    it('should deny actions blocked by policy', async () => {
      const tokenResponse = await tokenService.issueToken({
        agent_id: 'agent-1',
        tenant_id: 'tenant-1',
        role: 'operator',
        scopes: ['*'],
      });

      const result = await proxy.processAction({
        authorization: `Bearer ${tokenResponse.access_token}`,
        tool: 'database',
        action: 'delete',
        parameters: { id: '123' },
      });

      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('DENY');
    });
  });

  describe('Shadow Mode', () => {
    it('should allow all actions in shadow mode', async () => {
      const shadowProxy = new EnforcementProxy(
        {
          port: 8080,
          host: '0.0.0.0',
          timeout_ms: 30000,
          max_body_size: '10mb',
          shadow_mode: true,
          fail_closed: true,
        },
        tokenService,
        policyEngine
      );

      const tokenResponse = await tokenService.issueToken({
        agent_id: 'agent-1',
        tenant_id: 'tenant-1',
        role: 'operator',
        scopes: ['*'],
      });

      const result = await shadowProxy.processAction({
        authorization: `Bearer ${tokenResponse.access_token}`,
        tool: 'database',
        action: 'delete', // Would normally be denied
        parameters: { id: '123' },
      });

      expect(result.allowed).toBe(true);
      expect(result.message).toContain('Shadow mode');
    });
  });
});

// =============================================================================
// Performance Tests
// =============================================================================

describe('Performance', () => {
  let policyEngine: PolicyEngine;

  beforeEach(() => {
    policyEngine = new PolicyEngine({
      opa_url: 'http://localhost:8181',
      bundle_path: './policies/examples',
      hot_reload: false,
      reload_interval_seconds: 60,
      cache_ttl_seconds: 300,
    });

    // Add simple policy bundle
    policyEngine.addBundle({
      id: 'perf-bundle',
      version: '1.0.0',
      name: 'Performance Test Bundle',
      description: 'For performance testing',
      tenant_id: null,
      rules: [
        {
          id: 'allow-all',
          name: 'Allow All',
          description: 'Allow all for perf test',
          priority: 100,
          enabled: true,
          conditions: [{ field: 'action', operator: 'exists', value: true }],
          effect: { decision: 'ALLOW', reason_template: 'Allowed' },
        },
      ],
      default_decision: 'ALLOW',
      metadata: {
        created_at: new Date(),
        updated_at: new Date(),
        created_by: 'test',
        checksum: '',
        tags: [],
      },
    });
  });

  afterEach(async () => {
    await policyEngine.shutdown();
  });

  it('should evaluate policies in under 20ms', async () => {
    const request: PolicyRequest = {
      agent: {
        agent_id: 'agent-1',
        tenant_id: 'tenant-1',
        role: 'operator',
        scopes: ['*'],
        iat: Date.now() / 1000,
        exp: Date.now() / 1000 + 3600,
        jti: 'test-jti',
      },
      tool: 'database',
      action: 'get',
      parameters: {},
      context: {
        timestamp: new Date(),
        correlation_id: 'test-correlation',
        environment: 'test',
      },
    };

    // Warm up cache
    await policyEngine.evaluate(request);

    // Measure subsequent evaluations
    const iterations = 100;
    const start = Date.now();

    for (let i = 0; i < iterations; i++) {
      await policyEngine.evaluate({
        ...request,
        context: { ...request.context, correlation_id: `test-${i}` },
      });
    }

    const elapsed = Date.now() - start;
    const avgLatency = elapsed / iterations;

    console.log(`Average policy evaluation latency: ${avgLatency.toFixed(2)}ms`);
    expect(avgLatency).toBeLessThan(20);
  });
});
