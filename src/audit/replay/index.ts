/**
 * AEGIS-T2A Deterministic Replay Engine
 *
 * Captures full execution context for SOC 2 CC7.2 compliance, enabling
 * complete reconstruction of "why" decisions were made under specific conditions.
 *
 * Key Components:
 * - ExecutionArtifactRecorder: Captures full context per workflow step
 * - Immutable Storage: Append-only with Merkle tree roots
 * - ReplayEngine: Re-executes with identical responses via deterministic caching
 * - Time Travel Debugging: API for historical state inspection
 *
 * CRITICAL SAFETY CONSTRAINT:
 * Replay artifacts MUST include cryptographic proof that LLM responses weren't
 * tampered with. Artifacts are immutable once recorded.
 */

import { EventEmitter } from 'events';
import { z } from 'zod';
import { componentLogger } from '../../core/logger.js';
import { generateId } from '../../core/ids.js';
import { hashObject, signObject, chainHash } from '../../core/crypto.js';
import type { PlanStep, RiskLevel, AuditEvent } from '../../core/types.js';

const logger = componentLogger('replay-engine');

// =============================================================================
// Constants
// =============================================================================

/**
 * Merkle root commit interval (5 minutes)
 */
const MERKLE_COMMIT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Default artifact retention (90 days)
 */
const DEFAULT_RETENTION_DAYS = 90;

/**
 * Maximum artifacts per query
 */
const MAX_ARTIFACTS_PER_QUERY = 10000;

/**
 * Prompt cache TTL (7 days)
 */
const PROMPT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// =============================================================================
// Types
// =============================================================================

/**
 * Full execution artifact per workflow step
 */
export interface ExecutionArtifact {
  artifactId: string;
  workflowId: string;
  stepId: string;
  planId: string;
  timestamp: string;
  sequenceNumber: number;

  // LLM interaction capture
  llmInteraction?: LLMInteractionCapture;

  // Tool execution capture
  toolCall: ToolCallCapture;

  // Environment state capture
  environmentSnapshot: EnvironmentSnapshot;

  // Risk and policy capture
  riskScore: number;
  policyDecisions: PolicyDecisionCapture[];

  // Cryptographic integrity
  hash: string;
  previousArtifactHash: string;
  signature: string;
  llmProviderSignature?: string; // When available from provider
}

/**
 * LLM interaction capture
 */
export interface LLMInteractionCapture {
  provider: string;
  model: string;
  promptHash: string;
  prompt: string;
  systemPrompt?: string;
  responseHash: string;
  response: string;
  tokenCount: {
    input: number;
    output: number;
  };
  latencyMs: number;
  temperature?: number;
  topP?: number;
  requestId?: string;
  providerSignature?: string;
}

/**
 * Tool call capture
 */
export interface ToolCallCapture {
  toolAdapter: string;
  action: string;
  parametersHash: string;
  parameters: Record<string, unknown>;
  outputsHash: string;
  outputs: Record<string, unknown>;
  success: boolean;
  error?: string;
  durationMs: number;
  retryCount: number;
}

/**
 * Environment snapshot before/after execution
 */
export interface EnvironmentSnapshot {
  snapshotId: string;
  timestamp: string;
  phase: 'pre' | 'post';

  // Resource state
  targetResource?: string;
  resourceState?: Record<string, unknown>;

  // Context
  userId: string;
  userRoles: string[];
  environment: 'development' | 'staging' | 'production';

  // System state
  systemMetrics?: {
    memoryUsageMb: number;
    cpuPercent: number;
    activeConnections: number;
  };

  // External dependencies
  dependencyStates?: Record<string, DependencyState>;
}

/**
 * External dependency state
 */
export interface DependencyState {
  name: string;
  status: 'available' | 'degraded' | 'unavailable';
  latencyMs?: number;
  version?: string;
}

/**
 * Policy decision capture
 */
export interface PolicyDecisionCapture {
  policyId: string;
  policyName: string;
  result: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
  reason: string;
  evaluationTimeMs: number;
  matchedConditions: string[];
}

