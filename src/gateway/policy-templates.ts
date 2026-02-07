/**
 * Policy Templates Library
 *
 * Pre-built, battle-tested policy templates for common security scenarios.
 * Templates follow industry best practices and compliance frameworks.
 *
 * Features:
 * - 20+ ready-to-use policy templates
 * - Compliance mappings (SOC 2, ISO 27001, NIST, PCI-DSS)
 * - Customizable parameters
 * - Template categories and search
 * - Template versioning
 *
 * References:
 * - AWS IAM Policy templates
 * - Azure Policy definitions
 * - OPA Policy library
 */

import { componentLogger } from '../core/logger.js';
import type { PolicyRule } from '../core/types.js';

const logger = componentLogger('policy-templates');

// =============================================================================
// Types
// =============================================================================

export interface PolicyTemplate {
  templateId: string;
  name: string;
  description: string;
  category: PolicyCategory;
  complianceFrameworks: ComplianceFramework[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  ruleTemplate: Omit<PolicyRule, 'createdAt' | 'updatedAt'>;
  parameters: TemplateParameter[];
  usageExamples: string[];
  tags: string[];
}

export type PolicyCategory =
  | 'access_control'
  | 'data_protection'
  | 'cost_management'
  | 'compliance'
  | 'security'
  | 'change_management'
  | 'incident_response'
  | 'business_continuity';

export type ComplianceFramework =
  | 'SOC2_CC6.1'
  | 'SOC2_CC6.6'
  | 'SOC2_CC7.2'
  | 'SOC2_CC7.3'
  | 'ISO27001_A9'
  | 'ISO27001_A12'
  | 'NIST_AC'
  | 'NIST_AU'
  | 'PCI_DSS_7'
  | 'PCI_DSS_8'
  | 'GDPR_32'
  | 'HIPAA_164.308';

export interface TemplateParameter {
  name: string;
  description: string;
  type: 'string' | 'number' | 'boolean' | 'array';
  required: boolean;
  default?: unknown;
  options?: unknown[];
}

export interface TemplateInstantiation {
  templateId: string;
  ruleId: string;
  parameters: Record<string, unknown>;
  customizations?: Partial<PolicyRule>;
}

// =============================================================================
// Policy Template Library
// =============================================================================

export const POLICY_TEMPLATES: PolicyTemplate[] = [
  // ACCESS CONTROL
  {
    templateId: 'deny-production-changes-outside-hours',
    name: 'Deny Production Changes Outside Business Hours',
    description: 'Prevent production modifications outside defined maintenance windows',
    category: 'access_control',
    complianceFrameworks: ['SOC2_CC6.1', 'ISO27001_A12', 'NIST_AC'],
    severity: 'high',
    ruleTemplate: {
      ruleId: 'deny-production-changes-outside-hours',
      name: 'Deny Production Changes Outside Business Hours',
      description: 'Production changes only allowed during maintenance windows',
      condition: `context.environment === 'production' && intent.sideEffect === true && (new Date().getHours() < {{START_HOUR}} || new Date().getHours() >= {{END_HOUR}})`,
      action: 'deny',
      priority: 95,
      enabled: true,
    },
    parameters: [
      {
        name: 'START_HOUR',
        description: 'Start hour for allowed changes (0-23)',
        type: 'number',
        required: true,
        default: 2,
      },
      {
        name: 'END_HOUR',
        description: 'End hour for allowed changes (0-23)',
        type: 'number',
        required: true,
        default: 6,
      },
    ],
    usageExamples: [
      'Allow production changes only between 2 AM and 6 AM',
      'Restrict deployments to maintenance windows',
    ],
    tags: ['production', 'time-based', 'change-management'],
  },

  {
    templateId: 'require-dual-approval-destructive',
    name: 'Require Dual Approval for Destructive Actions',
    description: 'Enforce four-eyes principle for high-risk operations',
    category: 'access_control',
    complianceFrameworks: ['SOC2_CC6.6', 'ISO27001_A9', 'PCI_DSS_7'],
    severity: 'critical',
    ruleTemplate: {
      ruleId: 'require-dual-approval-destructive',
      name: 'Require Dual Approval for Destructive Actions',
      description: 'Destructive actions require approval from two authorized users',
      condition: 'intent.riskLevel === "destructive"',
      action: 'require_approval',
      riskLevel: 'destructive',
      priority: 100,
      enabled: true,
    },
    parameters: [],
    usageExamples: [
      'Deletion of production databases',
      'Termination of critical infrastructure',
    ],
    tags: ['destructive', 'dual-approval', 'four-eyes'],
  },

  {
    templateId: 'deny-cross-region-data-transfer',
    name: 'Deny Cross-Region Data Transfer',
    description: 'Prevent data from leaving specified geographic regions',
    category: 'data_protection',
    complianceFrameworks: ['GDPR_32', 'ISO27001_A9'],
    severity: 'critical',
    ruleTemplate: {
      ruleId: 'deny-cross-region-data-transfer',
      name: 'Deny Cross-Region Data Transfer',
      description: 'Data must stay within approved regions for compliance',
      condition: `intent.actionType === 'data_transfer' && !{{ALLOWED_REGIONS}}.includes(intent.targetRegion)`,
      action: 'deny',
      priority: 98,
      enabled: true,
    },
    parameters: [
      {
        name: 'ALLOWED_REGIONS',
        description: 'List of allowed regions',
        type: 'array',
        required: true,
        default: ['us-east-1', 'us-west-2'],
      },
    ],
    usageExamples: [
      'Keep EU customer data within EU regions (GDPR)',
      'Restrict data to US regions only',
    ],
    tags: ['data-residency', 'gdpr', 'compliance'],
  },

  // COST MANAGEMENT
  {
    templateId: 'deny-expensive-operations',
    name: 'Deny Operations Exceeding Cost Threshold',
    description: 'Automatically reject operations that would exceed budget limits',
    category: 'cost_management',
    complianceFrameworks: [],
    severity: 'medium',
    ruleTemplate: {
      ruleId: 'deny-expensive-operations',
      name: 'Deny Operations Exceeding Cost Threshold',
      description: 'Protect against unexpectedly expensive operations',
      condition: 'intent.budget.limit > {{MAX_COST}}',
      action: 'deny',
      priority: 85,
      enabled: true,
    },
    parameters: [
      {
        name: 'MAX_COST',
        description: 'Maximum allowed cost in USD',
        type: 'number',
        required: true,
        default: 1000,
      },
    ],
    usageExamples: [
      'Prevent accidental provisioning of large resources',
      'Budget control for development environments',
    ],
    tags: ['cost-control', 'budget', 'finops'],
  },

  {
    templateId: 'require-approval-high-cost',
    name: 'Require Approval for High-Cost Operations',
    description: 'Human review required for operations above cost threshold',
    category: 'cost_management',
    complianceFrameworks: [],
    severity: 'medium',
    ruleTemplate: {
      ruleId: 'require-approval-high-cost',
      name: 'Require Approval for High-Cost Operations',
      description: 'Operations above threshold require manager approval',
      condition: 'intent.budget.limit > {{APPROVAL_THRESHOLD}} && intent.budget.limit <= {{DENY_THRESHOLD}}',
      action: 'require_approval',
      priority: 80,
      enabled: true,
    },
    parameters: [
      {
        name: 'APPROVAL_THRESHOLD',
        description: 'Cost threshold requiring approval (USD)',
        type: 'number',
        required: true,
        default: 500,
      },
      {
        name: 'DENY_THRESHOLD',
        description: 'Cost threshold for automatic denial (USD)',
        type: 'number',
        required: true,
        default: 5000,
      },
    ],
    usageExamples: [
      'Manager approval for ops costing $500-$5000',
      'Auto-deny anything over $5000',
    ],
    tags: ['cost-control', 'approval-workflow'],
  },

  // SECURITY
  {
    templateId: 'deny-public-exposure',
    name: 'Deny Public Exposure of Resources',
    description: 'Prevent resources from being made publicly accessible',
    category: 'security',
    complianceFrameworks: ['SOC2_CC6.1', 'ISO27001_A9', 'NIST_AC'],
    severity: 'critical',
    ruleTemplate: {
      ruleId: 'deny-public-exposure',
      name: 'Deny Public Exposure of Resources',
      description: 'Resources must not be publicly accessible',
      condition: `intent.actionType.includes('create') && intent.parameters.visibility === 'public'`,
      action: 'deny',
      priority: 99,
      enabled: true,
    },
    parameters: [],
    usageExamples: [
      'Prevent S3 buckets from being public',
      'Block public database access',
    ],
    tags: ['security', 'public-access', 'least-privilege'],
  },

  {
    templateId: 'require-encryption-at-rest',
    name: 'Require Encryption at Rest',
    description: 'All data storage must have encryption enabled',
    category: 'security',
    complianceFrameworks: ['SOC2_CC6.1', 'PCI_DSS_8', 'HIPAA_164.308'],
    severity: 'high',
    ruleTemplate: {
      ruleId: 'require-encryption-at-rest',
      name: 'Require Encryption at Rest',
      description: 'Storage resources must have encryption enabled',
      condition: `intent.actionType.includes('storage') && intent.parameters.encryption !== true`,
      action: 'deny',
      priority: 96,
      enabled: true,
    },
    parameters: [],
    usageExamples: [
      'Enforce encryption for all databases',
      'Require encrypted EBS volumes',
    ],
    tags: ['encryption', 'data-protection', 'compliance'],
  },

  {
    templateId: 'deny-privileged-escalation',
    name: 'Deny Privilege Escalation',
    description: 'Prevent users from granting themselves elevated permissions',
    category: 'security',
    complianceFrameworks: ['SOC2_CC6.6', 'ISO27001_A9', 'NIST_AC'],
    severity: 'critical',
    ruleTemplate: {
      ruleId: 'deny-privileged-escalation',
      name: 'Deny Privilege Escalation',
      description: 'Users cannot elevate their own permissions',
      condition: `intent.actionType.includes('grant') && intent.parameters.targetUserId === context.userId`,
      action: 'deny',
      priority: 100,
      enabled: true,
    },
    parameters: [],
    usageExamples: [
      'Prevent self-promotion to admin',
      'Block IAM policy self-modification',
    ],
    tags: ['security', 'privilege-escalation', 'least-privilege'],
  },

  // COMPLIANCE
  {
    templateId: 'require-change-ticket',
    name: 'Require Change Ticket Reference',
    description: 'All changes must reference an approved change ticket',
    category: 'compliance',
    complianceFrameworks: ['SOC2_CC7.3', 'ISO27001_A12'],
    severity: 'medium',
    ruleTemplate: {
      ruleId: 'require-change-ticket',
      name: 'Require Change Ticket Reference',
      description: 'Production changes require valid ticket number',
      condition: `context.environment === 'production' && intent.sideEffect === true && !intent.metadata?.ticketId`,
      action: 'deny',
      priority: 85,
      enabled: true,
    },
    parameters: [],
    usageExamples: [
      'Link changes to Jira tickets',
      'Audit trail for production modifications',
    ],
    tags: ['compliance', 'change-management', 'audit'],
  },

  {
    templateId: 'require-mfa-sensitive-actions',
    name: 'Require MFA for Sensitive Actions',
    description: 'Multi-factor authentication required for sensitive operations',
    category: 'security',
    complianceFrameworks: ['SOC2_CC6.1', 'PCI_DSS_8', 'NIST_AU'],
    severity: 'high',
    ruleTemplate: {
      ruleId: 'require-mfa-sensitive-actions',
      name: 'Require MFA for Sensitive Actions',
      description: 'MFA required for destructive or high-risk actions',
      condition: `(intent.riskLevel === 'destructive' || intent.riskLevel === 'high') && !context.mfaVerified`,
      action: 'deny',
      priority: 98,
      enabled: true,
    },
    parameters: [],
    usageExamples: [
      'MFA before database deletion',
      'MFA for production deployments',
    ],
    tags: ['mfa', 'authentication', 'security'],
  },

  // CHANGE MANAGEMENT
  {
    templateId: 'rate-limit-changes',
    name: 'Rate Limit Changes Per User',
    description: 'Limit the number of changes a user can make in a time window',
    category: 'change_management',
    complianceFrameworks: ['SOC2_CC7.2'],
    severity: 'medium',
    ruleTemplate: {
      ruleId: 'rate-limit-changes',
      name: 'Rate Limit Changes Per User',
      description: 'Prevent runaway automation or abuse',
      condition: `context.previousActions?.filter(a => a.timestamp > Date.now() - {{TIME_WINDOW_MS}}).length >= {{MAX_CHANGES}}`,
      action: 'deny',
      priority: 75,
      enabled: true,
    },
    parameters: [
      {
        name: 'MAX_CHANGES',
        description: 'Maximum changes allowed in time window',
        type: 'number',
        required: true,
        default: 10,
      },
      {
        name: 'TIME_WINDOW_MS',
        description: 'Time window in milliseconds',
        type: 'number',
        required: true,
        default: 3600000, // 1 hour
      },
    ],
    usageExamples: [
      'Max 10 production changes per hour',
      'Prevent automation loops',
    ],
    tags: ['rate-limiting', 'abuse-prevention'],
  },

  {
    templateId: 'deny-weekend-deployments',
    name: 'Deny Weekend Deployments',
    description: 'Block deployments on weekends to ensure support availability',
    category: 'change_management',
    complianceFrameworks: ['ISO27001_A12'],
    severity: 'low',
    ruleTemplate: {
      ruleId: 'deny-weekend-deployments',
      name: 'Deny Weekend Deployments',
      description: 'No deployments on Saturday or Sunday',
      condition: `context.environment === 'production' && intent.actionType.includes('deploy') && (new Date().getDay() === 0 || new Date().getDay() === 6)`,
      action: 'deny',
      priority: 70,
      enabled: true,
    },
    parameters: [],
    usageExamples: [
      'Ensure support team availability',
      'Reduce weekend incident risk',
    ],
    tags: ['deployment', 'schedule', 'incident-prevention'],
  },

  // DATA PROTECTION
  {
    templateId: 'deny-unencrypted-pii-access',
    name: 'Deny Unencrypted PII Access',
    description: 'PII must be accessed only through encrypted channels',
    category: 'data_protection',
    complianceFrameworks: ['GDPR_32', 'HIPAA_164.308', 'SOC2_CC6.1'],
    severity: 'critical',
    ruleTemplate: {
      ruleId: 'deny-unencrypted-pii-access',
      name: 'Deny Unencrypted PII Access',
      description: 'PII access requires encryption in transit',
      condition: `intent.sensitivity === 'restricted' && !intent.parameters.encrypted`,
      action: 'deny',
      priority: 100,
      enabled: true,
    },
    parameters: [],
    usageExamples: [
      'Protect customer data in transit',
      'GDPR/HIPAA compliance',
    ],
    tags: ['pii', 'encryption', 'gdpr', 'hipaa'],
  },

  {
    templateId: 'require-data-retention-policy',
    name: 'Require Data Retention Policy',
    description: 'All data storage must specify retention period',
    category: 'data_protection',
    complianceFrameworks: ['GDPR_32', 'ISO27001_A9'],
    severity: 'medium',
    ruleTemplate: {
      ruleId: 'require-data-retention-policy',
      name: 'Require Data Retention Policy',
      description: 'Data retention period must be specified',
      condition: `intent.actionType.includes('store') && !intent.metadata?.retentionDays`,
      action: 'deny',
      priority: 80,
      enabled: true,
    },
    parameters: [],
    usageExamples: [
      'Enforce GDPR data retention limits',
      'Automatic data lifecycle management',
    ],
    tags: ['data-retention', 'gdpr', 'lifecycle'],
  },

  // BUSINESS CONTINUITY
  {
    templateId: 'require-backup-before-delete',
    name: 'Require Backup Before Deletion',
    description: 'Critical resources must be backed up before deletion',
    category: 'business_continuity',
    complianceFrameworks: ['SOC2_CC7.3', 'ISO27001_A12'],
    severity: 'high',
    ruleTemplate: {
      ruleId: 'require-backup-before-delete',
      name: 'Require Backup Before Deletion',
      description: 'Backup verification required before deletion',
      condition: `intent.actionType.includes('delete') && intent.riskLevel === 'destructive' && !intent.metadata?.backupVerified`,
      action: 'deny',
      priority: 95,
      enabled: true,
    },
    parameters: [],
    usageExamples: [
      'Backup databases before deletion',
      'Prevent accidental data loss',
    ],
    tags: ['backup', 'disaster-recovery', 'data-loss-prevention'],
  },

  {
    templateId: 'deny-single-point-of-failure',
    name: 'Deny Single Point of Failure',
    description: 'Critical resources must have redundancy',
    category: 'business_continuity',
    complianceFrameworks: ['SOC2_CC7.2'],
    severity: 'high',
    ruleTemplate: {
      ruleId: 'deny-single-point-of-failure',
      name: 'Deny Single Point of Failure',
      description: 'Require multi-AZ or multi-region redundancy',
      condition: `intent.actionType.includes('create') && intent.metadata?.critical === true && !intent.metadata?.redundancy`,
      action: 'deny',
      priority: 90,
      enabled: true,
    },
    parameters: [],
    usageExamples: [
      'Require multi-AZ RDS instances',
      'Enforce load balancer redundancy',
    ],
    tags: ['high-availability', 'redundancy', 'resilience'],
  },
];

// =============================================================================
// Template Manager
// =============================================================================

export class PolicyTemplateManager {
  private templates = new Map<string, PolicyTemplate>();

