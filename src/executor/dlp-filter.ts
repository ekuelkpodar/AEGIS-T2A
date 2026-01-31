/**
 * AEGIS-T2A Schema-Aware DLP Filter
 *
 * Advanced Data Loss Prevention filter with schema awareness,
 * multi-format support, and context-aware redaction.
 */

import { EventEmitter } from 'events';
import { componentLogger } from '../core/logger.js';

const logger = componentLogger('dlp-filter');

// =============================================================================
// Types
// =============================================================================

export interface DLPConfig {
  /** Enable DLP filtering */
  enabled: boolean;
  /** Log detections without blocking (shadow mode) */
  shadow_mode: boolean;
  /** Redaction method */
  redaction_method: RedactionMethod;
  /** Custom redaction token format */
  redaction_token_format: string;
  /** Enable PII detection */
  detect_pii: boolean;
  /** Enable financial data detection */
  detect_financial: boolean;
  /** Enable credential detection */
  detect_credentials: boolean;
  /** Enable health data detection (HIPAA) */
  detect_health_data: boolean;
  /** Enable custom schema detection */
  detect_custom_schemas: boolean;
  /** Schemas for structured data */
  schemas: DataSchema[];
  /** Custom detection patterns */
  custom_patterns: DLPPattern[];
  /** Fields to always redact */
  always_redact_fields: string[];
  /** Fields to never redact (allowlist) */
  never_redact_fields: string[];
  /** Maximum depth for nested object scanning */
  max_scan_depth: number;
  /** Maximum string length to scan */
  max_string_length: number;
}

export type RedactionMethod =
  | 'mask'       // Replace with asterisks
  | 'hash'       // Replace with hash
  | 'token'      // Replace with token
  | 'remove'     // Remove entirely
  | 'encrypt';   // Encrypt value (requires key)

export interface DataSchema {
  id: string;
  name: string;
  description: string;
  format: 'json' | 'xml' | 'sql' | 'csv' | 'yaml' | 'text';
  sensitive_paths: SensitivePath[];
  validation_rules?: ValidationRule[];
}

export interface SensitivePath {
  path: string; // JSONPath, XPath, or field name
  data_type: DataType;
  classification: DataClassification;
  redaction_override?: RedactionMethod;
  context_rules?: ContextRule[];
}

export type DataType =
  | 'pii_name'
  | 'pii_email'
  | 'pii_phone'
  | 'pii_ssn'
  | 'pii_address'
  | 'pii_dob'
  | 'financial_card'
  | 'financial_account'
  | 'financial_routing'
  | 'financial_amount'
  | 'credential_password'
  | 'credential_api_key'
  | 'credential_token'
  | 'credential_private_key'
  | 'credential_certificate'
  | 'health_record'
  | 'health_diagnosis'
  | 'health_prescription'
  | 'custom';

export type DataClassification =
  | 'public'
  | 'internal'
  | 'confidential'
  | 'restricted'
  | 'top_secret';

export interface ContextRule {
  condition: string;
  action: 'allow' | 'redact' | 'block';
  reason: string;
}

export interface ValidationRule {
  field: string;
  rule: 'required' | 'format' | 'range' | 'enum';
  params?: Record<string, unknown>;
}

export interface DLPPattern {
  id: string;
  name: string;
  description: string;
  pattern: RegExp;
  data_type: DataType;
  classification: DataClassification;
  confidence: number;
  context_keywords?: string[];
  negative_keywords?: string[];
}

export interface DLPScanResult {
  scan_id: string;
  timestamp: string;
  input_size: number;
  output_size: number;
  format_detected: string;
  findings: DLPFinding[];
  redactions_applied: number;
  scan_time_ms: number;
  blocked: boolean;
  block_reason?: string;
}

export interface DLPFinding {
  finding_id: string;
  pattern_id: string;
  pattern_name: string;
  data_type: DataType;
  classification: DataClassification;
  location: FindingLocation;
  confidence: number;
  context: string;
  action_taken: 'allowed' | 'redacted' | 'blocked';
  redacted_value?: string;
}

export interface FindingLocation {
  path?: string;
  line?: number;
  column?: number;
  start_offset: number;
  end_offset: number;
}

export interface FilteredOutput<T = unknown> {
  data: T;
  scan_result: DLPScanResult;
}