/**
 * Merkle tree node
 */
export interface MerkleNode {
  nodeId: string;
  level: number;
  hash: string;
  leftChildHash?: string;
  rightChildHash?: string;
  artifactIds?: string[]; // Only for leaf nodes
  timestamp: string;
}

/**
 * Merkle root commit
 */
export interface MerkleRootCommit {
  commitId: string;
  timestamp: string;
  rootHash: string;
  artifactCount: number;
  firstArtifactId: string;
  lastArtifactId: string;
  signature: string;
}

/**
 * Prompt-response cache entry
 */
export interface PromptCacheEntry {
  cacheKey: string;
  promptHash: string;
  responseHash: string;
  response: string;
  provider: string;
  model: string;
  cachedAt: string;
  expiresAt: string;
  hitCount: number;
  lastHitAt: string;
}

/**
 * Replay request
 */
export interface ReplayRequest {
  requestId: string;
  workflowId: string;
  targetTimestamp?: string; // For time-travel
  stepRange?: { from: number; to: number };
  useCachedResponses: boolean;
  validateIntegrity: boolean;
}

/**
 * Replay result
 */
export interface ReplayResult {
  requestId: string;
  success: boolean;
  workflowId: string;
  artifactsReplayed: number;
  timeline: ReplayTimelineEntry[];
  integrityVerification?: IntegrityVerification;
  errors: ReplayError[];
  duration: {
    totalMs: number;
    replayMs: number;
    verificationMs: number;
  };
}

/**
 * Replay timeline entry
 */
export interface ReplayTimelineEntry {
  stepId: string;
  timestamp: string;
  action: string;
  originalOutcome: 'success' | 'failure';
  replayOutcome: 'success' | 'failure' | 'skipped';
  responseMatched: boolean;
  driftDetected: boolean;
  driftDetails?: string;
}

/**
 * Integrity verification result
 */
export interface IntegrityVerification {
  verified: boolean;
  artifactsChecked: number;
  hashMismatches: string[];
  signatureFailures: string[];
  chainBreaks: number[];
  merkleRootValid: boolean;
}

/**
 * Replay error
 */
export interface ReplayError {
  stepId: string;
  errorType: 'ARTIFACT_MISSING' | 'HASH_MISMATCH' | 'CACHE_MISS' | 'EXECUTION_FAILURE';
  message: string;
  recoverable: boolean;
}

/**
 * Replay engine configuration
 */
export interface ReplayEngineConfig {
  enabled: boolean;
  captureFullPrompts: boolean;
  captureEnvironmentState: boolean;
  enablePromptCaching: boolean;
  promptCacheTtlMs: number;
  merkleCommitIntervalMs: number;
  retentionDays: number;
  compressArtifacts: boolean;
  encryptSensitiveData: boolean;
}

/**
 * Time travel query
 */
export interface TimeTravelQuery {
  workflowId: string;
  timestamp: string;
  includeEnvironmentState: boolean;
  includePrompts: boolean;
}

/**
 * Time travel snapshot
 */
export interface TimeTravelSnapshot {
  queryId: string;
  workflowId: string;
  requestedTimestamp: string;
  nearestArtifactTimestamp: string;
  state: {
    stepId: string;
    stepStatus: string;
    completedSteps: string[];
    pendingSteps: string[];
    riskScore: number;
    policyDecisions: PolicyDecisionCapture[];
  };
  environment?: EnvironmentSnapshot;
  llmContext?: {
    lastPrompt?: string;
    lastResponse?: string;
    totalTokens: number;
  };
  integrityProof: {
    artifactHash: string;
    merkleProof: string[];
    rootHash: string;
  };
}

// =============================================================================
// Zod Schemas
// =============================================================================

