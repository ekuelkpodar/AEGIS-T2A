/**
 * AEGIS-T2A Queryable Audit Index
 *
 * Dual-audit architecture providing fast forensic queries while maintaining
 * immutable hash-chained ledger integrity. Optimized for incident response
 * and compliance investigations.
 *
 * Key Features:
 * - In-memory index for sub-millisecond lookups
 * - Multi-dimensional indexing (time, actor, resource, workflow)
 * - Complex query composition with AND/OR logic
 * - Aggregation and analytics for pattern detection
 * - Real-time streaming with filters
 * - Hash-chain verification on demand
 * - Compliance export with attestation
 */

import { EventEmitter } from 'events';
import { z } from 'zod';
import {
  AuditEvent,
  EventType,
  ActorType,
  RiskLevel,
} from '../core/types.js';
import { componentLogger } from '../core/logger.js';
import { hashObject, chainHash, signObject } from '../core/crypto.js';
import { generateId } from '../core/ids.js';

const logger = componentLogger('queryable-audit-index');

// =============================================================================
// Constants
// =============================================================================

/**
 * Default index retention period (90 days)
 */
const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Maximum results per query
 */
const MAX_QUERY_RESULTS = 10000;

/**
 * Index compaction threshold
 */
const COMPACTION_THRESHOLD = 100000;

// =============================================================================
// Types
// =============================================================================

/**
 * Indexed audit entry with additional metadata
 */
export interface IndexedAuditEntry {
  event: AuditEvent;
  indexedAt: string;
  searchTokens: string[];
  riskScore: number;
  chainPosition: number;
  verified: boolean;
}

/**
 * Complex query filter
 */
export interface AuditQueryFilter {
  // Time-based filters
  startTime?: string;
  endTime?: string;
  lastNHours?: number;
  lastNDays?: number;

  // Entity filters
  intentIds?: string[];
  workflowIds?: string[];
  planIds?: string[];
  stepIds?: string[];
  actorIds?: string[];

  // Type filters
  eventTypes?: EventType[];
  actorTypes?: ActorType[];
  riskLevels?: RiskLevel[];

  // Resource filters
  targetResources?: string[];
  resourcePatterns?: string[]; // Glob patterns

  // Status filters
  successOnly?: boolean;
  failuresOnly?: boolean;

  // Text search
  searchText?: string;
  actionPatterns?: string[];

  // Advanced
  minRiskScore?: number;
  maxRiskScore?: number;
  hasErrors?: boolean;
  costThreshold?: number;
}

/**
 * Query options for pagination and sorting
 */
export interface AuditQueryOptions {
  limit?: number;
  offset?: number;
  sortBy?: 'timestamp' | 'riskScore' | 'cost' | 'duration';
  sortOrder?: 'asc' | 'desc';
  includeVerification?: boolean;
}

/**
 * Query result with metadata
 */
export interface AuditQueryResult {
  queryId: string;
  executedAt: string;
  executionTimeMs: number;
  totalMatches: number;
  returnedCount: number;
  hasMore: boolean;
  entries: IndexedAuditEntry[];
  aggregations?: QueryAggregations;
  chainIntegrity?: ChainIntegrityResult;
}

/**
 * Aggregation results
 */
export interface QueryAggregations {
  byEventType: Record<string, number>;
  byActorType: Record<string, number>;
  byRiskLevel: Record<string, number>;
  byHour: Record<string, number>;
  byResource: Record<string, number>;
  totalCost: number;
  avgDuration: number;
  successRate: number;
  errorCount: number;
}

/**
 * Chain integrity verification result
 */
export interface ChainIntegrityResult {
  verified: boolean;
  eventsChecked: number;
  brokenLinks: BrokenChainLink[];
  verificationTimeMs: number;
  attestation?: ChainAttestation;
}

/**
 * Broken chain link details
 */
export interface BrokenChainLink {
  eventId: string;
  position: number;
  expectedHash: string;
  actualHash: string;
  detectedAt: string;
}

/**
 * Chain attestation for compliance
 */
export interface ChainAttestation {
  attestationId: string;
  attestedAt: string;
  firstEventId: string;
  lastEventId: string;
  eventCount: number;
  chainValid: boolean;
  attestorId: string;
  signature: string;
}