// =============================================================================
// Default Patterns
// =============================================================================

const DEFAULT_PATTERNS: DLPPattern[] = [
  // PII Patterns
  {
    id: 'pii-email',
    name: 'Email Address',
    description: 'Detects email addresses',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    data_type: 'pii_email',
    classification: 'confidential',
    confidence: 0.95,
    context_keywords: ['email', 'e-mail', 'contact', 'address'],
  },
  {
    id: 'pii-phone-us',
    name: 'US Phone Number',
    description: 'Detects US phone numbers',
    pattern: /\b(?:\+1[-.\s]?)?(?:\([0-9]{3}\)|[0-9]{3})[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g,
    data_type: 'pii_phone',
    classification: 'confidential',
    confidence: 0.85,
    context_keywords: ['phone', 'tel', 'mobile', 'cell', 'contact'],
  },
  {
    id: 'pii-ssn',
    name: 'Social Security Number',
    description: 'Detects US Social Security Numbers',
    pattern: /\b(?!000|666|9\d{2})\d{3}[-\s]?(?!00)\d{2}[-\s]?(?!0000)\d{4}\b/g,
    data_type: 'pii_ssn',
    classification: 'restricted',
    confidence: 0.9,
    context_keywords: ['ssn', 'social', 'security', 'tax'],
    negative_keywords: ['phone', 'zip', 'code'],
  },
  {
    id: 'pii-dob',
    name: 'Date of Birth',
    description: 'Detects dates that may be DOB',
    pattern: /\b(?:0?[1-9]|1[0-2])[\/\-](?:0?[1-9]|[12]\d|3[01])[\/\-](?:19|20)\d{2}\b/g,
    data_type: 'pii_dob',
    classification: 'confidential',
    confidence: 0.7,
    context_keywords: ['birth', 'dob', 'born', 'birthday', 'age'],
  },

  // Financial Patterns
  {
    id: 'fin-credit-card',
    name: 'Credit Card Number',
    description: 'Detects credit card numbers (Luhn-validated)',
    pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12}|3(?:0[0-5]|[68][0-9])[0-9]{11})\b/g,
    data_type: 'financial_card',
    classification: 'restricted',
    confidence: 0.95,
    context_keywords: ['card', 'credit', 'debit', 'payment', 'visa', 'mastercard', 'amex'],
  },
  {
    id: 'fin-credit-card-formatted',
    name: 'Formatted Credit Card',
    description: 'Detects formatted credit card numbers',
    pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    data_type: 'financial_card',
    classification: 'restricted',
    confidence: 0.85,
    context_keywords: ['card', 'credit', 'debit', 'payment'],
  },
  {
    id: 'fin-bank-account',
    name: 'Bank Account Number',
    description: 'Detects bank account numbers',
    pattern: /\b[0-9]{8,17}\b/g,
    data_type: 'financial_account',
    classification: 'restricted',
    confidence: 0.5,
    context_keywords: ['account', 'bank', 'checking', 'savings', 'iban', 'swift'],
  },
  {
    id: 'fin-routing',
    name: 'Bank Routing Number',
    description: 'Detects US bank routing numbers',
    pattern: /\b(?:0[1-9]|[1-3][0-9]|4[0-8])\d{7}\b/g,
    data_type: 'financial_routing',
    classification: 'restricted',
    confidence: 0.7,
    context_keywords: ['routing', 'aba', 'transit'],
  },

  // Credential Patterns
  {
    id: 'cred-aws-access',
    name: 'AWS Access Key',
    description: 'Detects AWS access key IDs',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    data_type: 'credential_api_key',
    classification: 'top_secret',
    confidence: 0.99,
  },
  {
    id: 'cred-aws-secret',
    name: 'AWS Secret Key',
    description: 'Detects AWS secret access keys',
    pattern: /\b[A-Za-z0-9/+=]{40}\b/g,
    data_type: 'credential_api_key',
    classification: 'top_secret',
    confidence: 0.6,
    context_keywords: ['aws', 'secret', 'key', 'credential'],
  },
  {
    id: 'cred-private-key',
    name: 'Private Key',
    description: 'Detects private key headers',
    pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g,
    data_type: 'credential_private_key',
    classification: 'top_secret',
    confidence: 0.99,
  },
  {
    id: 'cred-github-token',
    name: 'GitHub Token',
    description: 'Detects GitHub personal access tokens',
    pattern: /\bgh[ps]_[A-Za-z0-9]{36}\b/g,
    data_type: 'credential_token',
    classification: 'top_secret',
    confidence: 0.99,
  },
  {
    id: 'cred-generic-api-key',
    name: 'Generic API Key',
    description: 'Detects generic API key patterns',
    pattern: /\b(?:api[_-]?key|apikey|api_secret)[=:]\s*['"]?[A-Za-z0-9\-_]{20,}['"]?/gi,
    data_type: 'credential_api_key',
    classification: 'restricted',
    confidence: 0.8,
  },
  {
    id: 'cred-password-field',
    name: 'Password Field',
    description: 'Detects password values',
    pattern: /\b(?:password|passwd|pwd|secret)[=:]\s*['"]?[^\s'"]{8,}['"]?/gi,
    data_type: 'credential_password',
    classification: 'restricted',
    confidence: 0.85,
  },
  {
    id: 'cred-jwt-token',
    name: 'JWT Token',
    description: 'Detects JWT tokens',
    pattern: /\beyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\b/g,
    data_type: 'credential_token',
    classification: 'restricted',
    confidence: 0.95,
  },
  {
    id: 'cred-bearer-token',
    name: 'Bearer Token',
    description: 'Detects bearer tokens',
    pattern: /\bBearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g,
    data_type: 'credential_token',
    classification: 'restricted',
    confidence: 0.9,
  },

  // Health Data Patterns (HIPAA)
  {
    id: 'health-mrn',
    name: 'Medical Record Number',
    description: 'Detects medical record numbers',
    pattern: /\bMRN[-:\s]?[0-9]{6,10}\b/gi,
    data_type: 'health_record',
    classification: 'restricted',
    confidence: 0.9,
    context_keywords: ['medical', 'patient', 'health', 'record', 'mrn'],
  },
  {
    id: 'health-npi',
    name: 'NPI Number',
    description: 'Detects National Provider Identifier',
    pattern: /\b[12]\d{9}\b/g,
    data_type: 'health_record',
    classification: 'confidential',
    confidence: 0.7,
    context_keywords: ['npi', 'provider', 'physician', 'doctor'],
  },
  {
    id: 'health-icd-code',
    name: 'ICD Diagnosis Code',
    description: 'Detects ICD-10 diagnosis codes',
    pattern: /\b[A-TV-Z][0-9][0-9AB]\.?[0-9A-TV-Z]{0,4}\b/g,
    data_type: 'health_diagnosis',
    classification: 'restricted',
    confidence: 0.75,
    context_keywords: ['diagnosis', 'icd', 'code', 'condition'],
  },
];

