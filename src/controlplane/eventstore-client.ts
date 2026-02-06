/**
 * Event Store Client
 *
 * Client for the AEGIS-T2A Event Store microservice.
 * Provides immutable, append-only audit logging with hash-chaining and Merkle proofs.
 */

import { ControlPlaneClient, ControlPlaneConfig } from './client.js';
import { logger } from '../core/logger.js';

export interface AuditEvent {
  eventId: string;
  eventType: string;
  timestamp: string;
  actorId: string;
  actorType: 'user' | 'agent' | 'system';
  workflowId?: string;
  action: string;
  resource?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  success: boolean;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
  previousHash?: string;
  eventHash: string;
  signature?: string;
}

export interface MerkleProof {
  eventId: string;
  leafHash: string;
  rootHash: string;
  proof: string[];
  treeIndex: number;
  totalLeaves: number;
  verified: boolean;
}

export interface ChainVerification {
  valid: boolean;
  startEventId: string;
  endEventId: string;
  eventsChecked: number;
  brokenAt?: string;
  reason?: string;
}

export interface EventQuery {
  workflowId?: string;
  actorId?: string;
  eventType?: string;
  action?: string;
  startTime?: string;
  endTime?: string;
  success?: boolean;
  limit?: number;
  offset?: number;
}

export class EventStoreClient extends ControlPlaneClient {
  constructor(config?: Partial<ControlPlaneConfig>) {
    super({
      baseUrl: config?.baseUrl || process.env.EVENTSTORE_URL || 'http://localhost:8001',
      ...config,
    });
  }

  /**
   * Append a new event to the audit log
   */
  async appendEvent(event: {
    eventType: string;
    actorId: string;
    actorType: 'user' | 'agent' | 'system';
    workflowId?: string;
    action: string;
    resource?: string;
    inputs?: Record<string, unknown>;
    outputs?: Record<string, unknown>;
    success: boolean;
    errorMessage?: string;
    metadata?: Record<string, unknown>;
  }): Promise<AuditEvent> {
    logger.debug('Appending event to audit log', {
      eventType: event.eventType,
      action: event.action,
      actorId: event.actorId,
    });

    const response = await this.post<{ event: AuditEvent }>('/api/v1/events', event);

    return response.event;
  }

  /**
   * Query events from the audit log
   */
  async queryEvents(query: EventQuery): Promise<{
    events: AuditEvent[];
    total: number;
    hasMore: boolean;
  }> {
    const params: Record<string, string> = {};

    if (query.workflowId) params.workflow_id = query.workflowId;
    if (query.actorId) params.actor_id = query.actorId;
    if (query.eventType) params.event_type = query.eventType;
    if (query.action) params.action = query.action;
    if (query.startTime) params.start_time = query.startTime;
    if (query.endTime) params.end_time = query.endTime;
    if (query.success !== undefined) params.success = query.success.toString();
    if (query.limit) params.limit = query.limit.toString();
    if (query.offset) params.offset = query.offset.toString();

    const response = await this.get<{
      events: AuditEvent[];
      total: number;
      has_more: boolean;
    }>('/api/v1/events', params);

    return {
      events: response.events,
      total: response.total,
      hasMore: response.has_more,
    };
  }

  /**
   * Get a specific event by ID
   */
  async getEvent(eventId: string): Promise<AuditEvent> {
    const response = await this.get<{ event: AuditEvent }>(`/api/v1/events/${eventId}`);
    return response.event;
  }

  /**
   * Get Merkle proof for an event
   */
  async getMerkleProof(eventId: string): Promise<MerkleProof> {
    logger.debug('Getting Merkle proof', { eventId });

    const response = await this.get<{ proof: MerkleProof }>(
      `/api/v1/events/${eventId}/proof`
    );

    return response.proof;
  }

  /**
   * Verify hash chain integrity
   */
  async verifyChain(
    startEventId: string,
    endEventId?: string
  ): Promise<ChainVerification> {
    logger.info('Verifying hash chain', { startEventId, endEventId });

    const response = await this.post<{ verification: ChainVerification }>(
      '/api/v1/events/verify-chain',
      {
        start_event_id: startEventId,
        end_event_id: endEventId,
      }
    );

    if (!response.verification.valid) {
      logger.error('Hash chain verification failed', {
        startEventId,
        endEventId,
        brokenAt: response.verification.brokenAt,
        reason: response.verification.reason,
      });
    }

    return response.verification;
  }