/**
 * Forensic timeline entry
 */
export interface ForensicTimelineEntry {
  timestamp: string;
  eventId: string;
  eventType: EventType;
  action: string;
  actor: string;
  resource?: string;
  riskLevel?: RiskLevel;
  success: boolean;
  relatedEvents: string[];
  context: Record<string, unknown>;
}

/**
 * Forensic investigation report
 */
export interface ForensicReport {
  reportId: string;
  generatedAt: string;
  generationTimeMs: number;
  scope: {
    startTime: string;
    endTime: string;
    entities: string[];
  };
  timeline: ForensicTimelineEntry[];
  summary: {
    totalEvents: number;
    uniqueActors: number;
    uniqueResources: number;
    riskDistribution: Record<string, number>;
    criticalFindings: string[];
  };
  chainAttestation: ChainAttestation;
  signature: string;
}

/**
 * Real-time streaming subscription
 */
export interface StreamSubscription {
  subscriptionId: string;
  filter: AuditQueryFilter;
  callback: (entry: IndexedAuditEntry) => void;
  createdAt: string;
  eventsDelivered: number;
}

/**
 * Index configuration
 */
export interface AuditIndexConfig {
  retentionMs: number;
  maxEntries: number;
  enableRealTimeStreaming: boolean;
  autoCompaction: boolean;
  verifyOnIndex: boolean;
}

// =============================================================================
// Default Configuration
// =============================================================================

export const defaultAuditIndexConfig: AuditIndexConfig = {
  retentionMs: DEFAULT_RETENTION_MS,
  maxEntries: COMPACTION_THRESHOLD,
  enableRealTimeStreaming: true,
  autoCompaction: true,
  verifyOnIndex: false, // Verification is expensive, do on-demand
};

// =============================================================================
// Queryable Audit Index
// =============================================================================

export class QueryableAuditIndex extends EventEmitter {
  private config: AuditIndexConfig;
  private initialized = false;

  // Primary storage
  private entries: IndexedAuditEntry[] = [];
  private chainPosition = 0;
  private lastEventHash = '0'.repeat(64);

  // Indexes for fast lookups
  private byEventId = new Map<string, IndexedAuditEntry>();
  private byIntentId = new Map<string, IndexedAuditEntry[]>();
  private byWorkflowId = new Map<string, IndexedAuditEntry[]>();
  private byActorId = new Map<string, IndexedAuditEntry[]>();
  private byEventType = new Map<EventType, IndexedAuditEntry[]>();
  private byResource = new Map<string, IndexedAuditEntry[]>();
  private byTimeBucket = new Map<string, IndexedAuditEntry[]>(); // Hourly buckets

  // Streaming subscriptions
  private subscriptions = new Map<string, StreamSubscription>();

  // Statistics
  private stats = {
    totalIndexed: 0,
    totalQueries: 0,
    avgQueryTimeMs: 0,
    lastCompactionAt: '',
    chainVerifications: 0,
  };

  constructor(config: Partial<AuditIndexConfig> = {}) {
    super();
    this.config = { ...defaultAuditIndexConfig, ...config };
  }

  /**
   * Initialize the audit index
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.initialized = true;
    logger.info('Queryable audit index initialized');
  }

  /**
   * Index a new audit event
   */
  async indexEvent(event: AuditEvent): Promise<IndexedAuditEntry> {
    const indexedAt = new Date().toISOString();
    this.chainPosition++;

    // Verify chain integrity if configured
    let verified = false;
    if (this.config.verifyOnIndex) {
      verified = event.previousEventHash === this.lastEventHash;
    }

    // Calculate risk score
    const riskScore = this.calculateRiskScore(event);

    // Generate search tokens
    const searchTokens = this.generateSearchTokens(event);

    const entry: IndexedAuditEntry = {
      event,
      indexedAt,
      searchTokens,
      riskScore,
      chainPosition: this.chainPosition,
      verified,
    };

    // Add to primary storage
    this.entries.push(entry);
    this.stats.totalIndexed++;

    // Update indexes
    this.updateIndexes(entry);

    // Update chain tracking
    this.lastEventHash = chainHash(event.previousEventHash, event.signature);

    // Notify streaming subscribers
    if (this.config.enableRealTimeStreaming) {
      this.notifySubscribers(entry);
    }

    // Check if compaction is needed
    if (this.config.autoCompaction && this.entries.length > this.config.maxEntries) {
      await this.compact();
    }

    this.emit('event_indexed', {
      eventId: event.eventId,
      chainPosition: this.chainPosition,
    });

    return entry;
  }

