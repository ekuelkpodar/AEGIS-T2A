/**
 * AEGIS-T2A Budget & Rate Limiting Service
 *
 * Tracks per-agent and per-tenant resource usage, enforces budget limits,
 * and implements rate limiting for API calls.
 */

import { EventEmitter } from 'events';
import {
  BudgetConfig,
  BudgetPeriod,
  BudgetUsage,
  CostEstimate,
  CostBreakdown,
  RateLimitConfig,
  RateStatus,
  BudgetExceededError,
  RateLimitError,
} from '../types';

/**
 * Budget record for tracking usage
 */
interface BudgetRecord {
  config: BudgetConfig;
  usage: number;
  history: { timestamp: Date; units: number; action: string }[];
}

/**
 * Rate limit record
 */
interface RateLimitRecord {
  config: RateLimitConfig;
  windowStart: Date;
  count: number;
  burst: number;
}

/**
 * Cost estimation rules
 */
interface CostRule {
  tool: string;
  action: string | RegExp;
  baseCost: number;
  parameterMultipliers?: {
    field: string;
    multiplier: number;
    maxValue?: number;
  }[];
}

/**
 * Budget Service
 */
export class BudgetService extends EventEmitter {
  private budgets: Map<string, BudgetRecord> = new Map();
  private rateLimits: Map<string, RateLimitRecord> = new Map();
  private costRules: CostRule[] = [];
  private warningCallbacks: Map<string, (budget: BudgetUsage) => void> = new Map();

  constructor() {
    super();

    // Initialize default cost rules
    this.initializeDefaultCostRules();

    // Reset periods periodically
    setInterval(() => this.checkPeriodResets(), 60000);

    // Clean up old rate limit windows
    setInterval(() => this.cleanupRateLimits(), 30000);
  }

  /**
   * Initialize default cost estimation rules
   */
  private initializeDefaultCostRules(): void {
    this.costRules = [
      // LLM operations
      {
        tool: 'llm',
        action: /^(complete|generate|chat)/,
        baseCost: 10,
        parameterMultipliers: [
          { field: 'max_tokens', multiplier: 0.01, maxValue: 4000 },
        ],
      },
      // Cloud operations
      {
        tool: 'aws',
        action: /^(create|launch|start)/,
        baseCost: 50,
      },
      {
        tool: 'aws',
        action: /^(delete|terminate|stop)/,
        baseCost: 5,
      },
      {
        tool: 'aws',
        action: /^(describe|list|get)/,
        baseCost: 1,
      },
      // Database operations
      {
        tool: 'database',
        action: /^(insert|update|delete)/,
        baseCost: 2,
        parameterMultipliers: [{ field: 'rows', multiplier: 0.1 }],
      },
      {
        tool: 'database',
        action: /^(select|query)/,
        baseCost: 1,
      },
      // Default for unknown operations
      {
        tool: '*',
        action: /.*/,
        baseCost: 1,
      },
    ];
  }

  // ===========================================================================
  // Budget Management
  // ===========================================================================

  /**
   * Create or update a budget configuration
   */
  createBudget(config: Omit<BudgetConfig, 'current_usage' | 'created_at' | 'updated_at'>): BudgetConfig {
    const now = new Date();
    const { periodStart, periodEnd } = this.calculatePeriodBounds(config.period, now);

    const fullConfig: BudgetConfig = {
      ...config,
      current_usage: 0,
      period_start: periodStart,
      period_end: periodEnd,
      created_at: now,
      updated_at: now,
    };

    const key = this.getBudgetKey(config.tenant_id, config.agent_id);
    this.budgets.set(key, {
      config: fullConfig,
      usage: 0,
      history: [],
    });

    this.emit('budget_created', { budget_id: config.id, key });

    return fullConfig;
  }

  /**
   * Get budget usage for an agent/tenant
   */
  getBudgetUsage(tenantId: string, agentId: string | null): BudgetUsage | null {
    const key = this.getBudgetKey(tenantId, agentId);
    const record = this.budgets.get(key);

    if (!record) {
      // Check for tenant-wide budget
      const tenantKey = this.getBudgetKey(tenantId, null);
      const tenantRecord = this.budgets.get(tenantKey);
      if (!tenantRecord) return null;
      return this.recordToUsage(tenantRecord);
    }

    return this.recordToUsage(record);
  }

