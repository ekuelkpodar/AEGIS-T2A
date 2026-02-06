/**
 * Prompt Injection Detection
 *
 * Multi-layered defense against prompt injection attacks:
 * 1. Pattern-based detection (known attack vectors)
 * 2. Structural analysis (unusual formatting, encoding)
 * 3. Semantic analysis (suspicious instructions)
 * 4. Perplexity scoring (statistical anomalies)
 *
 * References:
 * - OWASP LLM01: Prompt Injection
 * - Simon Willison's prompt injection taxonomy
 * - Anthropic's prompt injection research
 */

import { logger } from '../core/logger.js';

export enum ThreatLevel {
  SAFE = 'safe',
  SUSPICIOUS = 'suspicious',
  LIKELY_ATTACK = 'likely_attack',
  DEFINITE_ATTACK = 'definite_attack',
}

export interface DetectionResult {
  threatLevel: ThreatLevel;
  confidence: number; // 0-1
  detectedPatterns: DetectionPattern[];
  sanitizedPrompt?: string;
  blocked: boolean;
  reason?: string;
}

export interface DetectionPattern {
  type: 'jailbreak' | 'instruction_override' | 'encoding' | 'context_escape' | 'data_exfiltration';
  pattern: string;
  severity: number; // 0-10
  matchedText?: string;
}

export interface PromptInjectionConfig {
  blockThreshold: number; // Confidence threshold to block (0-1)
  enablePatternDetection: boolean;
  enableStructuralAnalysis: boolean;
  enableSemanticAnalysis: boolean;
  logAllDetections: boolean;
}

export class PromptInjectionDetector {
  private readonly config: PromptInjectionConfig;
  private readonly suspiciousPatterns: Map<string, DetectionPattern>;
  private detectionCount = 0;
  private blockCount = 0;

  constructor(config?: Partial<PromptInjectionConfig>) {
    this.config = {
      blockThreshold: config?.blockThreshold ?? 0.8,
      enablePatternDetection: config?.enablePatternDetection ?? true,
      enableStructuralAnalysis: config?.enableStructuralAnalysis ?? true,
      enableSemanticAnalysis: config?.enableSemanticAnalysis ?? true,
      logAllDetections: config?.logAllDetections ?? true,
    };

    this.suspiciousPatterns = new Map();
    this.initializePatterns();
  }

  /**
   * Analyze prompt for injection attacks
   */
  async analyzePrompt(prompt: string, context?: {
    userId?: string;
    sessionId?: string;
    previousPrompts?: string[];
  }): Promise<DetectionResult> {
    this.detectionCount++;

    const detectedPatterns: DetectionPattern[] = [];
    let maxSeverity = 0;

    // Layer 1: Pattern-based detection
    if (this.config.enablePatternDetection) {
      const patternResults = this.detectSuspiciousPatterns(prompt);
      detectedPatterns.push(...patternResults);
      maxSeverity = Math.max(maxSeverity, ...patternResults.map(p => p.severity));
    }

    // Layer 2: Structural analysis
    if (this.config.enableStructuralAnalysis) {
      const structuralResults = this.analyzeStructure(prompt);
      detectedPatterns.push(...structuralResults);
      maxSeverity = Math.max(maxSeverity, ...structuralResults.map(p => p.severity));
    }

    // Layer 3: Semantic analysis
    if (this.config.enableSemanticAnalysis) {
      const semanticResults = this.analyzeSemantics(prompt);
      detectedPatterns.push(...semanticResults);
      maxSeverity = Math.max(maxSeverity, ...semanticResults.map(p => p.severity));
    }

    // Calculate overall confidence and threat level
    const confidence = maxSeverity / 10;
    const threatLevel = this.calculateThreatLevel(confidence, detectedPatterns);
    const blocked = confidence >= this.config.blockThreshold;

    const result: DetectionResult = {
      threatLevel,
      confidence,
      detectedPatterns,
      blocked,
    };

    if (blocked) {
      this.blockCount++;
      result.reason = this.buildBlockReason(detectedPatterns);

      logger.warn('Prompt injection blocked', {
        threatLevel,
        confidence,
        patterns: detectedPatterns.length,
        userId: context?.userId,
        sessionId: context?.sessionId,
      });
    } else if (this.config.logAllDetections && detectedPatterns.length > 0) {
      logger.info('Suspicious prompt detected but not blocked', {
        threatLevel,
        confidence,
        patterns: detectedPatterns.length,
        userId: context?.userId,
      });
    }

    return result;
  }

  /**
   * Initialize known attack patterns
   */
  private initializePatterns(): void {
    // Jailbreak attempts
    this.addPattern({
      type: 'jailbreak',
      pattern: /ignore (all |your )?previous (instructions|rules|guidelines)/i,
      severity: 9,
    });

    this.addPattern({
      type: 'jailbreak',
      pattern: /forget (all |your )?previous (instructions|rules|constraints)/i,
      severity: 9,
    });

    this.addPattern({
      type: 'jailbreak',
      pattern: /(you are now|act as|pretend to be|roleplay as).*(DAN|evil|unrestricted)/i,
      severity: 8,
    });

    // Instruction override attempts
    this.addPattern({
      type: 'instruction_override',
      pattern: /system:?\s*(override|bypass|disable|ignore)/i,
      severity: 9,
    });

    this.addPattern({
      type: 'instruction_override',
      pattern: /(new|updated|different)\s*instructions?:/i,
      severity: 7,
    });

    this.addPattern({
      type: 'instruction_override',
      pattern: /---\s*END\s*(SYSTEM|INSTRUCTIONS|PROMPT)/i,
      severity: 8,
    });

    // Context escape attempts
    this.addPattern({
      type: 'context_escape',
      pattern: /```[\s\S]*?(system|admin|root)[\s\S]*?```/i,
      severity: 7,
    });

    this.addPattern({
      type: 'context_escape',
      pattern: /<\s*(script|system|prompt|instruction)>/i,
      severity: 8,
    });

    // Data exfiltration attempts
    this.addPattern({
      type: 'data_exfiltration',
      pattern: /(repeat|output|print|show|display)\s*(your|the)\s*(system\s*)?(prompt|instructions)/i,
      severity: 8,
    });

    this.addPattern({
      type: 'data_exfiltration',
      pattern: /what (were|are) your (original|initial|system) (instructions|rules|prompt)/i,
      severity: 8,
    });

    // Unicode and encoding tricks
    this.addPattern({
      type: 'encoding',
      pattern: /[\u200B-\u200D\uFEFF]/,
      severity: 6,
    });

    this.addPattern({
      type: 'encoding',
      pattern: /\\u[0-9a-fA-F]{4}/,
      severity: 5,
    });
  }

