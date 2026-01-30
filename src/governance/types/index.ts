/**
 * AEGIS-T2A Governance Types
 *
 * Core type definitions for the enterprise security and governance layer.
 * Provides type safety for policy enforcement, identity management,
 * approval workflows, and audit trails.
 */

// =============================================================================
// Identity & Authentication Types
// =============================================================================

/**
 * Agent identity claims embedded in JWT tokens
 */
export interface AgentIdentity {
  /** Unique agent identifier */
  agent_id: string;
  /** Tenant/organization identifier */
  tenant_id: string;
  /** Agent's assigned role */
  role: AgentRole;
  /** Granted permission scopes */
  scopes: string[];
  /** Token issue timestamp */
  iat: number;
  /** Token expiration timestamp */
  exp: number;
  /** Token unique identifier for revocation tracking */
  jti: string;
  /** Optional session identifier */
  session_id?: string;
}

/**
 * Predefined agent roles with hierarchical permissions
 */
export type AgentRole =
  | 'system_admin'      // Full system access
  | 'tenant_admin'      // Full tenant access
  | 'operator'          // Execute approved actions
  | 'developer'         // Development/testing access
  | 'readonly'          // Read-only monitoring
  | 'restricted';       // Minimal permissions, approval required

/**
 * Token metadata for management and revocation
 */
export interface TokenMetadata {
  jti: string;
  agent_id: string;
  tenant_id: string;
  issued_at: Date;
  expires_at: Date;
  revoked: boolean;
  revoked_at?: Date;
  revoked_reason?: string;
}

/**
 * Token issuance request
 */
export interface TokenRequest {
  agent_id: string;
  tenant_id: string;
  role: AgentRole;
  scopes: string[];
  ttl_seconds?: number;
  session_id?: string;
}

/**
 * Token issuance response
 */
export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

// =============================================================================
// Policy Types
// =============================================================================

/**
 * Policy decision outcomes
 */
export type PolicyDecision = 'ALLOW' | 'DENY' | 'MODIFY' | 'AWAIT_APPROVAL';

/**
 * Policy evaluation request
 */
export interface PolicyRequest {
  /** Agent making the request */
  agent: AgentIdentity;
  /** Tool being invoked */
  tool: string;
  /** Action within the tool */
  action: string;
  /** Action parameters */
  parameters: Record<string, unknown>;
  /** Request context */
  context: PolicyContext;
}

/**
 * Additional context for policy evaluation
 */