  /**
   * Check if budget allows an action
   */
  async checkBudget(
    agentId: string,
    tenantId: string
  ): Promise<{
    allowed: boolean;
    usage?: { current: number; limit: number; remaining: number };
  }> {
    // Check agent-specific budget first
    let record = this.budgets.get(this.getBudgetKey(tenantId, agentId));

    // Fall back to tenant-wide budget
    if (!record) {
      record = this.budgets.get(this.getBudgetKey(tenantId, null));
    }

    if (!record) {
      // No budget configured - allow
      return { allowed: true };
    }

    const config = record.config;
    const usage = {
      current: record.usage,
      limit: config.limit_units,
      remaining: config.limit_units - record.usage,
    };

    // Check warning threshold
    const usagePercent = (record.usage / config.limit_units) * 100;
    if (usagePercent >= config.warning_threshold && usagePercent < 100) {
      this.emit('budget_warning', {
        budget_id: config.id,
        usage_percent: usagePercent,
        tenant_id: tenantId,
        agent_id: agentId,
      });
    }

    // Check hard limit
    if (config.hard_limit && record.usage >= config.limit_units) {
      this.emit('budget_exceeded', {
        budget_id: config.id,
        current: record.usage,
        limit: config.limit_units,
        tenant_id: tenantId,
        agent_id: agentId,
      });
      return { allowed: false, usage };
    }

    return { allowed: true, usage };
  }

  /**
   * Record budget usage
   */
  async recordUsage(
    agentId: string,
    tenantId: string,
    units: number,
    action?: string
  ): Promise<void> {
    // Record to agent-specific budget
    const agentKey = this.getBudgetKey(tenantId, agentId);
    const agentRecord = this.budgets.get(agentKey);
    if (agentRecord) {
      agentRecord.usage += units;
      agentRecord.config.current_usage = agentRecord.usage;
      agentRecord.config.updated_at = new Date();
      agentRecord.history.push({
        timestamp: new Date(),
        units,
        action: action || 'unknown',
      });

      // Trim history
      if (agentRecord.history.length > 1000) {
        agentRecord.history = agentRecord.history.slice(-500);
      }
    }

    // Record to tenant-wide budget
    const tenantKey = this.getBudgetKey(tenantId, null);
    const tenantRecord = this.budgets.get(tenantKey);
    if (tenantRecord) {
      tenantRecord.usage += units;
      tenantRecord.config.current_usage = tenantRecord.usage;
      tenantRecord.config.updated_at = new Date();
    }

    this.emit('usage_recorded', {
      agent_id: agentId,
      tenant_id: tenantId,
      units,
    });
  }

  /**
   * Estimate cost for an action
   */
  estimateCost(
    tool: string,
    action: string,
    parameters: Record<string, unknown>
  ): CostEstimate {
    const breakdown: CostBreakdown[] = [];
    let totalCost = 0;

    // Find matching cost rule
    const rule = this.costRules.find((r) => {
      const toolMatch = r.tool === '*' || r.tool === tool;
      const actionMatch =
        r.action instanceof RegExp ? r.action.test(action) : r.action === action;
      return toolMatch && actionMatch;
    });

    if (rule) {
      // Base cost
      breakdown.push({
        resource_type: 'base',
        quantity: 1,
        unit_cost: rule.baseCost,
        total: rule.baseCost,
      });
      totalCost += rule.baseCost;

      // Parameter multipliers
      if (rule.parameterMultipliers) {
        for (const mult of rule.parameterMultipliers) {
          const value = this.getNestedValue(parameters, mult.field);
          if (typeof value === 'number') {
            const effectiveValue = mult.maxValue
              ? Math.min(value, mult.maxValue)
              : value;
            const cost = effectiveValue * mult.multiplier;
            breakdown.push({
              resource_type: mult.field,
              quantity: effectiveValue,
              unit_cost: mult.multiplier,
              total: cost,
            });
            totalCost += cost;
          }
        }
      }
    } else {
      // Default cost
      breakdown.push({
        resource_type: 'default',
        quantity: 1,
        unit_cost: 1,
        total: 1,
      });
      totalCost = 1;
    }

    return {
      estimated_units: Math.ceil(totalCost),
      breakdown,
      confidence: rule && rule.tool !== '*' ? 'high' : 'low',
    };
  }

  /**
   * Add a custom cost rule
   */
  addCostRule(rule: CostRule): void {
    // Insert before the catch-all rule
    const catchAllIndex = this.costRules.findIndex((r) => r.tool === '*');
    if (catchAllIndex >= 0) {
      this.costRules.splice(catchAllIndex, 0, rule);
    } else {
      this.costRules.push(rule);
    }
  }