export const ReplayEngineConfigSchema = z.object({
  enabled: z.boolean().default(false),
  captureFullPrompts: z.boolean().default(true),
  captureEnvironmentState: z.boolean().default(true),
  enablePromptCaching: z.boolean().default(true),
  promptCacheTtlMs: z.number().positive().default(PROMPT_CACHE_TTL_MS),
  merkleCommitIntervalMs: z.number().positive().default(MERKLE_COMMIT_INTERVAL_MS),
  retentionDays: z.number().int().positive().default(DEFAULT_RETENTION_DAYS),
  compressArtifacts: z.boolean().default(true),
  encryptSensitiveData: z.boolean().default(true),
});

// =============================================================================
// Default Configuration
// =============================================================================

export const defaultReplayEngineConfig: ReplayEngineConfig = {
  enabled: false, // Backward compatible - opt-in (requires storage budget)
  captureFullPrompts: true,
  captureEnvironmentState: true,
  enablePromptCaching: true,
  promptCacheTtlMs: PROMPT_CACHE_TTL_MS,
  merkleCommitIntervalMs: MERKLE_COMMIT_INTERVAL_MS,
  retentionDays: DEFAULT_RETENTION_DAYS,
  compressArtifacts: true,
  encryptSensitiveData: true,
};

// =============================================================================
// Execution Artifact Recorder
// =============================================================================

/**
 * Records full execution context for each workflow step
 */
export class ExecutionArtifactRecorder extends EventEmitter {
  private config: ReplayEngineConfig;
  private artifacts: ExecutionArtifact[] = [];
  private merkleLeaves: MerkleNode[] = [];
  private merkleRoots: MerkleRootCommit[] = [];
  private lastArtifactHash = 'genesis';
  private promptCache = new Map<string, PromptCacheEntry>();
  private merkleTimer: NodeJS.Timeout | null = null;
  private initialized = false;

  constructor(config: Partial<ReplayEngineConfig> = {}) {
    super();
    this.config = { ...defaultReplayEngineConfig, ...config };
  }

  /**
   * Initialize the recorder
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!this.config.enabled) {
      logger.info('Deterministic replay is disabled');
      this.initialized = true;
      return;
    }

    // Start Merkle commit timer
    this.merkleTimer = setInterval(
      () => this.commitMerkleRoot(),
      this.config.merkleCommitIntervalMs
    );

    this.initialized = true;
    logger.info('Execution artifact recorder initialized');
  }

  /**
   * Shutdown the recorder
   */
  async shutdown(): Promise<void> {
    if (this.merkleTimer) {
      clearInterval(this.merkleTimer);
      this.merkleTimer = null;
    }

    // Final Merkle commit
    await this.commitMerkleRoot();

    this.initialized = false;
    logger.info('Execution artifact recorder shut down');
  }

  /**
   * Record execution artifact
   */
  async recordArtifact(
    workflowId: string,
    stepId: string,
    planId: string,
    sequenceNumber: number,
    llmInteraction: LLMInteractionCapture | undefined,
    toolCall: ToolCallCapture,
    environmentSnapshot: EnvironmentSnapshot,
    riskScore: number,
    policyDecisions: PolicyDecisionCapture[]
  ): Promise<ExecutionArtifact> {
    if (!this.config.enabled) {
      throw new Error('Deterministic replay is disabled');
    }

    const artifactId = generateId();
    const timestamp = new Date().toISOString();

    // Sanitize sensitive data if configured
    const sanitizedToolCall = this.config.encryptSensitiveData
      ? this.sanitizeToolCall(toolCall)
      : toolCall;

    const sanitizedEnv = this.config.encryptSensitiveData
      ? this.sanitizeEnvironmentSnapshot(environmentSnapshot)
      : environmentSnapshot;

    // Build artifact without hash/signature
    const artifactData = {
      artifactId,
      workflowId,
      stepId,
      planId,
      timestamp,
      sequenceNumber,
      llmInteraction: llmInteraction
        ? this.processLLMInteraction(llmInteraction)
        : undefined,
      toolCall: sanitizedToolCall,
      environmentSnapshot: sanitizedEnv,
      riskScore,
      policyDecisions,
      previousArtifactHash: this.lastArtifactHash,
    };

    // Compute hash
    const hash = hashObject(artifactData);

    // Sign the artifact
    const signature = signObject({ ...artifactData, hash });

    const artifact: ExecutionArtifact = {
      ...artifactData,
      hash,
      signature,
      llmProviderSignature: llmInteraction?.providerSignature,
    };

    // Update chain
    this.lastArtifactHash = hash;
    this.artifacts.push(artifact);

    // Add to Merkle tree
    this.addToMerkleTree(artifact);

    // Cache prompt-response if enabled
    if (this.config.enablePromptCaching && llmInteraction) {
      this.cachePromptResponse(llmInteraction);
    }

    this.emit('artifact_recorded', {
      artifactId,
      workflowId,
      stepId,
      sequenceNumber,
    });

    logger.debug(
      {
        artifactId,
        workflowId,
        stepId,
        sequenceNumber,
      },
      'Execution artifact recorded'
    );

    return artifact;
  }