  /**
   * Execute a complex query
   */
  async query(
    filter: AuditQueryFilter,
    options: AuditQueryOptions = {}
  ): Promise<AuditQueryResult> {
    const queryId = generateId();
    const startTime = Date.now();

    this.stats.totalQueries++;

    // Normalize options
    const limit = Math.min(options.limit ?? 100, MAX_QUERY_RESULTS);
    const offset = options.offset ?? 0;
    const sortBy = options.sortBy ?? 'timestamp';
    const sortOrder = options.sortOrder ?? 'desc';

    // Find matching entries
    let matches = this.findMatches(filter);

    // Sort results
    matches = this.sortEntries(matches, sortBy, sortOrder);

    // Calculate total before pagination
    const totalMatches = matches.length;

    // Apply pagination
    const paginatedMatches = matches.slice(offset, offset + limit);

    // Calculate aggregations
    const aggregations = this.calculateAggregations(matches);

    // Verify chain if requested
    let chainIntegrity: ChainIntegrityResult | undefined;
    if (options.includeVerification) {
      chainIntegrity = await this.verifyChainIntegrity(paginatedMatches);
    }

    const executionTimeMs = Date.now() - startTime;

    // Update average query time
    this.stats.avgQueryTimeMs =
      (this.stats.avgQueryTimeMs * (this.stats.totalQueries - 1) + executionTimeMs) /
      this.stats.totalQueries;

    const result: AuditQueryResult = {
      queryId,
      executedAt: new Date().toISOString(),
      executionTimeMs,
      totalMatches,
      returnedCount: paginatedMatches.length,
      hasMore: offset + limit < totalMatches,
      entries: paginatedMatches,
      aggregations,
      chainIntegrity,
    };

    this.emit('query_executed', {
      queryId,
      totalMatches,
      executionTimeMs,
    });

    return result;
  }

  /**
   * Quick lookup by event ID
   */
  getByEventId(eventId: string): IndexedAuditEntry | undefined {
    return this.byEventId.get(eventId);
  }

  /**
   * Get all events for a workflow
   */
  getByWorkflowId(workflowId: string): IndexedAuditEntry[] {
    return this.byWorkflowId.get(workflowId) ?? [];
  }

  /**
   * Get all events for an intent
   */
  getByIntentId(intentId: string): IndexedAuditEntry[] {
    return this.byIntentId.get(intentId) ?? [];
  }

  /**
   * Get all events by actor
   */
  getByActorId(actorId: string): IndexedAuditEntry[] {
    return this.byActorId.get(actorId) ?? [];
  }

  /**
   * Generate forensic timeline for investigation
   */
  async generateForensicTimeline(
    filter: AuditQueryFilter
  ): Promise<ForensicTimelineEntry[]> {
    const result = await this.query(filter, {
      sortBy: 'timestamp',
      sortOrder: 'asc',
      limit: MAX_QUERY_RESULTS,
    });

    return result.entries.map((entry) => this.toTimelineEntry(entry));
  }