  // ===========================================================================
  // Rate Limiting
  // ===========================================================================

  /**
   * Create a rate limit configuration
   */
  createRateLimit(config: RateLimitConfig): void {
    const key = this.getRateLimitKey(
      config.tenant_id,
      config.agent_id,
      config.tool,
      config.action
    );

    this.rateLimits.set(key, {
      config,
      windowStart: new Date(),
      count: 0,
      burst: 0,
    });

    this.emit('rate_limit_created', { key, config });
  }

  /**
   * Check rate limit for an action
   */
  async checkRate(
    agentId: string,
    tool: string,
    action: string
  ): Promise<{
    allowed: boolean;
    remaining: number;
    reset_at: Date;
  }> {
    // Find applicable rate limit (most specific first)
    const record = this.findRateLimitRecord(agentId, tool, action);

    if (!record || !record.config.enabled) {
      return {
        allowed: true,
        remaining: Infinity,
        reset_at: new Date(Date.now() + 3600000),
      };
    }

    const config = record.config;
    const now = new Date();

    // Check if we need to reset the window
    const windowAge = now.getTime() - record.windowStart.getTime();
    if (windowAge > config.window_seconds * 1000) {
      record.windowStart = now;
      record.count = 0;
      record.burst = 0;
    }

    const resetAt = new Date(
      record.windowStart.getTime() + config.window_seconds * 1000
    );

    // Check if rate limited
    const effectiveLimit = config.requests_per_window + config.burst_allowance;
    const remaining = effectiveLimit - record.count;

    if (record.count >= effectiveLimit) {
      this.emit('rate_limit_exceeded', {
        agent_id: agentId,
        tool,
        action,
        limit: effectiveLimit,
        reset_at: resetAt,
      });
      return { allowed: false, remaining: 0, reset_at: resetAt };
    }

    // Check burst warning
    if (record.count >= config.requests_per_window) {
      this.emit('rate_limit_warning', {
        agent_id: agentId,
        tool,
        action,
        using_burst: true,
        remaining: remaining,
      });
    }

    return { allowed: true, remaining, reset_at: resetAt };
  }

  /**
   * Record a rate-limited request
   */
  async recordRequest(agentId: string, tool: string, action: string): Promise<void> {
    const record = this.findRateLimitRecord(agentId, tool, action);
    if (record) {
      record.count++;
      if (record.count > record.config.requests_per_window) {
        record.burst++;
      }
    }
  }