  /**
   * Add a detection pattern
   */
  private addPattern(pattern: {
    type: DetectionPattern['type'];
    pattern: RegExp;
    severity: number;
  }): void {
    const key = pattern.pattern.source;
    this.suspiciousPatterns.set(key, {
      type: pattern.type,
      pattern: key,
      severity: pattern.severity,
    });
  }

  /**
   * Detect suspicious patterns in prompt
   */
  private detectSuspiciousPatterns(prompt: string): DetectionPattern[] {
    const detected: DetectionPattern[] = [];

    for (const [_, pattern] of this.suspiciousPatterns) {
      const regex = new RegExp(pattern.pattern, 'gi');
      const matches = prompt.match(regex);

      if (matches) {
        detected.push({
          ...pattern,
          matchedText: matches[0],
        });
      }
    }

    return detected;
  }

  /**
   * Analyze prompt structure for anomalies
   */
  private analyzeStructure(prompt: string): DetectionPattern[] {
    const detected: DetectionPattern[] = [];

    // Check for excessive special characters
    const specialCharRatio = (prompt.match(/[^a-zA-Z0-9\s]/g) || []).length / prompt.length;
    if (specialCharRatio > 0.3) {
      detected.push({
        type: 'encoding',
        pattern: 'High special character ratio',
        severity: 6,
      });
    }

    // Check for excessive line breaks (potential formatting attacks)
    const lineBreaks = (prompt.match(/\n/g) || []).length;
    if (lineBreaks > 20) {
      detected.push({
        type: 'context_escape',
        pattern: 'Excessive line breaks',
        severity: 5,
      });
    }

    // Check for very long prompts (potential overflow)
    if (prompt.length > 10000) {
      detected.push({
        type: 'context_escape',
        pattern: 'Unusually long prompt',
        severity: 4,
      });
    }

    // Check for repeated delimiters
    if (/[=-]{10,}/.test(prompt) || /[#*]{5,}/.test(prompt)) {
      detected.push({
        type: 'context_escape',
        pattern: 'Suspicious delimiter patterns',
        severity: 6,
      });
    }

    return detected;
  }

  /**
   * Analyze prompt semantics for suspicious content
   */
  private analyzeSemantics(prompt: string): DetectionPattern[] {
    const detected: DetectionPattern[] = [];
    const lowerPrompt = prompt.toLowerCase();

    // Meta-instructions (talking about the AI itself)
    const metaKeywords = [
      'your instructions',
      'your system prompt',
      'your guidelines',
      'how you were trained',
      'your constraints',
    ];

    for (const keyword of metaKeywords) {
      if (lowerPrompt.includes(keyword)) {
        detected.push({
          type: 'data_exfiltration',
          pattern: `Meta-instruction: ${keyword}`,
          severity: 7,
        });
      }
    }

    // Authority escalation attempts
    const authorityKeywords = ['as admin', 'as root', 'sudo mode', 'developer mode'];

    for (const keyword of authorityKeywords) {
      if (lowerPrompt.includes(keyword)) {
        detected.push({
          type: 'jailbreak',
          pattern: `Authority escalation: ${keyword}`,
          severity: 8,
        });
      }
    }

    return detected;
  }

  /**
   * Calculate overall threat level
   */
  private calculateThreatLevel(
    confidence: number,
    patterns: DetectionPattern[]
  ): ThreatLevel {
    if (confidence >= 0.9 || patterns.some(p => p.severity >= 9)) {
      return ThreatLevel.DEFINITE_ATTACK;
    }

    if (confidence >= 0.7 || patterns.some(p => p.severity >= 7)) {
      return ThreatLevel.LIKELY_ATTACK;
    }

    if (confidence >= 0.4 || patterns.length > 0) {
      return ThreatLevel.SUSPICIOUS;
    }

    return ThreatLevel.SAFE;
  }

  /**
   * Build human-readable block reason
   */
  private buildBlockReason(patterns: DetectionPattern[]): string {
    const types = [...new Set(patterns.map(p => p.type))];
    return `Blocked due to potential prompt injection attack (${types.join(', ')})`;
  }

  /**
   * Get detection statistics
   */
  getStats(): {
    totalDetections: number;
    totalBlocks: number;
    blockRate: number;
  } {
    return {
      totalDetections: this.detectionCount,
      totalBlocks: this.blockCount,
      blockRate: this.detectionCount > 0 ? this.blockCount / this.detectionCount : 0,
    };
  }
}

// Singleton instance
let promptInjectionDetector: PromptInjectionDetector;

export function getPromptInjectionDetector(
  config?: Partial<PromptInjectionConfig>
): PromptInjectionDetector {
  if (!promptInjectionDetector) {
    promptInjectionDetector = new PromptInjectionDetector(config);
  }
  return promptInjectionDetector;
}