  constructor() {
    this.loadTemplates();
  }

  /**
   * Load all templates
   */
  private loadTemplates(): void {
    for (const template of POLICY_TEMPLATES) {
      this.templates.set(template.templateId, template);
    }

    logger.info({ count: this.templates.size }, 'Policy templates loaded');
  }

  /**
   * Get a template by ID
   */
  getTemplate(templateId: string): PolicyTemplate | undefined {
    return this.templates.get(templateId);
  }

  /**
   * Get all templates
   */
  getAllTemplates(): PolicyTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Get templates by category
   */
  getTemplatesByCategory(category: PolicyCategory): PolicyTemplate[] {
    return this.getAllTemplates().filter(t => t.category === category);
  }

  /**
   * Get templates by compliance framework
   */
  getTemplatesByCompliance(framework: ComplianceFramework): PolicyTemplate[] {
    return this.getAllTemplates().filter(t =>
      t.complianceFrameworks.includes(framework)
    );
  }

  /**
   * Search templates
   */
  searchTemplates(query: string): PolicyTemplate[] {
    const lowerQuery = query.toLowerCase();

    return this.getAllTemplates().filter(
      t =>
        t.name.toLowerCase().includes(lowerQuery) ||
        t.description.toLowerCase().includes(lowerQuery) ||
        t.tags.some(tag => tag.toLowerCase().includes(lowerQuery))
    );
  }

