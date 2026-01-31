/**
 * AEGIS-T2A Intent Validation Sandbox
 *
 * Performs static analysis and sandboxed validation of parsed intents
 * before they proceed to execution. Detects potentially dangerous patterns,
 * resource escalation attempts, and policy violations.
 */

import { EventEmitter } from 'events';
import {
  TypedIntent,
  RiskLevel,
  Sensitivity,
} from '../core/types.js';
import { componentLogger } from '../core/logger.js';
import { hashObject } from '../core/crypto.js';

const logger = componentLogger('intent-sandbox');

// =============================================================================
// Types
// =============================================================================

export interface SandboxConfig {
  /** Maximum analysis time in milliseconds */
  analysis_timeout_ms: number;
  /** Enable static pattern analysis */
  enable_static_analysis: boolean;
  /** Enable semantic validation */
  enable_semantic_validation: boolean;
  /** Enable resource scope validation */
  enable_scope_validation: boolean;
  /** Maximum resource count per intent */
  max_resources_per_intent: number;
  /** Maximum parameter depth */
  max_parameter_depth: number;
  /** Maximum parameter size in bytes */
  max_parameter_size_bytes: number;
  /** Dangerous patterns to detect */
  dangerous_patterns: DangerousPattern[];
  /** Allowed resource prefixes by sensitivity level */
  resource_restrictions: Record<Sensitivity, string[]>;
  /** Shadow mode - log but don't block */
  shadow_mode: boolean;
}

export interface DangerousPattern {
  id: string;
  name: string;
  description: string;
  pattern: RegExp | string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: PatternCategory;
  mitigation: string;
}

export type PatternCategory =
  | 'injection'
  | 'escalation'
  | 'data_exfiltration'
  | 'resource_abuse'
  | 'credential_exposure'
  | 'bypass_attempt'
  | 'destructive_operation';

export interface ValidationResult {
  valid: boolean;
  intent_id: string;
  validation_id: string;
  timestamp: string;
  checks: ValidationCheck[];
  violations: ValidationViolation[];
  warnings: ValidationWarning[];
  risk_assessment: RiskAssessment;
  recommendations: string[];
  analysis_time_ms: number;
}

export interface ValidationCheck {
  check_id: string;
  name: string;
  category: string;
  passed: boolean;
  details?: string;
}

export interface ValidationViolation {
  violation_id: string;
  check_id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: PatternCategory;
  description: string;
  evidence: string;
  location?: string;
  mitigation: string;
}

export interface ValidationWarning {
  warning_id: string;
  category: string;
  message: string;
  suggestion?: string;
}

export interface RiskAssessment {
  overall_risk: RiskLevel;
  confidence: number;
  factors: RiskFactor[];
  score: number;
}

export interface RiskFactor {
  name: string;
  weight: number;
  score: number;
  description: string;
}

export interface SandboxContext {
  user_id: string;
  user_roles: string[];
  environment: 'development' | 'staging' | 'production';
  session_id?: string;
  previous_intents?: string[];
}

// =============================================================================
// Default Configuration
// =============================================================================

