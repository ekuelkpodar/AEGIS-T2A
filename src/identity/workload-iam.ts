/**
 * Workload IAM - Context-Aware Access Control
 *
 * Implements Aembit-style workload IAM: policy decisions based on
 * identity + context + resource sensitivity.
 *
 * Evaluation considers:
 * - SPIFFE ID (who)
 * - Scopes (permissions)
 * - Context (time, location, risk score, blast radius)
 * - Resource sensitivity (classification level)
 * - Environmental factors (production vs dev)
 *
 * References:
 * - Aembit.io Workload IAM
 * - arxiv:2504.14760 (NHI Management)
 * - NIST ABAC (Attribute-Based Access Control)
 */

import { SPIFFEId } from './spiffe.js';
import { ScopeLevel, getScopeManager } from './scopes.js';
import { logger } from '../core/logger.js';

/**
 * Access context for policy evaluation
 */
export interface AccessContext {
  time: Date;
  location?: string; // e.g., "us-east-1", "on-premises"
  environment: 'production' | 'staging' | 'development' | 'test';
  riskScore?: number; // 0-100
  blastRadius?: number; // 0-100
  sourceIp?: string;
  userAgent?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Resource sensitivity classification
 */
export enum ResourceSensitivity {
  PUBLIC = 'public',
  INTERNAL = 'internal',
  CONFIDENTIAL = 'confidential',
  RESTRICTED = 'restricted',
}

/**
 * Resource metadata for policy evaluation
 */
export interface ResourceMetadata {
  resourceId: string;
  resourceType: string; // e.g., "truck", "load", "driver", "payment"
  sensitivity: ResourceSensitivity;
  owner?: string;
  tags?: Record<string, string>;
  complianceFlags?: string[]; // e.g., ["PCI", "PII", "PHI"]
}

/**
 * Access decision
 */
export enum AccessDecision {
  ALLOW = 'allow',
  DENY = 'deny',
  REQUIRE_APPROVAL = 'require_approval',
  REQUIRE_MFA = 'require_mfa',
}

/**
 * Access evaluation result
 */
export interface AccessEvaluationResult {
  decision: AccessDecision;
  reason: string;
  matchedPolicies: string[];
  metadata?: {
    scopeCheck?: boolean;
    contextCheck?: boolean;
    sensitivityCheck?: boolean;
    riskThreshold?: number;
  };
}

/**
 * IAM Policy rule
 */
export interface IAMPolicyRule {
  ruleId: string;
  name: string;
  priority: number; // Lower = higher priority
  enabled: boolean;
  
  // Conditions
  conditions: {
    identityPatterns?: string[]; // SPIFFE ID patterns
    requiredScope?: { resource: string; level: ScopeLevel };
    
    // Context constraints
    allowedEnvironments?: Array<'production' | 'staging' | 'development' | 'test'>;
    maxRiskScore?: number;
    maxBlastRadius?: number;
    businessHoursOnly?: boolean;
    allowedLocations?: string[];
    
    // Resource constraints
    minSensitivity?: ResourceSensitivity;
    maxSensitivity?: ResourceSensitivity;
    requiredTags?: Record<string, string>;
    forbiddenTags?: Record<string, string>;
  };
  
  // Action
  decision: AccessDecision;
  reason?: string;
}

/**
 * Workload IAM Engine
 */
export class WorkloadIAM {
  private policies: IAMPolicyRule[] = [];

  /**
   * Register an IAM policy rule
   */
  registerPolicy(policy: IAMPolicyRule): void {
    this.policies.push(policy);
    this.policies.sort((a, b) => a.priority - b.priority);
    
    logger.info('Registered IAM policy', {
      ruleId: policy.ruleId,
      name: policy.name,
      priority: policy.priority,
    });
  }

  /**
   * Remove a policy
   */
  removePolicy(ruleId: string): boolean {
    const index = this.policies.findIndex(p => p.ruleId === ruleId);
    if (index !== -1) {
      this.policies.splice(index, 1);
      logger.info('Removed IAM policy', { ruleId });
      return true;
    }
    return false;
  }

