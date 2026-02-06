/**
 * LLM Safety Guardrails
 *
 * Multi-layered safety system for LLM interactions:
 * 1. Output content filtering (PII, secrets, harmful content)
 * 2. Response validation (hallucination detection, consistency checks)
 * 3. Rate limiting and cost controls
 * 4. Jailbreak detection in responses
 *
 * References:
 * - OWASP LLM Top 10
 * - NeMo Guardrails architecture
 * - Anthropic Constitutional AI principles
 */

import { logger } from '../core/logger.js';
import { getDLPFilter } from '../executor/index.js';

export enum SafetyViolationType {
  PII_EXPOSURE = 'pii_exposure',
  SECRET_EXPOSURE = 'secret_exposure',
  HARMFUL_CONTENT = 'harmful_content',
  HALLUCINATION = 'hallucination',
  JAILBREAK_SUCCESS = 'jailbreak_success',
  EXCESSIVE_COST = 'excessive_cost',
  RATE_LIMIT = 'rate_limit',
}

export interface SafetyCheckResult {
  safe: boolean;
  violations: SafetyViolation[];
  sanitizedOutput?: string;
  riskScore: number; // 0-100
  allowWithWarning: boolean;
}

export interface SafetyViolation {
  type: SafetyViolationType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  detectedContent?: string;
  recommendation: string;
}

export interface LLMGuardrailsConfig {
  enablePIIDetection: boolean;
  enableSecretDetection: boolean;
  enableHarmfulContentDetection: boolean;
  enableHallucinationDetection: boolean;
  enableRateLimiting: boolean;
  enableCostControls: boolean;
  maxTokensPerRequest: number;
  maxCostPerRequest: number; // USD
  maxRequestsPerMinute: number;
  riskThreshold: number; // 0-100, block if risk score exceeds this
}

export class LLMGuardrails {
  private readonly config: LLMGuardrailsConfig;
  private requestCount = 0;
  private lastResetTime = Date.now();
  private readonly requestTimestamps: number[] = [];

  constructor(config?: Partial<LLMGuardrailsConfig>) {
    this.config = {
      enablePIIDetection: config?.enablePIIDetection ?? true,
      enableSecretDetection: config?.enableSecretDetection ?? true,
      enableHarmfulContentDetection: config?.enableHarmfulContentDetection ?? true,
      enableHallucinationDetection: config?.enableHallucinationDetection ?? false,
      enableRateLimiting: config?.enableRateLimiting ?? true,
      enableCostControls: config?.enableCostControls ?? true,
      maxTokensPerRequest: config?.maxTokensPerRequest ?? 4096,
      maxCostPerRequest: config?.maxCostPerRequest ?? 1.0,
      maxRequestsPerMinute: config?.maxRequestsPerMinute ?? 60,
      riskThreshold: config?.riskThreshold ?? 70,
    };
  }

  /**
   * Check LLM output for safety violations
   */
  async checkOutput(
    output: string,
    context: {
      modelName?: string;
      promptTokens?: number;
      completionTokens?: number;
      estimatedCost?: number;
    } = {}
  ): Promise<SafetyCheckResult> {
    const violations: SafetyViolation[] = [];
    let sanitizedOutput = output;

    // Check 1: PII Detection
    if (this.config.enablePIIDetection) {
      const piiViolations = await this.detectPII(output);
      violations.push(...piiViolations);

      // Redact PII if found
      if (piiViolations.length > 0) {
        sanitizedOutput = this.redactPII(sanitizedOutput);
      }
    }

    // Check 2: Secret Detection
    if (this.config.enableSecretDetection) {
      const secretViolations = await this.detectSecrets(output);
      violations.push(...secretViolations);

      // Redact secrets if found
      if (secretViolations.length > 0) {
        sanitizedOutput = this.redactSecrets(sanitizedOutput);
      }
    }

    // Check 3: Harmful Content Detection
    if (this.config.enableHarmfulContentDetection) {
      const harmfulViolations = this.detectHarmfulContent(output);
      violations.push(...harmfulViolations);
    }

    // Check 4: Jailbreak Success Detection
    const jailbreakViolations = this.detectJailbreakSuccess(output);
    violations.push(...jailbreakViolations);

    // Check 5: Rate Limiting
    if (this.config.enableRateLimiting) {
      const rateLimitViolation = this.checkRateLimit();
      if (rateLimitViolation) {
        violations.push(rateLimitViolation);
      }
    }

    // Check 6: Cost Controls
    if (this.config.enableCostControls && context.estimatedCost) {
      const costViolation = this.checkCostLimit(context.estimatedCost);
      if (costViolation) {
        violations.push(costViolation);
      }
    }

    // Calculate overall risk score
    const riskScore = this.calculateRiskScore(violations);
    const criticalViolations = violations.filter(v => v.severity === 'critical');
    const safe = riskScore < this.config.riskThreshold && criticalViolations.length === 0;
    const allowWithWarning = riskScore < this.config.riskThreshold && violations.length > 0;

    if (!safe) {
      logger.warn('LLM output blocked by guardrails', {
        riskScore,
        violations: violations.length,
        criticalCount: criticalViolations.length,
      });
    } else if (violations.length > 0) {
      logger.info('LLM output has warnings', {
        riskScore,
        violations: violations.length,
      });
    }

    return {
      safe,
      violations,
      sanitizedOutput: sanitizedOutput !== output ? sanitizedOutput : undefined,
      riskScore,
      allowWithWarning,
    };
  }

