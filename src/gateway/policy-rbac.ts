/**
 * Policy RBAC Integration with SPIFFE
 *
 * Integrates Role-Based Access Control with SPIFFE workload identities from Phase 1.
 * Maps SPIFFE IDs to roles and permissions for fine-grained policy enforcement.
 *
 * Features:
 * - SPIFFE ID to role mapping
 * - Dynamic role assignment
 * - Permission inheritance
 * - Attribute-Based Access Control (ABAC)
 * - Time-boxed role grants
 *
 * References:
 * - Istio RBAC with SPIFFE
 * - Kubernetes RBAC
 * - AWS IAM Roles
 */

import { EventEmitter } from 'events';
import { componentLogger } from '../core/logger.js';

const logger = componentLogger('policy-rbac');

// =============================================================================
// Types
// =============================================================================

export interface Role {
  roleId: string;
  name: string;
  description: string;
  permissions: Permission[];
  inheritsFrom: string[]; // Parent role IDs
  createdAt: Date;
  updatedAt: Date;
}

export interface Permission {
  permissionId: string;
  resource: string; // Resource type (e.g., 's3:bucket', 'ec2:instance')
  actions: string[]; // Actions allowed (e.g., 'read', 'write', 'delete')
  conditions?: Record<string, unknown>; // Conditional permissions
}

export interface RoleBinding {
  bindingId: string;
  spiffeId: string; // SPIFFE ID from Phase 1
  roleId: string;
  grantedBy: string;
  grantedAt: Date;
  expiresAt?: Date; // Time-boxed grant
  metadata?: Record<string, unknown>;
}

export interface PolicyRBACContext {
  spiffeId: string;
  roles: string[];
  permissions: Permission[];
  attributes: Record<string, unknown>; // ABAC attributes
}

export interface RBACEvaluationResult {
  allowed: boolean;
  matchedPermissions: Permission[];
  deniedPermissions: Permission[];
  reason: string;
}

// =============================================================================
// Built-in Roles
// =============================================================================

const BUILT_IN_ROLES: Omit<Role, 'createdAt' | 'updatedAt'>[] = [
  {
    roleId: 'admin',
    name: 'Administrator',
    description: 'Full system access',
    permissions: [
      {
        permissionId: 'admin_all',
        resource: '*',
        actions: ['*'],
      },
    ],
    inheritsFrom: [],
  },
  {
    roleId: 'operator',
    name: 'Operator',
    description: 'Can execute operations but not modify policies',
    permissions: [
      {
        permissionId: 'operator_execute',
        resource: '*',
        actions: ['read', 'execute'],
      },
    ],
    inheritsFrom: [],
  },
  {
    roleId: 'developer',
    name: 'Developer',
    description: 'Development environment access',
    permissions: [
      {
        permissionId: 'dev_read_write',
        resource: '*',
        actions: ['read', 'write'],
        conditions: {
          environment: 'development',
        },
      },
    ],
    inheritsFrom: [],
  },
  {
    roleId: 'auditor',
    name: 'Auditor',
    description: 'Read-only access for compliance',
    permissions: [
      {
        permissionId: 'auditor_read',
        resource: '*',
        actions: ['read'],
      },
    ],
    inheritsFrom: [],
  },
  {
    roleId: 'security',
    name: 'Security Team',
    description: 'Security policy management',
    permissions: [
      {
        permissionId: 'security_policies',
        resource: 'policy:*',
        actions: ['read', 'write', 'delete'],
      },
      {
        permissionId: 'security_identities',
        resource: 'identity:*',
        actions: ['read', 'revoke'],
      },
    ],
    inheritsFrom: ['auditor'],
  },
];

// =============================================================================
// RBAC Manager
// =============================================================================

export class PolicyRBACManager extends EventEmitter {
  private roles = new Map<string, Role>();
  private bindings = new Map<string, RoleBinding>();
  private spiffeIdToBindings = new Map<string, RoleBinding[]>();

  constructor() {
    super();
    this.loadBuiltInRoles();
  }

