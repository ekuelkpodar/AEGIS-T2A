/**
 * Policy Conflict Detection
 *
 * Identifies conflicting, redundant, or contradictory policy rules before deployment.
 * Prevents policy deadlocks and unexpected behavior.
 *
 * Features:
 * - Conflict detection (deny vs allow)
 * - Redundancy analysis
 * - Shadow rule detection
 * - Priority ordering validation
 * - Dead code elimination
 *
 * References:
 * - Firewall rule conflict detection
 * - IAM policy conflict analysis
 * - XACML policy conflicts
 */

import { componentLogger } from '../core/logger.js';
import type { PolicyRule } from '../core/types.js';

const logger = componentLogger('policy-conflict-detector');

// =============================================================================
// Types
// =============================================================================

export interface PolicyConflict {
  conflictId: string;
  type: ConflictType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  affectedRules: string[];
  description: string;
  recommendation: string;
  autoResolvable: boolean;
}

export type ConflictType =
  | 'contradictory' // deny vs allow for same condition
  | 'redundant' // duplicate rules
  | 'shadowed' // lower priority rule never reached
  | 'overlapping' // partial overlap in conditions
  | 'priority_conflict' // incorrect priority ordering
  | 'unreachable'; // dead code

export interface ConflictAnalysisResult {
  totalRules: number;
  conflicts: PolicyConflict[];
  conflictCount: number;
  criticalConflicts: number;
  resolvableConflicts: number;
  healthScore: number; // 0-100
}

export interface ConflictResolution {
  conflictId: string;
  resolution: 'merge' | 'delete' | 'reorder' | 'modify' | 'manual';
  changes: Array<{
    ruleId: string;
    action: 'delete' | 'update' | 'reorder';
    newValue?: Partial<PolicyRule>;
  }>;
}

// =============================================================================
// Policy Conflict Detector
// =============================================================================

export class PolicyConflictDetector {
  /**
   * Analyze all rules for conflicts
   */
  analyze(rules: PolicyRule[]): ConflictAnalysisResult {
    const conflicts: PolicyConflict[] = [];

    // Sort rules by priority
    const sortedRules = [...rules].sort((a, b) => b.priority - a.priority);

    // Detect contradictory rules
    conflicts.push(...this.detectContradictory(sortedRules));

    // Detect redundant rules
    conflicts.push(...this.detectRedundant(sortedRules));

    // Detect shadowed rules
    conflicts.push(...this.detectShadowed(sortedRules));

    // Detect overlapping rules
    conflicts.push(...this.detectOverlapping(sortedRules));

    // Detect priority conflicts
    conflicts.push(...this.detectPriorityConflicts(sortedRules));

    // Detect unreachable rules
    conflicts.push(...this.detectUnreachable(sortedRules));

    const criticalConflicts = conflicts.filter(c => c.severity === 'critical').length;
    const resolvableConflicts = conflicts.filter(c => c.autoResolvable).length;

    // Calculate health score (0-100)
    const healthScore = this.calculateHealthScore(rules.length, conflicts);

    logger.info(
      {
        totalRules: rules.length,
        conflictCount: conflicts.length,
        criticalConflicts,
        healthScore,
      },
      'Policy conflict analysis completed'
    );

    return {
      totalRules: rules.length,
      conflicts,
      conflictCount: conflicts.length,
      criticalConflicts,
      resolvableConflicts,
      healthScore,
    };
  }