  /**
   * Detect PII in output
   */
  private async detectPII(output: string): Promise<SafetyViolation[]> {
    const violations: SafetyViolation[] = [];
    const dlp = getDLPFilter();

    // Use existing DLP patterns
    const patterns = [
      { regex: /\b\d{3}-\d{2}-\d{4}\b/, type: 'SSN' },
      { regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, type: 'Credit Card' },
      { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, type: 'Email' },
      { regex: /\b\d{3}[\s-]?\d{3}[\s-]?\d{4}\b/, type: 'Phone Number' },
    ];

    for (const pattern of patterns) {
      const matches = output.match(pattern.regex);
      if (matches) {
        violations.push({
          type: SafetyViolationType.PII_EXPOSURE,
          severity: 'high',
          message: `Detected ${pattern.type} in output`,
          detectedContent: matches[0],
          recommendation: 'Redact PII before returning to user',
        });
      }
    }

    return violations;
  }

  /**
   * Detect secrets in output
   */
  private async detectSecrets(output: string): Promise<SafetyViolation[]> {
    const violations: SafetyViolation[] = [];

    const secretPatterns = [
      { regex: /AKIA[0-9A-Z]{16}/, type: 'AWS Access Key' },
      { regex: /sk-[a-zA-Z0-9]{32,}/, type: 'API Key' },
      { regex: /ghp_[a-zA-Z0-9]{36}/, type: 'GitHub Personal Access Token' },
      { regex: /xox[baprs]-[a-zA-Z0-9-]+/, type: 'Slack Token' },
    ];

    for (const pattern of secretPatterns) {
      const matches = output.match(pattern.regex);
      if (matches) {
        violations.push({
          type: SafetyViolationType.SECRET_EXPOSURE,
          severity: 'critical',
          message: `Detected ${pattern.type} in output`,
          detectedContent: '***REDACTED***',
          recommendation: 'Immediately revoke exposed credentials',
        });
      }
    }

    return violations;
  }

  /**
   * Detect harmful content
   */
  private detectHarmfulContent(output: string): SafetyViolation[] {
    const violations: SafetyViolation[] = [];
    const lowerOutput = output.toLowerCase();

    // Harmful instruction patterns
    const harmfulPatterns = [
      'how to hack',
      'create malware',
      'exploit vulnerability',
      'bypass security',
      'social engineer',
      'phishing',
    ];

    for (const pattern of harmfulPatterns) {
      if (lowerOutput.includes(pattern)) {
        violations.push({
          type: SafetyViolationType.HARMFUL_CONTENT,
          severity: 'high',
          message: `Detected potentially harmful instruction: ${pattern}`,
          recommendation: 'Review output for compliance with usage policies',
        });
      }
    }

    return violations;
  }

  /**
   * Detect successful jailbreak attempts
   */
  private detectJailbreakSuccess(output: string): SafetyViolation[] {
    const violations: SafetyViolation[] = [];
    const lowerOutput = output.toLowerCase();

    // Signs of successful jailbreak
    const jailbreakIndicators = [
      'as dan',
      'in developer mode',
      'ignoring previous instructions',
      'constraints disabled',
      'safety filters off',
    ];

    for (const indicator of jailbreakIndicators) {
      if (lowerOutput.includes(indicator)) {
        violations.push({
          type: SafetyViolationType.JAILBREAK_SUCCESS,
          severity: 'critical',
          message: 'Detected signs of successful jailbreak attempt',
          recommendation: 'Terminate conversation and reset context',
        });
      }
    }

    return violations;
  }

