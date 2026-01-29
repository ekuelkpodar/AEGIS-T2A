/**
 * AEGIS-T2A Policy Engine
 *
 * Evaluates intents and actions against policy rules.
 */

import { TypedIntent, PolicyRule, RiskLevel, PlanStep } from '../core/types.js';
import { getDatabase, queryAll, queryOne, execute, transaction } from '../core/database.js';
import { componentLogger, logPolicyViolation } from '../core/logger.js';
import { generateId } from '../core/ids.js';

const logger = componentLogger('policy-engine');

// =============================================================================
// Types
// =============================================================================

export interface PolicyEvaluationResult {
  allowed: boolean;
  requiresApproval: boolean;
  violations: PolicyViolation[];
  warnings: string[];
  appliedRules: string[];
  effectiveRiskLevel: RiskLevel;
}

export interface PolicyViolation {
  ruleId: string;
  ruleName: string;
  message: string;
  severity: 'warning' | 'error' | 'critical';
}

export interface PolicyContext {
  userId: string;
  userRoles?: string[];
  environment?: 'development' | 'staging' | 'production';
  previousActions?: string[];
  currentTime?: Date;
}

// =============================================================================
// Default Policy Rules
// =============================================================================

const DEFAULT_RULES: Omit<PolicyRule, 'createdAt' | 'updatedAt'>[] = [
  {
    ruleId: 'deny-destructive-without-approval',
    name: 'Require approval for destructive actions',
    description: 'All destructive actions must be approved by a human',
    condition: 'intent.riskLevel === "destructive"',
    action: 'require_approval',
    riskLevel: 'destructive',
    priority: 100,
    enabled: true,
  },
  {
    ruleId: 'deny-high-risk-without-approval',
    name: 'Require approval for high-risk actions',
    description: 'High-risk actions require human approval',
    condition: 'intent.riskLevel === "high"',
    action: 'require_approval',
    riskLevel: 'high',
    priority: 90,
    enabled: true,
  },
  {
    ruleId: 'deny-production-without-approval',
    name: 'Require approval for production changes',
    description: 'Any changes to production require approval',
    condition: 'context.environment === "production" && intent.sideEffect === true',
    action: 'require_approval',
    priority: 85,
    enabled: true,
  },
  {
    ruleId: 'deny-excessive-cost',
    name: 'Deny excessive cost operations',
    description: 'Deny operations that exceed cost threshold',
    condition: 'intent.budget.limit > 1000',
    action: 'deny',
    priority: 80,
    enabled: true,
  },
  {
    ruleId: 'require-medium-risk-approval',
    name: 'Require approval for medium-risk with side effects',
    description: 'Medium-risk operations with side effects need approval',
    condition: 'intent.riskLevel === "medium" && intent.sideEffect === true',
    action: 'require_approval',
    riskLevel: 'medium',
    priority: 70,
    enabled: true,
  },
  {
    ruleId: 'allow-low-risk-read',
    name: 'Allow low-risk read operations',
    description: 'Low-risk read-only operations are allowed',
    condition: 'intent.riskLevel === "low" && intent.sideEffect === false',
    action: 'allow',
    riskLevel: 'low',
    priority: 10,
    enabled: true,
  },
  {
    ruleId: 'deny-restricted-sensitivity-auto',
    name: 'Deny auto-execution of restricted operations',
    description: 'Restricted sensitivity operations cannot be auto-executed',
    condition: 'intent.sensitivity === "restricted"',
    action: 'require_approval',
    priority: 95,
    enabled: true,
  },
];

// =============================================================================
// Policy Engine
// =============================================================================

export class PolicyEngine {
  private rules: PolicyRule[] = [];
  private initialized = false;

