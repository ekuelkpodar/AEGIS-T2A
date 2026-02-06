/**
 * Aembit-style Workload IAM Layer
 *
 * Enforces access policies based on agent identity, context (time, location, risk score),
 * and target resource sensitivity. Acts as a policy decision point between agent identity
 * and action execution.
 *
 * Reference: aembit.io architecture, Workload IAM patterns
 */

import { logger } from '../core/logger.js';
import type { SPIFFEId } from './spiffe.js';

export interface AccessContext {
  requestTime: Date;
  sourceIp?: string;
  geoLocation?: string;
  riskScore?: number; // 0-100
  sessionId?: string;
  parentWorkflowId?: string;
  userAgent?: string;
}

export interface ResourceTarget {
  resourceId: string;
  resourceType: string; // e.g., "database", "api", "tool", "secret"
  sensitivity: ResourceSensitivity;
  owner?: string;
  tags?: Record<string, string>;
}

export enum ResourceSensitivity {
  PUBLIC = 'public',
  INTERNAL = 'internal',
  CONFIDENTIAL = 'confidential',
  RESTRICTED = 'restricted',
}

export interface AccessPolicy {
  id: string;
  name: string;
  description?: string;
  priority: number; // Higher priority = evaluated first

  // Who can access
  allowedSpiffePatterns: string[]; // e.g., ["spiffe://aegis-t2a.local/ns/production/agent/*"]
  deniedSpiffePatterns?: string[];

  // What they can access
  resourceTypes?: string[]; // If not specified, applies to all types
  resourceSensitivity?: ResourceSensitivity[];
  resourceTags?: Record<string, string>; // Must match all tags

  // Contextual conditions
  allowedTimeRanges?: TimeRange[];
  allowedGeoLocations?: string[];
  maxRiskScore?: number;
  requireMFA?: boolean;

  // Actions
  action: PolicyAction;
  conditions?: Record<string, unknown>;

  // Metadata
  createdAt: Date;
  updatedAt?: Date;
  createdBy: string;
  enabled: boolean;
}

export interface TimeRange {
  start: string; // HH:MM format
  end: string;
  daysOfWeek?: number[]; // 0 = Sunday, 6 = Saturday
  timezone?: string;
}

export enum PolicyAction {
  ALLOW = 'allow',
  DENY = 'deny',
  REQUIRE_APPROVAL = 'require_approval',
  REQUIRE_MFA = 'require_mfa',
  STEP_UP_AUTH = 'step_up_auth',
}

export interface AccessDecision {
  allowed: boolean;
  action: PolicyAction;
  matchedPolicies: string[]; // Policy IDs
  reason?: string;
  requiredApprovals?: string[]; // Approver IDs/roles
  additionalContext?: Record<string, unknown>;
}

export class WorkloadIAM {
  private policies: Map<string, AccessPolicy>;

  constructor() {
    this.policies = new Map();
  }

  /**
   * Add or update an access policy
   */
  addPolicy(policy: AccessPolicy): void {
    this.policies.set(policy.id, policy);

    logger.info('Access policy added', {
      policyId: policy.id,
      name: policy.name,
      priority: policy.priority,
      action: policy.action,
    });
  }

  /**
   * Remove an access policy
   */
  removePolicy(policyId: string): boolean {
    const removed = this.policies.delete(policyId);

    if (removed) {
      logger.info('Access policy removed', { policyId });
    }

    return removed;
  }