  /**
   * Get current rate status
   */
  getRateStatus(agentId: string, tool: string, action: string): RateStatus | null {
    const record = this.findRateLimitRecord(agentId, tool, action);
    if (!record) return null;

    const config = record.config;
    const effectiveLimit = config.requests_per_window + config.burst_allowance;
    const resetAt = new Date(
      record.windowStart.getTime() + config.window_seconds * 1000
    );

    return {
      remaining: effectiveLimit - record.count,
      limit: effectiveLimit,
      reset_at: resetAt,
      current_count: record.count,
      rate_limited: record.count >= effectiveLimit,
    };
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  /**
   * Generate budget key
   */
  private getBudgetKey(tenantId: string, agentId: string | null): string {
    return agentId ? `${tenantId}:${agentId}` : `${tenantId}:*`;
  }

  /**
   * Generate rate limit key
   */
  private getRateLimitKey(
    tenantId: string,
    agentId: string | null,
    tool: string | null,
    action: string | null
  ): string {
    return [tenantId, agentId || '*', tool || '*', action || '*'].join(':');
  }

  /**
   * Find applicable rate limit record
   */
  private findRateLimitRecord(
    agentId: string,
    tool: string,
    action: string
  ): RateLimitRecord | undefined {
    // Try most specific to least specific
    const keys = [
      this.getRateLimitKey('*', agentId, tool, action),
      this.getRateLimitKey('*', agentId, tool, null),
      this.getRateLimitKey('*', agentId, null, null),
      this.getRateLimitKey('*', null, tool, action),
      this.getRateLimitKey('*', null, tool, null),
      this.getRateLimitKey('*', null, null, null),
    ];

    for (const key of keys) {
      const record = this.rateLimits.get(key);
      if (record) return record;
    }

    return undefined;
  }

  /**
   * Convert budget record to usage info
   */
  private recordToUsage(record: BudgetRecord): BudgetUsage {
    const config = record.config;
    const usagePercent = (record.usage / config.limit_units) * 100;

    return {
      budget_id: config.id,
      current_usage: record.usage,
      limit: config.limit_units,
      usage_percentage: usagePercent,
      remaining: config.limit_units - record.usage,
      period_start: config.period_start,
      period_end: config.period_end,
      warning_triggered: usagePercent >= config.warning_threshold,
      limit_exceeded: record.usage >= config.limit_units,
    };
  }

  /**
   * Calculate period bounds
   */
  private calculatePeriodBounds(
    period: BudgetPeriod,
    now: Date
  ): { periodStart: Date; periodEnd: Date } {
    const start = new Date(now);
    const end = new Date(now);

    switch (period) {
      case 'hourly':
        start.setMinutes(0, 0, 0);
        end.setHours(end.getHours() + 1);
        end.setMinutes(0, 0, 0);
        break;
      case 'daily':
        start.setHours(0, 0, 0, 0);
        end.setDate(end.getDate() + 1);
        end.setHours(0, 0, 0, 0);
        break;
      case 'weekly':
        const dayOfWeek = start.getDay();
        start.setDate(start.getDate() - dayOfWeek);
        start.setHours(0, 0, 0, 0);
        end.setDate(start.getDate() + 7);
        end.setHours(0, 0, 0, 0);
        break;
      case 'monthly':
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
        end.setMonth(end.getMonth() + 1);
        end.setDate(1);
        end.setHours(0, 0, 0, 0);
        break;
    }

    return { periodStart: start, periodEnd: end };
  }

  /**
   * Check and reset expired periods
   */
  private checkPeriodResets(): void {
    const now = new Date();

    for (const [key, record] of this.budgets) {
      if (now >= record.config.period_end) {
        // Reset usage
        record.usage = 0;
        record.config.current_usage = 0;
        record.history = [];

        // Calculate new period bounds
        const { periodStart, periodEnd } = this.calculatePeriodBounds(
          record.config.period,
          now
        );
        record.config.period_start = periodStart;
        record.config.period_end = periodEnd;
        record.config.updated_at = now;

        this.emit('budget_period_reset', { budget_id: record.config.id, key });
      }
    }
  }

  /**
   * Cleanup old rate limit windows
   */
  private cleanupRateLimits(): void {
    const now = new Date();

    for (const [key, record] of this.rateLimits) {
      const windowAge = now.getTime() - record.windowStart.getTime();
      const maxAge = record.config.window_seconds * 1000 * 10; // Keep for 10 windows

      if (windowAge > maxAge && record.count === 0) {
        // Reset instead of delete to preserve config
        record.windowStart = now;
        record.count = 0;
        record.burst = 0;
      }
    }
  }

  /**
   * Get nested value from object
   */
  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  /**
   * List all budgets for a tenant
   */
  listBudgets(tenantId: string): BudgetConfig[] {
    const configs: BudgetConfig[] = [];
    for (const record of this.budgets.values()) {
      if (record.config.tenant_id === tenantId) {
        configs.push(record.config);
      }
    }
    return configs;
  }

  /**
   * List all rate limits
   */
  listRateLimits(tenantId?: string): RateLimitConfig[] {
    const configs: RateLimitConfig[] = [];
    for (const record of this.rateLimits.values()) {
      if (!tenantId || record.config.tenant_id === tenantId) {
        configs.push(record.config);
      }
    }
    return configs;
  }

  /**
   * Get usage history for an agent
   */
  getUsageHistory(
    tenantId: string,
    agentId: string,
    limit: number = 100
  ): { timestamp: Date; units: number; action: string }[] {
    const key = this.getBudgetKey(tenantId, agentId);
    const record = this.budgets.get(key);
    if (!record) return [];
    return record.history.slice(-limit);
  }

  /**
   * Get service statistics
   */
  getStats(): {
    totalBudgets: number;
    totalRateLimits: number;
    activeBudgets: number;
    budgetsOverWarning: number;
    budgetsExceeded: number;
  } {
    let activeBudgets = 0;
    let budgetsOverWarning = 0;
    let budgetsExceeded = 0;

    for (const record of this.budgets.values()) {
      if (record.usage > 0) activeBudgets++;
      const usagePercent = (record.usage / record.config.limit_units) * 100;
      if (usagePercent >= record.config.warning_threshold) budgetsOverWarning++;
      if (record.usage >= record.config.limit_units) budgetsExceeded++;
    }

    return {
      totalBudgets: this.budgets.size,
      totalRateLimits: this.rateLimits.size,
      activeBudgets,
      budgetsOverWarning,
      budgetsExceeded,
    };
  }
}

export default BudgetService;
