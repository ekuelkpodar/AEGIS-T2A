/**
 * AEGIS-T2A Policy Engine
 *
 * Integrates with OPA (Open Policy Agent) for policy evaluation.
 * Supports hot-reload of policies, caching, and fallback behavior.
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import {
  PolicyRequest,
  PolicyResult,
  PolicyDecision,
  PolicyBundle,
  PolicyRule,
  PolicyCondition,
  ConditionOperator,
  PolicyEngineConfig,
  GovernanceError,
} from '../types';

/**
 * OPA decision response
 */
interface OPADecisionResponse {
  result?: {
    allow: boolean;
    decision: PolicyDecision;
    reason: string;
    matched_rule?: string;
    modifications?: Record<string, unknown>;
    require_approval?: boolean;
    approval_config?: Record<string, unknown>;
  };
  decision_id?: string;
}

/**
 * Policy cache entry
 */
interface CacheEntry {
  result: PolicyResult;
  timestamp: Date;
  key: string;
}

/**
 * Policy Engine for evaluating agent actions
 */
export class PolicyEngine extends EventEmitter {
  private config: PolicyEngineConfig;
  private bundles: Map<string, PolicyBundle> = new Map();
  private cache: Map<string, CacheEntry> = new Map();
  private policyVersion: string = '0.0.0';
  private lastReload: Date = new Date();
  private reloadTimer?: NodeJS.Timeout;
  private opaAvailable: boolean = false;

  constructor(config: PolicyEngineConfig) {
    super();
    this.config = config;

    // Start hot-reload if enabled
    if (config.hot_reload) {
      this.startHotReload();
    }

    // Clean cache periodically
    setInterval(() => this.cleanCache(), 30000);
  }

  /**
   * Initialize the policy engine
   */
  async initialize(): Promise<void> {
    // Check OPA availability
    await this.checkOPAHealth();

    // Load initial policies
    await this.loadPolicies();

    this.emit('initialized', { version: this.policyVersion });
  }

