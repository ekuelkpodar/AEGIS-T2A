/**
 * Compliance control mappings across frameworks.
 */

export interface ControlMapping {
  framework: string;
  controlId: string;
  name: string;
  description: string;
  relatedControls: string[];
  evidenceSources: string[];
}

const MAPPINGS: ControlMapping[] = [
  {
    framework: 'SOC2',
    controlId: 'CC6.1',
    name: 'Logical and Physical Access Controls',
    description: 'Access provisioning and authorization controls',
    relatedControls: ['NIST-800-53:AC-2', 'ISO-42001:A.5.2'],
    evidenceSources: ['identity/spiffe', 'identity/scopes', 'identity/attestors'],
  },
  {
    framework: 'SOC2',
    controlId: 'CC6.6',
    name: 'Logical Access - Authentication',
    description: 'Authentication and credential management',
    relatedControls: ['NIST-800-53:IA-2', 'ISO-42001:A.6.3'],
    evidenceSources: ['identity/workload-iam', 'identity/delegation'],
  },
  {
    framework: 'SOC2',
    controlId: 'CC7.2',
    name: 'System Monitoring',
    description: 'Monitoring and detection of anomalies',
    relatedControls: ['NIST-800-53:SI-4', 'ISO-42001:A.7.2'],
    evidenceSources: ['audit/ledger', 'gateway/confidence-telemetry'],
  },
  {
    framework: 'GDPR',
    controlId: 'Art.30',
    name: 'Records of Processing Activities',
    description: 'Maintain RoPA for processing activities',
    relatedControls: ['ISO-42001:A.8.2'],
    evidenceSources: ['compliance/ropa'],
  },
  {
    framework: 'GDPR',
    controlId: 'Art.35',
    name: 'Data Protection Impact Assessment',
    description: 'Perform DPIA for high-risk processing',
    relatedControls: ['NIST-AI-RMF:MAP-2', 'ISO-42001:A.8.4'],
    evidenceSources: ['compliance/dpia'],
  },
  {
    framework: 'EU-AI-ACT',
    controlId: 'Art.9',
    name: 'Risk Management System',
    description: 'Documented AI risk assessment and mitigation',
    relatedControls: ['NIST-AI-RMF:MANAGE-1'],
    evidenceSources: ['simulation/blast-radius', 'policy/opa'],
  },
  {
    framework: 'EU-AI-ACT',
    controlId: 'Art.14',
    name: 'Human Oversight',
    description: 'Human approval and intervention mechanisms',
    relatedControls: ['ISO-42001:A.9.1'],
    evidenceSources: ['controlplane/approvals'],
  },
  {
    framework: 'NIST-AI-RMF',
    controlId: 'GOV-1',
    name: 'AI Governance Policies',
    description: 'Policies and accountability for AI systems',
    relatedControls: ['ISO-42001:Clause-5'],
    evidenceSources: ['governance/policy-engine', 'audit/ledger'],
  },
  {
    framework: 'HIPAA',
    controlId: '164.312(a)(1)',
    name: 'Access Control',
    description: 'Unique user identification and access control',
    relatedControls: ['NIST-800-53:AC-3'],
    evidenceSources: ['identity/spiffe', 'identity/scopes'],
  },
  {
    framework: 'HIPAA',
    controlId: '164.312(b)',
    name: 'Audit Controls',
    description: 'Hardware, software, and procedural mechanisms to record activity',
    relatedControls: ['SOC2:CC7.2'],
    evidenceSources: ['audit/ledger'],
  },
];

export function listControlMappings(): ControlMapping[] {
  return [...MAPPINGS];
}

export function listControlMappingsByFramework(framework: string): ControlMapping[] {
  return MAPPINGS.filter((mapping) => mapping.framework.toLowerCase() === framework.toLowerCase());
}