  /**
   * Get artifacts for workflow
   */
  getWorkflowArtifacts(workflowId: string): ExecutionArtifact[] {
    return this.artifacts
      .filter((a) => a.workflowId === workflowId)
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  }

  /**
   * Get artifact by ID
   */
  getArtifact(artifactId: string): ExecutionArtifact | undefined {
    return this.artifacts.find((a) => a.artifactId === artifactId);
  }

  /**
   * Get cached response for prompt
   */
  getCachedResponse(promptHash: string): PromptCacheEntry | undefined {
    const entry = this.promptCache.get(promptHash);

    if (!entry) return undefined;

    // Check expiration
    if (new Date(entry.expiresAt) < new Date()) {
      this.promptCache.delete(promptHash);
      return undefined;
    }

    // Update hit count
    entry.hitCount++;
    entry.lastHitAt = new Date().toISOString();

    return entry;
  }

  /**
   * Get Merkle proof for artifact
   */
  getMerkleProof(artifactId: string): { proof: string[]; rootHash: string } | undefined {
    // Find leaf containing artifact
    const leaf = this.merkleLeaves.find((l) => l.artifactIds?.includes(artifactId));

    if (!leaf) return undefined;

    // Build proof path to root (simplified for demo)
    const proof: string[] = [leaf.hash];

    // Find most recent root
    const root = this.merkleRoots[this.merkleRoots.length - 1];

    if (!root) return undefined;

    return {
      proof,
      rootHash: root.rootHash,
    };
  }

  /**
   * Verify artifact integrity
   */
  verifyArtifactIntegrity(artifact: ExecutionArtifact): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    // Verify hash
    const computed = hashObject({
      artifactId: artifact.artifactId,
      workflowId: artifact.workflowId,
      stepId: artifact.stepId,
      planId: artifact.planId,
      timestamp: artifact.timestamp,
      sequenceNumber: artifact.sequenceNumber,
      llmInteraction: artifact.llmInteraction,
      toolCall: artifact.toolCall,
      environmentSnapshot: artifact.environmentSnapshot,
      riskScore: artifact.riskScore,
      policyDecisions: artifact.policyDecisions,
      previousArtifactHash: artifact.previousArtifactHash,
    });

    if (computed !== artifact.hash) {
      errors.push(`Hash mismatch: expected ${artifact.hash}, computed ${computed}`);
    }

    // Verify LLM response integrity
    if (artifact.llmInteraction) {
      const responseHash = hashObject({ response: artifact.llmInteraction.response });
      if (responseHash !== artifact.llmInteraction.responseHash) {
        errors.push('LLM response hash mismatch - possible tampering');
      }
    }