  /**
   * Evaluate access request
   */
  evaluate(
    spiffeId: SPIFFEId,
    resource: ResourceMetadata,
    action: ScopeLevel,
    context: AccessContext
  ): AccessEvaluationResult {
    logger.debug('Evaluating IAM policy', {
      spiffeId: spiffeId.toString(),
      resource: resource.resourceId,
      action,
      environment: context.environment,
    });

    // 1. Check scope first (fast fail)
    const scopeCheck = getScopeManager().evaluate(spiffeId, resource.resourceType, action);
    if (!scopeCheck.allowed) {
      return {
        decision: AccessDecision.DENY,
        reason: `Scope check failed: ${scopeCheck.reason}`,
        matchedPolicies: [],
        metadata: { scopeCheck: false },
      };
    }

    // 2. Evaluate policies in priority order
    const matchedPolicies: string[] = [];
    
    for (const policy of this.policies) {
      if (!policy.enabled) {
        continue;
      }

      if (this.policyMatches(policy, spiffeId, resource, action, context)) {
        matchedPolicies.push(policy.ruleId);
        
        // First matching policy wins
        return {
          decision: policy.decision,
          reason: policy.reason || `Matched policy: ${policy.name}`,
          matchedPolicies,
          metadata: {
            scopeCheck: true,
            contextCheck: true,
            sensitivityCheck: true,
          },
        };
      }
    }

    // 3. Default: allow if scopes passed and no policy matched
    return {
      decision: AccessDecision.ALLOW,
      reason: 'No restrictive policies matched',
      matchedPolicies,
      metadata: {
        scopeCheck: true,
        contextCheck: true,
        sensitivityCheck: true,
      },
    };
  }

  /**
   * Check if policy matches the request
   */
  private policyMatches(
    policy: IAMPolicyRule,
    spiffeId: SPIFFEId,
    resource: ResourceMetadata,
    action: ScopeLevel,
    context: AccessContext
  ): boolean {
    const conds = policy.conditions;

    // Identity pattern match
    if (conds.identityPatterns) {
      const matches = conds.identityPatterns.some(pattern =>
        spiffeId.toString().match(pattern)
      );
      if (!matches) {
        return false;
      }
    }

    // Scope requirement
    if (conds.requiredScope) {
      const scopeCheck = getScopeManager().evaluate(
        spiffeId,
        conds.requiredScope.resource,
        conds.requiredScope.level
      );
      if (!scopeCheck.allowed) {
        return false;
      }
    }

    // Environment check
    if (conds.allowedEnvironments) {
      if (!conds.allowedEnvironments.includes(context.environment)) {
        return false;
      }
    }

    // Risk score check
    if (conds.maxRiskScore !== undefined && context.riskScore !== undefined) {
      if (context.riskScore > conds.maxRiskScore) {
        return false;
      }
    }

    // Blast radius check
    if (conds.maxBlastRadius !== undefined && context.blastRadius !== undefined) {
      if (context.blastRadius > conds.maxBlastRadius) {
        return false;
      }
    }

    // Business hours check
    if (conds.businessHoursOnly) {
      const hour = context.time.getHours();
      const day = context.time.getDay();
      // Mon-Fri, 9 AM - 5 PM
      if (day === 0 || day === 6 || hour < 9 || hour >= 17) {
        return false;
      }
    }

    // Location check
    if (conds.allowedLocations && context.location) {
      if (!conds.allowedLocations.includes(context.location)) {
        return false;
      }
    }

    // Resource sensitivity
    if (conds.minSensitivity) {
      if (!this.meetsMinSensitivity(resource.sensitivity, conds.minSensitivity)) {
        return false;
      }
    }
    if (conds.maxSensitivity) {
      if (!this.meetsMaxSensitivity(resource.sensitivity, conds.maxSensitivity)) {
        return false;
      }
    }

    // Tag checks
    if (conds.requiredTags) {
      for (const [key, value] of Object.entries(conds.requiredTags)) {
        if (resource.tags?.[key] !== value) {
          return false;
        }
      }
    }
    if (conds.forbiddenTags) {
      for (const [key, value] of Object.entries(conds.forbiddenTags)) {
        if (resource.tags?.[key] === value) {
          return false;
        }
      }
    }

    return true;
  }