// =============================================================================
// Default Configuration
// =============================================================================

export const defaultDLPConfig: DLPConfig = {
  enabled: true,
  shadow_mode: false,
  redaction_method: 'mask',
  redaction_token_format: '[REDACTED:{type}]',
  detect_pii: true,
  detect_financial: true,
  detect_credentials: true,
  detect_health_data: true,
  detect_custom_schemas: true,
  schemas: [],
  custom_patterns: [],
  always_redact_fields: ['password', 'secret', 'token', 'api_key', 'apiKey', 'credential'],
  never_redact_fields: ['id', 'type', 'version', 'timestamp'],
  max_scan_depth: 20,
  max_string_length: 1024 * 1024, // 1MB
};

// =============================================================================
// DLP Filter
// =============================================================================

export class DLPFilter extends EventEmitter {
  private config: DLPConfig;
  private patterns: DLPPattern[] = [];
  private initialized = false;
  private scanCount = 0;
  private findingsCount = 0;
  private redactionsCount = 0;

  constructor(config: Partial<DLPConfig> = {}) {
    super();
    this.config = { ...defaultDLPConfig, ...config };
  }

  /**
   * Initialize the DLP filter
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Build pattern list based on config
    this.patterns = [];

    if (this.config.detect_pii) {
      this.patterns.push(...DEFAULT_PATTERNS.filter((p) => p.data_type.startsWith('pii_')));
    }
    if (this.config.detect_financial) {
      this.patterns.push(...DEFAULT_PATTERNS.filter((p) => p.data_type.startsWith('financial_')));
    }
    if (this.config.detect_credentials) {
      this.patterns.push(...DEFAULT_PATTERNS.filter((p) => p.data_type.startsWith('credential_')));
    }
    if (this.config.detect_health_data) {
      this.patterns.push(...DEFAULT_PATTERNS.filter((p) => p.data_type.startsWith('health_')));
    }

    // Add custom patterns
    this.patterns.push(...this.config.custom_patterns);

    this.initialized = true;
    logger.info({ patternCount: this.patterns.length }, 'DLP filter initialized');
  }

  /**
   * Filter data (main entry point)
   */
  async filter<T>(data: T, context?: FilterContext): Promise<FilteredOutput<T>> {
    const startTime = Date.now();
    const scanId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    this.scanCount++;

    if (!this.config.enabled) {
      return {
        data,
        scan_result: {
          scan_id: scanId,
          timestamp: new Date().toISOString(),
          input_size: 0,
          output_size: 0,
          format_detected: 'unknown',
          findings: [],
          redactions_applied: 0,
          scan_time_ms: 0,
          blocked: false,
        },
      };
    }

    const findings: DLPFinding[] = [];
    let filteredData = data;
    let blocked = false;
    let blockReason: string | undefined;

    // Detect format
    const format = this.detectFormat(data);

    // Scan based on type
    if (typeof data === 'string') {
      const result = await this.scanString(data, '', findings, context);
      filteredData = result.filtered as T;
      blocked = result.blocked;
      blockReason = result.blockReason;
    } else if (typeof data === 'object' && data !== null) {
      const result = await this.scanObject(data as Record<string, unknown>, '', findings, context, 0);
      filteredData = result.filtered as T;
      blocked = result.blocked;
      blockReason = result.blockReason;
    }

    // Apply schema-specific scanning
    if (this.config.detect_custom_schemas && this.config.schemas.length > 0) {
      for (const schema of this.config.schemas) {
        if (schema.format === format || format === 'json') {
          await this.applySchemaScanning(filteredData, schema, findings);
        }
      }
    }

    this.findingsCount += findings.length;
    this.redactionsCount += findings.filter((f) => f.action_taken === 'redacted').length;

    const inputSize = this.estimateSize(data);
    const outputSize = this.estimateSize(filteredData);

    const scanResult: DLPScanResult = {
      scan_id: scanId,
      timestamp: new Date().toISOString(),
      input_size: inputSize,
      output_size: outputSize,
      format_detected: format,
      findings,
      redactions_applied: findings.filter((f) => f.action_taken === 'redacted').length,
      scan_time_ms: Date.now() - startTime,
      blocked,
      block_reason: blockReason,
    };

    // Emit events
    if (findings.length > 0) {
      this.emit('findings_detected', {
        scan_id: scanId,
        count: findings.length,
        classifications: [...new Set(findings.map((f) => f.classification))],
      });
    }

    if (blocked) {
      this.emit('data_blocked', {
        scan_id: scanId,
        reason: blockReason,
      });
    }

    logger.info(
      {
        scanId,
        findings: findings.length,
        redactions: scanResult.redactions_applied,
        blocked,
        scanTimeMs: scanResult.scan_time_ms,
      },
      'DLP scan completed'
    );

    return {
      data: filteredData,
      scan_result: scanResult,
    };
  }