  /**
   * Generate comprehensive forensic report
   */
  async generateForensicReport(
    filter: AuditQueryFilter,
    attestorId: string
  ): Promise<ForensicReport> {
    const startTime = Date.now();
    const reportId = generateId();

    // Get all matching events
    const result = await this.query(filter, {
      sortBy: 'timestamp',
      sortOrder: 'asc',
      limit: MAX_QUERY_RESULTS,
      includeVerification: true,
    });

    // Build timeline
    const timeline = result.entries.map((entry) => this.toTimelineEntry(entry));

    // Calculate unique values
    const uniqueActors = new Set(result.entries.map((e) => e.event.actorId));
    const uniqueResources = new Set(
      result.entries.map((e) => e.event.targetResource).filter(Boolean)
    );

    // Build risk distribution
    const riskDistribution: Record<string, number> = {};
    for (const entry of result.entries) {
      const risk = entry.event.riskLevel ?? 'unknown';
      riskDistribution[risk] = (riskDistribution[risk] ?? 0) + 1;
    }

    // Identify critical findings
    const criticalFindings = this.identifyCriticalFindings(result.entries);

    // Create attestation
    const attestation = await this.createAttestation(
      result.entries,
      attestorId,
      result.chainIntegrity?.verified ?? false
    );

    // Determine scope
    const timestamps = result.entries.map((e) => e.event.timestamp);
    const scope = {
      startTime: timestamps[0] ?? new Date().toISOString(),
      endTime: timestamps[timestamps.length - 1] ?? new Date().toISOString(),
      entities: [
        ...new Set([
          ...result.entries.map((e) => e.event.intentId).filter(Boolean),
          ...result.entries.map((e) => e.event.workflowId).filter(Boolean),
        ]),
      ] as string[],
    };

    const report: ForensicReport = {
      reportId,
      generatedAt: new Date().toISOString(),
      generationTimeMs: Date.now() - startTime,
      scope,
      timeline,
      summary: {
        totalEvents: result.totalMatches,
        uniqueActors: uniqueActors.size,
        uniqueResources: uniqueResources.size,
        riskDistribution,
        criticalFindings,
      },
      chainAttestation: attestation,
      signature: '', // Will be set after hashing
    };

    // Sign the report
    report.signature = signObject({
      ...report,
      signature: undefined,
    });

    this.emit('forensic_report_generated', {
      reportId,
      eventCount: result.totalMatches,
    });

    return report;
  }

  /**
   * Subscribe to real-time event stream
   */
  subscribe(
    filter: AuditQueryFilter,
    callback: (entry: IndexedAuditEntry) => void
  ): string {
    const subscriptionId = generateId();

    const subscription: StreamSubscription = {
      subscriptionId,
      filter,
      callback,
      createdAt: new Date().toISOString(),
      eventsDelivered: 0,
    };

    this.subscriptions.set(subscriptionId, subscription);

    this.emit('subscription_created', { subscriptionId });

    return subscriptionId;
  }

  /**
   * Unsubscribe from real-time stream
   */
  unsubscribe(subscriptionId: string): boolean {
    const removed = this.subscriptions.delete(subscriptionId);

    if (removed) {
      this.emit('subscription_removed', { subscriptionId });
    }

    return removed;
  }