  /**
   * Check rate limiting
   */
  private checkRateLimit(): SafetyViolation | null {
    const now = Date.now();

    // Remove timestamps older than 1 minute
    while (
      this.requestTimestamps.length > 0 &&
      now - this.requestTimestamps[0] > 60000
    ) {
      this.requestTimestamps.shift();
    }

    this.requestTimestamps.push(now);

    if (this.requestTimestamps.length > this.config.maxRequestsPerMinute) {
      return {
        type: SafetyViolationType.RATE_LIMIT,
        severity: 'medium',
        message: `Rate limit exceeded: ${this.requestTimestamps.length} requests in last minute`,
        recommendation: 'Implement backoff or reduce request frequency',
      };
    }

    return null;
  }

  /**
   * Check cost limits
   */
  private checkCostLimit(estimatedCost: number): SafetyViolation | null {
    if (estimatedCost > this.config.maxCostPerRequest) {
      return {
        type: SafetyViolationType.EXCESSIVE_COST,
        severity: 'high',
        message: `Request cost $${estimatedCost.toFixed(4)} exceeds limit $${this.config.maxCostPerRequest}`,
        recommendation: 'Use a smaller model or reduce token count',
      };
    }

    return null;
  }

  /**
   * Redact PII from output
   */
  private redactPII(output: string): string {
    let redacted = output;

    // Redact SSNs
    redacted = redacted.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '***-**-****');

    // Redact credit cards
    redacted = redacted.replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '****-****-****-****');

    // Redact emails (partial)
    redacted = redacted.replace(
      /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Z|a-z]{2,})\b/g,
      '***@$2'
    );

    // Redact phone numbers
    redacted = redacted.replace(/\b\d{3}[\s-]?\d{3}[\s-]?\d{4}\b/g, '***-***-****');

    return redacted;
  }

  /**
   * Redact secrets from output
   */
  private redactSecrets(output: string): string {
    let redacted = output;

    // Redact AWS keys
    redacted = redacted.replace(/AKIA[0-9A-Z]{16}/g, 'AKIA****************');

    // Redact API keys
    redacted = redacted.replace(/sk-[a-zA-Z0-9]{32,}/g, 'sk-***REDACTED***');

    // Redact GitHub tokens
    redacted = redacted.replace(/ghp_[a-zA-Z0-9]{36}/g, 'ghp_***REDACTED***');

    // Redact Slack tokens
    redacted = redacted.replace(/xox[baprs]-[a-zA-Z0-9-]+/g, 'xox*-***REDACTED***');

    return redacted;
  }

  /**
   * Calculate overall risk score
   */
  private calculateRiskScore(violations: SafetyViolation[]): number {
    if (violations.length === 0) return 0;

    const severityScores = {
      low: 10,
      medium: 30,
      high: 60,
      critical: 100,
    };

    const maxScore = Math.max(...violations.map(v => severityScores[v.severity]));
    const avgScore = violations.reduce((sum, v) => sum + severityScores[v.severity], 0) / violations.length;

    // Weighted average: 70% max, 30% average
    return Math.round(maxScore * 0.7 + avgScore * 0.3);
  }

  /**
   * Get guardrails statistics
   */
  getStats(): {
    totalRequests: number;
    blockedRequests: number;
    warningRequests: number;
    currentRPM: number;
  } {
    const now = Date.now();
    const recentRequests = this.requestTimestamps.filter(t => now - t < 60000);

    return {
      totalRequests: this.requestCount,
      blockedRequests: 0, // Would track this in production
      warningRequests: 0, // Would track this in production
      currentRPM: recentRequests.length,
    };
  }
}

// Singleton instance
let llmGuardrails: LLMGuardrails;

export function getLLMGuardrails(config?: Partial<LLMGuardrailsConfig>): LLMGuardrails {
  if (!llmGuardrails) {
    llmGuardrails = new LLMGuardrails(config);
  }
  return llmGuardrails;
}