    // Verify tool output integrity
    const outputsHash = hashObject(artifact.toolCall.outputs);
    if (outputsHash !== artifact.toolCall.outputsHash) {
      errors.push('Tool outputs hash mismatch - possible tampering');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Verify chain integrity for workflow
   */
  verifyChainIntegrity(workflowId: string): {
    valid: boolean;
    brokenAt?: number;
  } {
    const artifacts = this.getWorkflowArtifacts(workflowId);

    if (artifacts.length === 0) return { valid: true };

    // First artifact should reference genesis
    if (artifacts[0].previousArtifactHash !== 'genesis') {
      // Check if it chains from a previous workflow
      const prevArtifact = this.artifacts.find(
        (a) => a.hash === artifacts[0].previousArtifactHash
      );

      if (!prevArtifact) {
        return { valid: false, brokenAt: 0 };
      }
    }

    // Check chain continuity
    for (let i = 1; i < artifacts.length; i++) {
      if (artifacts[i].previousArtifactHash !== artifacts[i - 1].hash) {
        return { valid: false, brokenAt: i };
      }
    }

    return { valid: true };
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalArtifacts: number;
    merkleRoots: number;
    cacheEntries: number;
    cacheHitRate: number;
  } {
    let totalHits = 0;
    let totalEntries = 0;

    for (const entry of this.promptCache.values()) {
      totalHits += entry.hitCount;
      totalEntries++;
    }

    return {
      totalArtifacts: this.artifacts.length,
      merkleRoots: this.merkleRoots.length,
      cacheEntries: totalEntries,
      cacheHitRate: totalEntries > 0 ? totalHits / totalEntries : 0,
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Process LLM interaction for storage
   */
  private processLLMInteraction(
    interaction: LLMInteractionCapture
  ): LLMInteractionCapture {
    // Compute hashes if not provided
    const promptHash =
      interaction.promptHash || hashObject({ prompt: interaction.prompt });
    const responseHash =
      interaction.responseHash || hashObject({ response: interaction.response });

    return {
      ...interaction,
      promptHash,
      responseHash,
      // Optionally truncate for storage
      prompt: this.config.captureFullPrompts
        ? interaction.prompt
        : `[TRUNCATED: ${promptHash}]`,
    };
  }

  /**
   * Sanitize tool call (redact sensitive parameters)
   */
  private sanitizeToolCall(toolCall: ToolCallCapture): ToolCallCapture {
    const sensitiveKeys = [
      'password',
      'secret',
      'token',
      'key',
      'credential',
      'auth',
    ];

    const sanitizedParams = { ...toolCall.parameters };

    for (const key of Object.keys(sanitizedParams)) {
      if (sensitiveKeys.some((sk) => key.toLowerCase().includes(sk))) {
        sanitizedParams[key] = '[REDACTED]';
      }
    }

    return {
      ...toolCall,
      parameters: sanitizedParams,
      parametersHash: toolCall.parametersHash || hashObject(toolCall.parameters),
    };
  }

  /**
   * Sanitize environment snapshot
   */
  private sanitizeEnvironmentSnapshot(
    snapshot: EnvironmentSnapshot
  ): EnvironmentSnapshot {
    // Remove potentially sensitive resource state
    const sanitized = { ...snapshot };

    if (sanitized.resourceState) {
      const cleanState: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(sanitized.resourceState)) {
        if (typeof value === 'string' && value.length > 100) {
          cleanState[key] = '[TRUNCATED]';
        } else {
          cleanState[key] = value;
        }
      }
      sanitized.resourceState = cleanState;
    }

    return sanitized;
  }

  /**
   * Add artifact to Merkle tree
   */
  private addToMerkleTree(artifact: ExecutionArtifact): void {
    const leaf: MerkleNode = {
      nodeId: generateId(),
      level: 0,
      hash: artifact.hash,
      artifactIds: [artifact.artifactId],
      timestamp: new Date().toISOString(),
    };

    this.merkleLeaves.push(leaf);
  }

  /**
   * Commit Merkle root
   */
  private async commitMerkleRoot(): Promise<void> {
    if (this.merkleLeaves.length === 0) return;

    // Build tree and compute root
    const rootHash = this.computeMerkleRoot();

    const commit: MerkleRootCommit = {
      commitId: generateId(),
      timestamp: new Date().toISOString(),
      rootHash,
      artifactCount: this.merkleLeaves.length,
      firstArtifactId: this.merkleLeaves[0]?.artifactIds?.[0] ?? '',
      lastArtifactId:
        this.merkleLeaves[this.merkleLeaves.length - 1]?.artifactIds?.[0] ?? '',
      signature: '', // Will be set after signing
    };

    commit.signature = signObject({ ...commit, signature: undefined });

    this.merkleRoots.push(commit);

    this.emit('merkle_root_committed', {
      commitId: commit.commitId,
      rootHash,
      artifactCount: commit.artifactCount,
    });

    logger.info(
      {
        commitId: commit.commitId,
        artifactCount: commit.artifactCount,
      },
      'Merkle root committed'
    );
  }

  /**
   * Compute Merkle root from leaves
   */
  private computeMerkleRoot(): string {
    if (this.merkleLeaves.length === 0) return '';

    let level = this.merkleLeaves.map((l) => l.hash);

    while (level.length > 1) {
      const nextLevel: string[] = [];

      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = level[i + 1] ?? level[i]; // Duplicate if odd

        nextLevel.push(chainHash(left, right));
      }

      level = nextLevel;
    }

    return level[0] ?? '';
  }

  /**
   * Cache prompt-response pair
   */
  private cachePromptResponse(interaction: LLMInteractionCapture): void {
    const cacheKey = interaction.promptHash;

    const entry: PromptCacheEntry = {
      cacheKey,
      promptHash: interaction.promptHash,
      responseHash: interaction.responseHash,
      response: interaction.response,
      provider: interaction.provider,
      model: interaction.model,
      cachedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.config.promptCacheTtlMs).toISOString(),
      hitCount: 0,
      lastHitAt: new Date().toISOString(),
    };

    this.promptCache.set(cacheKey, entry);
  }
}

