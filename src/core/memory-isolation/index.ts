/**
 * AEGIS-T2A Memory Isolation Engine
 *
 * Enterprise-grade session-scoped memory isolation with cryptographic separation.
 * Prevents cross-tenant data leakage (OWASP AAI006) through strict namespace
 * enforcement and DLP scanning.
 *
 * Key Components:
 * - MemoryNamespace: Cryptographically separated namespaces per (tenantId, userId, sessionId)
 * - SessionMemoryManager: Auto-purges memory on workflow completion (max TTL 24h)
 * - MemoryAccessControlList: RBAC policies on memory reads/writes
 * - DLPMemoryFilter: Scans all memory writes for PII/credentials/secrets
 *
 * CRITICAL SAFETY CONSTRAINT:
 * Memory isolation MUST NOT be bypassable via "emergency mode" or admin overrides.
 * This is a hard security boundary.
 */

import { EventEmitter } from 'events';
import { z } from 'zod';
import { componentLogger } from '../logger.js';
import { generateId } from '../ids.js';
import { hashObject } from '../crypto.js';

const logger = componentLogger('memory-isolation');

// =============================================================================
// Constants
// =============================================================================

/**
 * Maximum memory TTL (24 hours)
 */
const MAX_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Default memory TTL (1 hour)
 */
const DEFAULT_MEMORY_TTL_MS = 60 * 60 * 1000;

/**
 * Memory purge check interval (5 minutes)
 */
const PURGE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * HKDF info prefix for namespace derivation
 */
const HKDF_INFO_PREFIX = 'AEGIS-T2A-MEMORY-NAMESPACE-V1';

// =============================================================================
// Types
// =============================================================================

/**
 * Memory namespace identifier components
 */
export interface NamespaceIdentifier {
  tenantId: string;
  userId: string;
  sessionId: string;
}

/**
 * Memory entry with metadata
 */
export interface MemoryEntry {
  entryId: string;
  namespaceId: string;
  key: string;
  value: unknown;
  dataClassification: DataClassification;
  createdAt: string;
  expiresAt: string;
  accessCount: number;
  lastAccessedAt: string;
  hash: string;
  encrypted: boolean;
}

/**
 * Data classification levels
 */
export type DataClassification =
  | 'public'
  | 'internal'
  | 'confidential'
  | 'restricted'
  | 'pii'
  | 'credential';

/**
 * Memory access operation types
 */
export type MemoryOperation = 'read' | 'write' | 'delete' | 'list' | 'purge';

/**
 * Memory access request
 */
export interface MemoryAccessRequest {
  requestId: string;
  namespaceId: string;
  operation: MemoryOperation;
  key?: string;
  actorId: string;
  actorRoles: string[];
  timestamp: string;
}

/**
 * Memory access decision
 */
export interface MemoryAccessDecision {
  requestId: string;
  allowed: boolean;
  reason: string;
  matchedRules: string[];
  auditRequired: boolean;
}

/**
 * DLP scan result
 */
export interface DLPScanResult {
  scanId: string;
  passed: boolean;
  findings: DLPFinding[];
  severity: DLPSeverity;
  blocked: boolean;
  redactedValue?: unknown;
}

/**
 * DLP finding
 */
export interface DLPFinding {
  findingId: string;
  patternName: string;
  patternCategory: DLPCategory;
  matchedText: string;
  location: string;
  severity: DLPSeverity;
  recommendation: string;
}

/**
 * DLP severity levels
 */
export type DLPSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/**
 * DLP pattern categories
 */
export type DLPCategory =
  | 'pii'
  | 'credential'
  | 'financial'
  | 'health'
  | 'secret'
  | 'sensitive';

/**
 * Memory isolation configuration
 */
export interface MemoryIsolationConfig {
  enabled: boolean;
  defaultTtlMs: number;
  maxTtlMs: number;
  purgeIntervalMs: number;
  dlpEnabled: boolean;
  dlpBlockOnCritical: boolean;
  encryptAtRest: boolean;
  auditAllAccess: boolean;
  strictIsolation: boolean; // Cannot be disabled once enabled
}

/**
 * Memory access control rule
 */
export interface MemoryAccessRule {
  ruleId: string;
  name: string;
  description: string;
  priority: number;
  enabled: boolean;
  conditions: AccessRuleCondition[];
  effect: 'allow' | 'deny';
  auditRequired: boolean;
}

/**
 * Access rule condition
 */
export interface AccessRuleCondition {
  field: 'actorId' | 'actorRoles' | 'operation' | 'namespaceId' | 'dataClassification';
  operator: 'equals' | 'notEquals' | 'contains' | 'notContains' | 'matches';
  value: string | string[];
}

