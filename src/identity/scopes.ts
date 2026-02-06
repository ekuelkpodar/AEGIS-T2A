/**
 * Agent-to-Tool Authorization with Scope Inheritance
 *
 * Implements hierarchical scope model for fine-grained access control.
 * Child agents inherit parent scope ceiling but can be further restricted.
 *
 * Reference: Aembit scope model, OAuth 2.0 scope patterns
 */

import { logger } from '../core/logger.js';
import type { SPIFFEId } from './spiffe.js';

export interface Scope {
  name: string;
  description?: string;
  parent?: string; // Parent scope name
  impliedScopes?: string[]; // Scopes automatically granted with this scope
  requiredFor?: string[]; // Tool/resource IDs that require this scope
}

export interface ScopeGrant {
  agentSpiffeId: string;
  scopes: Set<string>;
  ceilingScopes?: Set<string>; // Maximum scopes this agent can delegate
  grantedAt: Date;
  grantedBy: string;
  expiresAt?: Date;
}

export class ScopeManager {
  private readonly scopes: Map<string, Scope>;
  private readonly grants: Map<string, ScopeGrant>;

  constructor() {
    this.scopes = new Map();
    this.grants = new Map();

    // Initialize default scopes
    this.initializeDefaultScopes();
  }

  /**
   * Register a scope definition
   */
  registerScope(scope: Scope): void {
    this.scopes.set(scope.name, scope);

    logger.debug('Scope registered', {
      scope: scope.name,
      parent: scope.parent,
      impliedScopes: scope.impliedScopes,
    });
  }

  /**
   * Grant scopes to an agent
   */
  grantScopes(
    agentSpiffeId: string,
    scopes: string[],
    grantedBy: string,
    ceilingScopes?: string[],
    expiresAt?: Date
  ): ScopeGrant {
    // Expand scopes to include all implied scopes
    const expandedScopes = this.expandScopes(scopes);

    const grant: ScopeGrant = {
      agentSpiffeId,
      scopes: new Set(expandedScopes),
      ceilingScopes: ceilingScopes ? new Set(ceilingScopes) : undefined,
      grantedAt: new Date(),
      grantedBy,
      expiresAt,
    };

    this.grants.set(agentSpiffeId, grant);

    logger.info('Scopes granted to agent', {
      agentSpiffeId,
      scopesGranted: scopes.length,
      expandedScopes: expandedScopes.length,
      ceilingScopes: ceilingScopes?.length,
      grantedBy,
    });

    return grant;
  }

  /**
   * Check if an agent has a specific scope
   */
  hasScope(agentSpiffeId: string, requiredScope: string): boolean {
    const grant = this.grants.get(agentSpiffeId);
    if (!grant) return false;

    // Check expiration
    if (grant.expiresAt && grant.expiresAt < new Date()) {
      logger.warn('Agent scope grant expired', {
        agentSpiffeId,
        expiresAt: grant.expiresAt.toISOString(),
      });
      return false;
    }

    // Check exact scope match
    if (grant.scopes.has(requiredScope)) {
      return true;
    }

    // Check hierarchical scope inheritance
    // e.g., agent has "action:execute:*", request needs "action:execute:aws"
    return this.checkHierarchicalScope(grant.scopes, requiredScope);
  }

  /**
   * Check if agent has all required scopes
   */
  hasAllScopes(agentSpiffeId: string, requiredScopes: string[]): boolean {
    return requiredScopes.every(scope => this.hasScope(agentSpiffeId, scope));
  }

  /**
   * Check if agent has any of the required scopes
   */
  hasAnyScope(agentSpiffeId: string, requiredScopes: string[]): boolean {
    return requiredScopes.some(scope => this.hasScope(agentSpiffeId, scope));
  }

  /**
   * Get all scopes granted to an agent
   */
  getGrantedScopes(agentSpiffeId: string): string[] {
    const grant = this.grants.get(agentSpiffeId);
    return grant ? Array.from(grant.scopes) : [];
  }