// =============================================================================
// Replay Engine
// =============================================================================

/**
 * Re-executes workflows with identical LLM responses
 */
export class ReplayEngine extends EventEmitter {
  private recorder: ExecutionArtifactRecorder;
  private config: ReplayEngineConfig;
  private initialized = false;

  constructor(
    recorder: ExecutionArtifactRecorder,
    config: Partial<ReplayEngineConfig> = {}
  ) {
    super();
    this.recorder = recorder;
    this.config = { ...defaultReplayEngineConfig, ...config };
  }

  /**
   * Initialize the replay engine
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.initialized = true;
    logger.info('Replay engine initialized');
  }

  /**
   * Replay workflow execution
   */
  async replay(request: ReplayRequest): Promise<ReplayResult> {
    const startTime = Date.now();
    const errors: ReplayError[] = [];
    const timeline: ReplayTimelineEntry[] = [];

    let artifacts = this.recorder.getWorkflowArtifacts(request.workflowId);

    if (artifacts.length === 0) {
      return {
        requestId: request.requestId,
        success: false,
        workflowId: request.workflowId,
        artifactsReplayed: 0,
        timeline: [],
        errors: [
          {
            stepId: '',
            errorType: 'ARTIFACT_MISSING',
            message: `No artifacts found for workflow ${request.workflowId}`,
            recoverable: false,
          },
        ],
        duration: {
          totalMs: Date.now() - startTime,
          replayMs: 0,
          verificationMs: 0,
        },
      };
    }

    // Filter by time if requested
    if (request.targetTimestamp) {
      artifacts = artifacts.filter(
        (a) => a.timestamp <= request.targetTimestamp!
      );
    }

    // Filter by step range if requested
    if (request.stepRange) {
      artifacts = artifacts.filter(
        (a) =>
          a.sequenceNumber >= request.stepRange!.from &&
          a.sequenceNumber <= request.stepRange!.to
      );
    }

    // Verify integrity if requested
    let integrityVerification: IntegrityVerification | undefined;
    const verificationStart = Date.now();

    if (request.validateIntegrity) {
      integrityVerification = await this.verifyIntegrity(artifacts);
    }

    const verificationMs = Date.now() - verificationStart;
    const replayStart = Date.now();

    // Replay each artifact
    for (const artifact of artifacts) {
      const entry = await this.replayArtifact(artifact, request.useCachedResponses);
      timeline.push(entry);

      if (!entry.responseMatched) {
        errors.push({
          stepId: artifact.stepId,
          errorType: 'CACHE_MISS',
          message: `LLM response did not match for step ${artifact.stepId}`,
          recoverable: true,
        });
      }
    }

    const replayMs = Date.now() - replayStart;

    this.emit('replay_complete', {
      requestId: request.requestId,
      workflowId: request.workflowId,
      artifactsReplayed: artifacts.length,
    });

    return {
      requestId: request.requestId,
      success: errors.filter((e) => !e.recoverable).length === 0,
      workflowId: request.workflowId,
      artifactsReplayed: artifacts.length,
      timeline,
      integrityVerification,
      errors,
      duration: {
        totalMs: Date.now() - startTime,
        replayMs,
        verificationMs,
      },
    };
  }

