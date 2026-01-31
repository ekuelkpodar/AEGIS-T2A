/**
 * AEGIS-T2A Audit & Observability
 *
 * Immutable audit ledger with hash-chaining and signed events.
 */

import { AuditEvent, EventType, ActorType, RiskLevel } from '../core/types.js';
import { generateEventId } from '../core/ids.js';
import { componentLogger } from '../core/logger.js';
import { execute, queryOne, queryAll } from '../core/database.js';
import { sha256, signObject, hashObject, chainHash } from '../core/crypto.js';

const logger = componentLogger('audit');

// =============================================================================
// Types
// =============================================================================

export interface AuditEventInput {
  eventType: EventType;
  intentId?: string;
  planId?: string;
  planVersion?: number;
  stepId?: string;
  workflowId?: string;
  actorId: string;
  actorType: ActorType;
  action: string;
  targetResource?: string;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  riskLevel?: RiskLevel;
  costIncurred?: number;
  durationMs?: number;
}

export interface AuditQuery {
  startTime?: string;
  endTime?: string;
  intentId?: string;
  workflowId?: string;
  actorId?: string;
  eventType?: EventType;
  limit?: number;
  offset?: number;
}

// =============================================================================
// Audit Ledger
// =============================================================================

export class AuditLedger {
  private initialized = false;
  private lastEventHash: string = '0'.repeat(64);

