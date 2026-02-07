/**
 * Hierarchical Authorization Scopes
 *
 * Implements OpenClaw.ai-style scoped actuation with hierarchical permissions.
 * Every MCP tool call validates SPIFFE ID against required scopes.
 *
 * Scope hierarchy: admin > execute > write > read
 *
 * References:
 * - OpenClaw.ai (Scoped Actuation)
 * - Aembit.io (Workload IAM)
 * - OAuth 2.0 Scope patterns
 */

import { SPIFFEId } from './spiffe.js';
import { logger } from '../core/logger.js';

/**
 * Scope levels (hierarchical)
 */
export enum ScopeLevel {
  READ = 'read',
  WRITE = 'write',
  EXECUTE = 'execute',
  ADMIN = 'admin',
}

/**
 * Scope hierarchy mapping (lower number = higher permission)
 */
const SCOPE_HIERARCHY: Record<ScopeLevel, number> = {
  [ScopeLevel.ADMIN]: 4,
  [ScopeLevel.EXECUTE]: 3,
  [ScopeLevel.WRITE]: 2,
  [ScopeLevel.READ]: 1,
};

/**
 * Resource scope definition
 */
export interface ResourceScope {
  resource: string; // e.g., "trucks", "loads", "drivers", "*"
  level: ScopeLevel;
  constraints?: Record<string, unknown>; // Additional constraints (e.g., namespace, region)
}

/**
 * Scope grant for an identity
 */
export interface ScopeGrant {
  spiffeId: string;
  scopes: ResourceScope[];
  grantedAt: Date;
  expiresAt?: Date;
  grantedBy: string;
  reason?: string;
}

/**
 * Scope evaluation result
 */
export interface ScopeEvaluationResult {
  allowed: boolean;
  reason?: string;
  matchedScope?: ResourceScope;
  requiredLevel: ScopeLevel;
  grantedLevel?: ScopeLevel;
}

/**
 * Scope manager for managing and evaluating scopes
 */
export class ScopeManager {
  private grants: Map<string, ScopeGrant> = new Map();

  /**
   * Grant scopes to a SPIFFE ID
   */
  grantScopes(
    spiffeId: SPIFFEId,
    scopes: ResourceScope[],
    options: {
      expiresAt?: Date;
      grantedBy: string;
      reason?: string;
    }
  ): ScopeGrant {
    const grant: ScopeGrant = {
      spiffeId: spiffeId.toString(),
      scopes,
      grantedAt: new Date(),
      expiresAt: options.expiresAt,
      grantedBy: options.grantedBy,
      reason: options.reason,
    };

    this.grants.set(spiffeId.toString(), grant);

    logger.info('Granted scopes', {
      spiffeId: spiffeId.toString(),
      scopeCount: scopes.length,
      grantedBy: options.grantedBy,
      expiresAt: options.expiresAt?.toISOString(),
    });

    return grant;
  }

  /**
   * Revoke all scopes for a SPIFFE ID
   */
  revokeScopes(spiffeId: SPIFFEId): boolean {
    const had = this.grants.has(spiffeId.toString());
    this.grants.delete(spiffeId.toString());

    if (had) {
      logger.warn('Revoked all scopes', {
        spiffeId: spiffeId.toString(),
      });
    }

    return had;
  }

  /**
   * Get current scopes for a SPIFFE ID
   */
  getScopes(spiffeId: SPIFFEId): ResourceScope[] {
    const grant = this.grants.get(spiffeId.toString());
    if (!grant) {
      return [];
    }

    // Check expiration
    if (grant.expiresAt && grant.expiresAt < new Date()) {
      this.grants.delete(spiffeId.toString());
      logger.warn('Scope grant expired', {
        spiffeId: spiffeId.toString(),
        expiredAt: grant.expiresAt.toISOString(),
      });
      return [];
    }

    return grant.scopes;
  }

  /**
   * Evaluate if SPIFFE ID has required scope for resource
   */
  evaluate(
    spiffeId: SPIFFEId,
    resource: string,
    requiredLevel: ScopeLevel
  ): ScopeEvaluationResult {
    const scopes = this.getScopes(spiffeId);

    if (scopes.length === 0) {
      return {
        allowed: false,
        reason: 'No scopes granted',
        requiredLevel,
      };
    }

    // Find matching scope with highest level
    let bestMatch: ResourceScope | undefined;
    for (const scope of scopes) {
      if (this.resourceMatches(resource, scope.resource)) {
        if (!bestMatch || SCOPE_HIERARCHY[scope.level] > SCOPE_HIERARCHY[bestMatch.level]) {
          bestMatch = scope;
        }
      }
    }

    if (!bestMatch) {
      return {
        allowed: false,
        reason: `No scope for resource: ${resource}`,
        requiredLevel,
      };
    }

    // Check if granted level is sufficient
    const allowed = SCOPE_HIERARCHY[bestMatch.level] >= SCOPE_HIERARCHY[requiredLevel];

    return {
      allowed,
      reason: allowed
        ? undefined
        : `Insufficient permission: has ${bestMatch.level}, needs ${requiredLevel}`,
      matchedScope: bestMatch,
      requiredLevel,
      grantedLevel: bestMatch.level,
    };
  }