  /**
   * Get event chain for a workflow
   */
  async getWorkflowChain(workflowId: string): Promise<AuditEvent[]> {
    const response = await this.get<{ events: AuditEvent[] }>(
      '/api/v1/events/workflow-chain',
      { workflow_id: workflowId }
    );

    return response.events;
  }

  /**
   * Export events to S3 for long-term archival
   */
  async exportToS3(options: {
    startTime: string;
    endTime: string;
    bucket: string;
    prefix?: string;
  }): Promise<{
    exportId: string;
    bucket: string;
    key: string;
    eventCount: number;
  }> {
    logger.info('Exporting events to S3', {
      startTime: options.startTime,
      endTime: options.endTime,
      bucket: options.bucket,
    });

    const response = await this.post<{
      export: {
        export_id: string;
        bucket: string;
        key: string;
        event_count: number;
      };
    }>('/api/v1/events/export-s3', {
      start_time: options.startTime,
      end_time: options.endTime,
      bucket: options.bucket,
      prefix: options.prefix,
    });

    return {
      exportId: response.export.export_id,
      bucket: response.export.bucket,
      key: response.export.key,
      eventCount: response.export.event_count,
    };
  }

  /**
   * Get current Merkle root hash
   */
  async getCurrentRoot(): Promise<{
    rootHash: string;
    treeSize: number;
    lastEventId: string;
    timestamp: string;
  }> {
    const response = await this.get<{
      root: {
        root_hash: string;
        tree_size: number;
        last_event_id: string;
        timestamp: string;
      };
    }>('/api/v1/events/merkle-root');

    return {
      rootHash: response.root.root_hash,
      treeSize: response.root.tree_size,
      lastEventId: response.root.last_event_id,
      timestamp: response.root.timestamp,
    };
  }

  /**
   * Get audit statistics
   */
  async getAuditStats(timeRange?: {
    start: Date;
    end: Date;
  }): Promise<{
    totalEvents: number;
    byEventType: Record<string, number>;
    byActor: Record<string, number>;
    successRate: number;
    avgEventsPerWorkflow: number;
  }> {
    const params: Record<string, string> = {};

    if (timeRange) {
      params.start = timeRange.start.toISOString();
      params.end = timeRange.end.toISOString();
    }

    const response = await this.get<{
      stats: {
        total_events: number;
        by_event_type: Record<string, number>;
        by_actor: Record<string, number>;
        success_rate: number;
        avg_events_per_workflow: number;
      };
    }>('/api/v1/events/stats', params);

    return {
      totalEvents: response.stats.total_events,
      byEventType: response.stats.by_event_type,
      byActor: response.stats.by_actor,
      successRate: response.stats.success_rate,
      avgEventsPerWorkflow: response.stats.avg_events_per_workflow,
    };
  }

  /**
   * Generate compliance report
   */
  async generateComplianceReport(options: {
    startDate: Date;
    endDate: Date;
    includeWorkflows?: boolean;
    includeActors?: boolean;
    format?: 'json' | 'pdf';
  }): Promise<{
    reportId: string;
    downloadUrl?: string;
    report: {
      period: { start: string; end: string };
      totalEvents: number;
      criticalEvents: number;
      failedEvents: number;
      uniqueWorkflows: number;
      uniqueActors: number;
      chainIntegrity: boolean;
    };
  }> {
    logger.info('Generating compliance report', {
      startDate: options.startDate,
      endDate: options.endDate,
    });

    const response = await this.post<{
      report_id: string;
      download_url?: string;
      report: {
        period: { start: string; end: string };
        total_events: number;
        critical_events: number;
        failed_events: number;
        unique_workflows: number;
        unique_actors: number;
        chain_integrity: boolean;
      };
    }>('/api/v1/events/compliance-report', {
      start_date: options.startDate.toISOString(),
      end_date: options.endDate.toISOString(),
      include_workflows: options.includeWorkflows,
      include_actors: options.includeActors,
      format: options.format || 'json',
    });

    return {
      reportId: response.report_id,
      downloadUrl: response.download_url,
      report: {
        period: response.report.period,
        totalEvents: response.report.total_events,
        criticalEvents: response.report.critical_events,
        failedEvents: response.report.failed_events,
        uniqueWorkflows: response.report.unique_workflows,
        uniqueActors: response.report.unique_actors,
        chainIntegrity: response.report.chain_integrity,
      },
    };
  }
}

// Singleton instance
let eventStoreClient: EventStoreClient;

export function getEventStoreClient(
  config?: Partial<ControlPlaneConfig>
): EventStoreClient {
  if (!eventStoreClient) {
    eventStoreClient = new EventStoreClient(config);
  }
  return eventStoreClient;
}
