/**
 * Policy Compliance Mapper
 *
 * Maps policies to compliance frameworks and generates compliance reports.
 * Helps organizations meet regulatory requirements.
 *
 * Features:
 * - SOC 2, ISO 27001, NIST, PCI-DSS, GDPR, HIPAA mappings
 * - Compliance coverage analysis
 * - Gap identification
 * - Evidence collection
 * - Automated reporting
 *
 * References:
 * - AWS Audit Manager
 * - Azure Compliance Manager
 * - Vanta, Drata compliance automation
 */

import { componentLogger } from '../core/logger.js';
import type { PolicyRule } from '../core/types.js';

const logger = componentLogger('policy-compliance-mapper');

// =============================================================================
// Types
// =============================================================================

export interface ComplianceControl {
  controlId: string;
  framework: ComplianceFramework;
  title: string;
  description: string;
  category: string;
  requiresEvidence: boolean;
}

export type ComplianceFramework =
  | 'SOC2'
  | 'ISO27001'
  | 'NIST_800_53'
  | 'PCI_DSS'
  | 'GDPR'
  | 'HIPAA'
  | 'FedRAMP';

export interface PolicyComplianceMapping {
  ruleId: string;
  controls: string[]; // Control IDs
  coverage: 'full' | 'partial' | 'none';
  evidence: string[];
  lastVerified?: Date;
}

export interface ComplianceReport {
  framework: ComplianceFramework;
  generatedAt: Date;
  summary: {
    totalControls: number;
    coveredControls: number;
    partiallyCoveredControls: number;
    uncoveredControls: number;
    coveragePercentage: number;
  };
  controlStatus: Array<{
    control: ComplianceControl;
    status: 'covered' | 'partial' | 'gap';
    mappedPolicies: string[];
    evidence: string[];
  }>;
  gaps: ComplianceGap[];
  recommendations: string[];
}

export interface ComplianceGap {
  control: ComplianceControl;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  suggestedPolicies: string[];
}

// =============================================================================
// Compliance Controls Database
// =============================================================================

export const COMPLIANCE_CONTROLS: Record<string, ComplianceControl> = {
  // SOC 2
  'SOC2_CC6.1': {
    controlId: 'SOC2_CC6.1',
    framework: 'SOC2',
    title: 'Logical and Physical Access Controls',
    description: 'The entity implements logical access security software, infrastructure, and architectures over protected information assets to protect them from security events',
    category: 'Access Control',
    requiresEvidence: true,
  },
  'SOC2_CC6.6': {
    controlId: 'SOC2_CC6.6',
    framework: 'SOC2',
    title: 'Access Authorization',
    description: 'The entity implements logical access security measures to protect against threats',
    category: 'Authorization',
    requiresEvidence: true,
  },
  'SOC2_CC7.2': {
    controlId: 'SOC2_CC7.2',
    framework: 'SOC2',
    title: 'System Monitoring',
    description: 'The entity monitors system components and the operation of those components',
    category: 'Monitoring',
    requiresEvidence: true,
  },
  'SOC2_CC7.3': {
    controlId: 'SOC2_CC7.3',
    framework: 'SOC2',
    title: 'Change Management',
    description: 'The entity evaluates security events to determine whether they could impact the system',
    category: 'Change Management',
    requiresEvidence: true,
  },

  // ISO 27001
  'ISO27001_A.9.1.2': {
    controlId: 'ISO27001_A.9.1.2',
    framework: 'ISO27001',
    title: 'Access to networks and network services',
    description: 'Users shall only be provided with access to the network and network services that they have been specifically authorized to use',
    category: 'Access Control',
    requiresEvidence: true,
  },
  'ISO27001_A.9.2.3': {
    controlId: 'ISO27001_A.9.2.3',
    framework: 'ISO27001',
    title: 'Management of privileged access rights',
    description: 'The allocation and use of privileged access rights shall be restricted and controlled',
    category: 'Access Control',
    requiresEvidence: true,
  },

  // NIST 800-53
  'NIST_AC-2': {
    controlId: 'NIST_AC-2',
    framework: 'NIST_800_53',
    title: 'Account Management',
    description: 'Organization manages information system accounts',
    category: 'Access Control',
    requiresEvidence: true,
  },
  'NIST_AC-3': {
    controlId: 'NIST_AC-3',
    framework: 'NIST_800_53',
    title: 'Access Enforcement',
    description: 'Information system enforces approved authorizations',
    category: 'Access Control',
    requiresEvidence: true,
  },

  // PCI DSS
  'PCI_7.1': {
    controlId: 'PCI_7.1',
    framework: 'PCI_DSS',
    title: 'Limit access to system components',
    description: 'Limit access to system components and cardholder data to only those individuals whose job requires such access',
    category: 'Access Control',
    requiresEvidence: true,
  },
  'PCI_8.1': {
    controlId: 'PCI_8.1',
    framework: 'PCI_DSS',
    title: 'Identify and authenticate access',
    description: 'Define and implement policies and procedures to ensure proper user identification management',
    category: 'Authentication',
    requiresEvidence: true,
  },

  // GDPR
  'GDPR_32': {
    controlId: 'GDPR_32',
    framework: 'GDPR',
    title: 'Security of Processing',
    description: 'Implement appropriate technical and organizational measures to ensure a level of security appropriate to the risk',
    category: 'Data Protection',
    requiresEvidence: true,
  },

  // HIPAA
  'HIPAA_164.308': {
    controlId: 'HIPAA_164.308',
    framework: 'HIPAA',
    title: 'Administrative Safeguards',
    description: 'Implement policies and procedures to prevent, detect, contain, and correct security violations',
    category: 'Administrative',
    requiresEvidence: true,
  },
};