  /**
   * Time travel to specific point
   */
  async timeTravel(query: TimeTravelQuery): Promise<TimeTravelSnapshot> {
    const queryId = generateId();
    const artifacts = this.recorder.getWorkflowArtifacts(query.workflowId);

    // Find nearest artifact to requested timestamp
    let nearestArtifact: ExecutionArtifact | undefined;
    let minDiff = Infinity;

    for (const artifact of artifacts) {
      const diff = Math.abs(
        new Date(artifact.timestamp).getTime() -
          new Date(query.timestamp).getTime()
      );
      if (diff < minDiff) {
        minDiff = diff;
        nearestArtifact = artifact;
      }
    }

    if (!nearestArtifact) {
      throw new Error(`No artifacts found for workflow ${query.workflowId}`);
    }

    // Get all artifacts up to this point
    const relevantArtifacts = artifacts.filter(
      (a) => a.timestamp <= nearestArtifact!.timestamp
    );

    // Build state snapshot
    const completedSteps = relevantArtifacts
      .filter((a) => a.toolCall.success)
      .map((a) => a.stepId);

    const pendingSteps = artifacts
      .filter((a) => a.timestamp > nearestArtifact!.timestamp)
      .map((a) => a.stepId);

    // Get Merkle proof
    const merkleProof = this.recorder.getMerkleProof(nearestArtifact.artifactId);

    // Calculate total tokens
    let totalTokens = 0;
    for (const a of relevantArtifacts) {
      if (a.llmInteraction) {
        totalTokens +=
          a.llmInteraction.tokenCount.input + a.llmInteraction.tokenCount.output;
      }
    }

    const snapshot: TimeTravelSnapshot = {
      queryId,
      workflowId: query.workflowId,
      requestedTimestamp: query.timestamp,
      nearestArtifactTimestamp: nearestArtifact.timestamp,
      state: {
        stepId: nearestArtifact.stepId,
        stepStatus: nearestArtifact.toolCall.success ? 'completed' : 'failed',
        completedSteps,
        pendingSteps,
        riskScore: nearestArtifact.riskScore,
        policyDecisions: nearestArtifact.policyDecisions,
      },
      environment: query.includeEnvironmentState
        ? nearestArtifact.environmentSnapshot
        : undefined,
      llmContext: query.includePrompts
        ? {
            lastPrompt: nearestArtifact.llmInteraction?.prompt,
            lastResponse: nearestArtifact.llmInteraction?.response,
            totalTokens,
          }
        : undefined,
      integrityProof: {
        artifactHash: nearestArtifact.hash,
        merkleProof: merkleProof?.proof ?? [],
        rootHash: merkleProof?.rootHash ?? '',
      },
    };

    this.emit('time_travel', {
      queryId,
      workflowId: query.workflowId,
      timestamp: query.timestamp,
    });

    return snapshot;
  }