  /**
   * Check if OPA server is available
   */
  private async checkOPAHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.opa_url}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      this.opaAvailable = response.ok;
      return this.opaAvailable;
    } catch {
      this.opaAvailable = false;
      this.emit('opa_unavailable', { url: this.config.opa_url });
      return false;
    }
  }

  /**
   * Evaluate a policy request
   */
  async evaluate(request: PolicyRequest): Promise<PolicyResult> {
    const startTime = Date.now();

    // Check cache first
    const cacheKey = this.generateCacheKey(request);
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return {
        ...cached,
        evaluation_ms: Date.now() - startTime,
      };
    }

    let result: PolicyResult;

    // Try OPA evaluation first
    if (this.opaAvailable) {
      try {
        result = await this.evaluateWithOPA(request);
      } catch (error) {
        this.emit('opa_error', { error, request });
        // Fall back to local evaluation
        result = await this.evaluateLocally(request);
      }
    } else {
      // Use local evaluation
      result = await this.evaluateLocally(request);
    }

    result.evaluation_ms = Date.now() - startTime;
    result.policy_version = this.policyVersion;

    // Cache the result
    this.setCache(cacheKey, result);

    // Emit evaluation event
    this.emit('evaluation', {
      request,
      result,
      evaluation_ms: result.evaluation_ms,
    });

    return result;
  }

  /**
   * Evaluate using OPA server
   */
  private async evaluateWithOPA(request: PolicyRequest): Promise<PolicyResult> {
    const input = {
      agent: {
        id: request.agent.agent_id,
        tenant_id: request.agent.tenant_id,
        role: request.agent.role,
        scopes: request.agent.scopes,
      },
      action: {
        tool: request.tool,
        action: request.action,
        parameters: request.parameters,
      },
      context: {
        timestamp: request.context.timestamp.toISOString(),
        environment: request.context.environment,
        correlation_id: request.context.correlation_id,
        budget_usage: request.context.budget_usage,
        rate_status: request.context.rate_status,
      },
    };

    const response = await fetch(
      `${this.config.opa_url}/v1/data/aegis/authz/decision`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!response.ok) {
      throw new GovernanceError(
        `OPA evaluation failed: ${response.status}`,
        'OPA_ERROR',
        500
      );
    }

    const data = (await response.json()) as OPADecisionResponse;

    if (!data.result) {
      // Default deny if no result
      return {
        decision: 'DENY',
        reason: 'No policy decision returned',
        policy_version: this.policyVersion,
        evaluation_ms: 0,
      };
    }

    return {
      decision: data.result.decision || (data.result.allow ? 'ALLOW' : 'DENY'),
      reason: data.result.reason || 'Policy evaluation completed',
      matched_policy: data.result.matched_rule,
      policy_version: this.policyVersion,
      evaluation_ms: 0,
      modified_parameters: data.result.modifications,
    };
  }

  /**
   * Evaluate using local policy rules
   */
  private async evaluateLocally(request: PolicyRequest): Promise<PolicyResult> {
    // Get applicable bundles (tenant-specific first, then global)
    const applicableBundles = this.getApplicableBundles(request.agent.tenant_id);

    // Collect all rules and sort by priority
    const allRules: { rule: PolicyRule; bundle: PolicyBundle }[] = [];
    for (const bundle of applicableBundles) {
      for (const rule of bundle.rules) {
        if (rule.enabled) {
          allRules.push({ rule, bundle });
        }
      }
    }
    allRules.sort((a, b) => a.rule.priority - b.rule.priority);

    // Evaluate rules in order
    for (const { rule, bundle } of allRules) {
      const matches = this.evaluateConditions(rule.conditions, request);
      if (matches) {
        const result: PolicyResult = {
          decision: rule.effect.decision,
          reason: this.formatReason(rule.effect.reason_template, request, rule),
          matched_policy: rule.id,
          policy_version: this.policyVersion,
          evaluation_ms: 0,
        };

        // Handle modifications
        if (rule.effect.decision === 'MODIFY' && rule.modifications) {
          result.modified_parameters = this.applyModifications(
            request.parameters,
            rule.modifications
          );
        }

        return result;
      }
    }

    // No rules matched, use default decision
    const defaultBundle = applicableBundles[0];
    return {
      decision: defaultBundle?.default_decision || 'DENY',
      reason: 'No matching policy rules found',
      policy_version: this.policyVersion,
      evaluation_ms: 0,
    };
  }

  /**
   * Evaluate conditions against a request
   */
  private evaluateConditions(
    conditions: PolicyCondition[],
    request: PolicyRequest
  ): boolean {
    for (const condition of conditions) {
      const value = this.getFieldValue(condition.field, request);
      let result = this.evaluateCondition(condition.operator, value, condition.value);
      if (condition.negate) result = !result;
      if (!result) return false;
    }
    return true;
  }

  /**
   * Get field value from request using dot notation
   */
  private getFieldValue(field: string, request: PolicyRequest): unknown {
    const parts = field.split('.');
    let current: unknown = {
      agent: request.agent,
      tool: request.tool,
      action: request.action,
      parameters: request.parameters,
      context: request.context,
    };

    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  /**
   * Evaluate a single condition
   */
  private evaluateCondition(
    operator: ConditionOperator,
    actual: unknown,
    expected: unknown
  ): boolean {
    switch (operator) {
      case 'equals':
        return actual === expected;
      case 'not_equals':
        return actual !== expected;
      case 'contains':
        if (typeof actual === 'string' && typeof expected === 'string') {
          return actual.includes(expected);
        }
        if (Array.isArray(actual)) {
          return actual.includes(expected);
        }
        return false;
      case 'not_contains':
        return !this.evaluateCondition('contains', actual, expected);
      case 'matches':
        if (typeof actual === 'string' && typeof expected === 'string') {
          return new RegExp(expected).test(actual);
        }
        return false;
      case 'in':
        if (Array.isArray(expected)) {
          return expected.includes(actual);
        }
        return false;
      case 'not_in':
        return !this.evaluateCondition('in', actual, expected);
      case 'greater_than':
        return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
      case 'less_than':
        return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
      case 'greater_than_or_equal':
        return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
      case 'less_than_or_equal':
        return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
      case 'exists':
        return actual !== undefined && actual !== null;
      case 'not_exists':
        return actual === undefined || actual === null;
      default:
        return false;
    }
  }

  /**
   * Apply parameter modifications
   */
  private applyModifications(
    parameters: Record<string, unknown>,
    modifications: PolicyRule['modifications']
  ): Record<string, unknown> {
    const result = JSON.parse(JSON.stringify(parameters));

    for (const mod of modifications || []) {
      const path = mod.path.split('.');
      let current = result;

      for (let i = 0; i < path.length - 1; i++) {
        if (current[path[i]] === undefined) break;
        current = current[path[i]] as Record<string, unknown>;
      }

      const lastKey = path[path.length - 1];
      if (current[lastKey] === undefined) continue;

      switch (mod.type) {
        case 'redact':
          current[lastKey] = '[REDACTED]';
          break;
        case 'mask':
          if (typeof current[lastKey] === 'string') {
            const value = current[lastKey] as string;
            const pattern = mod.mask_pattern || '****';
            current[lastKey] = value.substring(0, 2) + pattern + value.substring(value.length - 2);
          }
          break;
        case 'replace':
          current[lastKey] = mod.value;
          break;
        case 'remove':
          delete current[lastKey];
          break;
        case 'transform':
          // Transform would call a registered function
          break;
      }
    }

    return result;
  }

  /**
   * Format reason template with request context
   */
  private formatReason(
    template: string,
    request: PolicyRequest,
    rule: PolicyRule
  ): string {
    return template
      .replace('{agent_id}', request.agent.agent_id)
      .replace('{tenant_id}', request.agent.tenant_id)
      .replace('{role}', request.agent.role)
      .replace('{tool}', request.tool)
      .replace('{action}', request.action)
      .replace('{rule_id}', rule.id)
      .replace('{rule_name}', rule.name);
  }

  /**
   * Get applicable bundles for a tenant
   */
  private getApplicableBundles(tenantId: string): PolicyBundle[] {
    const result: PolicyBundle[] = [];

    // Tenant-specific bundles first
    for (const bundle of this.bundles.values()) {
      if (bundle.tenant_id === tenantId) {
        result.push(bundle);
      }
    }

    // Global bundles (tenant_id is null)
    for (const bundle of this.bundles.values()) {
      if (bundle.tenant_id === null) {
        result.push(bundle);
      }
    }

    return result;
  }

  /**
   * Load policies from bundle path
   */
  async loadPolicies(): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const yaml = await import('js-yaml');

      const bundlePath = this.config.bundle_path;

      // Check if path exists
      try {
        await fs.access(bundlePath);
      } catch {
        // Create default bundle if path doesn't exist
        this.createDefaultBundle();
        return;
      }

      const stats = await fs.stat(bundlePath);

      if (stats.isDirectory()) {
        // Load all YAML files from directory
        const files = await fs.readdir(bundlePath);
        for (const file of files) {
          if (file.endsWith('.yaml') || file.endsWith('.yml')) {
            const filePath = path.join(bundlePath, file);
            const content = await fs.readFile(filePath, 'utf-8');
            const bundle = yaml.load(content) as PolicyBundle;
            if (bundle && bundle.id) {
              this.bundles.set(bundle.id, bundle);
            }
          }
        }
      } else {
        // Load single file
        const content = await fs.readFile(bundlePath, 'utf-8');
        const bundle = yaml.load(content) as PolicyBundle;
        if (bundle && bundle.id) {
          this.bundles.set(bundle.id, bundle);
        }
      }

      // Calculate new version hash
      this.policyVersion = this.calculateVersionHash();
      this.lastReload = new Date();

      this.emit('policies_loaded', {
        bundle_count: this.bundles.size,
        version: this.policyVersion,
      });
    } catch (error) {
      this.emit('load_error', { error });
      // Create default bundle on error
      this.createDefaultBundle();
    }
  }

  /**
   * Create a default deny-all bundle
   */
  private createDefaultBundle(): void {
    const defaultBundle: PolicyBundle = {
      id: 'default',
      version: '1.0.0',
      name: 'Default Policy Bundle',
      description: 'Default deny-all policy',
      tenant_id: null,
      rules: [
        {
          id: 'allow-readonly',
          name: 'Allow Read-Only Operations',
          description: 'Allow read-only operations for all authenticated agents',
          priority: 100,
          enabled: true,
          conditions: [
            { field: 'action', operator: 'matches', value: '^(get|list|read|describe|status)' },
          ],
          effect: {
            decision: 'ALLOW',
            reason: 'Read-only operation allowed',
          },
        },
        {
          id: 'require-approval-destructive',
          name: 'Require Approval for Destructive Operations',
          description: 'Require human approval for delete/destroy operations',
          priority: 50,
          enabled: true,
          conditions: [
            { field: 'action', operator: 'matches', value: '^(delete|destroy|remove|drop)' },
          ],
          effect: {
            decision: 'AWAIT_APPROVAL',
            reason: 'Destructive operation requires approval',
          },
          approval_config: {
            required_approvers: ['tenant_admin', 'operator'],
            min_approvals: 1,
            timeout_seconds: 3600,
            notify_channels: ['slack'],
            auto_deny_on_timeout: true,
          },
        },
      ],
      default_decision: 'DENY',
      metadata: {
        created_at: new Date(),
        updated_at: new Date(),
        created_by: 'system',
        checksum: '',
        tags: ['default'],
      },
    };

    this.bundles.set(defaultBundle.id, defaultBundle);
    this.policyVersion = this.calculateVersionHash();
  }

  /**
   * Calculate version hash from all bundles
   */
  private calculateVersionHash(): string {
    const content = JSON.stringify(Array.from(this.bundles.values()));
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  /**
   * Start hot-reload timer
   */
  private startHotReload(): void {
    this.reloadTimer = setInterval(async () => {
      try {
        await this.loadPolicies();
      } catch (error) {
        this.emit('reload_error', { error });
      }
    }, this.config.reload_interval_seconds * 1000);
  }

  /**
   * Stop hot-reload timer
   */
  stopHotReload(): void {
    if (this.reloadTimer) {
      clearInterval(this.reloadTimer);
      this.reloadTimer = undefined;
    }
  }

  /**
   * Generate cache key for request
   */
  private generateCacheKey(request: PolicyRequest): string {
    const keyData = {
      agent_id: request.agent.agent_id,
      tenant_id: request.agent.tenant_id,
      role: request.agent.role,
      tool: request.tool,
      action: request.action,
      params_hash: crypto
        .createHash('md5')
        .update(JSON.stringify(request.parameters))
        .digest('hex'),
    };
    return crypto.createHash('md5').update(JSON.stringify(keyData)).digest('hex');
  }

  /**
   * Get result from cache
   */
  private getFromCache(key: string): PolicyResult | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    const age = Date.now() - entry.timestamp.getTime();
    if (age > this.config.cache_ttl_seconds * 1000) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.result;
  }

  /**
   * Set result in cache
   */
  private setCache(key: string, result: PolicyResult): void {
    this.cache.set(key, {
      result,
      timestamp: new Date(),
      key,
    });
  }

  /**
   * Clean expired cache entries
   */
  private cleanCache(): void {
    const now = Date.now();
    const ttl = this.config.cache_ttl_seconds * 1000;

    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp.getTime() > ttl) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Add or update a policy bundle
   */
  addBundle(bundle: PolicyBundle): void {
    bundle.metadata.updated_at = new Date();
    this.bundles.set(bundle.id, bundle);
    this.policyVersion = this.calculateVersionHash();
    this.clearCache();
    this.emit('bundle_updated', { bundle_id: bundle.id });
  }

  /**
   * Remove a policy bundle
   */
  removeBundle(bundleId: string): boolean {
    const removed = this.bundles.delete(bundleId);
    if (removed) {
      this.policyVersion = this.calculateVersionHash();
      this.clearCache();
      this.emit('bundle_removed', { bundle_id: bundleId });
    }
    return removed;
  }

  /**
   * Get a policy bundle
   */
  getBundle(bundleId: string): PolicyBundle | undefined {
    return this.bundles.get(bundleId);
  }

  /**
   * List all policy bundles
   */
  listBundles(): PolicyBundle[] {
    return Array.from(this.bundles.values());
  }

  /**
   * Clear the policy cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get current policy version
   */
  getVersion(): string {
    return this.policyVersion;
  }

  /**
   * Get engine statistics
   */
  getStats(): {
    bundles: number;
    rules: number;
    cacheSize: number;
    opaAvailable: boolean;
    lastReload: Date;
    version: string;
  } {
    let totalRules = 0;
    for (const bundle of this.bundles.values()) {
      totalRules += bundle.rules.length;
    }

    return {
      bundles: this.bundles.size,
      rules: totalRules,
      cacheSize: this.cache.size,
      opaAvailable: this.opaAvailable,
      lastReload: this.lastReload,
      version: this.policyVersion,
    };
  }

  /**
   * Shutdown the policy engine
   */
  async shutdown(): Promise<void> {
    this.stopHotReload();
    this.clearCache();
    this.emit('shutdown');
  }
}

export default PolicyEngine;