  /**
   * Evaluate access request against all applicable policies
   *
   * Returns the decision from the highest-priority matching policy.
   */
  async evaluateAccess(
    agentSpiffeId: SPIFFEId,
    resource: ResourceTarget,
    context: AccessContext,
    requiredAction: string = 'access'
  ): Promise<AccessDecision> {
    logger.debug('Evaluating workload access', {
      agentSpiffeId: agentSpiffeId.fullId,
      resourceId: resource.resourceId,
      resourceType: resource.resourceType,
      sensitivity: resource.sensitivity,
      context,
    });

    // Get all enabled policies, sorted by priority
    const enabledPolicies = Array.from(this.policies.values())
      .filter(p => p.enabled)
      .sort((a, b) => b.priority - a.priority);

    const matchedPolicies: string[] = [];
    let finalDecision: AccessDecision = {
      allowed: false,
      action: PolicyAction.DENY,
      matchedPolicies: [],
      reason: 'No matching policy - default deny',
    };

    // Evaluate policies in priority order
    for (const policy of enabledPolicies) {
      const matches = await this.policyMatches(
        policy,
        agentSpiffeId,
        resource,
        context
      );

      if (matches) {
        matchedPolicies.push(policy.id);

        // First matching policy determines the decision
        if (finalDecision.matchedPolicies.length === 0) {
          finalDecision = {
            allowed: policy.action === PolicyAction.ALLOW,
            action: policy.action,
            matchedPolicies: [policy.id],
            reason: policy.description || `Matched policy: ${policy.name}`,
          };

          // If it's a hard deny, stop processing
          if (policy.action === PolicyAction.DENY) {
            logger.warn('Access denied by policy', {
              agentSpiffeId: agentSpiffeId.fullId,
              resourceId: resource.resourceId,
              policyId: policy.id,
              policyName: policy.name,
            });
            break;
          }
        }
      }
    }

    // Log final decision
    if (finalDecision.allowed) {
      logger.info('Access granted', {
        agentSpiffeId: agentSpiffeId.fullId,
        resourceId: resource.resourceId,
        matchedPolicies,
        action: finalDecision.action,
      });
    } else {
      logger.warn('Access denied', {
        agentSpiffeId: agentSpiffeId.fullId,
        resourceId: resource.resourceId,
        matchedPolicies,
        reason: finalDecision.reason,
      });
    }

    finalDecision.matchedPolicies = matchedPolicies;
    return finalDecision;
  }

  /**
   * Check if a policy matches the access request
   */
  private async policyMatches(
    policy: AccessPolicy,
    agentSpiffeId: SPIFFEId,
    resource: ResourceTarget,
    context: AccessContext
  ): Promise<boolean> {
    // Check SPIFFE ID patterns
    if (policy.deniedSpiffePatterns) {
      for (const pattern of policy.deniedSpiffePatterns) {
        if (this.matchesPattern(agentSpiffeId.fullId, pattern)) {
          return false; // Explicit deny
        }
      }
    }

    let matchesAllowed = false;
    for (const pattern of policy.allowedSpiffePatterns) {
      if (this.matchesPattern(agentSpiffeId.fullId, pattern)) {
        matchesAllowed = true;
        break;
      }
    }
    if (!matchesAllowed) return false;

    // Check resource type
    if (policy.resourceTypes && !policy.resourceTypes.includes(resource.resourceType)) {
      return false;
    }

    // Check resource sensitivity
    if (policy.resourceSensitivity && !policy.resourceSensitivity.includes(resource.sensitivity)) {
      return false;
    }

    // Check resource tags
    if (policy.resourceTags && resource.tags) {
      for (const [key, value] of Object.entries(policy.resourceTags)) {
        if (resource.tags[key] !== value) {
          return false;
        }
      }
    }

    // Check time ranges
    if (policy.allowedTimeRanges) {
      if (!this.isInAllowedTimeRange(context.requestTime, policy.allowedTimeRanges)) {
        return false;
      }
    }

    // Check geo location
    if (policy.allowedGeoLocations && context.geoLocation) {
      if (!policy.allowedGeoLocations.includes(context.geoLocation)) {
        return false;
      }
    }

    // Check risk score
    if (policy.maxRiskScore !== undefined && context.riskScore !== undefined) {
      if (context.riskScore > policy.maxRiskScore) {
        return false;
      }
    }

    // All conditions matched
    return true;
  }

  /**
   * Check if a SPIFFE ID matches a pattern (supports wildcards)
   */
  private matchesPattern(spiffeId: string, pattern: string): boolean {
    // Convert pattern to regex
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(spiffeId);
  }