  /**
   * Verify chain integrity for a set of entries
   */
  async verifyChainIntegrity(
    entries: IndexedAuditEntry[]
  ): Promise<ChainIntegrityResult> {
    const startTime = Date.now();
    const brokenLinks: BrokenChainLink[] = [];

    this.stats.chainVerifications++;

    // Sort by chain position
    const sorted = [...entries].sort((a, b) => a.chainPosition - b.chainPosition);

    let expectedHash = sorted[0]?.event.previousEventHash ?? '0'.repeat(64);

    for (let i = 0; i < sorted.length; i++) {
      const entry = sorted[i];

      if (entry.event.previousEventHash !== expectedHash && i > 0) {
        brokenLinks.push({
          eventId: entry.event.eventId,
          position: entry.chainPosition,
          expectedHash,
          actualHash: entry.event.previousEventHash,
          detectedAt: new Date().toISOString(),
        });
      }

      expectedHash = chainHash(entry.event.previousEventHash, entry.event.signature);
    }

    return {
      verified: brokenLinks.length === 0,
      eventsChecked: sorted.length,
      brokenLinks,
      verificationTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Create attestation for compliance
   */
  async createAttestation(
    entries: IndexedAuditEntry[],
    attestorId: string,
    chainValid: boolean
  ): Promise<ChainAttestation> {
    const attestationId = generateId();

    if (entries.length === 0) {
      return {
        attestationId,
        attestedAt: new Date().toISOString(),
        firstEventId: '',
        lastEventId: '',
        eventCount: 0,
        chainValid,
        attestorId,
        signature: '',
      };
    }

    const sorted = [...entries].sort((a, b) => a.chainPosition - b.chainPosition);

    const attestation: ChainAttestation = {
      attestationId,
      attestedAt: new Date().toISOString(),
      firstEventId: sorted[0].event.eventId,
      lastEventId: sorted[sorted.length - 1].event.eventId,
      eventCount: entries.length,
      chainValid,
      attestorId,
      signature: '', // Will be set after hashing
    };

    attestation.signature = signObject({
      ...attestation,
      signature: undefined,
    });

    return attestation;
  }

  /**
   * Compact old entries based on retention policy
   */
  async compact(): Promise<{ removed: number; remaining: number }> {
    const cutoffTime = new Date(Date.now() - this.config.retentionMs).toISOString();
    const beforeCount = this.entries.length;

    // Filter entries
    const retained = this.entries.filter((e) => e.event.timestamp >= cutoffTime);
    const removed = beforeCount - retained.length;

    // Rebuild indexes
    this.rebuildIndexes(retained);

    this.entries = retained;
    this.stats.lastCompactionAt = new Date().toISOString();

    logger.info({ removed, remaining: retained.length }, 'Audit index compacted');

    this.emit('index_compacted', { removed, remaining: retained.length });

    return { removed, remaining: retained.length };
  }

  /**
   * Get index statistics
   */
  getStats(): typeof this.stats & { entryCount: number; subscriptionCount: number } {
    return {
      ...this.stats,
      entryCount: this.entries.length,
      subscriptionCount: this.subscriptions.size,
    };
  }

  /**
   * Export for compliance
   */
  async exportForCompliance(
    filter: AuditQueryFilter,
    attestorId: string
  ): Promise<{
    entries: AuditEvent[];
    attestation: ChainAttestation;
    exportedAt: string;
    checksum: string;
  }> {
    const result = await this.query(filter, {
      limit: MAX_QUERY_RESULTS,
      includeVerification: true,
    });

    const events = result.entries.map((e) => e.event);
    const attestation = await this.createAttestation(
      result.entries,
      attestorId,
      result.chainIntegrity?.verified ?? false
    );

    const exportData = {
      entries: events,
      attestation,
      exportedAt: new Date().toISOString(),
    };

    return {
      ...exportData,
      checksum: hashObject(exportData),
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Find entries matching filter
   */
  private findMatches(filter: AuditQueryFilter): IndexedAuditEntry[] {
    let candidates = this.entries;

    // Use indexes for common filters
    if (filter.workflowIds?.length === 1) {
      candidates = this.byWorkflowId.get(filter.workflowIds[0]) ?? [];
    } else if (filter.intentIds?.length === 1) {
      candidates = this.byIntentId.get(filter.intentIds[0]) ?? [];
    } else if (filter.actorIds?.length === 1) {
      candidates = this.byActorId.get(filter.actorIds[0]) ?? [];
    } else if (filter.eventTypes?.length === 1) {
      candidates = this.byEventType.get(filter.eventTypes[0]) ?? [];
    }

    // Apply remaining filters
    return candidates.filter((entry) => this.matchesFilter(entry, filter));
  }

  /**
   * Check if entry matches filter
   */
  private matchesFilter(entry: IndexedAuditEntry, filter: AuditQueryFilter): boolean {
    const event = entry.event;

    // Time filters
    if (filter.startTime && event.timestamp < filter.startTime) return false;
    if (filter.endTime && event.timestamp > filter.endTime) return false;

    if (filter.lastNHours) {
      const cutoff = new Date(Date.now() - filter.lastNHours * 60 * 60 * 1000).toISOString();
      if (event.timestamp < cutoff) return false;
    }

    if (filter.lastNDays) {
      const cutoff = new Date(Date.now() - filter.lastNDays * 24 * 60 * 60 * 1000).toISOString();
      if (event.timestamp < cutoff) return false;
    }

    // Entity filters
    if (filter.intentIds?.length && !filter.intentIds.includes(event.intentId ?? '')) {
      return false;
    }
    if (filter.workflowIds?.length && !filter.workflowIds.includes(event.workflowId ?? '')) {
      return false;
    }
    if (filter.planIds?.length && !filter.planIds.includes(event.planId ?? '')) {
      return false;
    }
    if (filter.stepIds?.length && !filter.stepIds.includes(event.stepId ?? '')) {
      return false;
    }
    if (filter.actorIds?.length && !filter.actorIds.includes(event.actorId)) {
      return false;
    }

    // Type filters
    if (filter.eventTypes?.length && !filter.eventTypes.includes(event.eventType as EventType)) {
      return false;
    }
    if (filter.actorTypes?.length && !filter.actorTypes.includes(event.actorType as ActorType)) {
      return false;
    }
    if (filter.riskLevels?.length && !filter.riskLevels.includes(event.riskLevel as RiskLevel)) {
      return false;
    }

    // Resource filters
    if (filter.targetResources?.length) {
      if (!event.targetResource || !filter.targetResources.includes(event.targetResource)) {
        return false;
      }
    }

    if (filter.resourcePatterns?.length && event.targetResource) {
      const matchesPattern = filter.resourcePatterns.some((pattern) =>
        this.matchGlobPattern(event.targetResource!, pattern)
      );
      if (!matchesPattern) return false;
    }

    // Status filters
    if (filter.successOnly && !event.success) return false;
    if (filter.failuresOnly && event.success) return false;

    // Text search
    if (filter.searchText) {
      const searchLower = filter.searchText.toLowerCase();
      if (!entry.searchTokens.some((token) => token.includes(searchLower))) {
        return false;
      }
    }

    // Action patterns
    if (filter.actionPatterns?.length) {
      const matchesAction = filter.actionPatterns.some((pattern) =>
        new RegExp(pattern, 'i').test(event.action)
      );
      if (!matchesAction) return false;
    }

    // Risk score filters
    if (filter.minRiskScore !== undefined && entry.riskScore < filter.minRiskScore) {
      return false;
    }
    if (filter.maxRiskScore !== undefined && entry.riskScore > filter.maxRiskScore) {
      return false;
    }

    // Error filter
    if (filter.hasErrors !== undefined) {
      const hasError = !!event.errorCode || !!event.errorMessage;
      if (filter.hasErrors !== hasError) return false;
    }

    // Cost threshold
    if (filter.costThreshold !== undefined) {
      if ((event.costIncurred ?? 0) < filter.costThreshold) return false;
    }

    return true;
  }

  /**
   * Sort entries by specified field
   */
  private sortEntries(
    entries: IndexedAuditEntry[],
    sortBy: string,
    sortOrder: 'asc' | 'desc'
  ): IndexedAuditEntry[] {
    const multiplier = sortOrder === 'asc' ? 1 : -1;

    return [...entries].sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case 'timestamp':
          comparison = a.event.timestamp.localeCompare(b.event.timestamp);
          break;
        case 'riskScore':
          comparison = a.riskScore - b.riskScore;
          break;
        case 'cost':
          comparison = (a.event.costIncurred ?? 0) - (b.event.costIncurred ?? 0);
          break;
        case 'duration':
          comparison = (a.event.durationMs ?? 0) - (b.event.durationMs ?? 0);
          break;
        default:
          comparison = a.event.timestamp.localeCompare(b.event.timestamp);
      }

      return comparison * multiplier;
    });
  }

  /**
   * Calculate aggregations for query results
   */
  private calculateAggregations(entries: IndexedAuditEntry[]): QueryAggregations {
    const byEventType: Record<string, number> = {};
    const byActorType: Record<string, number> = {};
    const byRiskLevel: Record<string, number> = {};
    const byHour: Record<string, number> = {};
    const byResource: Record<string, number> = {};

    let totalCost = 0;
    let totalDuration = 0;
    let durationCount = 0;
    let successCount = 0;
    let errorCount = 0;

    for (const entry of entries) {
      const event = entry.event;

      // Event type distribution
      byEventType[event.eventType] = (byEventType[event.eventType] ?? 0) + 1;

      // Actor type distribution
      byActorType[event.actorType] = (byActorType[event.actorType] ?? 0) + 1;

      // Risk level distribution
      if (event.riskLevel) {
        byRiskLevel[event.riskLevel] = (byRiskLevel[event.riskLevel] ?? 0) + 1;
      }

      // Hourly distribution
      const hour = event.timestamp.slice(0, 13); // YYYY-MM-DDTHH
      byHour[hour] = (byHour[hour] ?? 0) + 1;

      // Resource distribution
      if (event.targetResource) {
        byResource[event.targetResource] = (byResource[event.targetResource] ?? 0) + 1;
      }

      // Metrics
      totalCost += event.costIncurred ?? 0;

      if (event.durationMs !== undefined) {
        totalDuration += event.durationMs;
        durationCount++;
      }

      if (event.success) {
        successCount++;
      }

      if (event.errorCode || event.errorMessage) {
        errorCount++;
      }
    }

    return {
      byEventType,
      byActorType,
      byRiskLevel,
      byHour,
      byResource,
      totalCost,
      avgDuration: durationCount > 0 ? totalDuration / durationCount : 0,
      successRate: entries.length > 0 ? successCount / entries.length : 0,
      errorCount,
    };
  }

  /**
   * Update all indexes with new entry
   */
  private updateIndexes(entry: IndexedAuditEntry): void {
    const event = entry.event;

    // By event ID
    this.byEventId.set(event.eventId, entry);

    // By intent ID
    if (event.intentId) {
      const list = this.byIntentId.get(event.intentId) ?? [];
      list.push(entry);
      this.byIntentId.set(event.intentId, list);
    }

    // By workflow ID
    if (event.workflowId) {
      const list = this.byWorkflowId.get(event.workflowId) ?? [];
      list.push(entry);
      this.byWorkflowId.set(event.workflowId, list);
    }

    // By actor ID
    const actorList = this.byActorId.get(event.actorId) ?? [];
    actorList.push(entry);
    this.byActorId.set(event.actorId, actorList);

    // By event type
    const typeList = this.byEventType.get(event.eventType as EventType) ?? [];
    typeList.push(entry);
    this.byEventType.set(event.eventType as EventType, typeList);

    // By resource
    if (event.targetResource) {
      const resourceList = this.byResource.get(event.targetResource) ?? [];
      resourceList.push(entry);
      this.byResource.set(event.targetResource, resourceList);
    }

    // By time bucket (hourly)
    const bucket = event.timestamp.slice(0, 13);
    const bucketList = this.byTimeBucket.get(bucket) ?? [];
    bucketList.push(entry);
    this.byTimeBucket.set(bucket, bucketList);
  }

  /**
   * Rebuild all indexes from entries
   */
  private rebuildIndexes(entries: IndexedAuditEntry[]): void {
    // Clear existing indexes
    this.byEventId.clear();
    this.byIntentId.clear();
    this.byWorkflowId.clear();
    this.byActorId.clear();
    this.byEventType.clear();
    this.byResource.clear();
    this.byTimeBucket.clear();

    // Rebuild
    for (const entry of entries) {
      this.updateIndexes(entry);
    }
  }

  /**
   * Notify streaming subscribers
   */
  private notifySubscribers(entry: IndexedAuditEntry): void {
    for (const subscription of this.subscriptions.values()) {
      if (this.matchesFilter(entry, subscription.filter)) {
        try {
          subscription.callback(entry);
          subscription.eventsDelivered++;
        } catch (error) {
          logger.error(
            { error, subscriptionId: subscription.subscriptionId },
            'Error notifying subscriber'
          );
        }
      }
    }
  }

  /**
   * Calculate risk score for an event
   */
  private calculateRiskScore(event: AuditEvent): number {
    let score = 0;

    // Base score from risk level
    switch (event.riskLevel) {
      case 'destructive':
        score += 40;
        break;
      case 'high':
        score += 30;
        break;
      case 'medium':
        score += 20;
        break;
      case 'low':
        score += 10;
        break;
    }

    // Failure penalty
    if (!event.success) {
      score += 20;
    }

    // Error penalty
    if (event.errorCode || event.errorMessage) {
      score += 15;
    }

    // High cost penalty
    if ((event.costIncurred ?? 0) > 100) {
      score += 15;
    }

    return Math.min(100, score);
  }

  /**
   * Generate search tokens for full-text search
   */
  private generateSearchTokens(event: AuditEvent): string[] {
    const tokens: string[] = [];

    tokens.push(event.eventId.toLowerCase());
    tokens.push(event.eventType.toLowerCase());
    tokens.push(event.action.toLowerCase());
    tokens.push(event.actorId.toLowerCase());

    if (event.intentId) tokens.push(event.intentId.toLowerCase());
    if (event.workflowId) tokens.push(event.workflowId.toLowerCase());
    if (event.planId) tokens.push(event.planId.toLowerCase());
    if (event.stepId) tokens.push(event.stepId.toLowerCase());
    if (event.targetResource) tokens.push(event.targetResource.toLowerCase());
    if (event.errorMessage) tokens.push(event.errorMessage.toLowerCase());

    return tokens;
  }

  /**
   * Convert entry to timeline format
   */
  private toTimelineEntry(entry: IndexedAuditEntry): ForensicTimelineEntry {
    const event = entry.event;

    return {
      timestamp: event.timestamp,
      eventId: event.eventId,
      eventType: event.eventType as EventType,
      action: event.action,
      actor: event.actorId,
      resource: event.targetResource,
      riskLevel: event.riskLevel as RiskLevel | undefined,
      success: event.success,
      relatedEvents: this.findRelatedEvents(entry),
      context: {
        inputsHash: event.inputsHash,
        outputsHash: event.outputsHash,
        costIncurred: event.costIncurred,
        durationMs: event.durationMs,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
      },
    };
  }

  /**
   * Find events related to this entry
   */
  private findRelatedEvents(entry: IndexedAuditEntry): string[] {
    const related: string[] = [];
    const event = entry.event;

    // Find events with same workflow
    if (event.workflowId) {
      const workflowEvents = this.byWorkflowId.get(event.workflowId) ?? [];
      for (const e of workflowEvents) {
        if (e.event.eventId !== event.eventId) {
          related.push(e.event.eventId);
        }
      }
    }

    // Limit to 10 related events
    return related.slice(0, 10);
  }

  /**
   * Identify critical findings for forensic report
   */
  private identifyCriticalFindings(entries: IndexedAuditEntry[]): string[] {
    const findings: string[] = [];

    // Count failures
    const failures = entries.filter((e) => !e.event.success);
    if (failures.length > 0) {
      findings.push(`${failures.length} failed operations detected`);
    }

    // Count high-risk events
    const highRisk = entries.filter(
      (e) => e.event.riskLevel === 'high' || e.event.riskLevel === 'destructive'
    );
    if (highRisk.length > 0) {
      findings.push(`${highRisk.length} high-risk operations executed`);
    }

    // Check for unusual actors
    const actorCounts = new Map<string, number>();
    for (const entry of entries) {
      const count = actorCounts.get(entry.event.actorId) ?? 0;
      actorCounts.set(entry.event.actorId, count + 1);
    }

    // Find actors with unusually high activity
    for (const [actorId, count] of actorCounts) {
      if (count > entries.length * 0.5) {
        findings.push(`Actor ${actorId} responsible for ${count} events (>50%)`);
      }
    }

    // Check for error patterns
    const errorMessages = entries
      .filter((e) => e.event.errorMessage)
      .map((e) => e.event.errorMessage!);

    if (errorMessages.length > 5) {
      findings.push(`${errorMessages.length} errors logged during period`);
    }

    return findings;
  }

  /**
   * Match glob pattern
   */
  private matchGlobPattern(value: string, pattern: string): boolean {
    const regexPattern = pattern
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]');

    return new RegExp(`^${regexPattern}$`, 'i').test(value);
  }
}

// =============================================================================
// Singleton
// =============================================================================

let auditIndex: QueryableAuditIndex | null = null;

export function getQueryableAuditIndex(): QueryableAuditIndex {
  if (!auditIndex) {
    auditIndex = new QueryableAuditIndex();
  }
  return auditIndex;
}

export async function initializeQueryableAuditIndex(
  config?: Partial<AuditIndexConfig>
): Promise<QueryableAuditIndex> {
  if (!auditIndex) {
    auditIndex = new QueryableAuditIndex(config);
  }
  await auditIndex.initialize();
  return auditIndex;
}