  /**
   * Load built-in roles
   */
  private loadBuiltInRoles(): void {
    const now = new Date();

    for (const roleData of BUILT_IN_ROLES) {
      const role: Role = {
        ...roleData,
        createdAt: now,
        updatedAt: now,
      };
      this.roles.set(role.roleId, role);
    }

    logger.info({ count: BUILT_IN_ROLES.length }, 'Built-in roles loaded');
  }

  /**
   * Create a custom role
   */
  createRole(
    roleId: string,
    name: string,
    description: string,
    permissions: Permission[],
    inheritsFrom: string[] = []
  ): Role {
    // Validate parent roles exist
    for (const parentId of inheritsFrom) {
      if (!this.roles.has(parentId)) {
        throw new Error(`Parent role not found: ${parentId}`);
      }
    }

    const role: Role = {
      roleId,
      name,
      description,
      permissions,
      inheritsFrom,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.roles.set(roleId, role);

    this.emit('role_created', { roleId, name });

    logger.info({ roleId, name }, 'Role created');

    return role;
  }

  /**
   * Bind a role to a SPIFFE ID
   */
  bindRole(
    spiffeId: string,
    roleId: string,
    grantedBy: string,
    expiresAt?: Date
  ): RoleBinding {
    if (!this.roles.has(roleId)) {
      throw new Error(`Role not found: ${roleId}`);
    }

    const bindingId = `binding_${spiffeId}_${roleId}_${Date.now()}`;

    const binding: RoleBinding = {
      bindingId,
      spiffeId,
      roleId,
      grantedBy,
      grantedAt: new Date(),
      expiresAt,
    };

    this.bindings.set(bindingId, binding);

    // Index by SPIFFE ID
    const existingBindings = this.spiffeIdToBindings.get(spiffeId) || [];
    existingBindings.push(binding);
    this.spiffeIdToBindings.set(spiffeId, existingBindings);

    this.emit('role_bound', { spiffeId, roleId, bindingId });

    logger.info({ spiffeId, roleId }, 'Role bound to SPIFFE ID');

    return binding;
  }

  /**
   * Unbind a role from a SPIFFE ID
   */
  unbindRole(bindingId: string): void {
    const binding = this.bindings.get(bindingId);

    if (!binding) {
      throw new Error(`Binding not found: ${bindingId}`);
    }

    // Remove from bindings
    this.bindings.delete(bindingId);

    // Remove from index
    const existingBindings = this.spiffeIdToBindings.get(binding.spiffeId) || [];
    const filtered = existingBindings.filter(b => b.bindingId !== bindingId);
    this.spiffeIdToBindings.set(binding.spiffeId, filtered);

    this.emit('role_unbound', { spiffeId: binding.spiffeId, roleId: binding.roleId });

    logger.info({ bindingId, spiffeId: binding.spiffeId }, 'Role unbound');
  }

  /**
   * Get RBAC context for a SPIFFE ID
   */
  getRBACContext(spiffeId: string): PolicyRBACContext {
    const bindings = this.spiffeIdToBindings.get(spiffeId) || [];

    // Filter out expired bindings
    const now = new Date();
    const activeBindings = bindings.filter(
      b => !b.expiresAt || b.expiresAt > now
    );

    // Collect all roles
    const roleIds = activeBindings.map(b => b.roleId);

    // Collect all permissions (with inheritance)
    const permissions = this.collectPermissions(roleIds);

    // Extract attributes from bindings
    const attributes: Record<string, unknown> = {};
    for (const binding of activeBindings) {
      if (binding.metadata) {
        Object.assign(attributes, binding.metadata);
      }
    }

    return {
      spiffeId,
      roles: roleIds,
      permissions,
      attributes,
    };
  }

  /**
   * Collect all permissions for roles (including inherited)
   */
  private collectPermissions(roleIds: string[]): Permission[] {
    const allPermissions: Permission[] = [];
    const processedRoles = new Set<string>();

    const processRole = (roleId: string): void => {
      if (processedRoles.has(roleId)) return;

      processedRoles.add(roleId);

      const role = this.roles.get(roleId);
      if (!role) return;

      // Add role's own permissions
      allPermissions.push(...role.permissions);

      // Recursively process inherited roles
      for (const parentId of role.inheritsFrom) {
        processRole(parentId);
      }
    };

    for (const roleId of roleIds) {
      processRole(roleId);
    }

    return allPermissions;
  }

  /**
   * Evaluate RBAC for a resource and action
   */
  evaluate(
    context: PolicyRBACContext,
    resource: string,
    action: string,
    additionalConditions?: Record<string, unknown>
  ): RBACEvaluationResult {
    const matchedPermissions: Permission[] = [];
    const deniedPermissions: Permission[] = [];

    for (const permission of context.permissions) {
      // Check if resource matches
      if (this.matchesResource(permission.resource, resource)) {
        // Check if action matches
        if (this.matchesAction(permission.actions, action)) {
          // Check conditions
          if (this.matchesConditions(permission.conditions, {
            ...context.attributes,
            ...additionalConditions,
          })) {
            matchedPermissions.push(permission);
          } else {
            deniedPermissions.push(permission);
          }
        }
      }
    }

    const allowed = matchedPermissions.length > 0;

    const reason = allowed
      ? `Access granted via ${matchedPermissions.length} permission(s)`
      : deniedPermissions.length > 0
      ? 'Permission exists but conditions not met'
      : 'No matching permissions found';

    logger.debug(
      {
        spiffeId: context.spiffeId,
        resource,
        action,
        allowed,
        matchedPermissions: matchedPermissions.length,
      },
      'RBAC evaluation completed'
    );

    return {
      allowed,
      matchedPermissions,
      deniedPermissions,
      reason,
    };
  }

  /**
   * Check if resource pattern matches
   */
  private matchesResource(pattern: string, resource: string): boolean {
    if (pattern === '*') return true;

    // Convert glob pattern to regex
    const regex = new RegExp(
      '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
    );

    return regex.test(resource);
  }

  /**
   * Check if action matches
   */
  private matchesAction(allowedActions: string[], requestedAction: string): boolean {
    if (allowedActions.includes('*')) return true;

    return allowedActions.includes(requestedAction);
  }

  /**
   * Check if conditions match
   */
  private matchesConditions(
    permissionConditions: Record<string, unknown> | undefined,
    actualAttributes: Record<string, unknown>
  ): boolean {
    if (!permissionConditions || Object.keys(permissionConditions).length === 0) {
      return true; // No conditions to check
    }

    for (const [key, expectedValue] of Object.entries(permissionConditions)) {
      const actualValue = actualAttributes[key];

      if (actualValue !== expectedValue) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get role by ID
   */
  getRole(roleId: string): Role | undefined {
    return this.roles.get(roleId);
  }

  /**
   * Get all roles
   */
  getAllRoles(): Role[] {
    return Array.from(this.roles.values());
  }

  /**
   * Get bindings for a SPIFFE ID
   */
  getBindings(spiffeId: string): RoleBinding[] {
    return this.spiffeIdToBindings.get(spiffeId) || [];
  }

  /**
   * Clean up expired bindings
   */
  cleanupExpiredBindings(): number {
    const now = new Date();
    let cleaned = 0;

    for (const [bindingId, binding] of this.bindings.entries()) {
      if (binding.expiresAt && binding.expiresAt <= now) {
        this.unbindRole(bindingId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up expired role bindings');
    }

    return cleaned;
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalRoles: number;
    customRoles: number;
    totalBindings: number;
    uniqueIdentities: number;
  } {
    const customRoles = Array.from(this.roles.values()).filter(
      r => !BUILT_IN_ROLES.some(br => br.roleId === r.roleId)
    ).length;

    return {
      totalRoles: this.roles.size,
      customRoles,
      totalBindings: this.bindings.size,
      uniqueIdentities: this.spiffeIdToBindings.size,
    };
  }
}

// =============================================================================
// Singleton
// =============================================================================

let rbacManager: PolicyRBACManager | null = null;

export function getPolicyRBACManager(): PolicyRBACManager {
  if (!rbacManager) {
    rbacManager = new PolicyRBACManager();
  }
  return rbacManager;
}