  private meetsMinSensitivity(actual: ResourceSensitivity, min: ResourceSensitivity): boolean {
    const levels = [
      ResourceSensitivity.PUBLIC,
      ResourceSensitivity.INTERNAL,
      ResourceSensitivity.CONFIDENTIAL,
      ResourceSensitivity.RESTRICTED,
    ];
    return levels.indexOf(actual) >= levels.indexOf(min);
  }

  private meetsMaxSensitivity(actual: ResourceSensitivity, max: ResourceSensitivity): boolean {
    const levels = [
      ResourceSensitivity.PUBLIC,
      ResourceSensitivity.INTERNAL,
      ResourceSensitivity.CONFIDENTIAL,
      ResourceSensitivity.RESTRICTED,
    ];
    return levels.indexOf(actual) <= levels.indexOf(max);
  }

  /**
   * Get all registered policies
   */
  getPolicies(): IAMPolicyRule[] {
    return [...this.policies];
  }

  /**
   * Get compliance report for SOC 2 / audit purposes
   */
  getComplianceReport(): {
    totalPolicies: number;
    enabledPolicies: number;
    disabledPolicies: number;
    policiesByDecision: Record<AccessDecision, number>;
  } {
    let enabledPolicies = 0;
    let disabledPolicies = 0;
    const policiesByDecision: Record<AccessDecision, number> = {
      [AccessDecision.ALLOW]: 0,
      [AccessDecision.DENY]: 0,
      [AccessDecision.REQUIRE_APPROVAL]: 0,
      [AccessDecision.REQUIRE_MFA]: 0,
    };

    for (const policy of this.policies) {
      if (policy.enabled) {
        enabledPolicies++;
      } else {
        disabledPolicies++;
      }

      policiesByDecision[policy.decision]++;
    }

    return {
      totalPolicies: this.policies.length,
      enabledPolicies,
      disabledPolicies,
      policiesByDecision,
    };
  }
}

/**
 * Singleton instance
 */
let workloadIAM: WorkloadIAM;

export function getWorkloadIAM(): WorkloadIAM {
  if (!workloadIAM) {
    workloadIAM = new WorkloadIAM();
    
    // Register default policies
    registerDefaultPolicies(workloadIAM);
  }
  return workloadIAM;
}

/**
 * Initialize default IAM policies (exported function)
 */
export function initializeDefaultPolicies(iam: WorkloadIAM): void {
  registerDefaultPolicies(iam);
}

/**
 * Register default IAM policies
 */
function registerDefaultPolicies(iam: WorkloadIAM): void {
  // Policy 1: Deny high-risk operations in production
  iam.registerPolicy({
    ruleId: 'deny-high-risk-prod',
    name: 'Deny High Risk in Production',
    priority: 100,
    enabled: true,
    conditions: {
      allowedEnvironments: ['production'],
      maxRiskScore: 70,
    },
    decision: AccessDecision.DENY,
    reason: 'Risk score too high for production',
  });

  // Policy 2: Require approval for restricted resources
  iam.registerPolicy({
    ruleId: 'approval-restricted',
    name: 'Require Approval for Restricted Resources',
    priority: 200,
    enabled: true,
    conditions: {
      minSensitivity: ResourceSensitivity.RESTRICTED,
    },
    decision: AccessDecision.REQUIRE_APPROVAL,
    reason: 'Restricted resource requires approval',
  });

  // Policy 3: Require approval for high blast radius
  iam.registerPolicy({
    ruleId: 'approval-high-blast',
    name: 'Require Approval for High Blast Radius',
    priority: 300,
    enabled: true,
    conditions: {
      maxBlastRadius: 80,
    },
    decision: AccessDecision.REQUIRE_APPROVAL,
    reason: 'Blast radius too high, requires approval',
  });

  // Policy 4: Business hours only for production writes
  iam.registerPolicy({
    ruleId: 'business-hours-prod-write',
    name: 'Business Hours Only for Production Writes',
    priority: 400,
    enabled: true,
    conditions: {
      allowedEnvironments: ['production'],
      businessHoursOnly: true,
    },
    decision: AccessDecision.REQUIRE_APPROVAL,
    reason: 'Production changes outside business hours require approval',
  });

  logger.info('Registered default IAM policies', { count: 4 });
}