// =============================================================================
// Compliance Mapper
// =============================================================================

export class PolicyComplianceMapper {
  private mappings = new Map<string, PolicyComplianceMapping>();

  /**
   * Map a policy to compliance controls
   */
  mapPolicy(
    ruleId: string,
    controls: string[],
    coverage: PolicyComplianceMapping['coverage'],
    evidence: string[] = []
  ): void {
    // Validate controls exist
    for (const controlId of controls) {
      if (!COMPLIANCE_CONTROLS[controlId]) {
        logger.warn({ controlId }, 'Unknown compliance control');
      }
    }

    this.mappings.set(ruleId, {
      ruleId,
      controls,
      coverage,
      evidence,
      lastVerified: new Date(),
    });

    logger.debug({ ruleId, controls: controls.length }, 'Policy mapped to compliance controls');
  }

  /**
   * Auto-map policies based on keywords and patterns
   */
  autoMapPolicies(policies: PolicyRule[]): void {
    for (const policy of policies) {
      const controls = this.detectControls(policy);

      if (controls.length > 0) {
        this.mapPolicy(policy.ruleId, controls, 'partial', [
          `Auto-detected from policy: ${policy.name}`,
        ]);
      }
    }

    logger.info({ policiesProcessed: policies.length }, 'Auto-mapping completed');
  }

  /**
   * Detect applicable controls from policy content
   */
  private detectControls(policy: PolicyRule): string[] {
    const controls: string[] = [];
    const content = `${policy.name} ${policy.description} ${policy.condition}`.toLowerCase();

    // Access control
    if (content.includes('access') || content.includes('authorization')) {
      controls.push('SOC2_CC6.1', 'ISO27001_A.9.1.2', 'NIST_AC-3');
    }

    // Approval required
    if (content.includes('approval')) {
      controls.push('SOC2_CC6.6', 'ISO27001_A.9.2.3');
    }

    // Monitoring/auditing
    if (content.includes('audit') || content.includes('log')) {
      controls.push('SOC2_CC7.2');
    }

    // Change management
    if (content.includes('production') || content.includes('change')) {
      controls.push('SOC2_CC7.3');
    }

    // PII/data protection
    if (content.includes('pii') || content.includes('encrypt')) {
      controls.push('GDPR_32', 'HIPAA_164.308');
    }

    return [...new Set(controls)]; // Remove duplicates
  }