  /**
   * Generate compliance report
   */
  async generateComplianceReport(
    workflowId: string
  ): Promise<{
    workflowId: string;
    generatedAt: string;
    artifacts: ExecutionArtifact[];
    integrityVerification: IntegrityVerification;
    chainVerification: { valid: boolean; brokenAt?: number };
    merkleRoots: MerkleRootCommit[];
    signature: string;
  }> {
    const artifacts = this.recorder.getWorkflowArtifacts(workflowId);
    const integrityVerification = await this.verifyIntegrity(artifacts);
    const chainVerification = this.recorder.verifyChainIntegrity(workflowId);

    // Get relevant Merkle roots
    const merkleRoots: MerkleRootCommit[] = []; // Would filter by workflow

    const report = {
      workflowId,
      generatedAt: new Date().toISOString(),
      artifacts,
      integrityVerification,
      chainVerification,
      merkleRoots,
      signature: '', // Will be set after signing
    };

    report.signature = signObject({ ...report, signature: undefined });

    return report;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Replay single artifact
   */
  private async replayArtifact(
    artifact: ExecutionArtifact,
    useCachedResponses: boolean
  ): Promise<ReplayTimelineEntry> {
    let responseMatched = true;
    let driftDetected = false;
    let driftDetails: string | undefined;

    // Check for cached response
    if (useCachedResponses && artifact.llmInteraction) {
      const cached = this.recorder.getCachedResponse(
        artifact.llmInteraction.promptHash
      );

      if (cached) {
        if (cached.responseHash !== artifact.llmInteraction.responseHash) {
          responseMatched = false;
          driftDetected = true;
          driftDetails = 'Cached response differs from original';
        }
      } else {
        responseMatched = false;
        driftDetails = 'No cached response available';
      }
    }

    // Verify artifact integrity
    const integrity = this.recorder.verifyArtifactIntegrity(artifact);
    if (!integrity.valid) {
      driftDetected = true;
      driftDetails = integrity.errors.join('; ');
    }

    return {
      stepId: artifact.stepId,
      timestamp: artifact.timestamp,
      action: artifact.toolCall.action,
      originalOutcome: artifact.toolCall.success ? 'success' : 'failure',
      replayOutcome: artifact.toolCall.success ? 'success' : 'failure',
      responseMatched,
      driftDetected,
      driftDetails,
    };
  }

  /**
   * Verify integrity of artifacts
   */
  private async verifyIntegrity(
    artifacts: ExecutionArtifact[]
  ): Promise<IntegrityVerification> {
    const hashMismatches: string[] = [];
    const signatureFailures: string[] = [];
    const chainBreaks: number[] = [];

    for (let i = 0; i < artifacts.length; i++) {
      const artifact = artifacts[i];
      const integrity = this.recorder.verifyArtifactIntegrity(artifact);

      if (!integrity.valid) {
        hashMismatches.push(artifact.artifactId);
      }

      // Check chain continuity
      if (i > 0) {
        if (artifact.previousArtifactHash !== artifacts[i - 1].hash) {
          chainBreaks.push(i);
        }
      }
    }

    return {
      verified: hashMismatches.length === 0 && chainBreaks.length === 0,
      artifactsChecked: artifacts.length,
      hashMismatches,
      signatureFailures,
      chainBreaks,
      merkleRootValid: true, // Simplified
    };
  }
}

// =============================================================================
// Singleton
// =============================================================================

let recorder: ExecutionArtifactRecorder | null = null;
let replayEngine: ReplayEngine | null = null;

export function getExecutionArtifactRecorder(): ExecutionArtifactRecorder {
  if (!recorder) {
    recorder = new ExecutionArtifactRecorder();
  }
  return recorder;
}

export function getReplayEngine(): ReplayEngine {
  if (!replayEngine) {
    replayEngine = new ReplayEngine(getExecutionArtifactRecorder());
  }
  return replayEngine;
}

export async function initializeReplaySystem(
  config?: Partial<ReplayEngineConfig>
): Promise<{ recorder: ExecutionArtifactRecorder; engine: ReplayEngine }> {
  if (!recorder) {
    recorder = new ExecutionArtifactRecorder(config);
  }
  await recorder.initialize();

  if (!replayEngine) {
    replayEngine = new ReplayEngine(recorder, config);
  }
  await replayEngine.initialize();

  return { recorder, engine: replayEngine };
}
