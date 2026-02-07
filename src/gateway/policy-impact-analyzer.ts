/**
 * Policy Impact Analysis
 *
 * Simulate policy changes before applying them to understand impact.
 * Prevent unintended consequences and policy-induced outages.
 *
 * Features:
 * - What-if analysis for policy changes
 * - Historical request replay
 * - Impact prediction
 * - Blast radius calculation
 * - Rollback simulation
 *
 * References:
 * - AWS IAM Access Analyzer
 * - Azure Policy What-If
 * - OPA Decision Logs
 */

import { componentLogger } from '../core/logger.js';
import type { PolicyRule, TypedIntent } from '../core/types.js';
import type { PolicyContext, PolicyEvaluationResult } from './policy-engine.js';

const logger = componentLogger('policy-impact-analyzer');

// =============================================================================
// Types
// =============================================================================

export interface PolicyChange {
  changeType: 'add' | 'update' | 'delete';
  ruleId: string;
  before?: PolicyRule;
  after?: PolicyRule;
}

export interface ImpactAnalysisRequest {
  changes: PolicyChange[];
  historicalRequests?: Array<{ intent: TypedIntent; context: PolicyContext }>;
  scope: 'all' | 'production' | 'specific_users';
  userIds?: string[];
}

export interface ImpactAnalysisResult {
  changes: PolicyChange[];
  impactSummary: {
    totalRequests: number;
    newlyAllowed: number;
    newlyDenied: number;
    requiresApproval: number;
    unchanged: number;
  };
  affectedRequests: AffectedRequest[];
  blastRadius: {
    usersAffected: number;
    resourcesAffected: number;
    severity: 'low' | 'medium' | 'high' | 'critical';
  };
  recommendations: string[];
}

export interface AffectedRequest {
  requestId: string;
  intent: TypedIntent;
  context: PolicyContext;
  before: PolicyEvaluationResult;
  after: PolicyEvaluationResult;
  impactType: 'newly_allowed' | 'newly_denied' | 'requires_approval' | 'unchanged';
}

// =============================================================================
// Policy Impact Analyzer
// =============================================================================

export class PolicyImpactAnalyzer {
  /**
   * Analyze impact of policy changes
   */
  async analyze(
    request: ImpactAnalysisRequest,
    currentRules: PolicyRule[],
    evaluateFn: (
      intent: TypedIntent,
      context: PolicyContext,
      rules: PolicyRule[]
    ) => PolicyEvaluationResult
  ): Promise<ImpactAnalysisResult> {
    // Apply changes to create new ruleset
    const newRules = this.applyChanges(currentRules, request.changes);

    // Get historical requests (or generate synthetic ones)
    const testRequests =
      request.historicalRequests || this.generateSyntheticRequests(request);

    // Evaluate all requests with both rulesets
    const affectedRequests: AffectedRequest[] = [];

    for (const testRequest of testRequests) {
      const before = evaluateFn(testRequest.intent, testRequest.context, currentRules);
      const after = evaluateFn(testRequest.intent, testRequest.context, newRules);

      const impactType = this.classifyImpact(before, after);

      affectedRequests.push({
        requestId: testRequest.intent.intentId,
        intent: testRequest.intent,
        context: testRequest.context,
        before,
        after,
        impactType,
      });
    }

    // Calculate summary
    const impactSummary = {
      totalRequests: affectedRequests.length,
      newlyAllowed: affectedRequests.filter(r => r.impactType === 'newly_allowed').length,
      newlyDenied: affectedRequests.filter(r => r.impactType === 'newly_denied').length,
      requiresApproval: affectedRequests.filter(r => r.impactType === 'requires_approval')
        .length,
      unchanged: affectedRequests.filter(r => r.impactType === 'unchanged').length,
    };

    // Calculate blast radius
    const uniqueUsers = new Set(affectedRequests.map(r => r.context.userId));
    const uniqueResources = new Set(
      affectedRequests.map(r => r.intent.actionType)
    );

    const blastRadius = {
      usersAffected: uniqueUsers.size,
      resourcesAffected: uniqueResources.size,
      severity: this.calculateSeverity(impactSummary),
    };

    // Generate recommendations
    const recommendations = this.generateRecommendations(impactSummary, blastRadius);

    logger.info(
      {
        changes: request.changes.length,
        totalRequests: impactSummary.totalRequests,
        newlyDenied: impactSummary.newlyDenied,
        blastRadius: blastRadius.severity,
      },
      'Policy impact analysis completed'
    );

    return {
      changes: request.changes,
      impactSummary,
      affectedRequests,
      blastRadius,
      recommendations,
    };
  }

