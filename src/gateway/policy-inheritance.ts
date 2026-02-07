/**
 * Policy Inheritance
 *
 * Hierarchical policy structure: Global → Environment → Team → User
 * Enables policy reuse and centralized management.
 */

import { componentLogger } from '../core/logger.js';
import type { PolicyRule } from '../core/types.js';

const logger = componentLogger('policy-inheritance');

export interface PolicyScope {
  scopeId: string;
  scopeType: 'global' | 'environment' | 'team' | 'user';
  name: string;
  parentScopeId?: string;
  rules: PolicyRule[];
}

export class PolicyInheritanceManager {
  private scopes = new Map<string, PolicyScope>();

  constructor() {
    // Create global scope
    this.createScope('global', 'global', 'Global Policies');
  }

  createScope(
    scopeId: string,
    scopeType: PolicyScope['scopeType'],
    name: string,
    parentScopeId?: string
  ): PolicyScope {
    const scope: PolicyScope = {
      scopeId,
      scopeType,
      name,
      parentScopeId,
      rules: [],
    };

    this.scopes.set(scopeId, scope);

    logger.info({ scopeId, scopeType }, 'Policy scope created');

    return scope;
  }

  addRuleToScope(scopeId: string, rule: PolicyRule): void {
    const scope = this.scopes.get(scopeId);

    if (!scope) {
      throw new Error(`Scope not found: ${scopeId}`);
    }

    scope.rules.push(rule);
  }

  getEffectiveRules(scopeId: string): PolicyRule[] {
    const rules: PolicyRule[] = [];
    const visitedScopes = new Set<string>();

    const collectRules = (currentScopeId: string): void => {
      if (visitedScopes.has(currentScopeId)) return;

      visitedScopes.add(currentScopeId);

      const scope = this.scopes.get(currentScopeId);
      if (!scope) return;

      // Add scope's rules
      rules.push(...scope.rules);

      // Recursively add parent rules
      if (scope.parentScopeId) {
        collectRules(scope.parentScopeId);
      }
    };

    collectRules(scopeId);

    // Sort by priority
    return rules.sort((a, b) => b.priority - a.priority);
  }

  getScope(scopeId: string): PolicyScope | undefined {
    return this.scopes.get(scopeId);
  }
}

let inheritanceManager: PolicyInheritanceManager | null = null;

export function getPolicyInheritanceManager(): PolicyInheritanceManager {
  if (!inheritanceManager) {
    inheritanceManager = new PolicyInheritanceManager();
  }
  return inheritanceManager;
}