  /**
   * Check if current time is within allowed time ranges
   */
  private isInAllowedTimeRange(requestTime: Date, timeRanges: TimeRange[]): boolean {
    for (const range of timeRanges) {
      const dayOfWeek = requestTime.getDay();

      // Check day of week if specified
      if (range.daysOfWeek && !range.daysOfWeek.includes(dayOfWeek)) {
        continue;
      }

      // Check time of day
      const currentTime = requestTime.toTimeString().slice(0, 5); // HH:MM
      if (currentTime >= range.start && currentTime <= range.end) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get all policies
   */
  getPolicies(): AccessPolicy[] {
    return Array.from(this.policies.values());
  }

  /**
   * Get policies applicable to a specific agent
   */
  getPoliciesForAgent(agentSpiffeId: string): AccessPolicy[] {
    return this.getPolicies().filter(policy => {
      for (const pattern of policy.allowedSpiffePatterns) {
        if (this.matchesPattern(agentSpiffeId, pattern)) {
          return true;
        }
      }
      return false;
    });
  }

  /**
   * Get compliance report
   */
  getComplianceReport(): {
    totalPolicies: number;
    enabledPolicies: number;
    policiesByAction: Record<string, number>;
    policiesByResourceType: Record<string, number>;
    timestamp: string;
  } {
    const policies = this.getPolicies();
    const enabled = policies.filter(p => p.enabled);

    const byAction: Record<string, number> = {};
    const byResourceType: Record<string, number> = {};

    policies.forEach(p => {
      byAction[p.action] = (byAction[p.action] || 0) + 1;

      if (p.resourceTypes) {
        p.resourceTypes.forEach(type => {
          byResourceType[type] = (byResourceType[type] || 0) + 1;
        });
      }
    });

    return {
      totalPolicies: policies.length,
      enabledPolicies: enabled.length,
      policiesByAction: byAction,
      policiesByResourceType: byResourceType,
      timestamp: new Date().toISOString(),
    };
  }
}

// Singleton instance
let workloadIAM: WorkloadIAM;

export function getWorkloadIAM(): WorkloadIAM {
  if (!workloadIAM) {
    workloadIAM = new WorkloadIAM();
  }
  return workloadIAM;
}

/**
 * Initialize default policies for AEGIS-T2A
 */
export function initializeDefaultPolicies(iam: WorkloadIAM): void {
  // Policy 1: Allow read-only access to public resources
  iam.addPolicy({
    id: 'default-public-read',
    name: 'Public Resource Read Access',
    description: 'Allow all agents to read public resources',
    priority: 100,
    allowedSpiffePatterns: ['spiffe://aegis-t2a.local/ns/*/agent/*'],
    resourceSensitivity: [ResourceSensitivity.PUBLIC],
    action: PolicyAction.ALLOW,
    createdAt: new Date(),
    createdBy: 'system',
    enabled: true,
  });

  // Policy 2: Require approval for restricted resources
  iam.addPolicy({
    id: 'restricted-require-approval',
    name: 'Restricted Resource Approval',
    description: 'Require human approval for accessing restricted resources',
    priority: 200,
    allowedSpiffePatterns: ['spiffe://aegis-t2a.local/ns/*/agent/*'],
    resourceSensitivity: [ResourceSensitivity.RESTRICTED],
    action: PolicyAction.REQUIRE_APPROVAL,
    createdAt: new Date(),
    createdBy: 'system',
    enabled: true,
  });

  // Policy 3: Deny high-risk access outside business hours
  iam.addPolicy({
    id: 'after-hours-high-risk-deny',
    name: 'After-Hours High-Risk Deny',
    description: 'Deny high-risk actions outside business hours',
    priority: 300,
    allowedSpiffePatterns: ['spiffe://aegis-t2a.local/ns/*/agent/*'],
    resourceSensitivity: [ResourceSensitivity.CONFIDENTIAL, ResourceSensitivity.RESTRICTED],
    allowedTimeRanges: [
      {
        start: '09:00',
        end: '17:00',
        daysOfWeek: [1, 2, 3, 4, 5], // Monday-Friday
        timezone: 'America/Los_Angeles',
      },
    ],
    maxRiskScore: 30,
    action: PolicyAction.DENY,
    createdAt: new Date(),
    createdBy: 'system',
    enabled: true,
  });

  logger.info('Default Workload IAM policies initialized', {
    policiesAdded: 3,
  });
}