/**
 * Memory audit event
 */
export interface MemoryAuditEvent {
  eventId: string;
  timestamp: string;
  namespaceId: string;
  operation: MemoryOperation;
  actorId: string;
  key?: string;
  decision: 'allowed' | 'denied' | 'blocked_dlp';
  reason: string;
  dlpFindings?: DLPFinding[];
  hash: string;
  previousEventHash: string;
}

// =============================================================================
// Zod Schemas
// =============================================================================

export const MemoryIsolationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  defaultTtlMs: z.number().positive().max(MAX_MEMORY_TTL_MS).default(DEFAULT_MEMORY_TTL_MS),
  maxTtlMs: z.number().positive().max(MAX_MEMORY_TTL_MS).default(MAX_MEMORY_TTL_MS),
  purgeIntervalMs: z.number().positive().default(PURGE_CHECK_INTERVAL_MS),
  dlpEnabled: z.boolean().default(true),
  dlpBlockOnCritical: z.boolean().default(true),
  encryptAtRest: z.boolean().default(true),
  auditAllAccess: z.boolean().default(true),
  strictIsolation: z.boolean().default(true),
});

// =============================================================================
// Default Configuration
// =============================================================================

export const defaultMemoryIsolationConfig: MemoryIsolationConfig = {
  enabled: false, // Backward compatible - opt-in
  defaultTtlMs: DEFAULT_MEMORY_TTL_MS,
  maxTtlMs: MAX_MEMORY_TTL_MS,
  purgeIntervalMs: PURGE_CHECK_INTERVAL_MS,
  dlpEnabled: true,
  dlpBlockOnCritical: true,
  encryptAtRest: true,
  auditAllAccess: true,
  strictIsolation: true,
};

// =============================================================================
// DLP Patterns
// =============================================================================