  /**
   * Create a delegated scope grant from parent to child agent
   *
   * Child inherits parent's ceiling but can be further restricted.
   */
  delegateScopes(
    parentSpiffeId: string,
    childSpiffeId: string,
    requestedScopes: string[],
    delegatedBy: string,
    expiresAt?: Date
  ): ScopeGrant | null {
    const parentGrant = this.grants.get(parentSpiffeId);
    if (!parentGrant) {
      logger.warn('Cannot delegate - parent has no scope grant', {
        parentSpiffeId,
        childSpiffeId,
      });
      return null;
    }

    // Determine effective ceiling
    const parentCeiling = parentGrant.ceilingScopes || parentGrant.scopes;

    // Validate requested scopes against parent ceiling
    const validatedScopes: string[] = [];
    for (const scope of requestedScopes) {
      if (this.isScopeWithinCeiling(scope, Array.from(parentCeiling))) {
        validatedScopes.push(scope);
      } else {
        logger.warn('Requested scope exceeds parent ceiling', {
          parentSpiffeId,
          childSpiffeId,
          requestedScope: scope,
          parentCeiling: Array.from(parentCeiling),
        });
      }
    }

    if (validatedScopes.length === 0) {
      logger.error('No valid scopes to delegate', {
        parentSpiffeId,
        childSpiffeId,
        requestedScopes,
      });
      return null;
    }

    // Create delegated grant with parent's ceiling
    return this.grantScopes(
      childSpiffeId,
      validatedScopes,
      delegatedBy,
      Array.from(parentCeiling),
      expiresAt
    );
  }

  /**
   * Revoke all scopes from an agent
   */
  revokeAllScopes(agentSpiffeId: string): boolean {
    const removed = this.grants.delete(agentSpiffeId);

    if (removed) {
      logger.info('All scopes revoked from agent', { agentSpiffeId });
    }

    return removed;
  }

  /**
   * Revoke specific scopes from an agent
   */
  revokeScopes(agentSpiffeId: string, scopesToRevoke: string[]): boolean {
    const grant = this.grants.get(agentSpiffeId);
    if (!grant) return false;

    scopesToRevoke.forEach(scope => grant.scopes.delete(scope));

    logger.info('Scopes revoked from agent', {
      agentSpiffeId,
      revokedScopes: scopesToRevoke,
      remainingScopes: grant.scopes.size,
    });

    return true;
  }

  /**
   * Validate MCP tool call against agent scopes
   */
  async validateToolCall(
    agentSpiffeId: string,
    toolName: string,
    toolParams: Record<string, unknown>
  ): Promise<{ authorized: boolean; reason?: string }> {
    // Get required scopes for this tool
    const toolScope = this.getToolRequiredScope(toolName);
    if (!toolScope) {
      return {
        authorized: false,
        reason: `Unknown tool: ${toolName}`,
      };
    }

    // Check if agent has required scope
    if (!this.hasScope(agentSpiffeId, toolScope)) {
      logger.warn('Tool call unauthorized - missing scope', {
        agentSpiffeId,
        toolName,
        requiredScope: toolScope,
        agentScopes: this.getGrantedScopes(agentSpiffeId),
      });

      return {
        authorized: false,
        reason: `Missing required scope: ${toolScope}`,
      };
    }

    // Additional parameter validation could go here
    // e.g., check if agent has scope for specific resource IDs in params

    logger.debug('Tool call authorized', {
      agentSpiffeId,
      toolName,
      requiredScope: toolScope,
    });

    return { authorized: true };
  }

  /**
   * Expand scopes to include all implied scopes
   */
  private expandScopes(scopeNames: string[]): string[] {
    const expanded = new Set<string>(scopeNames);

    for (const scopeName of scopeNames) {
      const scope = this.scopes.get(scopeName);
      if (scope?.impliedScopes) {
        scope.impliedScopes.forEach(s => expanded.add(s));
      }
    }

    return Array.from(expanded);
  }