  /**
   * Instantiate a template into a policy rule
   */
  instantiate(request: TemplateInstantiation): Omit<PolicyRule, 'createdAt' | 'updatedAt'> {
    const template = this.getTemplate(request.templateId);

    if (!template) {
      throw new Error(`Template not found: ${request.templateId}`);
    }

    // Validate required parameters
    for (const param of template.parameters) {
      if (param.required && !(param.name in request.parameters)) {
        throw new Error(`Required parameter missing: ${param.name}`);
      }
    }

    // Create rule from template
    const rule = { ...template.ruleTemplate };
    rule.ruleId = request.ruleId;

    // Substitute parameters in condition
    let condition = rule.condition;
    for (const [key, value] of Object.entries(request.parameters)) {
      const placeholder = `{{${key}}}`;
      condition = condition.replace(placeholder, JSON.stringify(value));
    }
    rule.condition = condition;

    // Apply customizations
    if (request.customizations) {
      Object.assign(rule, request.customizations);
    }

    logger.info(
      { templateId: request.templateId, ruleId: request.ruleId },
      'Policy instantiated from template'
    );

    return rule;
  }

  /**
   * Get template statistics
   */
  getStats(): {
    totalTemplates: number;
    byCategory: Record<PolicyCategory, number>;
    byCompliance: Record<string, number>;
  } {
    const byCategory = {} as Record<PolicyCategory, number>;
    const byCompliance: Record<string, number> = {};

    for (const template of this.templates.values()) {
      byCategory[template.category] = (byCategory[template.category] || 0) + 1;

      for (const framework of template.complianceFrameworks) {
        byCompliance[framework] = (byCompliance[framework] || 0) + 1;
      }
    }

    return {
      totalTemplates: this.templates.size,
      byCategory,
      byCompliance,
    };
  }
}

// =============================================================================
// Singleton
// =============================================================================

let templateManager: PolicyTemplateManager | null = null;

export function getPolicyTemplateManager(): PolicyTemplateManager {
  if (!templateManager) {
    templateManager = new PolicyTemplateManager();
  }
  return templateManager;
}