  /**
   * Generate compliance report
   */
  generateReport(framework: ComplianceFramework, policies: PolicyRule[]): ComplianceReport {
    // Get all controls for this framework
    const frameworkControls = Object.values(COMPLIANCE_CONTROLS).filter(
      c => c.framework === framework
    );

    const controlStatus = frameworkControls.map(control => {
      // Find policies mapped to this control
      const mappedPolicies: string[] = [];
      const evidence: string[] = [];

      for (const [ruleId, mapping] of this.mappings.entries()) {
        if (mapping.controls.includes(control.controlId)) {
          mappedPolicies.push(ruleId);
          evidence.push(...mapping.evidence);
        }
      }

      const status: 'covered' | 'partial' | 'gap' =
        mappedPolicies.length === 0 ? 'gap' : mappedPolicies.length >= 2 ? 'covered' : 'partial';

      return {
        control,
        status,
        mappedPolicies,
        evidence,
      };
    });

    // Calculate summary
    const covered = controlStatus.filter(c => c.status === 'covered').length;
    const partial = controlStatus.filter(c => c.status === 'partial').length;
    const gaps = controlStatus.filter(c => c.status === 'gap').length;

    const summary = {
      totalControls: frameworkControls.length,
      coveredControls: covered,
      partiallyCoveredControls: partial,
      uncoveredControls: gaps,
      coveragePercentage:
        frameworkControls.length > 0
          ? ((covered + partial * 0.5) / frameworkControls.length) * 100
          : 0,
    };

    // Identify gaps
    const complianceGaps: ComplianceGap[] = controlStatus
      .filter(c => c.status === 'gap' || c.status === 'partial')
      .map(c => ({
        control: c.control,
        severity: c.status === 'gap' ? 'high' : 'medium',
        description: `${c.control.title} is ${c.status === 'gap' ? 'not covered' : 'partially covered'}`,
        suggestedPolicies: this.suggestPoliciesForControl(c.control),
      }));

    // Generate recommendations
    const recommendations = this.generateRecommendations(summary, complianceGaps);

    logger.info(
      {
        framework,
        coverage: summary.coveragePercentage,
        gaps: gaps,
      },
      'Compliance report generated'
    );

    return {
      framework,
      generatedAt: new Date(),
      summary,
      controlStatus,
      gaps: complianceGaps,
      recommendations,
    };
  }

  /**
   * Suggest policies for a control
   */
  private suggestPoliciesForControl(control: ComplianceControl): string[] {
    const suggestions: string[] = [];

    if (control.category === 'Access Control') {
      suggestions.push('require-dual-approval-destructive', 'deny-production-without-approval');
    }

    if (control.category === 'Data Protection') {
      suggestions.push('require-encryption-at-rest', 'deny-unencrypted-pii-access');
    }

    if (control.category === 'Change Management') {
      suggestions.push('require-change-ticket', 'deny-production-changes-outside-hours');
    }

    return suggestions;
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(
    summary: ComplianceReport['summary'],
    gaps: ComplianceGap[]
  ): string[] {
    const recommendations: string[] = [];

    if (summary.coveragePercentage < 50) {
      recommendations.push(
        `⚠️  Low compliance coverage (${summary.coveragePercentage.toFixed(1)}%). Immediate attention required.`
      );
    } else if (summary.coveragePercentage < 80) {
      recommendations.push(
        `⚡ Moderate compliance coverage (${summary.coveragePercentage.toFixed(1)}%). Review and address gaps.`
      );
    } else {
      recommendations.push(
        `✅ Good compliance coverage (${summary.coveragePercentage.toFixed(1)}%).`
      );
    }

    const criticalGaps = gaps.filter(g => g.severity === 'high' || g.severity === 'critical');
    if (criticalGaps.length > 0) {
      recommendations.push(
        `🚨 ${criticalGaps.length} critical compliance gaps require immediate remediation.`
      );
    }

    if (summary.uncoveredControls > 0) {
      recommendations.push(
        `📋 ${summary.uncoveredControls} controls have no policy coverage. Create policies to address these gaps.`
      );
    }

    return recommendations;
  }

  /**
   * Get mappings for a policy
   */
  getPolicyMapping(ruleId: string): PolicyComplianceMapping | undefined {
    return this.mappings.get(ruleId);
  }

  /**
   * Get all mappings
   */
  getAllMappings(): PolicyComplianceMapping[] {
    return Array.from(this.mappings.values());
  }
}

// =============================================================================
// Singleton
// =============================================================================

let complianceMapper: PolicyComplianceMapper | null = null;

export function getPolicyComplianceMapper(): PolicyComplianceMapper {
  if (!complianceMapper) {
    complianceMapper = new PolicyComplianceMapper();
  }
  return complianceMapper;
}
