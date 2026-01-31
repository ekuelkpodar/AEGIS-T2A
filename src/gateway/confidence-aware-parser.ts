/**
 * AEGIS-T2A Confidence-Aware Intent Parser
 *
 * Enhanced intent parsing with confidence assessment and disambiguation workflow.
 * When confidence < 8 (on 1-10 scale), forces user disambiguation before planning.
 *
 * Key Features:
 * - LLM-based confidence scoring (1-10 scale)
 * - Automatic disambiguation session creation
 * - 2-3 interpretation options per ambiguous intent
 * - Full audit trail of disambiguation choices
 * - Cryptographically linked disambiguation records
 */

import { z } from 'zod';
import { EventEmitter } from 'events';
import {
  TypedIntent,
  TypedIntentSchema,
  RiskLevel,
  Sensitivity,
  Budget,
} from '../core/types.js';
import { generateIntentId, generateIdempotencyKey, generateId } from '../core/ids.js';
import { componentLogger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import { hashObject, hashChain } from '../core/crypto.js';
import Anthropic from '@anthropic-ai/sdk';

const logger = componentLogger('confidence-aware-parser');

// =============================================================================
// Constants
// =============================================================================

/**
 * Confidence threshold (1-10 scale)
 * Below this value, disambiguation is required
 */
const CONFIDENCE_THRESHOLD = 8;

/**
 * Maximum number of interpretation options to present
 */
const MAX_INTERPRETATION_OPTIONS = 3;

/**
 * Minimum number of interpretation options required for disambiguation
 */
const MIN_INTERPRETATION_OPTIONS = 2;

// =============================================================================
// Types
// =============================================================================

/**
 * Individual interpretation option for disambiguation
 */
export interface InterpretationOption {
  optionId: string;
  description: string;
  actionType: string;
  targetResources: string[];
  estimatedRisk: RiskLevel;
  parameters: Record<string, unknown>;
  confidenceForThisOption: number;
  reasoning: string;
}

/**
 * Disambiguation session for ambiguous intents
 */
export interface DisambiguationSession {
  sessionId: string;
  userId: string;
  originalText: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'resolved' | 'expired' | 'cancelled';
  overallConfidence: number;
  ambiguityReasons: string[];
  options: InterpretationOption[];
  selectedOptionId?: string;
  selectionTimestamp?: string;
  auditHash: string;
  previousSessionHash?: string;
}

/**
 * Result of confidence-aware parsing
 */
export interface ConfidenceAwareParseResult {
  success: boolean;
  requiresDisambiguation: boolean;
  confidence: number;
  intent?: TypedIntent;
  disambiguationSession?: DisambiguationSession;
  error?: string;
  parsingMetadata: ParsingMetadata;
}

/**
 * Metadata about the parsing process
 */
export interface ParsingMetadata {
  parseTimeMs: number;
  modelUsed: string;
  confidenceScale: '1-10';
  disambiguationThreshold: number;
  rawConfidence: number;
  normalizedConfidence: number;
  ambiguityFactors: AmbiguityFactor[];
}

/**
 * Factor contributing to ambiguity
 */
export interface AmbiguityFactor {
  factor: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
}

/**
 * Audit record for disambiguation choices
 */
export interface DisambiguationAuditRecord {
  recordId: string;
  sessionId: string;
  userId: string;
  timestamp: string;
  eventType: 'session_created' | 'option_selected' | 'session_expired' | 'session_cancelled';
  originalText: string;
  optionsPresented: string[];
  selectedOptionId?: string;
  selectedOptionDescription?: string;
  confidenceAtSelection?: number;
  userAgent?: string;
  ipAddress?: string;
  signature: string;
  previousRecordHash: string;
}

/**
 * Configuration for the confidence-aware parser
 */
export interface ConfidenceParserConfig {
  confidenceThreshold: number;
  maxOptions: number;
  sessionTtlMs: number;
  requireExplicitSelection: boolean;
  auditAllSessions: boolean;
}

// =============================================================================
// Zod Schemas
// =============================================================================

const InterpretationOptionSchema = z.object({
  description: z.string(),
  actionType: z.string(),
  targetResources: z.array(z.string()),
  estimatedRisk: z.enum(['low', 'medium', 'high', 'destructive']),
  parameters: z.record(z.unknown()),
  confidenceForThisOption: z.number().min(1).max(10),
  reasoning: z.string(),
});

const LLMParseResponseSchema = z.object({
  confidence: z.number().min(1).max(10),
  primaryInterpretation: InterpretationOptionSchema,
  alternativeInterpretations: z.array(InterpretationOptionSchema).optional(),
  ambiguityReasons: z.array(z.string()).optional(),
  clarifyingQuestions: z.array(z.string()).optional(),
});

// =============================================================================
// Default Configuration
// =============================================================================

export const defaultConfidenceParserConfig: ConfidenceParserConfig = {
  confidenceThreshold: CONFIDENCE_THRESHOLD,
  maxOptions: MAX_INTERPRETATION_OPTIONS,
  sessionTtlMs: 30 * 60 * 1000, // 30 minutes
  requireExplicitSelection: true,
  auditAllSessions: true,
};

// =============================================================================
// LLM Prompt
// =============================================================================

const CONFIDENCE_AWARE_PARSE_PROMPT = `You are an intent parser for AEGIS-T2A, a secure automation platform.
Your task is to analyze natural language requests with high precision and assess your confidence level.

IMPORTANT: Rate your confidence on a 1-10 scale:
- 10: Completely unambiguous, single clear interpretation
- 8-9: Clear intent with minor uncertainties
- 6-7: Somewhat ambiguous, 2-3 valid interpretations possible
- 4-5: Quite ambiguous, multiple equally valid interpretations
- 1-3: Very ambiguous, unclear what user wants

If your confidence is below 8, you MUST provide alternative interpretations.

For each interpretation, analyze:
1. actionType: The type of action (create, update, delete, query, deploy, configure, etc.)
2. description: Clear description of what would happen
3. targetResources: List of resources that would be affected
4. estimatedRisk: Risk level (low, medium, high, destructive)
5. parameters: Key parameters extracted
6. confidenceForThisOption: How likely this interpretation is correct (1-10)
7. reasoning: Why you think this might be what the user means

Risk level guidelines:
- low: Read-only operations, status checks
- medium: Configuration changes, non-production updates
- high: Production data modifications, infrastructure changes
- destructive: Deletions, irreversible operations

Respond with a JSON object:
{
  "confidence": <1-10>,
  "primaryInterpretation": {
    "description": "string",
    "actionType": "string",
    "targetResources": ["string"],
    "estimatedRisk": "low|medium|high|destructive",
    "parameters": {},
    "confidenceForThisOption": <1-10>,
    "reasoning": "string"
  },
  "alternativeInterpretations": [
    // Required if confidence < 8, provide 1-2 alternatives
  ],
  "ambiguityReasons": ["reason1", "reason2"],
  "clarifyingQuestions": ["question1", "question2"]
}`;

// =============================================================================
// Confidence-Aware Parser
// =============================================================================

export class ConfidenceAwareParser extends EventEmitter {
  private config: ConfidenceParserConfig;
  private anthropicClient: Anthropic | null = null;
  private activeSessions = new Map<string, DisambiguationSession>();
  private auditChain: DisambiguationAuditRecord[] = [];
  private lastAuditHash: string = 'genesis';
  private initialized = false;

  constructor(config: Partial<ConfidenceParserConfig> = {}) {
    super();
    this.config = { ...defaultConfidenceParserConfig, ...config };
  }

  /**
   * Initialize the parser
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const config = getConfig();
    if (config.anthropicApiKey) {
      this.anthropicClient = new Anthropic({
        apiKey: config.anthropicApiKey,
      });
    }

    this.initialized = true;
    logger.info('Confidence-aware parser initialized');
  }

  /**
   * Parse intent with confidence assessment
   */
  async parseWithConfidence(
    userId: string,
    nlText: string,
    context?: Record<string, unknown>
  ): Promise<ConfidenceAwareParseResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const startTime = Date.now();

    logger.info({ userId, textLength: nlText.length }, 'Parsing intent with confidence assessment');

    try {
      // Parse using LLM
      const llmResult = await this.parseLLM(nlText, context);
      const parseTimeMs = Date.now() - startTime;

      // Calculate normalized confidence (0-1 scale for internal use)
      const normalizedConfidence = llmResult.confidence / 10;

      // Build parsing metadata
      const parsingMetadata: ParsingMetadata = {
        parseTimeMs,
        modelUsed: 'claude-3-5-sonnet-20241022',
        confidenceScale: '1-10',
        disambiguationThreshold: this.config.confidenceThreshold,
        rawConfidence: llmResult.confidence,
        normalizedConfidence,
        ambiguityFactors: this.extractAmbiguityFactors(llmResult),
      };

      // Check if disambiguation is required
      if (llmResult.confidence < this.config.confidenceThreshold) {
        const session = await this.createDisambiguationSession(
          userId,
          nlText,
          llmResult,
          parsingMetadata
        );

        this.emit('disambiguation_required', {
          sessionId: session.sessionId,
          userId,
          confidence: llmResult.confidence,
          optionCount: session.options.length,
        });

        return {
          success: true,
          requiresDisambiguation: true,
          confidence: llmResult.confidence,
          disambiguationSession: session,
          parsingMetadata,
        };
      }

      // High confidence - create intent directly
      const intent = await this.createIntentFromInterpretation(
        userId,
        nlText,
        llmResult.primaryInterpretation,
        normalizedConfidence,
        parseTimeMs
      );

      this.emit('intent_parsed', {
        intentId: intent.intentId,
        userId,
        confidence: llmResult.confidence,
        actionType: intent.actionType,
      });

      return {
        success: true,
        requiresDisambiguation: false,
        confidence: llmResult.confidence,
        intent,
        parsingMetadata,
      };
    } catch (error) {
      logger.error({ error, userId }, 'Failed to parse intent with confidence');

      return {
        success: false,
        requiresDisambiguation: false,
        confidence: 0,
        error: error instanceof Error ? error.message : 'Unknown parsing error',
        parsingMetadata: {
          parseTimeMs: Date.now() - startTime,
          modelUsed: 'none',
          confidenceScale: '1-10',
          disambiguationThreshold: this.config.confidenceThreshold,
          rawConfidence: 0,
          normalizedConfidence: 0,
          ambiguityFactors: [],
        },
      };
    }
  }

  /**
   * Resolve disambiguation by user selection
   */
  async resolveDisambiguation(
    sessionId: string,
    selectedOptionId: string,
    userMetadata?: { userAgent?: string; ipAddress?: string }
  ): Promise<ConfidenceAwareParseResult> {
    const session = this.activeSessions.get(sessionId);

    if (!session) {
      return {
        success: false,
        requiresDisambiguation: false,
        confidence: 0,
        error: `Disambiguation session not found: ${sessionId}`,
        parsingMetadata: this.createEmptyMetadata(),
      };
    }

    if (session.status !== 'pending') {
      return {
        success: false,
        requiresDisambiguation: false,
        confidence: 0,
        error: `Session is not pending: ${session.status}`,
        parsingMetadata: this.createEmptyMetadata(),
      };
    }

    // Check expiration
    if (new Date(session.expiresAt) < new Date()) {
      session.status = 'expired';
      await this.recordAuditEvent(session, 'session_expired');

      return {
        success: false,
        requiresDisambiguation: false,
        confidence: 0,
        error: 'Disambiguation session has expired',
        parsingMetadata: this.createEmptyMetadata(),
      };
    }

    // Find selected option
    const selectedOption = session.options.find(o => o.optionId === selectedOptionId);

    if (!selectedOption) {
      return {
        success: false,
        requiresDisambiguation: false,
        confidence: 0,
        error: `Invalid option selected: ${selectedOptionId}`,
        parsingMetadata: this.createEmptyMetadata(),
      };
    }

    // Update session
    session.status = 'resolved';
    session.selectedOptionId = selectedOptionId;
    session.selectionTimestamp = new Date().toISOString();

    // Record audit event
    await this.recordAuditEvent(
      session,
      'option_selected',
      selectedOption,
      userMetadata
    );

    // Create intent from selected option
    const intent = await this.createIntentFromInterpretation(
      session.userId,
      session.originalText,
      selectedOption,
      selectedOption.confidenceForThisOption / 10,
      0, // parseTimeMs not relevant for disambiguation resolution
      {
        disambiguationSessionId: sessionId,
        selectedOptionId,
        originalConfidence: session.overallConfidence,
        selectionTimestamp: session.selectionTimestamp,
      }
    );

    this.emit('disambiguation_resolved', {
      sessionId,
      userId: session.userId,
      selectedOptionId,
      intentId: intent.intentId,
    });

    // Clean up session
    this.activeSessions.delete(sessionId);

    return {
      success: true,
      requiresDisambiguation: false,
      confidence: selectedOption.confidenceForThisOption,
      intent,
      parsingMetadata: {
        parseTimeMs: 0,
        modelUsed: 'disambiguation-resolution',
        confidenceScale: '1-10',
        disambiguationThreshold: this.config.confidenceThreshold,
        rawConfidence: selectedOption.confidenceForThisOption,
        normalizedConfidence: selectedOption.confidenceForThisOption / 10,
        ambiguityFactors: [],
      },
    };
  }

  /**
   * Cancel a disambiguation session
   */
  async cancelDisambiguation(sessionId: string): Promise<boolean> {
    const session = this.activeSessions.get(sessionId);

    if (!session || session.status !== 'pending') {
      return false;
    }

    session.status = 'cancelled';
    await this.recordAuditEvent(session, 'session_cancelled');

    this.emit('disambiguation_cancelled', {
      sessionId,
      userId: session.userId,
    });

    this.activeSessions.delete(sessionId);
    return true;
  }

  /**
   * Get active disambiguation session
   */
  getSession(sessionId: string): DisambiguationSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  /**
   * Get user's pending disambiguation sessions
   */
  getUserPendingSessions(userId: string): DisambiguationSession[] {
    const sessions: DisambiguationSession[] = [];

    for (const session of this.activeSessions.values()) {
      if (session.userId === userId && session.status === 'pending') {
        sessions.push(session);
      }
    }

    return sessions;
  }

  /**
   * Get disambiguation audit trail
   */
  getAuditTrail(sessionId?: string): DisambiguationAuditRecord[] {
    if (sessionId) {
      return this.auditChain.filter(r => r.sessionId === sessionId);
    }
    return [...this.auditChain];
  }

  /**
   * Verify audit chain integrity
   */
  verifyAuditChainIntegrity(): { valid: boolean; brokenAt?: number } {
    if (this.auditChain.length === 0) {
      return { valid: true };
    }

    let expectedPreviousHash = 'genesis';

    for (let i = 0; i < this.auditChain.length; i++) {
      const record = this.auditChain[i];

      if (record.previousRecordHash !== expectedPreviousHash) {
        return { valid: false, brokenAt: i };
      }

      expectedPreviousHash = record.signature;
    }

    return { valid: true };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Parse using LLM with confidence assessment
   */
  private async parseLLM(
    nlText: string,
    context?: Record<string, unknown>
  ): Promise<z.infer<typeof LLMParseResponseSchema>> {
    if (!this.anthropicClient) {
      // Fallback to heuristic parsing
      return this.parseHeuristic(nlText);
    }

    const contextStr = context
      ? `\n\nAdditional context:\n${JSON.stringify(context, null, 2)}`
      : '';

    const response = await this.anthropicClient.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `${CONFIDENCE_AWARE_PARSE_PROMPT}${contextStr}\n\nUser request: "${nlText}"`,
        },
      ],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from LLM');
    }

    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No valid JSON found in LLM response');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return LLMParseResponseSchema.parse(parsed);
  }

  /**
   * Heuristic-based parsing fallback
   */
  private parseHeuristic(nlText: string): z.infer<typeof LLMParseResponseSchema> {
    const lowerText = nlText.toLowerCase();

    // Keyword-based detection
    const interpretations: Array<{
      keywords: string[];
      actionType: string;
      risk: RiskLevel;
      description: string;
    }> = [
      { keywords: ['delete', 'remove', 'destroy'], actionType: 'delete', risk: 'destructive', description: 'Delete or remove resources' },
      { keywords: ['create', 'add', 'new'], actionType: 'create', risk: 'medium', description: 'Create new resources' },
      { keywords: ['update', 'modify', 'change'], actionType: 'update', risk: 'medium', description: 'Update existing resources' },
      { keywords: ['get', 'list', 'show', 'query', 'find'], actionType: 'query', risk: 'low', description: 'Query or retrieve information' },
      { keywords: ['deploy', 'launch', 'start'], actionType: 'deploy', risk: 'high', description: 'Deploy or launch services' },
    ];

    const matches = interpretations.filter(i =>
      i.keywords.some(k => lowerText.includes(k))
    );

    // Determine confidence based on match clarity
    let confidence: number;
    if (matches.length === 0) {
      confidence = 3;
    } else if (matches.length === 1) {
      confidence = 7;
    } else {
      confidence = 5;
    }

    const primary = matches[0] ?? {
      actionType: 'unknown',
      risk: 'medium' as RiskLevel,
      description: 'Unable to determine intent',
    };

    const result: z.infer<typeof LLMParseResponseSchema> = {
      confidence,
      primaryInterpretation: {
        description: primary.description,
        actionType: primary.actionType,
        targetResources: [],
        estimatedRisk: primary.risk,
        parameters: {},
        confidenceForThisOption: confidence,
        reasoning: `Detected keywords matching "${primary.actionType}" action`,
      },
      ambiguityReasons: matches.length > 1
        ? ['Multiple action types detected in request']
        : ['Heuristic parsing has limited confidence'],
    };

    if (matches.length > 1) {
      result.alternativeInterpretations = matches.slice(1).map(m => ({
        description: m.description,
        actionType: m.actionType,
        targetResources: [],
        estimatedRisk: m.risk,
        parameters: {},
        confidenceForThisOption: confidence - 1,
        reasoning: `Also detected keywords matching "${m.actionType}" action`,
      }));
    }

    return result;
  }

  /**
   * Create disambiguation session
   */
  private async createDisambiguationSession(
    userId: string,
    nlText: string,
    llmResult: z.infer<typeof LLMParseResponseSchema>,
    metadata: ParsingMetadata
  ): Promise<DisambiguationSession> {
    const sessionId = generateId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.sessionTtlMs);

    // Build options array
    const options: InterpretationOption[] = [
      {
        optionId: generateId(),
        ...llmResult.primaryInterpretation,
      },
    ];

    // Add alternative interpretations
    if (llmResult.alternativeInterpretations) {
      for (const alt of llmResult.alternativeInterpretations.slice(0, this.config.maxOptions - 1)) {
        options.push({
          optionId: generateId(),
          ...alt,
        });
      }
    }

    // Ensure minimum options for disambiguation
    if (options.length < MIN_INTERPRETATION_OPTIONS) {
      // Add a "something else" option
      options.push({
        optionId: generateId(),
        description: 'None of the above - I meant something different',
        actionType: 'clarify',
        targetResources: [],
        estimatedRisk: 'low',
        parameters: {},
        confidenceForThisOption: 1,
        reasoning: 'User may have meant something not captured by other options',
      });
    }

    const session: DisambiguationSession = {
      sessionId,
      userId,
      originalText: nlText,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'pending',
      overallConfidence: llmResult.confidence,
      ambiguityReasons: llmResult.ambiguityReasons ?? [],
      options,
      auditHash: '', // Will be set after hashing
    };

    // Calculate audit hash
    session.auditHash = hashObject({
      sessionId,
      userId,
      originalText: nlText,
      createdAt: session.createdAt,
      options: options.map(o => o.optionId),
    });

    // Store session
    this.activeSessions.set(sessionId, session);

    // Record audit event
    await this.recordAuditEvent(session, 'session_created');

    logger.info(
      {
        sessionId,
        userId,
        confidence: llmResult.confidence,
        optionCount: options.length,
      },
      'Disambiguation session created'
    );

    return session;
  }

  /**
   * Create intent from interpretation
   */
  private async createIntentFromInterpretation(
    userId: string,
    nlText: string,
    interpretation: z.infer<typeof InterpretationOptionSchema>,
    normalizedConfidence: number,
    parseTimeMs: number,
    disambiguationMetadata?: Record<string, unknown>
  ): Promise<TypedIntent> {
    const intentId = generateIntentId();
    const now = new Date().toISOString();

    const budget: Budget = {
      currency: 'USD',
      limit: 10,
      spent: 0,
    };

    const sensitivity = this.determineSensitivity(interpretation);

    const intent: TypedIntent = {
      intentId,
      userId,
      timestamp: now,
      nlText,
      actionType: interpretation.actionType,
      riskLevel: interpretation.estimatedRisk,
      sensitivity,
      budget,
      requiredCapabilities: [],
      sideEffect: interpretation.estimatedRisk !== 'low',
      idempotencyKey: generateIdempotencyKey('intent', userId, nlText),
      policyStatus: 'pending',
      approvalRequired: this.shouldRequireApproval(interpretation.estimatedRisk),
      confidence: normalizedConfidence,
      metadata: {
        description: interpretation.description,
        targetResources: interpretation.targetResources,
        parameters: interpretation.parameters,
        parseTimeMs,
        confidenceScale: '1-10',
        rawConfidence: interpretation.confidenceForThisOption,
        reasoning: interpretation.reasoning,
        ...disambiguationMetadata,
      },
    };

    TypedIntentSchema.parse(intent);

    return intent;
  }

  /**
   * Determine sensitivity level
   */
  private determineSensitivity(
    interpretation: z.infer<typeof InterpretationOptionSchema>
  ): Sensitivity {
    if (interpretation.estimatedRisk === 'destructive') {
      return Sensitivity.RESTRICTED;
    }

    if (interpretation.estimatedRisk === 'high') {
      return Sensitivity.CONFIDENTIAL;
    }

    return Sensitivity.PUBLIC;
  }

  /**
   * Determine if approval is required
   */
  private shouldRequireApproval(riskLevel: RiskLevel): boolean {
    return riskLevel === 'medium' || riskLevel === 'high' || riskLevel === 'destructive';
  }

  /**
   * Extract ambiguity factors from LLM result
   */
  private extractAmbiguityFactors(
    llmResult: z.infer<typeof LLMParseResponseSchema>
  ): AmbiguityFactor[] {
    const factors: AmbiguityFactor[] = [];

    // Multiple interpretations indicate ambiguity
    if (llmResult.alternativeInterpretations && llmResult.alternativeInterpretations.length > 0) {
      factors.push({
        factor: 'multiple_interpretations',
        severity: llmResult.alternativeInterpretations.length > 1 ? 'high' : 'medium',
        description: `${llmResult.alternativeInterpretations.length + 1} valid interpretations detected`,
      });
    }

    // Low confidence indicates ambiguity
    if (llmResult.confidence < 5) {
      factors.push({
        factor: 'low_overall_confidence',
        severity: 'high',
        description: `Overall confidence is only ${llmResult.confidence}/10`,
      });
    } else if (llmResult.confidence < 7) {
      factors.push({
        factor: 'moderate_confidence',
        severity: 'medium',
        description: `Confidence is ${llmResult.confidence}/10`,
      });
    }

    // Explicit ambiguity reasons
    if (llmResult.ambiguityReasons) {
      for (const reason of llmResult.ambiguityReasons) {
        factors.push({
          factor: 'explicit_ambiguity',
          severity: 'medium',
          description: reason,
        });
      }
    }

    return factors;
  }

  /**
   * Record audit event
   */
  private async recordAuditEvent(
    session: DisambiguationSession,
    eventType: DisambiguationAuditRecord['eventType'],
    selectedOption?: InterpretationOption,
    userMetadata?: { userAgent?: string; ipAddress?: string }
  ): Promise<void> {
    const recordId = generateId();
    const timestamp = new Date().toISOString();

    const record: DisambiguationAuditRecord = {
      recordId,
      sessionId: session.sessionId,
      userId: session.userId,
      timestamp,
      eventType,
      originalText: session.originalText,
      optionsPresented: session.options.map(o => o.optionId),
      selectedOptionId: selectedOption?.optionId,
      selectedOptionDescription: selectedOption?.description,
      confidenceAtSelection: selectedOption?.confidenceForThisOption,
      userAgent: userMetadata?.userAgent,
      ipAddress: userMetadata?.ipAddress,
      previousRecordHash: this.lastAuditHash,
      signature: '', // Will be set after hashing
    };

    // Calculate signature (hash of the record)
    record.signature = hashObject({
      ...record,
      signature: undefined,
    });

    // Update chain hash
    this.lastAuditHash = record.signature;

    // Add to audit chain
    this.auditChain.push(record);

    this.emit('audit_recorded', {
      recordId,
      sessionId: session.sessionId,
      eventType,
    });

    logger.debug(
      {
        recordId,
        sessionId: session.sessionId,
        eventType,
      },
      'Disambiguation audit recorded'
    );
  }

  /**
   * Create empty metadata for error responses
   */
  private createEmptyMetadata(): ParsingMetadata {
    return {
      parseTimeMs: 0,
      modelUsed: 'none',
      confidenceScale: '1-10',
      disambiguationThreshold: this.config.confidenceThreshold,
      rawConfidence: 0,
      normalizedConfidence: 0,
      ambiguityFactors: [],
    };
  }
}

// =============================================================================
// Singleton
// =============================================================================

let confidenceParser: ConfidenceAwareParser | null = null;

export function getConfidenceAwareParser(): ConfidenceAwareParser {
  if (!confidenceParser) {
    confidenceParser = new ConfidenceAwareParser();
  }
  return confidenceParser;
}

export async function initializeConfidenceAwareParser(
  config?: Partial<ConfidenceParserConfig>
): Promise<ConfidenceAwareParser> {
  if (!confidenceParser) {
    confidenceParser = new ConfidenceAwareParser(config);
  }
  await confidenceParser.initialize();
  return confidenceParser;
}