  /**
   * Check if resource matches pattern (supports wildcards)
   */
  private resourceMatches(resource: string, pattern: string): boolean {
    // Exact match
    if (resource === pattern) {
      return true;
    }

    // Wildcard match
    if (pattern === '*') {
      return true;
    }

    // Prefix wildcard: "trucks/*" matches "trucks/123"
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -2);
      return resource.startsWith(prefix + '/');
    }

    // Suffix wildcard: "*/logs" matches "trucks/123/logs"
    if (pattern.startsWith('*/')) {
      const suffix = pattern.slice(2);
      return resource.endsWith('/' + suffix);
    }

    return false;
  }

  /**
   * Get all grants (for audit/debugging)
   */
  getAllGrants(): ScopeGrant[] {
    return Array.from(this.grants.values());
  }

  /**
   * Clear expired grants
   */
  cleanupExpired(): number {
    const now = new Date();
    let cleaned = 0;

    for (const [spiffeId, grant] of this.grants.entries()) {
      if (grant.expiresAt && grant.expiresAt < now) {
        this.grants.delete(spiffeId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info('Cleaned up expired scope grants', { count: cleaned });
    }

    return cleaned;
  }

  /**
   * Get granted scopes for a specific actor (by string ID)
   */
  getGrantedScopes(actorId: string): ResourceScope[] {
    const grant = this.grants.get(actorId);
    if (!grant) {
      return [];
    }

    // Check expiration
    if (grant.expiresAt && grant.expiresAt < new Date()) {
      this.grants.delete(actorId);
      return [];
    }

    return grant.scopes;
  }

  /**
   * Get compliance report for SOC 2 / audit purposes
   */
  getComplianceReport(): {
    activeGrants: number;
    expiredGrants: number;
    totalScopes: number;
    grantsByLevel: Record<ScopeLevel, number>;
  } {
    const now = new Date();
    let activeGrants = 0;
    let expiredGrants = 0;
    let totalScopes = 0;
    const grantsByLevel: Record<ScopeLevel, number> = {
      [ScopeLevel.READ]: 0,
      [ScopeLevel.WRITE]: 0,
      [ScopeLevel.EXECUTE]: 0,
      [ScopeLevel.ADMIN]: 0,
    };

    for (const grant of this.grants.values()) {
      if (grant.expiresAt && grant.expiresAt < now) {
        expiredGrants++;
      } else {
        activeGrants++;
      }

      totalScopes += grant.scopes.length;

      for (const scope of grant.scopes) {
        grantsByLevel[scope.level]++;
      }
    }

    return {
      activeGrants,
      expiredGrants,
      totalScopes,
      grantsByLevel,
    };
  }
}

/**
 * Singleton scope manager
 */
let scopeManager: ScopeManager;

export function getScopeManager(): ScopeManager {
  if (!scopeManager) {
    scopeManager = new ScopeManager();
    
    // Run cleanup every 5 minutes
    setInterval(() => {
      scopeManager.cleanupExpired();
    }, 5 * 60 * 1000);
  }
  return scopeManager;
}

/**
 * Helper: Grant read-only access to specific resources
 */
export function grantReadAccess(
  spiffeId: SPIFFEId,
  resources: string[],
  grantedBy: string,
  expiresAt?: Date
): ScopeGrant {
  const scopes: ResourceScope[] = resources.map(resource => ({
    resource,
    level: ScopeLevel.READ,
  }));

  return getScopeManager().grantScopes(spiffeId, scopes, {
    grantedBy,
    expiresAt,
    reason: 'Read-only access',
  });
}

/**
 * Helper: Grant full admin access
 */
export function grantAdminAccess(
  spiffeId: SPIFFEId,
  grantedBy: string,
  expiresAt?: Date
): ScopeGrant {
  const scopes: ResourceScope[] = [
    {
      resource: '*',
      level: ScopeLevel.ADMIN,
    },
  ];

  return getScopeManager().grantScopes(spiffeId, scopes, {
    grantedBy,
    expiresAt,
    reason: 'Admin access',
  });
}

/**
 * Helper: Grant execution permissions for specific workflows
 */
export function grantWorkflowExecution(
  spiffeId: SPIFFEId,
  workflows: string[],
  grantedBy: string,
  expiresAt?: Date
): ScopeGrant {
  const scopes: ResourceScope[] = workflows.map(workflow => ({
    resource: `workflows/${workflow}`,
    level: ScopeLevel.EXECUTE,
  }));

  return getScopeManager().grantScopes(spiffeId, scopes, {
    grantedBy,
    expiresAt,
    reason: 'Workflow execution',
  });
}

/**
 * Scope enforcement decorator for functions
 */
export function requireScope(resource: string, level: ScopeLevel) {
  return function (
    _target: unknown,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (this: unknown, ...args: unknown[]) {
      // Extract SPIFFE ID from context (first argument should have it)
      const context = args[0] as { spiffeId?: SPIFFEId };
      if (!context?.spiffeId) {
        throw new Error('Missing SPIFFE ID in context');
      }

      // Evaluate scope
      const result = getScopeManager().evaluate(context.spiffeId, resource, level);

      if (!result.allowed) {
        logger.error('Scope check failed', {
          spiffeId: context.spiffeId.toString(),
          resource,
          requiredLevel: level,
          reason: result.reason,
        });
        throw new Error(`Unauthorized: ${result.reason}`);
      }

      // Call original method
      return originalMethod.apply(this, args);
    };

    return descriptor;
  };
}