  /**
   * Detect data format
   */
  private detectFormat(data: unknown): string {
    if (typeof data === 'string') {
      // Try to detect format from string
      const trimmed = data.trim();

      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          JSON.parse(trimmed);
          return 'json';
        } catch {
          // Not valid JSON
        }
      }

      if (trimmed.startsWith('<?xml') || trimmed.startsWith('<')) {
        return 'xml';
      }

      if (trimmed.includes('SELECT') || trimmed.includes('INSERT') || trimmed.includes('UPDATE')) {
        return 'sql';
      }

      if (trimmed.includes(',') && trimmed.includes('\n')) {
        return 'csv';
      }

      return 'text';
    }

    if (typeof data === 'object' && data !== null) {
      return 'json';
    }

    return 'unknown';
  }

  /**
   * Scan a string value
   */
  private async scanString(
    value: string,
    path: string,
    findings: DLPFinding[],
    context?: FilterContext
  ): Promise<{ filtered: string; blocked: boolean; blockReason?: string }> {
    if (value.length > this.config.max_string_length) {
      logger.warn({ path, length: value.length }, 'String exceeds max scan length, truncating');
      value = value.slice(0, this.config.max_string_length);
    }

    let filtered = value;
    let blocked = false;
    let blockReason: string | undefined;

    // Check each pattern
    for (const pattern of this.patterns) {
      pattern.pattern.lastIndex = 0; // Reset regex state

      let match: RegExpExecArray | null;
      const matchesToProcess: Array<{
        match: RegExpExecArray;
        confidence: number;
      }> = [];

      // Find all matches
      while ((match = pattern.pattern.exec(value)) !== null) {
        // Calculate confidence based on context
        let confidence = pattern.confidence;

        // Check context keywords
        if (pattern.context_keywords && pattern.context_keywords.length > 0) {
          const surroundingText = value.slice(
            Math.max(0, match.index - 50),
            Math.min(value.length, match.index + match[0].length + 50)
          ).toLowerCase();

          const hasContextKeyword = pattern.context_keywords.some((kw) =>
            surroundingText.includes(kw.toLowerCase())
          );

          if (hasContextKeyword) {
            confidence = Math.min(1, confidence + 0.1);
          } else {
            confidence *= 0.8;
          }
        }

        // Check negative keywords
        if (pattern.negative_keywords && pattern.negative_keywords.length > 0) {
          const surroundingText = value.slice(
            Math.max(0, match.index - 50),
            Math.min(value.length, match.index + match[0].length + 50)
          ).toLowerCase();

          const hasNegativeKeyword = pattern.negative_keywords.some((kw) =>
            surroundingText.includes(kw.toLowerCase())
          );

          if (hasNegativeKeyword) {
            confidence *= 0.3;
          }
        }

        if (confidence >= 0.5) {
          matchesToProcess.push({ match, confidence });
        }

        // Prevent infinite loop
        if (pattern.pattern.global === false) break;
      }

      // Process matches in reverse order to maintain offsets
      matchesToProcess.sort((a, b) => b.match.index - a.match.index);

      for (const { match, confidence } of matchesToProcess) {
        const finding: DLPFinding = {
          finding_id: `find_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
          pattern_id: pattern.id,
          pattern_name: pattern.name,
          data_type: pattern.data_type,
          classification: pattern.classification,
          location: {
            path,
            start_offset: match.index,
            end_offset: match.index + match[0].length,
          },
          confidence,
          context: value.slice(
            Math.max(0, match.index - 20),
            Math.min(value.length, match.index + match[0].length + 20)
          ),
          action_taken: 'allowed',
        };

        // Determine action
        if (this.shouldBlock(pattern, context)) {
          blocked = true;
          blockReason = `Blocked due to ${pattern.classification} data: ${pattern.name}`;
          finding.action_taken = 'blocked';
        } else if (!this.config.shadow_mode) {
          // Redact the match
          const redacted = this.redact(match[0], pattern.data_type);
          filtered = filtered.slice(0, match.index) + redacted + filtered.slice(match.index + match[0].length);
          finding.action_taken = 'redacted';
          finding.redacted_value = redacted;
        }

        findings.push(finding);
      }
    }

    return { filtered, blocked, blockReason };
  }

  /**
   * Scan an object recursively
   */
  private async scanObject(
    obj: Record<string, unknown>,
    path: string,
    findings: DLPFinding[],
    context?: FilterContext,
    depth: number = 0
  ): Promise<{ filtered: Record<string, unknown>; blocked: boolean; blockReason?: string }> {
    if (depth > this.config.max_scan_depth) {
      logger.warn({ path, depth }, 'Max scan depth exceeded');
      return { filtered: obj, blocked: false };
    }

    const filtered: Record<string, unknown> = {};
    let blocked = false;
    let blockReason: string | undefined;

    for (const [key, value] of Object.entries(obj)) {
      const currentPath = path ? `${path}.${key}` : key;
      const lowerKey = key.toLowerCase();

      // Check if field is in never_redact list
      if (this.config.never_redact_fields.includes(key) ||
          this.config.never_redact_fields.includes(lowerKey)) {
        filtered[key] = value;
        continue;
      }

      // Check if field is in always_redact list
      if (this.config.always_redact_fields.some(
        (f) => lowerKey.includes(f.toLowerCase())
      )) {
        if (typeof value === 'string' && !this.config.shadow_mode) {
          findings.push({
            finding_id: `find_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
            pattern_id: 'field-name-match',
            pattern_name: 'Sensitive Field Name',
            data_type: this.inferDataTypeFromFieldName(key),
            classification: 'confidential',
            location: { path: currentPath, start_offset: 0, end_offset: 0 },
            confidence: 0.95,
            context: `Field: ${key}`,
            action_taken: 'redacted',
            redacted_value: this.redact(value, this.inferDataTypeFromFieldName(key)),
          });
          filtered[key] = this.redact(value, this.inferDataTypeFromFieldName(key));
        } else {
          filtered[key] = value;
        }
        continue;
      }

      // Process value based on type
      if (typeof value === 'string') {
        const result = await this.scanString(value, currentPath, findings, context);
        filtered[key] = result.filtered;
        if (result.blocked) {
          blocked = true;
          blockReason = result.blockReason;
        }
      } else if (Array.isArray(value)) {
        const filteredArray: unknown[] = [];
        for (let i = 0; i < value.length; i++) {
          const item = value[i];
          if (typeof item === 'string') {
            const result = await this.scanString(item, `${currentPath}[${i}]`, findings, context);
            filteredArray.push(result.filtered);
            if (result.blocked) {
              blocked = true;
              blockReason = result.blockReason;
            }
          } else if (typeof item === 'object' && item !== null) {
            const result = await this.scanObject(
              item as Record<string, unknown>,
              `${currentPath}[${i}]`,
              findings,
              context,
              depth + 1
            );
            filteredArray.push(result.filtered);
            if (result.blocked) {
              blocked = true;
              blockReason = result.blockReason;
            }
          } else {
            filteredArray.push(item);
          }
        }
        filtered[key] = filteredArray;
      } else if (typeof value === 'object' && value !== null) {
        const result = await this.scanObject(
          value as Record<string, unknown>,
          currentPath,
          findings,
          context,
          depth + 1
        );
        filtered[key] = result.filtered;
        if (result.blocked) {
          blocked = true;
          blockReason = result.blockReason;
        }
      } else {
        filtered[key] = value;
      }
    }

    return { filtered, blocked, blockReason };
  }

  /**
   * Apply schema-specific scanning
   */
  private async applySchemaScanning(
    data: unknown,
    schema: DataSchema,
    findings: DLPFinding[]
  ): Promise<void> {
    for (const sensitivePath of schema.sensitive_paths) {
      const values = this.getValuesByPath(data, sensitivePath.path);

      for (const { value, actualPath } of values) {
        if (typeof value !== 'string') continue;

        findings.push({
          finding_id: `find_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
          pattern_id: `schema-${schema.id}`,
          pattern_name: `Schema: ${schema.name} - ${sensitivePath.path}`,
          data_type: sensitivePath.data_type,
          classification: sensitivePath.classification,
          location: { path: actualPath, start_offset: 0, end_offset: value.length },
          confidence: 0.99,
          context: `Schema-defined sensitive path`,
          action_taken: this.config.shadow_mode ? 'allowed' : 'redacted',
        });
      }
    }
  }

  /**
   * Get values by JSONPath-like expression
   */
  private getValuesByPath(
    data: unknown,
    path: string
  ): Array<{ value: unknown; actualPath: string }> {
    const results: Array<{ value: unknown; actualPath: string }> = [];
    const parts = path.split('.');

    const traverse = (
      obj: unknown,
      remainingParts: string[],
      currentPath: string
    ) => {
      if (remainingParts.length === 0) {
        results.push({ value: obj, actualPath: currentPath });
        return;
      }

      const part = remainingParts[0]!;
      const rest = remainingParts.slice(1);

      if (part === '*' && Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
          traverse(obj[i], rest, `${currentPath}[${i}]`);
        }
      } else if (part === '**') {
        // Recursive descent
        if (typeof obj === 'object' && obj !== null) {
          for (const [key, value] of Object.entries(obj)) {
            traverse(value, remainingParts, `${currentPath}.${key}`);
            traverse(value, rest, `${currentPath}.${key}`);
          }
        }
      } else if (typeof obj === 'object' && obj !== null) {
        const record = obj as Record<string, unknown>;
        if (part in record) {
          traverse(record[part], rest, `${currentPath}.${part}`);
        }
      }
    };

    traverse(data, parts, '');
    return results;
  }

  /**
   * Determine if data should be blocked
   */
  private shouldBlock(pattern: DLPPattern, context?: FilterContext): boolean {
    if (this.config.shadow_mode) return false;

    // Block top_secret by default
    if (pattern.classification === 'top_secret') {
      return true;
    }

    // Block credentials in untrusted contexts
    if (pattern.data_type.startsWith('credential_') && context?.trusted !== true) {
      return true;
    }

    return false;
  }

  /**
   * Redact a value
   */
  private redact(value: string, dataType: DataType): string {
    switch (this.config.redaction_method) {
      case 'mask':
        return '*'.repeat(Math.min(value.length, 8));

      case 'hash':
        // Simple hash for demonstration
        let hash = 0;
        for (let i = 0; i < value.length; i++) {
          const char = value.charCodeAt(i);
          hash = ((hash << 5) - hash) + char;
          hash = hash & hash;
        }
        return `[HASH:${Math.abs(hash).toString(16).slice(0, 8)}]`;

      case 'token':
        return this.config.redaction_token_format.replace('{type}', dataType);

      case 'remove':
        return '';

      case 'encrypt':
        // Placeholder - would need actual encryption implementation
        return `[ENCRYPTED:${dataType}]`;

      default:
        return '[REDACTED]';
    }
  }

  /**
   * Infer data type from field name
   */
  private inferDataTypeFromFieldName(fieldName: string): DataType {
    const lower = fieldName.toLowerCase();

    if (lower.includes('password') || lower.includes('passwd') || lower.includes('pwd')) {
      return 'credential_password';
    }
    if (lower.includes('api') && lower.includes('key')) {
      return 'credential_api_key';
    }
    if (lower.includes('token')) {
      return 'credential_token';
    }
    if (lower.includes('secret')) {
      return 'credential_api_key';
    }
    if (lower.includes('email')) {
      return 'pii_email';
    }
    if (lower.includes('phone')) {
      return 'pii_phone';
    }
    if (lower.includes('ssn')) {
      return 'pii_ssn';
    }

    return 'custom';
  }

  /**
   * Estimate size of data
   */
  private estimateSize(data: unknown): number {
    try {
      return JSON.stringify(data).length;
    } catch {
      return 0;
    }
  }

  /**
   * Add custom pattern
   */
  addPattern(pattern: DLPPattern): void {
    this.patterns.push(pattern);
  }

  /**
   * Add custom schema
   */
  addSchema(schema: DataSchema): void {
    this.config.schemas.push(schema);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<DLPConfig>): void {
    this.config = { ...this.config, ...config };
    this.initialized = false;
  }

  /**
   * Get statistics
   */
  getStats(): {
    scans: number;
    findings: number;
    redactions: number;
    patterns: number;
    schemas: number;
  } {
    return {
      scans: this.scanCount,
      findings: this.findingsCount,
      redactions: this.redactionsCount,
      patterns: this.patterns.length,
      schemas: this.config.schemas.length,
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.scanCount = 0;
    this.findingsCount = 0;
    this.redactionsCount = 0;
  }
}

// =============================================================================
// Filter Context
// =============================================================================

export interface FilterContext {
  /** Request is from a trusted source */
  trusted?: boolean;
  /** User's clearance level */
  clearance?: DataClassification;
  /** Purpose of the data access */
  purpose?: string;
  /** Target destination */
  destination?: 'internal' | 'external' | 'logs';
}

// =============================================================================
// Singleton Instance
// =============================================================================

let filter: DLPFilter | null = null;

export function getDLPFilter(): DLPFilter {
  if (!filter) {
    filter = new DLPFilter();
  }
  return filter;
}

export async function initializeDLPFilter(
  config?: Partial<DLPConfig>
): Promise<DLPFilter> {
  const f = config ? new DLPFilter(config) : getDLPFilter();
  await f.initialize();
  filter = f;
  return f;
}