export interface PolicyContext {
  /** Request timestamp */
  timestamp: Date;
  /** Source IP address */
  source_ip?: string;
  /** Request correlation ID */
  correlation_id: string;
  /** Environment (production, staging, development) */
  environment: string;
  /** Current budget usage */
  budget_usage?: BudgetUsage;
  /** Rate limit status */
  rate_status?: RateStatus;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Policy evaluation result
 */
export interface PolicyResult {
  /** The decision outcome */
  decision: PolicyDecision;
  /** Human-readable reason for the decision */
  reason: string;
  /** Policy that matched */
  matched_policy?: string;
  /** Policy version used */
  policy_version: string;
  /** Evaluation latency in milliseconds */
  evaluation_ms: number;
  /** Modified parameters (for MODIFY decisions) */
  modified_parameters?: Record<string, unknown>;
  /** Approval request ID (for AWAIT_APPROVAL decisions) */
  approval_request_id?: string;
  /** Override token if pre-approved */
  override_token?: string;
  /** Additional decision metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Policy rule definition
 */
export interface PolicyRule {
  /** Unique rule identifier */
  id: string;
  /** Rule name */
  name: string;
  /** Rule description */
  description: string;
  /** Priority (lower = higher priority) */
  priority: number;
  /** Whether rule is enabled */
  enabled: boolean;
  /** Conditions that must match */
  conditions: PolicyCondition[];
  /** Effect when conditions match */
  effect: PolicyEffect;
  /** Parameter modifications (for MODIFY effect) */
  modifications?: ParameterModification[];
  /** Approval configuration (for AWAIT_APPROVAL effect) */
  approval_config?: ApprovalConfig;
}

/**
 * Policy condition for matching
 */
export interface PolicyCondition {
  /** Field to evaluate */
  field: string;
  /** Comparison operator */
  operator: ConditionOperator;
  /** Value to compare against */
  value: unknown;
  /** Negate the condition */
  negate?: boolean;
}

export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'matches'         // Regex match
  | 'in'              // Value in array
  | 'not_in'
  | 'greater_than'
  | 'less_than'
  | 'greater_than_or_equal'
  | 'less_than_or_equal'
  | 'exists'
  | 'not_exists';

/**
 * Policy effect definition
 */
export interface PolicyEffect {
  /** Decision to return */
  decision: PolicyDecision;
  /** Reason template */
  reason_template: string;
}

/**
 * Parameter modification rule
 */
export interface ParameterModification {
  /** Parameter path to modify */
  path: string;
  /** Modification type */
  type: 'redact' | 'mask' | 'replace' | 'remove' | 'transform';
  /** Replacement value or transform function */
  value?: unknown;
  /** Mask pattern (for mask type) */
  mask_pattern?: string;
}

/**
 * Approval configuration for AWAIT_APPROVAL decisions
 */
export interface ApprovalConfig {
  /** Required approver roles */
  required_approvers: AgentRole[];
  /** Minimum number of approvals needed */
  min_approvals: number;
  /** Approval timeout in seconds */
  timeout_seconds: number;
  /** Notification channels */
  notify_channels: string[];
  /** Auto-deny on timeout */
  auto_deny_on_timeout: boolean;
  /** Escalation rules */
  escalation?: EscalationRule[];
}

/**
 * Escalation rule for approvals
 */
export interface EscalationRule {
  /** Time after which to escalate (seconds) */
  after_seconds: number;
  /** Escalation target roles */
  escalate_to: AgentRole[];
  /** Notification message */
  message: string;
}

// =============================================================================
// Policy Bundle Types
// =============================================================================

/**
 * Policy bundle containing multiple rules
 */
export interface PolicyBundle {
  /** Bundle identifier */
  id: string;
  /** Bundle version */
  version: string;
  /** Bundle name */
  name: string;
  /** Bundle description */
  description: string;
  /** Tenant ID (null for global policies) */
  tenant_id: string | null;
  /** Policy rules */
  rules: PolicyRule[];
  /** Default decision when no rules match */
  default_decision: PolicyDecision;
  /** Bundle metadata */
  metadata: BundleMetadata;
}

/**
 * Bundle metadata
 */
export interface BundleMetadata {
  created_at: Date;
  updated_at: Date;
  created_by: string;
  checksum: string;
  tags: string[];
}

// =============================================================================
// Approval Workflow Types
// =============================================================================

/**
 * Approval request
 */
export interface ApprovalRequest {
  /** Request unique identifier */
  id: string;
  /** Original policy request */
  policy_request: PolicyRequest;
  /** Policy result that triggered approval */
  policy_result: PolicyResult;
  /** Request status */
  status: ApprovalStatus;
  /** Approvals received */
  approvals: Approval[];
  /** Request creation time */
  created_at: Date;
  /** Request expiration time */
  expires_at: Date;
  /** Notification status */
  notifications_sent: NotificationRecord[];
  /** Override token (once approved) */
  override_token?: string;
  /** Override token expiration */
  override_expires_at?: Date;
}

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'cancelled';

/**
 * Individual approval vote
 */
export interface Approval {
  /** Approver identity */
  approver_id: string;
  /** Approver role */
  approver_role: AgentRole;
  /** Approval decision */
  decision: 'approve' | 'deny';
  /** Optional comment */
  comment?: string;
  /** Approval timestamp */
  timestamp: Date;
  /** Verification method */
  verification_method: 'token' | 'mfa' | 'biometric';
}

/**
 * Notification record
 */
export interface NotificationRecord {
  channel: string;
  sent_at: Date;
  status: 'sent' | 'delivered' | 'failed';
  message_id?: string;
  error?: string;
}

/**
 * Override token for approved actions
 */
export interface OverrideToken {
  /** Token identifier */
  id: string;
  /** Associated approval request */
  approval_request_id: string;
  /** Token value */
  token: string;
  /** Allowed action signature */
  action_signature: string;
  /** Single use flag */
  single_use: boolean;
  /** Usage count */
  used_count: number;
  /** Maximum uses */
  max_uses: number;
  /** Creation time */
  created_at: Date;
  /** Expiration time */
  expires_at: Date;
  /** Revoked flag */
  revoked: boolean;
}

// =============================================================================
// Audit Types
// =============================================================================

/**
 * Audit event record
 */
export interface AuditEvent {
  /** Event unique identifier */
  id: string;
  /** Event timestamp */
  timestamp: Date;
  /** Event type */
  event_type: AuditEventType;
  /** Agent identity */
  agent_id: string;
  /** Tenant identifier */
  tenant_id: string;
  /** Agent role at time of event */
  role: AgentRole;
  /** Tool invoked */
  tool: string;
  /** Action performed */
  action: string;
  /** Request parameters (sanitized) */
  parameters: Record<string, unknown>;
  /** Policy version used */
  policy_version: string;
  /** Policy decision */
  decision: PolicyDecision;
  /** Decision reason */
  decision_reason: string;
  /** Matched policy ID */
  matched_policy_id?: string;
  /** Approval request ID (if applicable) */
  approval_id?: string;
  /** Override token ID (if applicable) */
  override_token_id?: string;
  /** Request correlation ID */
  correlation_id: string;
  /** Source IP address */
  source_ip?: string;
  /** User agent */
  user_agent?: string;
  /** Environment */
  environment: string;
  /** Evaluation latency (ms) */
  evaluation_ms: number;
  /** Shadow mode flag */
  shadow_mode: boolean;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export type AuditEventType =
  | 'policy_evaluation'
  | 'action_allowed'
  | 'action_denied'
  | 'action_modified'
  | 'approval_requested'
  | 'approval_granted'
  | 'approval_denied'
  | 'approval_expired'
  | 'token_issued'
  | 'token_revoked'
  | 'token_validated'
  | 'budget_warning'
  | 'budget_exceeded'
  | 'rate_limit_warning'
  | 'rate_limit_exceeded'
  | 'policy_updated'
  | 'config_changed';

/**
 * Audit query parameters
 */
export interface AuditQuery {
  /** Start time */
  start_time?: Date;
  /** End time */
  end_time?: Date;
  /** Agent ID filter */
  agent_id?: string;
  /** Tenant ID filter */
  tenant_id?: string;
  /** Event type filter */
  event_type?: AuditEventType;
  /** Decision filter */
  decision?: PolicyDecision;
  /** Tool filter */
  tool?: string;
  /** Action filter */
  action?: string;
  /** Correlation ID */
  correlation_id?: string;
  /** Shadow mode filter */
  shadow_mode?: boolean;
  /** Pagination limit */
  limit?: number;
  /** Pagination offset */
  offset?: number;
  /** Sort field */
  sort_by?: string;
  /** Sort direction */
  sort_order?: 'asc' | 'desc';
}

// =============================================================================
// Budget & Rate Limiting Types
// =============================================================================

/**
 * Budget configuration
 */
export interface BudgetConfig {
  /** Budget identifier */
  id: string;
  /** Tenant ID */
  tenant_id: string;
  /** Agent ID (null for tenant-wide) */
  agent_id: string | null;
  /** Budget period */
  period: BudgetPeriod;
  /** Budget limit in units */
  limit_units: number;
  /** Current usage */
  current_usage: number;
  /** Warning threshold (percentage) */
  warning_threshold: number;
  /** Hard limit enforcement */
  hard_limit: boolean;
  /** Reset timestamp */
  period_start: Date;
  /** Period end timestamp */
  period_end: Date;
  /** Created at */
  created_at: Date;
  /** Updated at */
  updated_at: Date;
}

export type BudgetPeriod = 'hourly' | 'daily' | 'weekly' | 'monthly';

/**
 * Budget usage snapshot
 */
export interface BudgetUsage {
  /** Budget ID */
  budget_id: string;
  /** Current usage */
  current_usage: number;
  /** Budget limit */
  limit: number;
  /** Usage percentage */
  usage_percentage: number;
  /** Remaining units */
  remaining: number;
  /** Period start */
  period_start: Date;
  /** Period end */
  period_end: Date;
  /** Warning triggered */
  warning_triggered: boolean;
  /** Limit exceeded */
  limit_exceeded: boolean;
}

/**
 * Cost estimation for an action
 */
export interface CostEstimate {
  /** Estimated cost in units */
  estimated_units: number;
  /** Cost breakdown */
  breakdown: CostBreakdown[];
  /** Confidence level */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Cost breakdown item
 */
export interface CostBreakdown {
  /** Resource type */
  resource_type: string;
  /** Quantity */
  quantity: number;
  /** Unit cost */
  unit_cost: number;
  /** Total cost */
  total: number;
}

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /** Rate limit identifier */
  id: string;
  /** Tenant ID */
  tenant_id: string;
  /** Agent ID (null for tenant-wide) */
  agent_id: string | null;
  /** Tool (null for all tools) */
  tool: string | null;
  /** Action (null for all actions) */
  action: string | null;
  /** Requests per window */
  requests_per_window: number;
  /** Window size in seconds */
  window_seconds: number;
  /** Burst allowance */
  burst_allowance: number;
  /** Enabled flag */
  enabled: boolean;
}

/**
 * Current rate limit status
 */
export interface RateStatus {
  /** Requests remaining in current window */
  remaining: number;
  /** Total allowed requests */
  limit: number;
  /** Window reset timestamp */
  reset_at: Date;
  /** Current request count */
  current_count: number;
  /** Rate limited flag */
  rate_limited: boolean;
}

// =============================================================================
// Telemetry Types
// =============================================================================

/**
 * Telemetry span for distributed tracing
 */
export interface TelemetrySpan {
  /** Trace ID */
  trace_id: string;
  /** Span ID */
  span_id: string;
  /** Parent span ID */
  parent_span_id?: string;
  /** Operation name */
  operation: string;
  /** Start time */
  start_time: Date;
  /** End time */
  end_time?: Date;
  /** Duration in milliseconds */
  duration_ms?: number;
  /** Span status */
  status: 'ok' | 'error';
  /** Span attributes */
  attributes: Record<string, unknown>;
  /** Span events */
  events: SpanEvent[];
}

/**
 * Span event
 */
export interface SpanEvent {
  /** Event name */
  name: string;
  /** Event timestamp */
  timestamp: Date;
  /** Event attributes */
  attributes: Record<string, unknown>;
}

/**
 * Metric definition
 */
export interface MetricDefinition {
  /** Metric name */
  name: string;
  /** Metric type */
  type: 'counter' | 'gauge' | 'histogram' | 'summary';
  /** Description */
  description: string;
  /** Unit */
  unit: string;
  /** Labels */
  labels: string[];
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Governance configuration
 */
export interface GovernanceConfig {
  /** Proxy configuration */
  proxy: ProxyConfig;
  /** Policy engine configuration */
  policy_engine: PolicyEngineConfig;
  /** Token service configuration */
  token_service: TokenServiceConfig;
  /** Approval service configuration */
  approval_service: ApprovalServiceConfig;
  /** Audit configuration */
  audit: AuditConfig;
  /** Telemetry configuration */
  telemetry: TelemetryConfig;
}

export interface ProxyConfig {
  /** Listen port */
  port: number;
  /** Listen host */
  host: string;
  /** Request timeout (ms) */
  timeout_ms: number;
  /** Max request body size */
  max_body_size: string;
  /** Shadow mode (dry-run) */
  shadow_mode: boolean;
  /** Fail-closed behavior */
  fail_closed: boolean;
}

export interface PolicyEngineConfig {
  /** OPA server URL */
  opa_url: string;
  /** Policy bundle path */
  bundle_path: string;
  /** Hot reload enabled */
  hot_reload: boolean;
  /** Reload interval (seconds) */
  reload_interval_seconds: number;
  /** Decision cache TTL (seconds) */
  cache_ttl_seconds: number;
}

export interface TokenServiceConfig {
  /** JWT signing algorithm */
  algorithm: 'RS256' | 'RS384' | 'RS512' | 'ES256' | 'ES384' | 'ES512';
  /** Private key path */
  private_key_path: string;
  /** Public key path */
  public_key_path: string;
  /** Token TTL (seconds) */
  token_ttl_seconds: number;
  /** Refresh token TTL (seconds) */
  refresh_ttl_seconds: number;
  /** Issuer claim */
  issuer: string;
  /** Audience claim */
  audience: string;
}

export interface ApprovalServiceConfig {
  /** Default timeout (seconds) */
  default_timeout_seconds: number;
  /** Max pending approvals per agent */
  max_pending_per_agent: number;
  /** Notification webhook URL */
  webhook_url?: string;
  /** Slack webhook URL */
  slack_webhook_url?: string;
  /** Teams webhook URL */
  teams_webhook_url?: string;
}

export interface AuditConfig {
  /** Audit storage backend */
  backend: 'file' | 'database' | 'elasticsearch' | 'kafka';
  /** File path (for file backend) */
  file_path?: string;
  /** Database connection string */
  database_url?: string;
  /** Elasticsearch URL */
  elasticsearch_url?: string;
  /** Kafka brokers */
  kafka_brokers?: string[];
  /** Retention days */
  retention_days: number;
  /** Batch size for writes */
  batch_size: number;
  /** Flush interval (seconds) */
  flush_interval_seconds: number;
}

export interface TelemetryConfig {
  /** Enable telemetry */
  enabled: boolean;
  /** OTLP endpoint */
  otlp_endpoint?: string;
  /** Service name */
  service_name: string;
  /** Sampling rate (0-1) */
  sampling_rate: number;
  /** Export interval (seconds) */
  export_interval_seconds: number;
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Governance error base class
 */
export class GovernanceError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'GovernanceError';
  }
}

export class PolicyDeniedError extends GovernanceError {
  constructor(reason: string, policy_id?: string) {
    super(reason, 'POLICY_DENIED', 403, { policy_id });
    this.name = 'PolicyDeniedError';
  }
}

export class ApprovalRequiredError extends GovernanceError {
  constructor(approval_request_id: string, reason: string) {
    super(reason, 'APPROVAL_REQUIRED', 202, { approval_request_id });
    this.name = 'ApprovalRequiredError';
  }
}

export class TokenError extends GovernanceError {
  constructor(message: string, code: string = 'TOKEN_ERROR') {
    super(message, code, 401);
    this.name = 'TokenError';
  }
}

export class BudgetExceededError extends GovernanceError {
  constructor(budget_id: string, current: number, limit: number) {
    super(
      `Budget exceeded: ${current}/${limit} units`,
      'BUDGET_EXCEEDED',
      429,
      { budget_id, current, limit }
    );
    this.name = 'BudgetExceededError';
  }
}

export class RateLimitError extends GovernanceError {
  constructor(reset_at: Date) {
    super(
      'Rate limit exceeded',
      'RATE_LIMITED',
      429,
      { reset_at: reset_at.toISOString() }
    );
    this.name = 'RateLimitError';
  }
}
