/**
 * AEGIS-T2A Governance Module
 *
 * Enterprise-grade security, policy enforcement, and governance layer.
 * Exports all governance components for use in the main application.
 */

// Types
export * from './types';

// Services
export { TokenService, createTokenService, TokenValidationResult } from './token/TokenService';
export { PolicyEngine } from './policy/PolicyEngine';
export { ApprovalService, SlackNotificationChannel, TeamsNotificationChannel, WebhookNotificationChannel, NotificationChannel } from './approval/ApprovalService';
export { AuditService, AuditBackend, FileAuditBackend, MemoryAuditBackend, CEFFormatter } from './audit/AuditService';
export { BudgetService } from './budget/BudgetService';
export { EnforcementProxy, ActionRequest, ActionResponse, BudgetChecker, RateLimiter, AuditLogger } from './proxy/EnforcementProxy';

// API Routes
export { createGovernanceRoutes } from './api/routes';

// Default configuration
export const defaultConfig = {
  proxy: {
    port: 8080,
    host: '0.0.0.0',
    timeout_ms: 30000,
    max_body_size: '10mb',
    shadow_mode: false,
    fail_closed: true,
  },
  policy_engine: {
    opa_url: 'http://localhost:8181',
    bundle_path: './policies',
    hot_reload: true,
    reload_interval_seconds: 60,
    cache_ttl_seconds: 300,
  },
  token_service: {
    algorithm: 'RS256' as const,
    private_key_path: '',
    public_key_path: '',
    token_ttl_seconds: 3600,
    refresh_ttl_seconds: 86400,
    issuer: 'aegis-t2a',
    audience: 'aegis-agents',
  },
  approval_service: {
    default_timeout_seconds: 3600,
    max_pending_per_agent: 10,
  },
  audit: {
    backend: 'file' as const,
    file_path: './audit/audit.log',
    retention_days: 90,
    batch_size: 100,
    flush_interval_seconds: 10,
  },
  telemetry: {
    enabled: false,
    service_name: 'aegis-governance',
    sampling_rate: 0.1,
    export_interval_seconds: 30,
  },
};