export const defaultSandboxConfig: SandboxConfig = {
  analysis_timeout_ms: 5000,
  enable_static_analysis: true,
  enable_semantic_validation: true,
  enable_scope_validation: true,
  max_resources_per_intent: 50,
  max_parameter_depth: 10,
  max_parameter_size_bytes: 1024 * 1024, // 1MB
  shadow_mode: false,
  dangerous_patterns: [
    // Injection patterns
    {
      id: 'sql-injection',
      name: 'SQL Injection',
      description: 'Potential SQL injection attempt detected',
      pattern: /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|OR|AND)\b.*['";])|(['"].*--)|(\bEXEC\b)|(\bxp_)/gi,
      severity: 'critical',
      category: 'injection',
      mitigation: 'Sanitize inputs and use parameterized queries',
    },
    {
      id: 'command-injection',
      name: 'Command Injection',
      description: 'Potential command injection attempt detected',
      pattern: /[;&|`$]|\$\(|`.*`|>\s*\/|<\s*\/|\\n.*[;&|]/g,
      severity: 'critical',
      category: 'injection',
      mitigation: 'Avoid shell execution or use strict input validation',
    },
    {
      id: 'path-traversal',
      name: 'Path Traversal',
      description: 'Potential path traversal attempt detected',
      pattern: /\.\.\/|\.\.\\|%2e%2e%2f|%2e%2e\/|\.%2e\//gi,
      severity: 'high',
      category: 'injection',
      mitigation: 'Validate and sanitize file paths',
    },
    {
      id: 'ldap-injection',
      name: 'LDAP Injection',
      description: 'Potential LDAP injection attempt detected',
      pattern: /[()\\*\x00]|\\\x2a|\x5c\x28|\x5c\x29/g,
      severity: 'high',
      category: 'injection',
      mitigation: 'Escape LDAP special characters',
    },
    {
      id: 'template-injection',
      name: 'Template Injection',
      description: 'Potential template injection attempt detected',
      pattern: /\{\{.*\}\}|\$\{.*\}|<%.*%>|\[\[.*\]\]/g,
      severity: 'high',
      category: 'injection',
      mitigation: 'Sanitize template expressions',
    },

    // Escalation patterns
    {
      id: 'privilege-escalation',
      name: 'Privilege Escalation',
      description: 'Potential privilege escalation attempt',
      pattern: /sudo|su\s+-|chmod\s+[0-7]*[46-7][0-7]{2}|chown.*root|setuid|setgid|capabilities/gi,
      severity: 'critical',
      category: 'escalation',
      mitigation: 'Restrict privilege-changing operations',
    },
    {
      id: 'role-manipulation',
      name: 'Role Manipulation',
      description: 'Attempt to modify or assume elevated roles',
      pattern: /admin|root|superuser|system|operator|elevated|privileged/gi,
      severity: 'high',
      category: 'escalation',
      mitigation: 'Enforce strict role-based access control',
    },

    // Data exfiltration patterns
    {
      id: 'bulk-data-access',
      name: 'Bulk Data Access',
      description: 'Potential bulk data exfiltration attempt',
      pattern: /SELECT\s+\*|LIMIT\s+\d{5,}|export.*all|dump.*database|backup.*full/gi,
      severity: 'high',
      category: 'data_exfiltration',
      mitigation: 'Implement data access limits and monitoring',
    },
    {
      id: 'external-transfer',
      name: 'External Data Transfer',
      description: 'Potential data transfer to external location',
      pattern: /curl\s+.*-d|wget.*-O|ftp\s+|scp\s+|rsync.*:/gi,
      severity: 'high',
      category: 'data_exfiltration',
      mitigation: 'Restrict external data transfers',
    },

    // Credential exposure patterns
    {
      id: 'credential-in-param',
      name: 'Credential in Parameter',
      description: 'Potential credential or secret in parameters',
      pattern: /password|passwd|secret|api[_-]?key|token|bearer|auth|credential/gi,
      severity: 'medium',
      category: 'credential_exposure',
      mitigation: 'Use secure credential management',
    },
    {
      id: 'hardcoded-secret',
      name: 'Hardcoded Secret',
      description: 'Potential hardcoded secret detected',
      pattern: /AKIA[0-9A-Z]{16}|-----BEGIN.*PRIVATE KEY-----/g,
      severity: 'critical',
      category: 'credential_exposure',
      mitigation: 'Remove hardcoded secrets and use vault',
    },

    // Destructive operation patterns
    {
      id: 'mass-deletion',
      name: 'Mass Deletion',
      description: 'Potential mass deletion operation',
      pattern: /delete.*all|rm\s+-rf|DROP\s+(TABLE|DATABASE)|truncate|purge.*all/gi,
      severity: 'critical',
      category: 'destructive_operation',
      mitigation: 'Require explicit approval for bulk deletions',
    },
    {
      id: 'infrastructure-destroy',
      name: 'Infrastructure Destruction',
      description: 'Potential infrastructure destruction operation',
      pattern: /terminate.*instance|destroy.*cluster|delete.*vpc|remove.*security.*group/gi,
      severity: 'critical',
      category: 'destructive_operation',
      mitigation: 'Enable destruction protection and require approval',
    },

    // Bypass attempt patterns
    {
      id: 'policy-bypass',
      name: 'Policy Bypass Attempt',
      description: 'Attempt to bypass security policies',
      pattern: /skip.*validation|bypass|disable.*check|ignore.*policy|--no-verify|--force/gi,
      severity: 'high',
      category: 'bypass_attempt',
      mitigation: 'Enforce mandatory policy checks',
    },
    {
      id: 'approval-bypass',
      name: 'Approval Bypass Attempt',
      description: 'Attempt to bypass approval workflow',
      pattern: /auto.*approve|skip.*approval|override.*approval|force.*execute/gi,
      severity: 'high',
      category: 'bypass_attempt',
      mitigation: 'Enforce mandatory approvals for high-risk operations',
    },

    // Resource abuse patterns
    {
      id: 'resource-exhaustion',
      name: 'Resource Exhaustion',
      description: 'Potential resource exhaustion attempt',
      pattern: /while.*true|infinite|fork.*bomb|:(){ :|stress|load.*test.*prod/gi,
      severity: 'high',
      category: 'resource_abuse',
      mitigation: 'Implement resource quotas and limits',
    },
    {
      id: 'crypto-mining',
      name: 'Cryptomining Detection',
      description: 'Potential cryptomining activity',
      pattern: /xmrig|minerd|cgminer|stratum\+tcp|nicehash|coinhive/gi,
      severity: 'critical',
      category: 'resource_abuse',
      mitigation: 'Block cryptomining software',
    },
  ],
  resource_restrictions: {
    [Sensitivity.PUBLIC]: ['*'],
    [Sensitivity.INTERNAL]: ['internal:*', 'shared:*'],
    [Sensitivity.CONFIDENTIAL]: ['confidential:*', 'internal:*'],
    [Sensitivity.RESTRICTED]: ['restricted:*'],
  },
};

// =============================================================================
// Intent Validation Sandbox
// =============================================================================

export class IntentValidationSandbox extends EventEmitter {
  private config: SandboxConfig;
  private compiledPatterns: Map<string, RegExp> = new Map();
  private validationCache: Map<string, ValidationResult> = new Map();
  private cacheMaxSize = 1000;
  private initialized = false;

  constructor(config: Partial<SandboxConfig> = {}) {
    super();
    this.config = { ...defaultSandboxConfig, ...config };
  }

  /**
   * Initialize the sandbox
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Compile regex patterns for performance
    for (const pattern of this.config.dangerous_patterns) {
      if (typeof pattern.pattern === 'string') {
        this.compiledPatterns.set(pattern.id, new RegExp(pattern.pattern, 'gi'));
      } else {
        this.compiledPatterns.set(pattern.id, pattern.pattern);
      }
    }

    this.initialized = true;
    logger.info('Intent validation sandbox initialized');
  }

  /**
   * Validate an intent in the sandbox
   */
  async validate(
    intent: TypedIntent,
    context: SandboxContext
  ): Promise<ValidationResult> {
    const startTime = Date.now();
    const validationId = `val_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    logger.info(
      { intentId: intent.intentId, validationId },
      'Starting intent validation'
    );

    // Check cache
    const cacheKey = this.getCacheKey(intent, context);
    const cached = this.validationCache.get(cacheKey);
    if (cached && Date.now() - new Date(cached.timestamp).getTime() < 60000) {
      logger.debug({ intentId: intent.intentId }, 'Using cached validation result');
      return cached;
    }

    const checks: ValidationCheck[] = [];
    const violations: ValidationViolation[] = [];
    const warnings: ValidationWarning[] = [];
    const riskFactors: RiskFactor[] = [];

    try {
      // Run validation checks with timeout
      await Promise.race([
        this.runValidationChecks(intent, context, checks, violations, warnings, riskFactors),
        this.timeout(this.config.analysis_timeout_ms),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.includes('timeout')) {
        violations.push({
          violation_id: `vio_${Date.now()}`,
          check_id: 'timeout',
          severity: 'high',
          category: 'bypass_attempt',
          description: 'Intent validation timed out - possible complexity attack',
          evidence: `Analysis exceeded ${this.config.analysis_timeout_ms}ms`,
          mitigation: 'Simplify intent or split into smaller operations',
        });
      } else {
        logger.error({ error, intentId: intent.intentId }, 'Validation error');
        throw error;
      }
    }

    // Calculate risk assessment
    const riskAssessment = this.calculateRiskAssessment(intent, violations, riskFactors);

    // Generate recommendations
    const recommendations = this.generateRecommendations(violations, warnings, riskAssessment);

    // Determine overall validity
    const criticalViolations = violations.filter((v) => v.severity === 'critical');
    const highViolations = violations.filter((v) => v.severity === 'high');

    let valid = true;
    if (!this.config.shadow_mode) {
      valid = criticalViolations.length === 0 &&
              (highViolations.length === 0 || riskAssessment.overall_risk !== 'destructive');
    }

    const result: ValidationResult = {
      valid,
      intent_id: intent.intentId,
      validation_id: validationId,
      timestamp: new Date().toISOString(),
      checks,
      violations,
      warnings,
      risk_assessment: riskAssessment,
      recommendations,
      analysis_time_ms: Date.now() - startTime,
    };

    // Cache result
    this.cacheResult(cacheKey, result);

    // Emit events
    this.emit('validation_complete', {
      intent_id: intent.intentId,
      valid: result.valid,
      violations: violations.length,
      risk_level: riskAssessment.overall_risk,
    });

    if (!valid) {
      this.emit('validation_failed', {
        intent_id: intent.intentId,
        violations: violations.map((v) => ({
          id: v.violation_id,
          severity: v.severity,
          category: v.category,
        })),
      });
    }

    logger.info(
      {
        intentId: intent.intentId,
        valid,
        violations: violations.length,
        warnings: warnings.length,
        analysisTimeMs: result.analysis_time_ms,
      },
      'Intent validation completed'
    );

    return result;
  }

  /**
   * Run all validation checks
   */
  private async runValidationChecks(
    intent: TypedIntent,
    context: SandboxContext,
    checks: ValidationCheck[],
    violations: ValidationViolation[],
    warnings: ValidationWarning[],
    riskFactors: RiskFactor[]
  ): Promise<void> {
    // 1. Static pattern analysis
    if (this.config.enable_static_analysis) {
      await this.runStaticAnalysis(intent, checks, violations);
    }

    // 2. Parameter validation
    await this.validateParameters(intent, checks, violations, warnings);

    // 3. Resource scope validation
    if (this.config.enable_scope_validation) {
      await this.validateResourceScope(intent, context, checks, violations, warnings);
    }

    // 4. Semantic validation
    if (this.config.enable_semantic_validation) {
      await this.runSemanticValidation(intent, context, checks, violations, warnings);
    }

    // 5. Capability validation
    await this.validateCapabilities(intent, context, checks, violations);

    // 6. Risk factor analysis
    this.analyzeRiskFactors(intent, context, violations, riskFactors);
  }

  /**
   * Run static pattern analysis
   */
  private async runStaticAnalysis(
    intent: TypedIntent,
    checks: ValidationCheck[],
    violations: ValidationViolation[]
  ): Promise<void> {
    const checkId = 'static-pattern-analysis';

    // Serialize intent for pattern matching
    const intentText = JSON.stringify({
      nlText: intent.nlText,
      actionType: intent.actionType,
      metadata: intent.metadata,
    });

    let passed = true;

    for (const pattern of this.config.dangerous_patterns) {
      const regex = this.compiledPatterns.get(pattern.id);
      if (!regex) continue;

      // Reset regex state
      regex.lastIndex = 0;
      const matches = intentText.match(regex);

      if (matches && matches.length > 0) {
        passed = false;
        violations.push({
          violation_id: `vio_${Date.now()}_${pattern.id}`,
          check_id: checkId,
          severity: pattern.severity,
          category: pattern.category,
          description: pattern.description,
          evidence: `Found ${matches.length} match(es): ${matches.slice(0, 3).join(', ')}${matches.length > 3 ? '...' : ''}`,
          location: 'intent content',
          mitigation: pattern.mitigation,
        });
      }
    }

    checks.push({
      check_id: checkId,
      name: 'Static Pattern Analysis',
      category: 'security',
      passed,
      details: passed ? 'No dangerous patterns detected' : `Found ${violations.length} pattern violations`,
    });
  }

  /**
   * Validate intent parameters
   */
  private async validateParameters(
    intent: TypedIntent,
    checks: ValidationCheck[],
    violations: ValidationViolation[],
    warnings: ValidationWarning[]
  ): Promise<void> {
    const checkId = 'parameter-validation';
    let passed = true;

    const metadata = intent.metadata as Record<string, unknown> | undefined;
    const parameters = metadata?.parameters as Record<string, unknown> | undefined;

    if (parameters) {
      // Check parameter size
      const paramSize = JSON.stringify(parameters).length;
      if (paramSize > this.config.max_parameter_size_bytes) {
        passed = false;
        violations.push({
          violation_id: `vio_${Date.now()}_param_size`,
          check_id: checkId,
          severity: 'medium',
          category: 'resource_abuse',
          description: 'Parameter size exceeds limit',
          evidence: `Size: ${paramSize} bytes, Limit: ${this.config.max_parameter_size_bytes} bytes`,
          mitigation: 'Reduce parameter payload size',
        });
      }

      // Check parameter depth
      const depth = this.getObjectDepth(parameters);
      if (depth > this.config.max_parameter_depth) {
        passed = false;
        violations.push({
          violation_id: `vio_${Date.now()}_param_depth`,
          check_id: checkId,
          severity: 'medium',
          category: 'bypass_attempt',
          description: 'Parameter nesting depth exceeds limit',
          evidence: `Depth: ${depth}, Limit: ${this.config.max_parameter_depth}`,
          mitigation: 'Flatten nested parameters',
        });
      }

      // Check for suspicious parameter names
      const suspiciousParams = this.findSuspiciousParameters(parameters);
      for (const param of suspiciousParams) {
        warnings.push({
          warning_id: `warn_${Date.now()}_${param.name}`,
          category: 'security',
          message: `Suspicious parameter: ${param.name}`,
          suggestion: param.suggestion,
        });
      }
    }

    // Check target resources count
    const targetResources = metadata?.targetResources as string[] | undefined;
    if (targetResources && targetResources.length > this.config.max_resources_per_intent) {
      passed = false;
      violations.push({
        violation_id: `vio_${Date.now()}_resource_count`,
        check_id: checkId,
        severity: 'medium',
        category: 'resource_abuse',
        description: 'Too many target resources',
        evidence: `Count: ${targetResources.length}, Limit: ${this.config.max_resources_per_intent}`,
        mitigation: 'Split into multiple smaller intents',
      });
    }

    checks.push({
      check_id: checkId,
      name: 'Parameter Validation',
      category: 'security',
      passed,
      details: passed ? 'Parameters validated successfully' : 'Parameter validation failed',
    });
  }

  /**
   * Validate resource scope
   */
  private async validateResourceScope(
    intent: TypedIntent,
    context: SandboxContext,
    checks: ValidationCheck[],
    violations: ValidationViolation[],
    warnings: ValidationWarning[]
  ): Promise<void> {
    const checkId = 'resource-scope-validation';
    let passed = true;

    const metadata = intent.metadata as Record<string, unknown> | undefined;
    const targetResources = metadata?.targetResources as string[] | undefined;

    if (targetResources && targetResources.length > 0) {
      const allowedPrefixes = this.config.resource_restrictions[intent.sensitivity] || [];

      for (const resource of targetResources) {
        const allowed = allowedPrefixes.some(
          (prefix) => prefix === '*' || resource.startsWith(prefix.replace('*', ''))
        );

        if (!allowed) {
          passed = false;
          violations.push({
            violation_id: `vio_${Date.now()}_scope`,
            check_id: checkId,
            severity: 'high',
            category: 'escalation',
            description: 'Resource access outside allowed scope',
            evidence: `Resource: ${resource}, Sensitivity: ${intent.sensitivity}`,
            mitigation: 'Request access to appropriate sensitivity level',
          });
        }
      }

      // Check for cross-environment access in production
      if (context.environment === 'production') {
        const devResources = targetResources.filter(
          (r) => r.includes('dev') || r.includes('test') || r.includes('staging')
        );
        if (devResources.length > 0) {
          warnings.push({
            warning_id: `warn_${Date.now()}_cross_env`,
            category: 'security',
            message: 'Production intent references non-production resources',
            suggestion: 'Verify resource references are correct for production',
          });
        }
      }
    }

    checks.push({
      check_id: checkId,
      name: 'Resource Scope Validation',
      category: 'authorization',
      passed,
      details: passed ? 'Resource scope validated' : 'Resource scope violation detected',
    });
  }

  /**
   * Run semantic validation
   */
  private async runSemanticValidation(
    intent: TypedIntent,
    context: SandboxContext,
    checks: ValidationCheck[],
    violations: ValidationViolation[],
    warnings: ValidationWarning[]
  ): Promise<void> {
    const checkId = 'semantic-validation';
    let passed = true;

    // Check action-risk consistency
    const actionRiskMap: Record<string, RiskLevel[]> = {
      'delete': ['high', 'destructive'],
      'destroy': ['destructive'],
      'terminate': ['high', 'destructive'],
      'create': ['medium', 'high'],
      'update': ['medium', 'high'],
      'query': ['low', 'medium'],
      'read': ['low'],
      'list': ['low'],
    };

    const expectedRisks = actionRiskMap[intent.actionType.toLowerCase()];
    if (expectedRisks && !expectedRisks.includes(intent.riskLevel)) {
      warnings.push({
        warning_id: `warn_${Date.now()}_risk_mismatch`,
        category: 'risk',
        message: `Action type '${intent.actionType}' has unexpected risk level '${intent.riskLevel}'`,
        suggestion: `Expected risk levels: ${expectedRisks.join(', ')}`,
      });
    }

    // Check for destructive operations in production
    if (context.environment === 'production' && intent.riskLevel === 'destructive') {
      if (!intent.approvalRequired) {
        passed = false;
        violations.push({
          violation_id: `vio_${Date.now()}_destructive_no_approval`,
          check_id: checkId,
          severity: 'critical',
          category: 'destructive_operation',
          description: 'Destructive operation in production without approval requirement',
          evidence: `Action: ${intent.actionType}, Risk: ${intent.riskLevel}, Environment: ${context.environment}`,
          mitigation: 'Enable approval requirement for destructive production operations',
        });
      }
    }

    // Check for side effects without idempotency
    if (intent.sideEffect && !intent.idempotencyKey) {
      warnings.push({
        warning_id: `warn_${Date.now()}_no_idempotency`,
        category: 'reliability',
        message: 'Intent has side effects but no idempotency key',
        suggestion: 'Add idempotency key to prevent duplicate operations',
      });
    }

    // Check confidence threshold
    if (intent.confidence < 0.7) {
      warnings.push({
        warning_id: `warn_${Date.now()}_low_confidence`,
        category: 'quality',
        message: `Low intent confidence: ${(intent.confidence * 100).toFixed(1)}%`,
        suggestion: 'Consider requesting clarification from user',
      });
    }

    checks.push({
      check_id: checkId,
      name: 'Semantic Validation',
      category: 'quality',
      passed,
      details: passed ? 'Semantic validation passed' : 'Semantic validation issues detected',
    });
  }

  /**
   * Validate required capabilities
   */
  private async validateCapabilities(
    intent: TypedIntent,
    context: SandboxContext,
    checks: ValidationCheck[],
    violations: ValidationViolation[]
  ): Promise<void> {
    const checkId = 'capability-validation';
    let passed = true;

    // Check for admin capabilities without admin role
    const adminCapabilities = intent.requiredCapabilities.filter(
      (cap) => cap.includes('admin') || cap.includes('root') || cap.includes('system')
    );

    const hasAdminRole = context.user_roles.some(
      (role) => role.includes('admin') || role === 'system'
    );

    if (adminCapabilities.length > 0 && !hasAdminRole) {
      passed = false;
      violations.push({
        violation_id: `vio_${Date.now()}_admin_cap`,
        check_id: checkId,
        severity: 'high',
        category: 'escalation',
        description: 'Admin capabilities requested without admin role',
        evidence: `Capabilities: ${adminCapabilities.join(', ')}, Roles: ${context.user_roles.join(', ')}`,
        mitigation: 'Request admin privileges or use non-admin operations',
      });
    }

    // Check for dangerous capability combinations
    const dangerousCombinations = [
      { caps: ['database:write', 'database:admin'], severity: 'high' as const },
      { caps: ['aws:ec2:terminate', 'aws:ec2:*'], severity: 'high' as const },
      { caps: ['secrets:read', 'http:external'], severity: 'critical' as const },
    ];

    for (const combo of dangerousCombinations) {
      const hasAll = combo.caps.every((cap) =>
        intent.requiredCapabilities.some((c) => c.includes(cap.replace('*', '')))
      );

      if (hasAll) {
        violations.push({
          violation_id: `vio_${Date.now()}_dangerous_combo`,
          check_id: checkId,
          severity: combo.severity,
          category: 'escalation',
          description: 'Dangerous capability combination detected',
          evidence: `Capabilities: ${combo.caps.join(' + ')}`,
          mitigation: 'Split into separate operations or add additional controls',
        });
        passed = false;
      }
    }

    checks.push({
      check_id: checkId,
      name: 'Capability Validation',
      category: 'authorization',
      passed,
      details: passed ? 'Capabilities validated' : 'Capability validation failed',
    });
  }

  /**
   * Analyze risk factors
   */
  private analyzeRiskFactors(
    intent: TypedIntent,
    context: SandboxContext,
    violations: ValidationViolation[],
    riskFactors: RiskFactor[]
  ): void {
    // Factor: Base risk level
    const baseRiskScores: Record<RiskLevel, number> = {
      'low': 10,
      'medium': 30,
      'high': 60,
      'destructive': 90,
    };

    riskFactors.push({
      name: 'Base Risk Level',
      weight: 0.3,
      score: baseRiskScores[intent.riskLevel],
      description: `Intent classified as ${intent.riskLevel} risk`,
    });

    // Factor: Violations
    const violationScore = Math.min(100, violations.length * 15);
    riskFactors.push({
      name: 'Security Violations',
      weight: 0.25,
      score: violationScore,
      description: `${violations.length} security violation(s) detected`,
    });

    // Factor: Environment
    const envScores: Record<string, number> = {
      'development': 10,
      'staging': 30,
      'production': 50,
    };
    riskFactors.push({
      name: 'Environment',
      weight: 0.15,
      score: envScores[context.environment] || 30,
      description: `Executing in ${context.environment} environment`,
    });

    // Factor: Side effects
    riskFactors.push({
      name: 'Side Effects',
      weight: 0.15,
      score: intent.sideEffect ? 60 : 10,
      description: intent.sideEffect ? 'Intent has side effects' : 'No side effects',
    });

    // Factor: Confidence
    const confidenceScore = Math.round((1 - intent.confidence) * 100);
    riskFactors.push({
      name: 'Parsing Confidence',
      weight: 0.15,
      score: confidenceScore,
      description: `Intent confidence: ${(intent.confidence * 100).toFixed(1)}%`,
    });
  }

  /**
   * Calculate overall risk assessment
   */
  private calculateRiskAssessment(
    intent: TypedIntent,
    violations: ValidationViolation[],
    riskFactors: RiskFactor[]
  ): RiskAssessment {
    // Calculate weighted score
    let weightedScore = 0;
    let totalWeight = 0;

    for (const factor of riskFactors) {
      weightedScore += factor.score * factor.weight;
      totalWeight += factor.weight;
    }

    const normalizedScore = totalWeight > 0 ? weightedScore / totalWeight : 50;

    // Boost score for critical violations
    const criticalCount = violations.filter((v) => v.severity === 'critical').length;
    const highCount = violations.filter((v) => v.severity === 'high').length;
    const boostedScore = Math.min(100, normalizedScore + criticalCount * 25 + highCount * 10);

    // Determine risk level
    let overallRisk: RiskLevel;
    if (boostedScore >= 80 || criticalCount > 0) {
      overallRisk = 'destructive';
    } else if (boostedScore >= 60 || highCount > 0) {
      overallRisk = 'high';
    } else if (boostedScore >= 30) {
      overallRisk = 'medium';
    } else {
      overallRisk = 'low';
    }

    // Calculate confidence in assessment
    const confidence = Math.min(1, 0.5 + (riskFactors.length * 0.1));

    return {
      overall_risk: overallRisk,
      confidence,
      factors: riskFactors,
      score: Math.round(boostedScore),
    };
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(
    violations: ValidationViolation[],
    warnings: ValidationWarning[],
    riskAssessment: RiskAssessment
  ): string[] {
    const recommendations: string[] = [];

    // Based on violations
    const categories = new Set(violations.map((v) => v.category));

    if (categories.has('injection')) {
      recommendations.push('Review and sanitize all user inputs before processing');
    }
    if (categories.has('escalation')) {
      recommendations.push('Verify the minimum privileges required for this operation');
    }
    if (categories.has('data_exfiltration')) {
      recommendations.push('Enable data loss prevention controls and audit logging');
    }
    if (categories.has('destructive_operation')) {
      recommendations.push('Enable approval workflow for destructive operations');
      recommendations.push('Verify backup and recovery procedures are in place');
    }
    if (categories.has('credential_exposure')) {
      recommendations.push('Use a secrets management system instead of inline credentials');
    }

    // Based on risk level
    if (riskAssessment.overall_risk === 'destructive') {
      recommendations.push('Consider breaking this into smaller, less risky operations');
      recommendations.push('Ensure human review before execution');
    } else if (riskAssessment.overall_risk === 'high') {
      recommendations.push('Enable additional logging and monitoring for this operation');
    }

    // Based on warnings
    if (warnings.length > 5) {
      recommendations.push('Multiple warnings indicate the intent may need clarification');
    }

    return [...new Set(recommendations)]; // Remove duplicates
  }

  /**
   * Get object nesting depth
   */
  private getObjectDepth(obj: unknown, currentDepth = 0): number {
    if (typeof obj !== 'object' || obj === null) {
      return currentDepth;
    }

    const values = Object.values(obj as Record<string, unknown>);
    if (values.length === 0) {
      return currentDepth;
    }

    return Math.max(...values.map((v) => this.getObjectDepth(v, currentDepth + 1)));
  }

  /**
   * Find suspicious parameter names
   */
  private findSuspiciousParameters(
    params: Record<string, unknown>,
    path = ''
  ): Array<{ name: string; suggestion: string }> {
    const suspicious: Array<{ name: string; suggestion: string }> = [];
    const suspiciousNames = [
      { pattern: /password/i, suggestion: 'Use secrets management' },
      { pattern: /secret/i, suggestion: 'Use secrets management' },
      { pattern: /api[_-]?key/i, suggestion: 'Use secrets management' },
      { pattern: /token/i, suggestion: 'Use secure token storage' },
      { pattern: /credential/i, suggestion: 'Use credentials manager' },
      { pattern: /__proto__/i, suggestion: 'Remove prototype pollution vector' },
      { pattern: /constructor/i, suggestion: 'Avoid reserved names' },
      { pattern: /eval/i, suggestion: 'Avoid eval-related parameters' },
    ];

    for (const [key, value] of Object.entries(params)) {
      const fullPath = path ? `${path}.${key}` : key;

      for (const { pattern, suggestion } of suspiciousNames) {
        if (pattern.test(key)) {
          suspicious.push({ name: fullPath, suggestion });
          break;
        }
      }

      if (typeof value === 'object' && value !== null) {
        suspicious.push(
          ...this.findSuspiciousParameters(value as Record<string, unknown>, fullPath)
        );
      }
    }

    return suspicious;
  }

  /**
   * Get cache key for intent
   */
  private getCacheKey(intent: TypedIntent, context: SandboxContext): string {
    const key = {
      intentId: intent.intentId,
      hash: hashObject({
        nlText: intent.nlText,
        actionType: intent.actionType,
        sensitivity: intent.sensitivity,
      }),
      userId: context.user_id,
      environment: context.environment,
    };
    return JSON.stringify(key);
  }

  /**
   * Cache validation result
   */
  private cacheResult(key: string, result: ValidationResult): void {
    // Enforce cache size limit
    if (this.validationCache.size >= this.cacheMaxSize) {
      const firstKey = this.validationCache.keys().next().value;
      if (firstKey) {
        this.validationCache.delete(firstKey);
      }
    }
    this.validationCache.set(key, result);
  }

  /**
   * Create timeout promise
   */
  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Analysis timeout after ${ms}ms`)), ms);
    });
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SandboxConfig>): void {
    this.config = { ...this.config, ...config };

    // Recompile patterns if updated
    if (config.dangerous_patterns) {
      this.compiledPatterns.clear();
      for (const pattern of this.config.dangerous_patterns) {
        if (typeof pattern.pattern === 'string') {
          this.compiledPatterns.set(pattern.id, new RegExp(pattern.pattern, 'gi'));
        } else {
          this.compiledPatterns.set(pattern.id, pattern.pattern);
        }
      }
    }
  }

  /**
   * Add custom dangerous pattern
   */
  addDangerousPattern(pattern: DangerousPattern): void {
    this.config.dangerous_patterns.push(pattern);
    if (typeof pattern.pattern === 'string') {
      this.compiledPatterns.set(pattern.id, new RegExp(pattern.pattern, 'gi'));
    } else {
      this.compiledPatterns.set(pattern.id, pattern.pattern);
    }
  }

  /**
   * Clear validation cache
   */
  clearCache(): void {
    this.validationCache.clear();
  }

  /**
   * Get statistics
   */
  getStats(): {
    cacheSize: number;
    patternCount: number;
    config: SandboxConfig;
  } {
    return {
      cacheSize: this.validationCache.size,
      patternCount: this.compiledPatterns.size,
      config: this.config,
    };
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let sandbox: IntentValidationSandbox | null = null;

export function getIntentSandbox(): IntentValidationSandbox {
  if (!sandbox) {
    sandbox = new IntentValidationSandbox();
  }
  return sandbox;
}

export async function initializeIntentSandbox(
  config?: Partial<SandboxConfig>
): Promise<IntentValidationSandbox> {
  const sb = config ? new IntentValidationSandbox(config) : getIntentSandbox();
  await sb.initialize();
  sandbox = sb;
  return sb;
}