  /**
   * Check hierarchical scope matching
   *
   * e.g., agent has "action:*", request needs "action:execute"
   */
  private checkHierarchicalScope(grantedScopes: Set<string>, requiredScope: string): boolean {
    const parts = requiredScope.split(':');

    // Build hierarchy from most specific to most general
    for (let i = parts.length; i > 0; i--) {
      const pattern = parts.slice(0, i).join(':') + (i < parts.length ? ':*' : '');

      if (grantedScopes.has(pattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a scope is within a ceiling set
   */
  private isScopeWithinCeiling(scope: string, ceiling: string[]): boolean {
    for (const ceilingScope of ceiling) {
      if (scope === ceilingScope) return true;

      // Check if ceiling scope is a wildcard that covers the requested scope
      if (ceilingScope.endsWith(':*')) {
        const prefix = ceilingScope.slice(0, -2);
        if (scope.startsWith(prefix + ':')) return true;
      }
    }

    return false;
  }

  /**
   * Get the required scope for a tool
   */
  private getToolRequiredScope(toolName: string): string | null {
    // This would typically query a registry of tools and their required scopes
    // For now, use a simple mapping based on tool naming conventions

    const scopeMapping: Record<string, string> = {
      // Read operations
      'list_*': 'action:read',
      'get_*': 'action:read',
      'describe_*': 'action:read',

      // Write operations
      'create_*': 'action:write',
      'update_*': 'action:write',
      'modify_*': 'action:write',

      // Execute operations
      'run_*': 'action:execute',
      'execute_*': 'action:execute',
      'invoke_*': 'action:execute',

      // Delete operations
      'delete_*': 'action:delete',
      'remove_*': 'action:delete',
      'terminate_*': 'action:delete',

      // Admin operations
      'admin_*': 'action:admin',
      'configure_*': 'action:admin',
    };

    // Check exact match first
    for (const [pattern, scope] of Object.entries(scopeMapping)) {
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        if (toolName.startsWith(prefix)) {
          return scope;
        }
      } else if (toolName === pattern) {
        return scope;
      }
    }

    // Default scope for unknown tools
    return 'action:execute';
  }

  /**
   * Initialize default scope hierarchy
   */
  private initializeDefaultScopes(): void {
    // Top-level scopes
    this.registerScope({
      name: 'action:*',
      description: 'All action permissions',
    });

    // Read scopes
    this.registerScope({
      name: 'action:read',
      description: 'Read-only access',
      parent: 'action:*',
    });

    this.registerScope({
      name: 'action:read:*',
      description: 'All read permissions',
      parent: 'action:read',
      impliedScopes: ['action:read'],
    });

    // Write scopes
    this.registerScope({
      name: 'action:write',
      description: 'Write access',
      parent: 'action:*',
      impliedScopes: ['action:read'], // Write implies read
    });

    this.registerScope({
      name: 'action:write:*',
      description: 'All write permissions',
      parent: 'action:write',
      impliedScopes: ['action:write', 'action:read'],
    });

    // Execute scopes
    this.registerScope({
      name: 'action:execute',
      description: 'Execute commands/workflows',
      parent: 'action:*',
      impliedScopes: ['action:read'], // Execute implies read
    });

    this.registerScope({
      name: 'action:execute:*',
      description: 'All execute permissions',
      parent: 'action:execute',
      impliedScopes: ['action:execute', 'action:read'],
    });

    // Delete scopes
    this.registerScope({
      name: 'action:delete',
      description: 'Delete/destroy resources',
      parent: 'action:*',
      impliedScopes: ['action:read'], // Delete implies read
    });

    this.registerScope({
      name: 'action:delete:*',
      description: 'All delete permissions',
      parent: 'action:delete',
      impliedScopes: ['action:delete', 'action:read'],
    });

    // Admin scopes
    this.registerScope({
      name: 'action:admin',
      description: 'Administrative access',
      parent: 'action:*',
      impliedScopes: ['action:read', 'action:write', 'action:execute', 'action:delete'],
    });

    this.registerScope({
      name: 'action:admin:*',
      description: 'All administrative permissions',
      parent: 'action:admin',
      impliedScopes: ['action:admin', 'action:read', 'action:write', 'action:execute', 'action:delete'],
    });

    logger.info('Default scope hierarchy initialized');
  }

  /**
   * Get compliance report
   */
  getComplianceReport(): {
    totalGrants: number;
    activeGrants: number;
    expiredGrants: number;
    grantsByScope: Record<string, number>;
    timestamp: string;
  } {
    const now = new Date();
    const grants = Array.from(this.grants.values());

    const active = grants.filter(g => !g.expiresAt || g.expiresAt > now);
    const expired = grants.filter(g => g.expiresAt && g.expiresAt <= now);

    const byScope: Record<string, number> = {};

    grants.forEach(grant => {
      grant.scopes.forEach(scope => {
        byScope[scope] = (byScope[scope] || 0) + 1;
      });
    });

    return {
      totalGrants: grants.length,
      activeGrants: active.length,
      expiredGrants: expired.length,
      grantsByScope: byScope,
      timestamp: new Date().toISOString(),
    };
  }
}

// Singleton instance
let scopeManager: ScopeManager;

export function getScopeManager(): ScopeManager {
  if (!scopeManager) {
    scopeManager = new ScopeManager();
  }
  return scopeManager;
}