  /**
   * Initialize the audit ledger
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Load last event hash for chain continuity
    const lastEvent = queryOne<{ previous_event_hash: string; signature: string }>(
      'SELECT previous_event_hash, signature FROM audit_events ORDER BY timestamp DESC LIMIT 1'
    );

    if (lastEvent) {
      this.lastEventHash = chainHash(lastEvent.previous_event_hash, lastEvent.signature);
    }

    this.initialized = true;
    logger.info('Audit ledger initialized');
  }

  /**
   * Record an audit event
   */
  async record(input: AuditEventInput): Promise<AuditEvent> {
    const eventId = generateEventId();
    const timestamp = new Date().toISOString();

    const inputsHash = hashObject(input.inputs);
    const outputsHash = input.outputs ? hashObject(input.outputs) : undefined;

    // Build event without signature
    const eventData = {
      eventId,
      timestamp,
      eventType: input.eventType,
      intentId: input.intentId,
      planId: input.planId,
      planVersion: input.planVersion,
      stepId: input.stepId,
      workflowId: input.workflowId,
      actorId: input.actorId,
      actorType: input.actorType,
      action: input.action,
      targetResource: input.targetResource,
      inputsHash,
      outputsHash,
      success: input.success,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      riskLevel: input.riskLevel,
      costIncurred: input.costIncurred,
      durationMs: input.durationMs,
      previousEventHash: this.lastEventHash,
    };

    // Sign the event
    const signature = signObject(eventData);

    const event: AuditEvent = {
      ...eventData,
      signature,
    };

    // Persist to database
    execute(
      `INSERT INTO audit_events
       (event_id, timestamp, event_type, intent_id, plan_id, plan_version, step_id,
        workflow_id, actor_id, actor_type, action, target_resource, inputs_hash,
        outputs_hash, success, error_code, error_message, risk_level, cost_incurred,
        duration_ms, signature, previous_event_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.eventId,
        event.timestamp,
        event.eventType,
        event.intentId ?? null,
        event.planId ?? null,
        event.planVersion ?? null,
        event.stepId ?? null,
        event.workflowId ?? null,
        event.actorId,
        event.actorType,
        event.action,
        event.targetResource ?? null,
        event.inputsHash,
        event.outputsHash ?? null,
        event.success ? 1 : 0,
        event.errorCode ?? null,
        event.errorMessage ?? null,
        event.riskLevel ?? null,
        event.costIncurred ?? null,
        event.durationMs ?? null,
        event.signature,
        event.previousEventHash,
      ]
    );

    // Update chain
    this.lastEventHash = chainHash(event.previousEventHash, event.signature);

    logger.debug(
      { eventId, eventType: event.eventType, action: event.action },
      'Audit event recorded'
    );

    return event;
  }

  /**
   * Query audit events
   */
  async query(query: AuditQuery): Promise<AuditEvent[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.startTime) {
      conditions.push('timestamp >= ?');
      params.push(query.startTime);
    }
    if (query.endTime) {
      conditions.push('timestamp <= ?');
      params.push(query.endTime);
    }
    if (query.intentId) {
      conditions.push('intent_id = ?');
      params.push(query.intentId);
    }
    if (query.workflowId) {
      conditions.push('workflow_id = ?');
      params.push(query.workflowId);
    }
    if (query.actorId) {
      conditions.push('actor_id = ?');
      params.push(query.actorId);
    }
    if (query.eventType) {
      conditions.push('event_type = ?');
      params.push(query.eventType);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const sql = `
      SELECT * FROM audit_events
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    const rows = queryAll<{
      event_id: string;
      timestamp: string;
      event_type: string;
      intent_id: string | null;
      plan_id: string | null;
      plan_version: number | null;
      step_id: string | null;
      workflow_id: string | null;
      actor_id: string;
      actor_type: string;
      action: string;
      target_resource: string | null;
      inputs_hash: string;
      outputs_hash: string | null;
      success: number;
      error_code: string | null;
      error_message: string | null;
      risk_level: string | null;
      cost_incurred: number | null;
      duration_ms: number | null;
      signature: string;
      previous_event_hash: string;
    }>(sql, params);

    return rows.map((row) => ({
      eventId: row.event_id,
      timestamp: row.timestamp,
      eventType: row.event_type as EventType,
      intentId: row.intent_id ?? undefined,
      planId: row.plan_id ?? undefined,
      planVersion: row.plan_version ?? undefined,
      stepId: row.step_id ?? undefined,
      workflowId: row.workflow_id ?? undefined,
      actorId: row.actor_id,
      actorType: row.actor_type as ActorType,
      action: row.action,
      targetResource: row.target_resource ?? undefined,
      inputsHash: row.inputs_hash,
      outputsHash: row.outputs_hash ?? undefined,
      success: row.success === 1,
      errorCode: row.error_code ?? undefined,
      errorMessage: row.error_message ?? undefined,
      riskLevel: (row.risk_level as RiskLevel) ?? undefined,
      costIncurred: row.cost_incurred ?? undefined,
      durationMs: row.duration_ms ?? undefined,
      signature: row.signature,
      previousEventHash: row.previous_event_hash,
    }));
  }

  /**
   * Verify chain integrity
   */
  async verifyChain(startEventId?: string, endEventId?: string): Promise<{
    valid: boolean;
    errors: string[];
    eventsChecked: number;
  }> {
    const errors: string[] = [];
    let sql = 'SELECT * FROM audit_events ORDER BY timestamp ASC';

    const rows = queryAll<{
      event_id: string;
      signature: string;
      previous_event_hash: string;
    }>(sql);

    let expectedPreviousHash = '0'.repeat(64);
    let eventsChecked = 0;

    for (const row of rows) {
      eventsChecked++;

      if (row.previous_event_hash !== expectedPreviousHash) {
        errors.push(
          `Chain broken at event ${row.event_id}: expected previous hash ${expectedPreviousHash}, got ${row.previous_event_hash}`
        );
      }

      expectedPreviousHash = chainHash(row.previous_event_hash, row.signature);
    }

    return {
      valid: errors.length === 0,
      errors,
      eventsChecked,
    };
  }

  /**
   * Get event by ID
   */
  async getEvent(eventId: string): Promise<AuditEvent | null> {
    const events = await this.query({ limit: 1 });
    const row = queryOne<{
      event_id: string;
      timestamp: string;
      event_type: string;
      intent_id: string | null;
      plan_id: string | null;
      plan_version: number | null;
      step_id: string | null;
      workflow_id: string | null;
      actor_id: string;
      actor_type: string;
      action: string;
      target_resource: string | null;
      inputs_hash: string;
      outputs_hash: string | null;
      success: number;
      error_code: string | null;
      error_message: string | null;
      risk_level: string | null;
      cost_incurred: number | null;
      duration_ms: number | null;
      signature: string;
      previous_event_hash: string;
    }>('SELECT * FROM audit_events WHERE event_id = ?', [eventId]);

    if (!row) return null;

    return {
      eventId: row.event_id,
      timestamp: row.timestamp,
      eventType: row.event_type as EventType,
      intentId: row.intent_id ?? undefined,
      planId: row.plan_id ?? undefined,
      planVersion: row.plan_version ?? undefined,
      stepId: row.step_id ?? undefined,
      workflowId: row.workflow_id ?? undefined,
      actorId: row.actor_id,
      actorType: row.actor_type as ActorType,
      action: row.action,
      targetResource: row.target_resource ?? undefined,
      inputsHash: row.inputs_hash,
      outputsHash: row.outputs_hash ?? undefined,
      success: row.success === 1,
      errorCode: row.error_code ?? undefined,
      errorMessage: row.error_message ?? undefined,
      riskLevel: (row.risk_level as RiskLevel) ?? undefined,
      costIncurred: row.cost_incurred ?? undefined,
      durationMs: row.duration_ms ?? undefined,
      signature: row.signature,
      previousEventHash: row.previous_event_hash,
    };
  }

  /**
   * Export audit trail for compliance
   */
  async export(query: AuditQuery): Promise<{
    events: AuditEvent[];
    chainValid: boolean;
    exportedAt: string;
    checksum: string;
  }> {
    const events = await this.query(query);
    const verification = await this.verifyChain();

    const exportData = {
      events,
      chainValid: verification.valid,
      exportedAt: new Date().toISOString(),
    };

    return {
      ...exportData,
      checksum: hashObject(exportData),
    };
  }
}

// =============================================================================
// Singleton
// =============================================================================

let ledger: AuditLedger | null = null;

export function getAuditLedger(): AuditLedger {
  if (!ledger) {
    ledger = new AuditLedger();
  }
  return ledger;
}

export async function initializeAuditLedger(): Promise<AuditLedger> {
  const l = getAuditLedger();
  await l.initialize();
  return l;
}

// =============================================================================
// Convenience Functions
// =============================================================================

export async function recordAuditEvent(input: AuditEventInput): Promise<AuditEvent> {
  const auditLedger = getAuditLedger();
  return auditLedger.record(input);
}

// Queryable Audit Index
export {
  QueryableAuditIndex,
  getQueryableAuditIndex,
  initializeQueryableAuditIndex,
  defaultAuditIndexConfig,
} from './queryable-audit-index.js';
export type {
  IndexedAuditEntry,
  AuditQueryFilter,
  AuditQueryOptions,
  AuditQueryResult,
  QueryAggregations,
  ChainIntegrityResult,
  BrokenChainLink,
  ChainAttestation,
  ForensicTimelineEntry,
  ForensicReport,
  StreamSubscription,
  AuditIndexConfig,
} from './queryable-audit-index.js';

// Deterministic Replay Engine
export {
  ExecutionArtifactRecorder,
  ReplayEngine,
  getExecutionArtifactRecorder,
  getReplayEngine,
  initializeReplaySystem,
  defaultReplayEngineConfig,
} from './replay/index.js';
export type {
  ExecutionArtifact,
  LLMInteractionCapture,
  ToolCallCapture,
  EnvironmentSnapshot,
  DependencyState,
  PolicyDecisionCapture,
  MerkleNode,
  MerkleRootCommit,
  PromptCacheEntry,
  ReplayRequest,
  ReplayResult,
  ReplayTimelineEntry,
  IntegrityVerification,
  ReplayError,
  ReplayEngineConfig,
  TimeTravelQuery,
  TimeTravelSnapshot,
} from './replay/index.js';