  /**
   * Apply changes to ruleset
   */
  private applyChanges(currentRules: PolicyRule[], changes: PolicyChange[]): PolicyRule[] {
    let newRules = [...currentRules];

    for (const change of changes) {
      switch (change.changeType) {
        case 'add':
          if (change.after) {
            newRules.push(change.after);
          }
          break;

        case 'update':
          newRules = newRules.map(r =>
            r.ruleId === change.ruleId && change.after ? change.after : r
          );
          break;

        case 'delete':
          newRules = newRules.filter(r => r.ruleId !== change.ruleId);
          break;
      }
    }

    return newRules;
  }

  /**
   * Classify impact type
   */
  private classifyImpact(
    before: PolicyEvaluationResult,
    after: PolicyEvaluationResult
  ): AffectedRequest['impactType'] {
    // Newly allowed
    if (!before.allowed && after.allowed) {
      return 'newly_allowed';
    }

    // Newly denied
    if (before.allowed && !after.allowed) {
      return 'newly_denied';
    }

    // Now requires approval (previously didn't)
    if (!before.requiresApproval && after.requiresApproval) {
      return 'requires_approval';
    }

    return 'unchanged';
  }

  /**
   * Calculate severity
   */
  private calculateSeverity(summary: ImpactAnalysisResult['impactSummary']): 'low' | 'medium' | 'high' | 'critical' {
    const { totalRequests, newlyDenied, newlyAllowed } = summary;

    if (totalRequests === 0) return 'low';

    const deniedPercentage = (newlyDenied / totalRequests) * 100;
    const allowedPercentage = (newlyAllowed / totalRequests) * 100;

    // Critical: >50% of requests newly denied
    if (deniedPercentage > 50) return 'critical';

    // High: >25% denied OR >75% newly allowed (security risk)
    if (deniedPercentage > 25 || allowedPercentage > 75) return 'high';

    // Medium: >10% denied OR >50% newly allowed
    if (deniedPercentage > 10 || allowedPercentage > 50) return 'medium';

    return 'low';
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(
    summary: ImpactAnalysisResult['impactSummary'],
    blastRadius: ImpactAnalysisResult['blastRadius']
  ): string[] {
    const recommendations: string[] = [];

    if (summary.newlyDenied > 0) {
      recommendations.push(
        `⚠️  ${summary.newlyDenied} requests will be newly denied. Review carefully to avoid breaking existing workflows.`
      );
    }

    if (summary.newlyAllowed > 0) {
      recommendations.push(
        `⚡ ${summary.newlyAllowed} requests will be newly allowed. Ensure this doesn't introduce security risks.`
      );
    }

    if (blastRadius.severity === 'critical' || blastRadius.severity === 'high') {
      recommendations.push(
        `🚨 High blast radius detected. Consider deploying changes gradually with canary rollout.`
      );
    }

    if (blastRadius.usersAffected > 10) {
      recommendations.push(
        `👥 ${blastRadius.usersAffected} users affected. Notify teams before deployment.`
      );
    }

    if (summary.unchanged === summary.totalRequests) {
      recommendations.push(
        `✅ No behavioral changes detected. Policy change appears safe.`
      );
    }

    return recommendations;
  }

  /**
   * Generate synthetic test requests
   */
  private generateSyntheticRequests(
    request: ImpactAnalysisRequest
  ): Array<{ intent: TypedIntent; context: PolicyContext }> {
    const requests: Array<{ intent: TypedIntent; context: PolicyContext }> = [];

    // Generate test requests for different risk levels
    const riskLevels: Array<TypedIntent['riskLevel']> = ['low', 'medium', 'high', 'destructive'];
    const environments: Array<PolicyContext['environment']> = [
      'development',
      'staging',
      'production',
    ];

    for (const riskLevel of riskLevels) {
      for (const environment of environments) {
        requests.push({
          intent: {
            intentId: `synthetic_${riskLevel}_${environment}`,
            userId: 'test-user',
            timestamp: new Date().toISOString(),
            nlText: `Test ${riskLevel} operation`,
            actionType: 'test_action',
            riskLevel,
            sensitivity: 'confidential',
            budget: { currency: 'USD', limit: 100, spent: 0 },
            requiredCapabilities: [],
            sideEffect: riskLevel !== 'low',
            policyStatus: 'pending',
            approvalRequired: false,
            confidence: 1.0,
          },
          context: {
            userId: 'test-user',
            environment,
          },
        });
      }
    }

    return requests;
  }
}

// =============================================================================
// Singleton
// =============================================================================

let impactAnalyzer: PolicyImpactAnalyzer | null = null;

export function getPolicyImpactAnalyzer(): PolicyImpactAnalyzer {
  if (!impactAnalyzer) {
    impactAnalyzer = new PolicyImpactAnalyzer();
  }
  return impactAnalyzer;
}