  /**
   * Initialize the policy engine and load rules
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.loadRules();
    this.initialized = true;

    logger.info({ ruleCount: this.rules.length }, 'Policy engine initialized');
  }

  /**
   * Load rules from database, insert defaults if none exist
   */
  private async loadRules(): Promise<void> {
    const existingRules = queryAll<PolicyRule>(
      'SELECT * FROM policy_rules WHERE enabled = 1 ORDER BY priority DESC'
    );

    if (existingRules.length === 0) {
      logger.info('No policy rules found, inserting defaults');
      await this.insertDefaultRules();
      this.rules = queryAll<PolicyRule>(
        'SELECT * FROM policy_rules WHERE enabled = 1 ORDER BY priority DESC'
      );
    } else {
      this.rules = existingRules;
    }
  }

  /**
   * Insert default policy rules
   */
  private async insertDefaultRules(): Promise<void> {
    const now = new Date().toISOString();

    transaction(() => {
      for (const rule of DEFAULT_RULES) {
        execute(
          `INSERT OR IGNORE INTO policy_rules
           (rule_id, name, description, condition, action, risk_level, priority, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            rule.ruleId,
            rule.name,
            rule.description,
            rule.condition,
            rule.action,
            rule.riskLevel ?? null,
            rule.priority,
            rule.enabled ? 1 : 0,
            now,
            now,
          ]
        );
      }
    });
  }

  /**
   * Evaluate an intent against all policy rules
   */
  evaluateIntent(intent: TypedIntent, context: PolicyContext): PolicyEvaluationResult {
    if (!this.initialized) {
      throw new Error('Policy engine not initialized');
    }

    const result: PolicyEvaluationResult = {
      allowed: true,
      requiresApproval: false,
      violations: [],
      warnings: [],
      appliedRules: [],
      effectiveRiskLevel: intent.riskLevel,
    };

    // Sort rules by priority (highest first)
    const sortedRules = [...this.rules].sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
      if (!rule.enabled) continue;

      const matches = this.evaluateCondition(rule.condition, intent, context);

      if (matches) {
        result.appliedRules.push(rule.ruleId);

        switch (rule.action) {
          case 'deny':
            result.allowed = false;
            result.violations.push({
              ruleId: rule.ruleId,
              ruleName: rule.name,
              message: rule.description,
              severity: 'critical',
            });
            logPolicyViolation(rule.ruleId, {
              intentId: intent.intentId,
              userId: intent.userId,
              action: rule.action,
            });
            break;

          case 'require_approval':
            result.requiresApproval = true;
            if (rule.riskLevel && this.isHigherRisk(rule.riskLevel, result.effectiveRiskLevel)) {
              result.effectiveRiskLevel = rule.riskLevel;
            }
            break;

          case 'allow':
            // Allow rules don't change the default allow state
            break;
        }
      }
    }

    // If intent requires approval based on its properties
    if (intent.approvalRequired && !result.requiresApproval) {
      result.requiresApproval = true;
    }

    logger.info(
      {
        intentId: intent.intentId,
        allowed: result.allowed,
        requiresApproval: result.requiresApproval,
        appliedRules: result.appliedRules,
        violations: result.violations.length,
      },
      'Policy evaluation completed'
    );

    return result;
  }

  /**
   * Evaluate a policy condition against intent and context
   */
  private evaluateCondition(
    condition: string,
    intent: TypedIntent,
    context: PolicyContext
  ): boolean {
    try {
      // Create a safe evaluation context
      const evalContext = {
        intent: {
          riskLevel: intent.riskLevel,
          sensitivity: intent.sensitivity,
          sideEffect: intent.sideEffect,
          actionType: intent.actionType,
          budget: intent.budget,
          confidence: intent.confidence,
          requiredCapabilities: intent.requiredCapabilities,
        },
        context: {
          environment: context.environment ?? 'development',
          userId: context.userId,
          userRoles: context.userRoles ?? [],
        },
      };

      // Simple condition evaluation using Function constructor
      // In production, use a proper expression evaluator for safety
      const fn = new Function('intent', 'context', `return ${condition}`);
      return fn(evalContext.intent, evalContext.context) === true;
    } catch (error) {
      logger.warn({ condition, error }, 'Failed to evaluate policy condition');
      return false;
    }
  }

  /**
   * Compare risk levels
   */
  private isHigherRisk(a: RiskLevel, b: RiskLevel): boolean {
    const levels: Record<RiskLevel, number> = {
      low: 1,
      medium: 2,
      high: 3,
      destructive: 4,
    };
    return levels[a] > levels[b];
  }

  /**
   * Evaluate a plan step against policies
   */
  evaluateStep(step: PlanStep, context: PolicyContext): PolicyEvaluationResult {
    // Convert step to intent-like structure for evaluation
    const pseudoIntent: TypedIntent = {
      intentId: step.stepId,
      userId: context.userId,
      timestamp: new Date().toISOString(),
      nlText: step.description,
      actionType: step.action,
      riskLevel: step.riskLevel,
      sensitivity: 'confidential',
      budget: { currency: 'USD', limit: step.estimatedCost, spent: 0 },
      requiredCapabilities: step.requiredCapabilities,
      sideEffect: step.sideEffect,
      idempotencyKey: step.idempotencyKey,
      policyStatus: 'pending',
      approvalRequired: step.approvalRequired,
      confidence: 1.0,
    };

    return this.evaluateIntent(pseudoIntent, context);
  }

  /**
   * Add a new policy rule
   */
  addRule(rule: Omit<PolicyRule, 'createdAt' | 'updatedAt'>): void {
    const now = new Date().toISOString();

    execute(
      `INSERT INTO policy_rules
       (rule_id, name, description, condition, action, risk_level, priority, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rule.ruleId,
        rule.name,
        rule.description,
        rule.condition,
        rule.action,
        rule.riskLevel ?? null,
        rule.priority,
        rule.enabled ? 1 : 0,
        now,
        now,
      ]
    );

    // Reload rules
    this.rules = queryAll<PolicyRule>(
      'SELECT * FROM policy_rules WHERE enabled = 1 ORDER BY priority DESC'
    );

    logger.info({ ruleId: rule.ruleId }, 'Policy rule added');
  }

  /**
   * Update a policy rule
   */
  updateRule(ruleId: string, updates: Partial<PolicyRule>): void {
    const now = new Date().toISOString();
    const existing = queryOne<PolicyRule>('SELECT * FROM policy_rules WHERE rule_id = ?', [ruleId]);

    if (!existing) {
      throw new Error(`Rule not found: ${ruleId}`);
    }

    execute(
      `UPDATE policy_rules SET
       name = ?, description = ?, condition = ?, action = ?,
       risk_level = ?, priority = ?, enabled = ?, updated_at = ?
       WHERE rule_id = ?`,
      [
        updates.name ?? existing.name,
        updates.description ?? existing.description,
        updates.condition ?? existing.condition,
        updates.action ?? existing.action,
        updates.riskLevel ?? existing.riskLevel,
        updates.priority ?? existing.priority,
        (updates.enabled ?? existing.enabled) ? 1 : 0,
        now,
        ruleId,
      ]
    );

    // Reload rules
    this.rules = queryAll<PolicyRule>(
      'SELECT * FROM policy_rules WHERE enabled = 1 ORDER BY priority DESC'
    );

    logger.info({ ruleId }, 'Policy rule updated');
  }

  /**
   * Get all policy rules
   */
  getRules(): PolicyRule[] {
    return [...this.rules];
  }

  /**
   * Validate a policy condition syntax
   */
  validateCondition(condition: string): { valid: boolean; error?: string } {
    try {
      new Function('intent', 'context', `return ${condition}`);
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Invalid condition syntax',
      };
    }
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let policyEngine: PolicyEngine | null = null;

export function getPolicyEngine(): PolicyEngine {
  if (!policyEngine) {
    policyEngine = new PolicyEngine();
  }
  return policyEngine;
}

export async function initializePolicyEngine(): Promise<PolicyEngine> {
  const engine = getPolicyEngine();
  await engine.initialize();
  return engine;
}
