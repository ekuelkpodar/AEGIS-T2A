/**
 * AEGIS-T2A Governance Server
 *
 * Standalone server for the governance control plane.
 * Runs the enforcement proxy, policy engine, approval service,
 * and audit logging.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { createTokenService, TokenService } from './token/TokenService';
import { PolicyEngine } from './policy/PolicyEngine';
import { ApprovalService } from './approval/ApprovalService';
import { AuditService, MemoryAuditBackend } from './audit/AuditService';
import { BudgetService } from './budget/BudgetService';
import { EnforcementProxy } from './proxy/EnforcementProxy';
import { createGovernanceRoutes } from './api/routes';
import { defaultConfig } from './index';

/**
 * Environment configuration
 */
const config = {
  port: parseInt(process.env.PORT || '8080'),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Policy Engine
  opaUrl: process.env.OPA_URL || defaultConfig.policy_engine.opa_url,
  policyBundlePath: process.env.POLICY_BUNDLE_PATH || defaultConfig.policy_engine.bundle_path,

  // Token Service
  jwtAlgorithm: (process.env.JWT_ALGORITHM || defaultConfig.token_service.algorithm) as any,
  jwtIssuer: process.env.JWT_ISSUER || defaultConfig.token_service.issuer,
  jwtAudience: process.env.JWT_AUDIENCE || defaultConfig.token_service.audience,
  tokenTtl: parseInt(process.env.TOKEN_TTL_SECONDS || String(defaultConfig.token_service.token_ttl_seconds)),

  // Approval Service
  approvalTimeout: parseInt(
    process.env.DEFAULT_TIMEOUT_SECONDS ||
      String(defaultConfig.approval_service.default_timeout_seconds)
  ),
  maxPendingPerAgent: parseInt(
    process.env.MAX_PENDING_PER_AGENT ||
      String(defaultConfig.approval_service.max_pending_per_agent)
  ),
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  teamsWebhookUrl: process.env.TEAMS_WEBHOOK_URL,

  // Audit
  auditBackend: (process.env.AUDIT_BACKEND || defaultConfig.audit.backend) as any,
  auditFilePath: process.env.AUDIT_FILE_PATH || defaultConfig.audit.file_path,

  // Proxy
  shadowMode: process.env.SHADOW_MODE === 'true',
  failClosed: process.env.FAIL_CLOSED !== 'false',
};

/**
 * Initialize and start the governance server
 */