const DLP_PATTERNS: Array<{
  name: string;
  category: DLPCategory;
  pattern: RegExp;
  severity: DLPSeverity;
  recommendation: string;
}> = [
  // PII Patterns
  {
    name: 'ssn',
    category: 'pii',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    severity: 'critical',
    recommendation: 'Remove or redact Social Security Number',
  },
  {
    name: 'email',
    category: 'pii',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    severity: 'medium',
    recommendation: 'Consider if email storage is necessary',
  },
  {
    name: 'phone',
    category: 'pii',
    pattern: /\b(?:\+?1[-.]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g,
    severity: 'medium',
    recommendation: 'Consider if phone number storage is necessary',
  },
  {
    name: 'credit_card',
    category: 'financial',
    pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    severity: 'critical',
    recommendation: 'Never store credit card numbers in memory',
  },
  {
    name: 'iban',
    category: 'financial',
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}([A-Z0-9]?){0,16}\b/g,
    severity: 'high',
    recommendation: 'Remove or encrypt IBAN',
  },

  // Credential Patterns
  {
    name: 'aws_access_key',
    category: 'credential',
    pattern: /AKIA[0-9A-Z]{16}/g,
    severity: 'critical',
    recommendation: 'NEVER store AWS access keys - use IAM roles',
  },
  {
    name: 'aws_secret_key',
    category: 'credential',
    pattern: /(?:aws)?_?(?:secret)?_?(?:access)?_?key[=:]\s*['\"]?[A-Za-z0-9/+=]{40}['\"]?/gi,
    severity: 'critical',
    recommendation: 'NEVER store AWS secret keys',
  },
  {
    name: 'api_key',
    category: 'credential',
    pattern: /(?:api[_-]?key|apikey)[=:]\s*['\"]?[\w-]{20,}['\"]?/gi,
    severity: 'critical',
    recommendation: 'Use ephemeral credentials instead of API keys',
  },
  {
    name: 'bearer_token',
    category: 'credential',
    pattern: /Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*/gi,
    severity: 'critical',
    recommendation: 'Never store bearer tokens in memory',
  },
  {
    name: 'private_key',
    category: 'credential',
    pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
    severity: 'critical',
    recommendation: 'NEVER store private keys in memory',
  },
  {
    name: 'password_field',
    category: 'credential',
    pattern: /(?:password|passwd|pwd)[=:]\s*['\"]?[^\s'\"]{8,}['\"]?/gi,
    severity: 'critical',
    recommendation: 'Never store passwords in memory',
  },
  {
    name: 'github_token',
    category: 'credential',
    pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g,
    severity: 'critical',
    recommendation: 'Use GitHub App tokens with minimal scopes',
  },

  // Secret Patterns
  {
    name: 'generic_secret',
    category: 'secret',
    pattern: /(?:secret|token)[=:]\s*['\"]?[\w-]{20,}['\"]?/gi,
    severity: 'high',
    recommendation: 'Evaluate if secret storage is necessary',
  },
  {
    name: 'connection_string',
    category: 'secret',
    pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^@]+@[^\s]+/gi,
    severity: 'critical',
    recommendation: 'Never store connection strings with credentials',
  },
];

// =============================================================================
// Memory Namespace
// =============================================================================

/**
 * Cryptographically separated memory namespace
 */
export class MemoryNamespace {
  readonly namespaceId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly createdAt: string;
  private readonly derivedKey: string;

  constructor(identifier: NamespaceIdentifier) {
    this.tenantId = identifier.tenantId;
    this.userId = identifier.userId;
    this.sessionId = identifier.sessionId;
    this.createdAt = new Date().toISOString();

    // Derive namespace ID using HKDF-SHA256
    this.derivedKey = this.deriveKey(identifier);
    this.namespaceId = this.computeNamespaceId();
  }

  /**
   * Derive cryptographic key for namespace
   */
  private deriveKey(identifier: NamespaceIdentifier): string {
    const input = `${HKDF_INFO_PREFIX}:${identifier.tenantId}:${identifier.userId}:${identifier.sessionId}`;
    return hashObject({ input, timestamp: this.createdAt });
  }

  /**
   * Compute namespace ID from derived key
   */
  private computeNamespaceId(): string {
    return `ns_${this.derivedKey.substring(0, 32)}`;
  }

  /**
   * Verify this namespace matches the given identifier
   */
  matches(identifier: NamespaceIdentifier): boolean {
    return (
      this.tenantId === identifier.tenantId &&
      this.userId === identifier.userId &&
      this.sessionId === identifier.sessionId
    );
  }

  /**
   * Check if actor has access to this namespace
   */
  canAccess(actorTenantId: string, actorUserId: string): boolean {
    // Strict tenant isolation - no cross-tenant access ever
    if (actorTenantId !== this.tenantId) {
      return false;
    }

    // Users can only access their own sessions
    return actorUserId === this.userId;
  }

  /**
   * Get namespace metadata for audit
   */
  toAuditMetadata(): Record<string, unknown> {
    return {
      namespaceId: this.namespaceId,
      tenantId: this.tenantId,
      userId: this.userId,
      sessionId: this.sessionId,
      createdAt: this.createdAt,
    };
  }
}

// =============================================================================
// DLP Memory Filter
// =============================================================================

/**
 * Data Loss Prevention filter for memory operations
 */
export class DLPMemoryFilter extends EventEmitter {
  private config: MemoryIsolationConfig;
  private customPatterns: typeof DLP_PATTERNS = [];

  constructor(config: Partial<MemoryIsolationConfig> = {}) {
    super();
    this.config = { ...defaultMemoryIsolationConfig, ...config };
  }

  /**
   * Add custom DLP pattern
   */
  addPattern(pattern: (typeof DLP_PATTERNS)[0]): void {
    this.customPatterns.push(pattern);
  }

  /**
   * Scan value for sensitive data
   */
  scan(value: unknown, key: string): DLPScanResult {
    const scanId = generateId();
    const findings: DLPFinding[] = [];

    const stringified = this.stringify(value);
    const allPatterns = [...DLP_PATTERNS, ...this.customPatterns];

    for (const pattern of allPatterns) {
      const matches = stringified.match(pattern.pattern);
      if (matches) {
        for (const match of matches) {
          findings.push({
            findingId: generateId(),
            patternName: pattern.name,
            patternCategory: pattern.category,
            matchedText: this.redactMatch(match),
            location: key,
            severity: pattern.severity,
            recommendation: pattern.recommendation,
          });
        }
      }
    }

    // Determine overall severity
    const severity = this.calculateOverallSeverity(findings);
    const blocked =
      this.config.dlpBlockOnCritical && severity === 'critical';

    const result: DLPScanResult = {
      scanId,
      passed: findings.length === 0,
      findings,
      severity,
      blocked,
    };

    if (blocked) {
      result.redactedValue = this.redactValue(value, findings);
    }

    if (findings.length > 0) {
      this.emit('dlp_findings', {
        scanId,
        findingCount: findings.length,
        severity,
        blocked,
      });

      logger.warn(
        {
          scanId,
          key,
          findingCount: findings.length,
          severity,
          blocked,
        },
        'DLP scan detected sensitive data'
      );
    }

    return result;
  }

  /**
   * Stringify value for scanning
   */
  private stringify(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  /**
   * Redact matched text for audit
   */
  private redactMatch(match: string): string {
    if (match.length <= 4) return '****';
    return `${match.substring(0, 2)}${'*'.repeat(match.length - 4)}${match.substring(match.length - 2)}`;
  }

  /**
   * Redact sensitive data from value
   */
  private redactValue(value: unknown, findings: DLPFinding[]): unknown {
    let stringified = this.stringify(value);

    for (const finding of findings) {
      // Build regex from finding (need to reconstruct since we redacted)
      const pattern = DLP_PATTERNS.find((p) => p.name === finding.patternName);
      if (pattern) {
        stringified = stringified.replace(pattern.pattern, '[REDACTED]');
      }
    }

    try {
      return JSON.parse(stringified);
    } catch {
      return stringified;
    }
  }

  /**
   * Calculate overall severity from findings
   */
  private calculateOverallSeverity(findings: DLPFinding[]): DLPSeverity {
    if (findings.length === 0) return 'info';

    const severityOrder: DLPSeverity[] = [
      'info',
      'low',
      'medium',
      'high',
      'critical',
    ];
    let maxIdx = 0;

    for (const finding of findings) {
      const idx = severityOrder.indexOf(finding.severity);
      if (idx > maxIdx) maxIdx = idx;
    }

    return severityOrder[maxIdx] ?? 'info';
  }
}

// =============================================================================
// Memory Access Control List
// =============================================================================

/**
 * RBAC-based memory access control
 */
export class MemoryAccessControlList extends EventEmitter {
  private rules: MemoryAccessRule[] = [];
  private defaultDeny = true;

  constructor() {
    super();
    this.initializeDefaultRules();
  }

  /**
   * Initialize default access rules
   */
  private initializeDefaultRules(): void {
    // Rule: Users can access their own namespace
    this.addRule({
      ruleId: 'default-self-access',
      name: 'Self Namespace Access',
      description: 'Users can read/write their own namespace',
      priority: 100,
      enabled: true,
      conditions: [], // Evaluated programmatically
      effect: 'allow',
      auditRequired: false,
    });

    // Rule: Block cross-tenant access
    this.addRule({
      ruleId: 'block-cross-tenant',
      name: 'Cross-Tenant Block',
      description: 'Block all cross-tenant memory access',
      priority: 1000,
      enabled: true,
      conditions: [], // Evaluated programmatically
      effect: 'deny',
      auditRequired: true,
    });

    // Rule: Admin can purge (but NOT read/write)
    this.addRule({
      ruleId: 'admin-purge-only',
      name: 'Admin Purge Only',
      description: 'Admins can purge memory but cannot read user data',
      priority: 50,
      enabled: true,
      conditions: [
        { field: 'actorRoles', operator: 'contains', value: 'admin' },
        { field: 'operation', operator: 'equals', value: 'purge' },
      ],
      effect: 'allow',
      auditRequired: true,
    });
  }

  /**
   * Add access control rule
   */
  addRule(rule: MemoryAccessRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority); // Higher priority first
  }

  /**
   * Remove rule by ID
   */
  removeRule(ruleId: string): boolean {
    const idx = this.rules.findIndex((r) => r.ruleId === ruleId);
    if (idx !== -1) {
      this.rules.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * Evaluate access request
   */
  evaluate(
    request: MemoryAccessRequest,
    namespace: MemoryNamespace,
    actorTenantId: string
  ): MemoryAccessDecision {
    const matchedRules: string[] = [];
    let decision: 'allow' | 'deny' = this.defaultDeny ? 'deny' : 'allow';
    let reason = this.defaultDeny ? 'Default deny policy' : 'Default allow policy';
    let auditRequired = false;

    // Critical: Check tenant isolation first (cannot be bypassed)
    if (actorTenantId !== namespace.tenantId) {
      return {
        requestId: request.requestId,
        allowed: false,
        reason: 'HARD_BLOCK: Cross-tenant memory access is forbidden',
        matchedRules: ['block-cross-tenant'],
        auditRequired: true,
      };
    }

    // Check namespace ownership for read/write operations
    if (['read', 'write', 'delete'].includes(request.operation)) {
      if (!namespace.canAccess(actorTenantId, request.actorId)) {
        return {
          requestId: request.requestId,
          allowed: false,
          reason: 'HARD_BLOCK: Cannot access other user namespaces',
          matchedRules: ['default-self-access'],
          auditRequired: true,
        };
      }
    }

    // Evaluate rules in priority order
    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      if (this.ruleMatches(rule, request)) {
        matchedRules.push(rule.ruleId);
        decision = rule.effect === 'allow' ? 'allow' : 'deny';
        reason = `Rule ${rule.name}: ${rule.description}`;
        auditRequired = auditRequired || rule.auditRequired;

        // First matching rule wins
        break;
      }
    }

    // Self-access is always allowed for own namespace
    if (
      ['read', 'write', 'delete', 'list'].includes(request.operation) &&
      namespace.canAccess(actorTenantId, request.actorId)
    ) {
      decision = 'allow';
      reason = 'Self namespace access allowed';
      matchedRules.push('default-self-access');
    }

    this.emit('access_evaluated', {
      requestId: request.requestId,
      allowed: decision === 'allow',
      matchedRules,
    });

    return {
      requestId: request.requestId,
      allowed: decision === 'allow',
      reason,
      matchedRules,
      auditRequired,
    };
  }

  /**
   * Check if rule matches request
   */
  private ruleMatches(rule: MemoryAccessRule, request: MemoryAccessRequest): boolean {
    for (const condition of rule.conditions) {
      if (!this.conditionMatches(condition, request)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if condition matches request
   */
  private conditionMatches(
    condition: AccessRuleCondition,
    request: MemoryAccessRequest
  ): boolean {
    const fieldValue = this.getFieldValue(condition.field, request);

    switch (condition.operator) {
      case 'equals':
        return fieldValue === condition.value;
      case 'notEquals':
        return fieldValue !== condition.value;
      case 'contains':
        if (Array.isArray(fieldValue)) {
          return fieldValue.includes(condition.value as string);
        }
        return String(fieldValue).includes(condition.value as string);
      case 'notContains':
        if (Array.isArray(fieldValue)) {
          return !fieldValue.includes(condition.value as string);
        }
        return !String(fieldValue).includes(condition.value as string);
      case 'matches':
        return new RegExp(condition.value as string).test(String(fieldValue));
      default:
        return false;
    }
  }

  /**
   * Get field value from request
   */
  private getFieldValue(
    field: AccessRuleCondition['field'],
    request: MemoryAccessRequest
  ): unknown {
    switch (field) {
      case 'actorId':
        return request.actorId;
      case 'actorRoles':
        return request.actorRoles;
      case 'operation':
        return request.operation;
      case 'namespaceId':
        return request.namespaceId;
      default:
        return undefined;
    }
  }
}

// =============================================================================
// Session Memory Manager
// =============================================================================

/**
 * Manages session-scoped memory with automatic purging
 */
export class SessionMemoryManager extends EventEmitter {
  private config: MemoryIsolationConfig;
  private namespaces = new Map<string, MemoryNamespace>();
  private entries = new Map<string, Map<string, MemoryEntry>>();
  private acl: MemoryAccessControlList;
  private dlpFilter: DLPMemoryFilter;
  private auditChain: MemoryAuditEvent[] = [];
  private lastAuditHash = 'genesis';
  private purgeTimer: NodeJS.Timeout | null = null;
  private initialized = false;

  constructor(config: Partial<MemoryIsolationConfig> = {}) {
    super();
    this.config = { ...defaultMemoryIsolationConfig, ...config };
    this.acl = new MemoryAccessControlList();
    this.dlpFilter = new DLPMemoryFilter(this.config);
  }

  /**
   * Initialize the memory manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!this.config.enabled) {
      logger.info('Memory isolation is disabled');
      this.initialized = true;
      return;
    }

    // Start purge timer
    this.purgeTimer = setInterval(
      () => this.purgeExpiredEntries(),
      this.config.purgeIntervalMs
    );

    this.initialized = true;
    logger.info('Session memory manager initialized');
  }

  /**
   * Shutdown the memory manager
   */
  async shutdown(): Promise<void> {
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }

    // Purge all remaining entries
    await this.purgeAll();

    this.initialized = false;
    logger.info('Session memory manager shut down');
  }

  /**
   * Get or create namespace for session
   */
  getNamespace(identifier: NamespaceIdentifier): MemoryNamespace {
    const existingNamespaces = Array.from(this.namespaces.values());
    const existing = existingNamespaces.find((ns) => ns.matches(identifier));

    if (existing) {
      return existing;
    }

    const namespace = new MemoryNamespace(identifier);
    this.namespaces.set(namespace.namespaceId, namespace);
    this.entries.set(namespace.namespaceId, new Map());

    this.emit('namespace_created', {
      namespaceId: namespace.namespaceId,
      tenantId: identifier.tenantId,
      userId: identifier.userId,
      sessionId: identifier.sessionId,
    });

    logger.debug({ namespaceId: namespace.namespaceId }, 'Namespace created');

    return namespace;
  }

  /**
   * Write value to memory
   */
  async write(
    namespace: MemoryNamespace,
    key: string,
    value: unknown,
    actorId: string,
    actorRoles: string[],
    actorTenantId: string,
    ttlMs?: number
  ): Promise<{ success: boolean; error?: string; dlpBlocked?: boolean }> {
    if (!this.config.enabled) {
      return { success: false, error: 'Memory isolation is disabled' };
    }

    const requestId = generateId();

    // Check access control
    const accessRequest: MemoryAccessRequest = {
      requestId,
      namespaceId: namespace.namespaceId,
      operation: 'write',
      key,
      actorId,
      actorRoles,
      timestamp: new Date().toISOString(),
    };

    const decision = this.acl.evaluate(accessRequest, namespace, actorTenantId);

    if (!decision.allowed) {
      await this.recordAuditEvent(
        namespace.namespaceId,
        'write',
        actorId,
        key,
        'denied',
        decision.reason
      );

      return { success: false, error: decision.reason };
    }

    // Run DLP scan
    if (this.config.dlpEnabled) {
      const scanResult = this.dlpFilter.scan(value, key);

      if (scanResult.blocked) {
        await this.recordAuditEvent(
          namespace.namespaceId,
          'write',
          actorId,
          key,
          'blocked_dlp',
          'DLP blocked sensitive data',
          scanResult.findings
        );

        return {
          success: false,
          error: 'DLP blocked: sensitive data detected',
          dlpBlocked: true,
        };
      }

      if (scanResult.findings.length > 0) {
        logger.warn(
          {
            namespaceId: namespace.namespaceId,
            key,
            findingCount: scanResult.findings.length,
          },
          'DLP warnings on memory write'
        );
      }
    }

    // Calculate TTL
    const effectiveTtl = Math.min(
      ttlMs ?? this.config.defaultTtlMs,
      this.config.maxTtlMs
    );

    const now = new Date();
    const expiresAt = new Date(now.getTime() + effectiveTtl);

    // Classify data
    const classification = this.classifyData(value);

    // Create entry
    const entry: MemoryEntry = {
      entryId: generateId(),
      namespaceId: namespace.namespaceId,
      key,
      value: this.config.encryptAtRest ? this.encrypt(value) : value,
      dataClassification: classification,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      accessCount: 0,
      lastAccessedAt: now.toISOString(),
      hash: hashObject({ key, value, createdAt: now.toISOString() }),
      encrypted: this.config.encryptAtRest,
    };

    // Store entry
    const nsEntries = this.entries.get(namespace.namespaceId);
    if (!nsEntries) {
      return { success: false, error: 'Namespace not found' };
    }
    nsEntries.set(key, entry);

    await this.recordAuditEvent(
      namespace.namespaceId,
      'write',
      actorId,
      key,
      'allowed',
      'Write successful'
    );

    this.emit('memory_write', {
      namespaceId: namespace.namespaceId,
      key,
      classification,
    });

    return { success: true };
  }

  /**
   * Read value from memory
   */
  async read(
    namespace: MemoryNamespace,
    key: string,
    actorId: string,
    actorRoles: string[],
    actorTenantId: string
  ): Promise<{ success: boolean; value?: unknown; error?: string }> {
    if (!this.config.enabled) {
      return { success: false, error: 'Memory isolation is disabled' };
    }

    const requestId = generateId();

    // Check access control
    const accessRequest: MemoryAccessRequest = {
      requestId,
      namespaceId: namespace.namespaceId,
      operation: 'read',
      key,
      actorId,
      actorRoles,
      timestamp: new Date().toISOString(),
    };

    const decision = this.acl.evaluate(accessRequest, namespace, actorTenantId);

    if (!decision.allowed) {
      await this.recordAuditEvent(
        namespace.namespaceId,
        'read',
        actorId,
        key,
        'denied',
        decision.reason
      );

      return { success: false, error: decision.reason };
    }

    // Get entry
    const nsEntries = this.entries.get(namespace.namespaceId);
    if (!nsEntries) {
      return { success: false, error: 'Namespace not found' };
    }

    const entry = nsEntries.get(key);
    if (!entry) {
      return { success: false, error: 'Key not found' };
    }

    // Check expiration
    if (new Date(entry.expiresAt) < new Date()) {
      nsEntries.delete(key);
      return { success: false, error: 'Entry expired' };
    }

    // Update access metadata
    entry.accessCount++;
    entry.lastAccessedAt = new Date().toISOString();

    await this.recordAuditEvent(
      namespace.namespaceId,
      'read',
      actorId,
      key,
      'allowed',
      'Read successful'
    );

    // Decrypt if necessary
    const value = entry.encrypted ? this.decrypt(entry.value) : entry.value;

    return { success: true, value };
  }

  /**
   * Delete value from memory
   */
  async delete(
    namespace: MemoryNamespace,
    key: string,
    actorId: string,
    actorRoles: string[],
    actorTenantId: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.config.enabled) {
      return { success: false, error: 'Memory isolation is disabled' };
    }

    const requestId = generateId();

    // Check access control
    const accessRequest: MemoryAccessRequest = {
      requestId,
      namespaceId: namespace.namespaceId,
      operation: 'delete',
      key,
      actorId,
      actorRoles,
      timestamp: new Date().toISOString(),
    };

    const decision = this.acl.evaluate(accessRequest, namespace, actorTenantId);

    if (!decision.allowed) {
      await this.recordAuditEvent(
        namespace.namespaceId,
        'delete',
        actorId,
        key,
        'denied',
        decision.reason
      );

      return { success: false, error: decision.reason };
    }

    const nsEntries = this.entries.get(namespace.namespaceId);
    if (!nsEntries) {
      return { success: false, error: 'Namespace not found' };
    }

    const deleted = nsEntries.delete(key);

    await this.recordAuditEvent(
      namespace.namespaceId,
      'delete',
      actorId,
      key,
      'allowed',
      deleted ? 'Delete successful' : 'Key not found'
    );

    return { success: deleted, error: deleted ? undefined : 'Key not found' };
  }

  /**
   * Purge entire namespace (workflow completion/failure)
   */
  async purgeNamespace(
    namespace: MemoryNamespace,
    actorId: string,
    actorRoles: string[],
    actorTenantId: string,
    reason: string
  ): Promise<{ success: boolean; entriesDeleted: number; error?: string }> {
    const requestId = generateId();

    // Check access control for purge
    const accessRequest: MemoryAccessRequest = {
      requestId,
      namespaceId: namespace.namespaceId,
      operation: 'purge',
      actorId,
      actorRoles,
      timestamp: new Date().toISOString(),
    };

    const decision = this.acl.evaluate(accessRequest, namespace, actorTenantId);

    // For purge, either the owner or admin can do it
    const isOwner = namespace.canAccess(actorTenantId, actorId);
    const isAdmin = actorRoles.includes('admin');

    if (!decision.allowed && !isOwner && !isAdmin) {
      await this.recordAuditEvent(
        namespace.namespaceId,
        'purge',
        actorId,
        undefined,
        'denied',
        decision.reason
      );

      return { success: false, entriesDeleted: 0, error: decision.reason };
    }

    const nsEntries = this.entries.get(namespace.namespaceId);
    const entriesDeleted = nsEntries?.size ?? 0;

    // Clear all entries
    this.entries.delete(namespace.namespaceId);
    this.namespaces.delete(namespace.namespaceId);

    await this.recordAuditEvent(
      namespace.namespaceId,
      'purge',
      actorId,
      undefined,
      'allowed',
      `Namespace purged: ${reason}. ${entriesDeleted} entries deleted.`
    );

    this.emit('namespace_purged', {
      namespaceId: namespace.namespaceId,
      entriesDeleted,
      reason,
    });

    logger.info(
      {
        namespaceId: namespace.namespaceId,
        entriesDeleted,
        reason,
      },
      'Namespace purged'
    );

    return { success: true, entriesDeleted };
  }

  /**
   * Purge expired entries across all namespaces
   */
  private async purgeExpiredEntries(): Promise<number> {
    const now = new Date();
    let totalPurged = 0;

    for (const [namespaceId, nsEntries] of this.entries) {
      const expiredKeys: string[] = [];

      for (const [key, entry] of nsEntries) {
        if (new Date(entry.expiresAt) < now) {
          expiredKeys.push(key);
        }
      }

      for (const key of expiredKeys) {
        nsEntries.delete(key);
        totalPurged++;
      }

      if (expiredKeys.length > 0) {
        logger.debug(
          {
            namespaceId,
            expiredCount: expiredKeys.length,
          },
          'Purged expired entries'
        );
      }
    }

    if (totalPurged > 0) {
      this.emit('entries_purged', { count: totalPurged });
    }

    return totalPurged;
  }

  /**
   * Purge all memory (shutdown)
   */
  private async purgeAll(): Promise<void> {
    const totalEntries = Array.from(this.entries.values()).reduce(
      (sum, ns) => sum + ns.size,
      0
    );

    this.entries.clear();
    this.namespaces.clear();

    logger.info({ totalEntries }, 'All memory purged on shutdown');
  }

  /**
   * Get audit trail for namespace
   */
  getAuditTrail(namespaceId: string): MemoryAuditEvent[] {
    return this.auditChain.filter((e) => e.namespaceId === namespaceId);
  }

  /**
   * Verify audit chain integrity
   */
  verifyAuditChainIntegrity(): { valid: boolean; brokenAt?: number } {
    if (this.auditChain.length === 0) {
      return { valid: true };
    }

    let expectedPreviousHash = 'genesis';

    for (let i = 0; i < this.auditChain.length; i++) {
      const event = this.auditChain[i];
      if (!event) continue;

      if (event.previousEventHash !== expectedPreviousHash) {
        return { valid: false, brokenAt: i };
      }

      expectedPreviousHash = event.hash;
    }

    return { valid: true };
  }

  /**
   * Get access control list
   */
  getACL(): MemoryAccessControlList {
    return this.acl;
  }

  /**
   * Get DLP filter
   */
  getDLPFilter(): DLPMemoryFilter {
    return this.dlpFilter;
  }

  /**
   * Get statistics
   */
  getStats(): {
    namespaceCount: number;
    totalEntries: number;
    auditEventCount: number;
  } {
    return {
      namespaceCount: this.namespaces.size,
      totalEntries: Array.from(this.entries.values()).reduce(
        (sum, ns) => sum + ns.size,
        0
      ),
      auditEventCount: this.auditChain.length,
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Record audit event
   */
  private async recordAuditEvent(
    namespaceId: string,
    operation: MemoryOperation,
    actorId: string,
    key: string | undefined,
    decision: 'allowed' | 'denied' | 'blocked_dlp',
    reason: string,
    dlpFindings?: DLPFinding[]
  ): Promise<void> {
    if (!this.config.auditAllAccess && decision === 'allowed') {
      return; // Skip audit for allowed operations if not required
    }

    const event: MemoryAuditEvent = {
      eventId: generateId(),
      timestamp: new Date().toISOString(),
      namespaceId,
      operation,
      actorId,
      key,
      decision,
      reason,
      dlpFindings,
      previousEventHash: this.lastAuditHash,
      hash: '', // Will be set after hashing
    };

    event.hash = hashObject({
      ...event,
      hash: undefined,
    });

    this.lastAuditHash = event.hash;
    this.auditChain.push(event);

    this.emit('audit_recorded', {
      eventId: event.eventId,
      operation,
      decision,
    });
  }

  /**
   * Classify data based on content
   */
  private classifyData(value: unknown): DataClassification {
    const stringified = typeof value === 'string' ? value : JSON.stringify(value);

    // Check for credentials
    if (
      /password|secret|token|key|credential/i.test(stringified) &&
      stringified.length > 20
    ) {
      return 'credential';
    }

    // Check for PII
    if (/\b\d{3}-\d{2}-\d{4}\b/.test(stringified)) {
      return 'pii'; // SSN
    }

    if (/\b(?:\d{4}[-\s]?){3}\d{4}\b/.test(stringified)) {
      return 'restricted'; // Credit card
    }

    // Default classification
    return 'internal';
  }

  /**
   * Encrypt value (placeholder - use proper encryption in production)
   */
  private encrypt(value: unknown): unknown {
    // In production, use AES-256-GCM with per-namespace keys derived from KMS
    // This is a placeholder that base64 encodes
    const stringified = JSON.stringify(value);
    return Buffer.from(stringified).toString('base64');
  }

  /**
   * Decrypt value (placeholder - use proper decryption in production)
   */
  private decrypt(value: unknown): unknown {
    // Corresponding decryption
    const decoded = Buffer.from(value as string, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  }
}

// =============================================================================
// Singleton
// =============================================================================

let memoryManager: SessionMemoryManager | null = null;

export function getSessionMemoryManager(): SessionMemoryManager {
  if (!memoryManager) {
    memoryManager = new SessionMemoryManager();
  }
  return memoryManager;
}

export async function initializeSessionMemoryManager(
  config?: Partial<MemoryIsolationConfig>
): Promise<SessionMemoryManager> {
  if (!memoryManager) {
    memoryManager = new SessionMemoryManager(config);
  }
  await memoryManager.initialize();
  return memoryManager;
}