  /**
   * Detect contradictory rules (deny vs allow for same condition)
   */
  private detectContradictory(rules: PolicyRule[]): PolicyConflict[] {
    const conflicts: PolicyConflict[] = [];

    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        const rule1 = rules[i];
        const rule2 = rules[j];

        // Check if conditions are similar but actions are opposite
        if (
          this.areSimilarConditions(rule1.condition, rule2.condition) &&
          this.areOppositeActions(rule1.action, rule2.action)
        ) {
          conflicts.push({
            conflictId: `contradictory_${rule1.ruleId}_${rule2.ruleId}`,
            type: 'contradictory',
            severity: 'critical',
            affectedRules: [rule1.ruleId, rule2.ruleId],
            description: `Rule "${rule1.name}" (${rule1.action}) conflicts with "${rule2.name}" (${rule2.action}) for similar conditions`,
            recommendation: `Review and merge rules, or adjust conditions to be mutually exclusive. Higher priority rule "${rule1.name}" will take precedence.`,
            autoResolvable: false,
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Detect redundant rules (exact duplicates)
   */
  private detectRedundant(rules: PolicyRule[]): PolicyConflict[] {
    const conflicts: PolicyConflict[] = [];
    const seen = new Map<string, PolicyRule>();

    for (const rule of rules) {
      const signature = this.getRuleSignature(rule);
      const existing = seen.get(signature);

      if (existing) {
        conflicts.push({
          conflictId: `redundant_${existing.ruleId}_${rule.ruleId}`,
          type: 'redundant',
          severity: 'medium',
          affectedRules: [existing.ruleId, rule.ruleId],
          description: `Rule "${rule.name}" is redundant with "${existing.name}"`,
          recommendation: `Delete one of the duplicate rules. Keep "${existing.name}" (higher priority).`,
          autoResolvable: true,
        });
      } else {
        seen.set(signature, rule);
      }
    }

    return conflicts;
  }

  /**
   * Detect shadowed rules (never reached due to higher priority)
   */
  private detectShadowed(rules: PolicyRule[]): PolicyConflict[] {
    const conflicts: PolicyConflict[] = [];

    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        const higherPriorityRule = rules[i];
        const lowerPriorityRule = rules[j];

        // If higher priority rule completely encompasses lower priority
        if (this.isSubsetCondition(lowerPriorityRule.condition, higherPriorityRule.condition)) {
          conflicts.push({
            conflictId: `shadowed_${higherPriorityRule.ruleId}_${lowerPriorityRule.ruleId}`,
            type: 'shadowed',
            severity: 'high',
            affectedRules: [higherPriorityRule.ruleId, lowerPriorityRule.ruleId],
            description: `Rule "${lowerPriorityRule.name}" will never execute because it's shadowed by higher-priority "${higherPriorityRule.name}"`,
            recommendation: `Delete the shadowed rule "${lowerPriorityRule.name}" or adjust its condition to be more specific.`,
            autoResolvable: false,
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Detect overlapping rules (partial condition overlap)
   */
  private detectOverlapping(rules: PolicyRule[]): PolicyConflict[] {
    const conflicts: PolicyConflict[] = [];

    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        const rule1 = rules[i];
        const rule2 = rules[j];

        // Check for partial overlap
        if (
          this.havePartialOverlap(rule1.condition, rule2.condition) &&
          rule1.action !== rule2.action
        ) {
          conflicts.push({
            conflictId: `overlapping_${rule1.ruleId}_${rule2.ruleId}`,
            type: 'overlapping',
            severity: 'medium',
            affectedRules: [rule1.ruleId, rule2.ruleId],
            description: `Rules "${rule1.name}" and "${rule2.name}" have overlapping conditions with different actions`,
            recommendation: `Review priority ordering or refine conditions to avoid ambiguity.`,
            autoResolvable: false,
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Detect priority conflicts (illogical ordering)
   */
  private detectPriorityConflicts(rules: PolicyRule[]): PolicyConflict[] {
    const conflicts: PolicyConflict[] = [];

    // Check if deny rules have higher priority than allow rules for same condition
    for (let i = 0; i < rules.length; i++) {
      for (let j = 0; j < i; j++) {
        const higherRule = rules[j];
        const lowerRule = rules[i];

        if (
          this.areSimilarConditions(higherRule.condition, lowerRule.condition) &&
          lowerRule.action === 'deny' &&
          higherRule.action === 'allow'
        ) {
          conflicts.push({
            conflictId: `priority_${higherRule.ruleId}_${lowerRule.ruleId}`,
            type: 'priority_conflict',
            severity: 'high',
            affectedRules: [higherRule.ruleId, lowerRule.ruleId],
            description: `Allow rule "${higherRule.name}" has higher priority than deny rule "${lowerRule.name}" for similar conditions`,
            recommendation: `Reorder rules so deny rules have higher priority than allow rules.`,
            autoResolvable: true,
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Detect unreachable rules (dead code)
   */
  private detectUnreachable(rules: PolicyRule[]): PolicyConflict[] {
    const conflicts: PolicyConflict[] = [];

    // Rules that are disabled or have impossible conditions
    for (const rule of rules) {
      if (!rule.enabled) {
        conflicts.push({
          conflictId: `unreachable_${rule.ruleId}`,
          type: 'unreachable',
          severity: 'low',
          affectedRules: [rule.ruleId],
          description: `Rule "${rule.name}" is disabled and will never execute`,
          recommendation: `Enable the rule or delete it if no longer needed.`,
          autoResolvable: true,
        });
      }

      // Check for obviously false conditions
      if (this.isImpossibleCondition(rule.condition)) {
        conflicts.push({
          conflictId: `unreachable_${rule.ruleId}`,
          type: 'unreachable',
          severity: 'medium',
          affectedRules: [rule.ruleId],
          description: `Rule "${rule.name}" has an impossible condition and will never execute`,
          recommendation: `Fix the condition or delete the rule.`,
          autoResolvable: false,
        });
      }
    }

    return conflicts;
  }

  /**
   * Check if two conditions are similar
   */
  private areSimilarConditions(cond1: string, cond2: string): boolean {
    // Normalize and compare
    const norm1 = this.normalizeCondition(cond1);
    const norm2 = this.normalizeCondition(cond2);

    // Simple similarity: check if 70% of tokens match
    const tokens1 = norm1.split(/\s+/);
    const tokens2 = norm2.split(/\s+/);

    const commonTokens = tokens1.filter(t => tokens2.includes(t));
    const similarity =
      (2 * commonTokens.length) / (tokens1.length + tokens2.length);

    return similarity > 0.7;
  }

  /**
   * Check if actions are opposite
   */
  private areOppositeActions(action1: string, action2: string): boolean {
    return (
      (action1 === 'deny' && action2 === 'allow') ||
      (action1 === 'allow' && action2 === 'deny')
    );
  }

  /**
   * Check if one condition is a subset of another
   */
  private isSubsetCondition(subset: string, superset: string): boolean {
    // Simplified: check if all tokens in subset are in superset
    const subsetTokens = this.normalizeCondition(subset).split(/\s+/);
    const supersetTokens = this.normalizeCondition(superset).split(/\s+/);

    return subsetTokens.every(token => supersetTokens.includes(token));
  }

  /**
   * Check if conditions have partial overlap
   */
  private havePartialOverlap(cond1: string, cond2: string): boolean {
    const norm1 = this.normalizeCondition(cond1);
    const norm2 = this.normalizeCondition(cond2);

    const tokens1 = norm1.split(/\s+/);
    const tokens2 = norm2.split(/\s+/);

    const commonTokens = tokens1.filter(t => tokens2.includes(t));

    // Partial overlap: 30-70% similarity
    const similarity =
      (2 * commonTokens.length) / (tokens1.length + tokens2.length);

    return similarity > 0.3 && similarity < 0.7;
  }

  /**
   * Check if condition is impossible
   */
  private isImpossibleCondition(condition: string): boolean {
    // Check for obviously false conditions
    const impossiblePatterns = [
      /true\s*===\s*false/,
      /false\s*===\s*true/,
      /\d+\s*===\s*\d+/,  // Same number comparison
    ];

    return impossiblePatterns.some(pattern => pattern.test(condition));
  }

  /**
   * Get rule signature for deduplication
   */
  private getRuleSignature(rule: PolicyRule): string {
    return `${rule.condition}|${rule.action}|${rule.riskLevel}`;
  }

  /**
   * Normalize condition for comparison
   */
  private normalizeCondition(condition: string): string {
    return condition
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/['"]/g, '')
      .trim();
  }

  /**
   * Calculate health score
   */
  private calculateHealthScore(totalRules: number, conflicts: PolicyConflict[]): number {
    if (totalRules === 0) return 100;

    const criticalConflicts = conflicts.filter(c => c.severity === 'critical').length;
    const highConflicts = conflicts.filter(c => c.severity === 'high').length;
    const mediumConflicts = conflicts.filter(c => c.severity === 'medium').length;
    const lowConflicts = conflicts.filter(c => c.severity === 'low').length;

    // Weight penalties by severity
    const penalty =
      criticalConflicts * 10 +
      highConflicts * 5 +
      mediumConflicts * 2 +
      lowConflicts * 0.5;

    const score = Math.max(0, 100 - penalty);

    return Math.round(score);
  }

  /**
   * Suggest resolution for a conflict
   */
  suggestResolution(conflict: PolicyConflict, rules: PolicyRule[]): ConflictResolution | null {
    switch (conflict.type) {
      case 'redundant': {
        // Delete lower priority duplicate
        const [rule1Id, rule2Id] = conflict.affectedRules;
        const rule1 = rules.find(r => r.ruleId === rule1Id);
        const rule2 = rules.find(r => r.ruleId === rule2Id);

        if (!rule1 || !rule2) return null;

        const toDelete = rule1.priority < rule2.priority ? rule1Id : rule2Id;

        return {
          conflictId: conflict.conflictId,
          resolution: 'delete',
          changes: [{ ruleId: toDelete, action: 'delete' }],
        };
      }

      case 'priority_conflict': {
        // Reorder rules
        const [higherRuleId, lowerRuleId] = conflict.affectedRules;

        return {
          conflictId: conflict.conflictId,
          resolution: 'reorder',
          changes: [
            {
              ruleId: higherRuleId,
              action: 'update',
              newValue: { priority: 90 },
            },
            {
              ruleId: lowerRuleId,
              action: 'update',
              newValue: { priority: 95 },
            },
          ],
        };
      }

      case 'unreachable': {
        // Delete unreachable rule
        const ruleId = conflict.affectedRules[0];

        return {
          conflictId: conflict.conflictId,
          resolution: 'delete',
          changes: [{ ruleId, action: 'delete' }],
        };
      }

      default:
        // Manual resolution required
        return {
          conflictId: conflict.conflictId,
          resolution: 'manual',
          changes: [],
        };
    }
  }
}

// =============================================================================
// Singleton
// =============================================================================

let conflictDetector: PolicyConflictDetector | null = null;

export function getPolicyConflictDetector(): PolicyConflictDetector {
  if (!conflictDetector) {
    conflictDetector = new PolicyConflictDetector();
  }
  return conflictDetector;
}