async function startServer(): Promise<void> {
  console.log('[Governance] Starting AEGIS-T2A Governance Server...');
  console.log(`[Governance] Environment: ${config.nodeEnv}`);
  console.log(`[Governance] Shadow Mode: ${config.shadowMode}`);
  console.log(`[Governance] Fail Closed: ${config.failClosed}`);

  // Initialize services
  console.log('[Governance] Initializing services...');

  // Token Service
  const tokenService = await createTokenService({
    algorithm: config.jwtAlgorithm,
    private_key_path: process.env.JWT_PRIVATE_KEY_PATH || '',
    public_key_path: process.env.JWT_PUBLIC_KEY_PATH || '',
    token_ttl_seconds: config.tokenTtl,
    refresh_ttl_seconds: config.tokenTtl * 24,
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
  });
  console.log('[Governance] Token Service initialized');

  // Policy Engine
  const policyEngine = new PolicyEngine({
    opa_url: config.opaUrl,
    bundle_path: config.policyBundlePath,
    hot_reload: true,
    reload_interval_seconds: 60,
    cache_ttl_seconds: 300,
  });
  await policyEngine.initialize();
  console.log(`[Governance] Policy Engine initialized (version: ${policyEngine.getVersion()})`);

  // Approval Service
  const approvalService = new ApprovalService({
    default_timeout_seconds: config.approvalTimeout,
    max_pending_per_agent: config.maxPendingPerAgent,
    slack_webhook_url: config.slackWebhookUrl,
    teams_webhook_url: config.teamsWebhookUrl,
  });
  console.log('[Governance] Approval Service initialized');

  // Audit Service
  const auditBackend =
    config.nodeEnv === 'development' ? new MemoryAuditBackend() : undefined;
  const auditService = new AuditService(
    {
      backend: config.auditBackend,
      file_path: config.auditFilePath,
      retention_days: 90,
      batch_size: 100,
      flush_interval_seconds: 10,
    },
    auditBackend
  );
  await auditService.initialize();
  console.log('[Governance] Audit Service initialized');

  // Budget Service
  const budgetService = new BudgetService();
  console.log('[Governance] Budget Service initialized');

  // Enforcement Proxy
  const enforcementProxy = new EnforcementProxy(
    {
      port: config.port,
      host: '0.0.0.0',
      timeout_ms: 30000,
      max_body_size: '10mb',
      shadow_mode: config.shadowMode,
      fail_closed: config.failClosed,
    },
    tokenService,
    policyEngine,
    {
      budgetChecker: {
        checkBudget: async (agentId, tenantId) =>
          budgetService.checkBudget(agentId, tenantId),
        recordUsage: async (agentId, tenantId, units) =>
          budgetService.recordUsage(agentId, tenantId, units),
      },
      rateLimiter: {
        checkRate: async (agentId, tool, action) =>
          budgetService.checkRate(agentId, tool, action),
        recordRequest: async (agentId, tool, action) =>
          budgetService.recordRequest(agentId, tool, action),
      },
      auditLogger: {
        log: async (event) => auditService.log(event as any),
      },
      approvalService: {
        createApprovalRequest: async (request, result) =>
          approvalService.createApprovalRequest(request, result),
        validateOverrideToken: async (token) =>
          approvalService.validateOverrideToken(token),
      },
      environment: config.nodeEnv,
    }
  );
  console.log('[Governance] Enforcement Proxy initialized');

  // Create Express app
  const app = express();

  // Middleware
  app.use(helmet());
  app.use(cors());
  app.use(compression());
  app.use(express.json());

  // Request logging
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    });
    next();
  });

  // Governance API routes
  const governanceRoutes = createGovernanceRoutes(
    tokenService,
    policyEngine,
    approvalService,
    auditService,
    budgetService,
    enforcementProxy
  );
  app.use('/api/v1/governance', governanceRoutes);

  // Root health check
  app.get('/', (_req, res) => {
    res.json({
      service: 'AEGIS-T2A Governance Control Plane',
      version: '1.0.0',
      status: 'running',
    });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'healthy' });
  });

  // Start server
  app.listen(config.port, () => {
    console.log(`[Governance] Server running on port ${config.port}`);
    console.log(`[Governance] API available at http://localhost:${config.port}/api/v1/governance`);
  });

  // Event handlers
  policyEngine.on('policies_loaded', (data) => {
    console.log(`[Governance] Policies loaded: ${data.bundle_count} bundles, version ${data.version}`);
  });

  approvalService.on('request_created', (data) => {
    console.log(`[Governance] Approval request created: ${data.request_id}`);
  });

  approvalService.on('request_approved', (data) => {
    console.log(`[Governance] Approval request approved: ${data.request_id}`);
  });

  approvalService.on('request_denied', (data) => {
    console.log(`[Governance] Approval request denied: ${data.request_id}`);
  });

  budgetService.on('budget_warning', (data) => {
    console.log(`[Governance] Budget warning: ${data.tenant_id}/${data.agent_id} at ${data.usage_percent}%`);
  });

  budgetService.on('budget_exceeded', (data) => {
    console.log(`[Governance] Budget exceeded: ${data.tenant_id}/${data.agent_id}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('[Governance] Received SIGTERM, shutting down gracefully...');
    await policyEngine.shutdown();
    await auditService.shutdown();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('[Governance] Received SIGINT, shutting down gracefully...');
    await policyEngine.shutdown();
    await auditService.shutdown();
    process.exit(0);
  });
}

// Start the server
startServer().catch((error) => {
  console.error('[Governance] Failed to start server:', error);
  process.exit(1);
});
