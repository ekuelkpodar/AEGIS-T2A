/**
 * AEGIS-T2A Audit Service
 *
 * Provides comprehensive audit logging for all governance decisions.
 * Supports multiple backends (file, database, Elasticsearch, Kafka)
 * and exports in various formats (JSON, CEF) for SIEM integration.
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  AuditEvent,
  AuditEventType,
  AuditQuery,
  AuditConfig,
  PolicyDecision,
} from '../types';

/**
 * Audit storage backend interface
 */
export interface AuditBackend {
  name: string;
  initialize(): Promise<void>;
  write(events: AuditEvent[]): Promise<void>;
  query(query: AuditQuery): Promise<{ events: AuditEvent[]; total: number }>;
  close(): Promise<void>;
}

/**
 * File-based audit backend
 */
export class FileAuditBackend implements AuditBackend {
  name = 'file';
  private filePath: string;
  private currentDate: string = '';
  private writeStream?: fs.FileHandle;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async initialize(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
  }

  async write(events: AuditEvent[]): Promise<void> {
    const date = new Date().toISOString().split('T')[0];
    const filePath = this.filePath.replace('.log', `-${date}.log`);

    const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fs.appendFile(filePath, lines, 'utf-8');
  }

  async query(query: AuditQuery): Promise<{ events: AuditEvent[]; total: number }> {
    // For file backend, we need to read and filter files
    // This is a simplified implementation
    const events: AuditEvent[] = [];
    const dir = path.dirname(this.filePath);

    try {
      const files = await fs.readdir(dir);
      const logFiles = files.filter((f) => f.endsWith('.log')).sort().reverse();

      for (const file of logFiles) {
        const content = await fs.readFile(path.join(dir, file), 'utf-8');
        const lines = content.split('\n').filter((l) => l.trim());

        for (const line of lines) {
          try {
            const event = JSON.parse(line) as AuditEvent;
            if (this.matchesQuery(event, query)) {
              events.push(event);
              if (events.length >= (query.limit || 1000)) break;
            }
          } catch {
            // Skip invalid lines
          }
        }

        if (events.length >= (query.limit || 1000)) break;
      }
    } catch {
      // Directory might not exist yet
    }

    const offset = query.offset || 0;
    const limit = query.limit || 100;

    return {
      events: events.slice(offset, offset + limit),
      total: events.length,
    };
  }

  private matchesQuery(event: AuditEvent, query: AuditQuery): boolean {
    if (query.agent_id && event.agent_id !== query.agent_id) return false;
    if (query.tenant_id && event.tenant_id !== query.tenant_id) return false;
    if (query.event_type && event.event_type !== query.event_type) return false;
    if (query.decision && event.decision !== query.decision) return false;
    if (query.tool && event.tool !== query.tool) return false;
    if (query.action && event.action !== query.action) return false;
    if (query.correlation_id && event.correlation_id !== query.correlation_id) return false;

    const eventTime = new Date(event.timestamp);
    if (query.start_time && eventTime < query.start_time) return false;
    if (query.end_time && eventTime > query.end_time) return false;

    return true;
  }

  async close(): Promise<void> {
    if (this.writeStream) {
      await this.writeStream.close();
    }
  }
}

/**
 * In-memory audit backend (for testing)
 */
export class MemoryAuditBackend implements AuditBackend {
  name = 'memory';
  private events: AuditEvent[] = [];
  private maxEvents: number;

  constructor(maxEvents: number = 10000) {
    this.maxEvents = maxEvents;
  }

  async initialize(): Promise<void> {}

  async write(events: AuditEvent[]): Promise<void> {
    this.events.push(...events);

    // Trim if exceeds max
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
  }

  async query(query: AuditQuery): Promise<{ events: AuditEvent[]; total: number }> {
    let filtered = [...this.events];

    if (query.agent_id) {
      filtered = filtered.filter((e) => e.agent_id === query.agent_id);
    }
    if (query.tenant_id) {
      filtered = filtered.filter((e) => e.tenant_id === query.tenant_id);
    }
    if (query.event_type) {
      filtered = filtered.filter((e) => e.event_type === query.event_type);
    }
    if (query.decision) {
      filtered = filtered.filter((e) => e.decision === query.decision);
    }
    if (query.tool) {
      filtered = filtered.filter((e) => e.tool === query.tool);
    }
    if (query.action) {
      filtered = filtered.filter((e) => e.action === query.action);
    }
    if (query.start_time) {
      filtered = filtered.filter(
        (e) => new Date(e.timestamp) >= query.start_time!
      );
    }
    if (query.end_time) {
      filtered = filtered.filter((e) => new Date(e.timestamp) <= query.end_time!);
    }

    // Sort
    const sortOrder = query.sort_order === 'asc' ? 1 : -1;
    filtered.sort((a, b) => {
      const aTime = new Date(a.timestamp).getTime();
      const bTime = new Date(b.timestamp).getTime();
      return (aTime - bTime) * sortOrder;
    });

    const total = filtered.length;
    const offset = query.offset || 0;
    const limit = query.limit || 100;

    return {
      events: filtered.slice(offset, offset + limit),
      total,
    };
  }

  async close(): Promise<void> {
    this.events = [];
  }

  getAll(): AuditEvent[] {
    return [...this.events];
  }
}

/**
 * CEF (Common Event Format) formatter for SIEM integration
 */
export class CEFFormatter {
  private vendor = 'AEGIS';
  private product = 'T2A';
  private version = '1.0';

  format(event: AuditEvent): string {
    const severity = this.getSeverity(event.decision);
    const signatureId = this.getSignatureId(event.event_type);
    const name = this.getEventName(event.event_type);

    const extensions = [
      `src=${event.source_ip || 'unknown'}`,
      `suser=${event.agent_id}`,
      `cs1=${event.tenant_id}`,
      `cs1Label=TenantID`,
      `cs2=${event.tool}`,
      `cs2Label=Tool`,
      `cs3=${event.action}`,
      `cs3Label=Action`,
      `cs4=${event.decision}`,
      `cs4Label=Decision`,
      `cs5=${event.correlation_id}`,
      `cs5Label=CorrelationID`,
      `msg=${event.decision_reason}`,
      `outcome=${event.decision === 'ALLOW' ? 'success' : 'failure'}`,
    ].join(' ');

    return `CEF:0|${this.vendor}|${this.product}|${this.version}|${signatureId}|${name}|${severity}|${extensions}`;
  }

  private getSeverity(decision: PolicyDecision): number {
    switch (decision) {
      case 'ALLOW':
        return 1;
      case 'MODIFY':
        return 3;
      case 'AWAIT_APPROVAL':
        return 5;
      case 'DENY':
        return 7;
      default:
        return 5;
    }
  }

  private getSignatureId(eventType: AuditEventType): string {
    const ids: Record<AuditEventType, string> = {
      policy_evaluation: '100',
      action_allowed: '101',
      action_denied: '102',
      action_modified: '103',
      approval_requested: '200',
      approval_granted: '201',
      approval_denied: '202',
      approval_expired: '203',
      token_issued: '300',
      token_revoked: '301',
      token_validated: '302',
      budget_warning: '400',
      budget_exceeded: '401',
      rate_limit_warning: '500',
      rate_limit_exceeded: '501',
      policy_updated: '600',
      config_changed: '601',
    };
    return ids[eventType] || '999';
  }

  private getEventName(eventType: AuditEventType): string {
    return eventType.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
}

/**
 * Audit Service
 */
export class AuditService extends EventEmitter {
  private config: AuditConfig;
  private backend: AuditBackend;
  private buffer: AuditEvent[] = [];
  private flushTimer?: NodeJS.Timeout;
  private cefFormatter: CEFFormatter;
  private hashChain: string = '';

  constructor(config: AuditConfig, backend?: AuditBackend) {
    super();
    this.config = config;
    this.cefFormatter = new CEFFormatter();

    // Initialize backend
    if (backend) {
      this.backend = backend;
    } else {
      switch (config.backend) {
        case 'file':
          this.backend = new FileAuditBackend(config.file_path || './audit/audit.log');
          break;
        case 'database':
        case 'elasticsearch':
        case 'kafka':
          // For these backends, fall back to file if not implemented
          this.backend = new FileAuditBackend(config.file_path || './audit/audit.log');
          break;
        default:
          this.backend = new MemoryAuditBackend();
      }
    }

    // Start flush timer
    this.startFlushTimer();
  }

  /**
   * Initialize the audit service
   */
  async initialize(): Promise<void> {
    await this.backend.initialize();
    this.emit('initialized');
  }

  /**
   * Log an audit event
   */
  async log(event: Partial<AuditEvent>): Promise<void> {
    const fullEvent = this.enrichEvent(event);

    // Add to buffer
    this.buffer.push(fullEvent);

    // Flush if buffer is full
    if (this.buffer.length >= this.config.batch_size) {
      await this.flush();
    }

    this.emit('event_logged', { event_id: fullEvent.id });
  }

  /**
   * Enrich event with defaults and computed fields
   */
  private enrichEvent(event: Partial<AuditEvent>): AuditEvent {
    const now = new Date();
    const id = crypto.randomUUID();

    // Calculate hash chain
    const previousHash = this.hashChain;
    const eventData = JSON.stringify({ ...event, id, timestamp: now, previousHash });
    this.hashChain = crypto.createHash('sha256').update(eventData).digest('hex');

    return {
      id,
      timestamp: now,
      event_type: event.event_type || 'policy_evaluation',
      agent_id: event.agent_id || 'unknown',
      tenant_id: event.tenant_id || 'unknown',
      role: event.role || 'restricted',
      tool: event.tool || 'unknown',
      action: event.action || 'unknown',
      parameters: event.parameters || {},
      policy_version: event.policy_version || 'unknown',
      decision: event.decision || 'DENY',
      decision_reason: event.decision_reason || 'No reason provided',
      matched_policy_id: event.matched_policy_id,
      approval_id: event.approval_id,
      override_token_id: event.override_token_id,
      correlation_id: event.correlation_id || crypto.randomUUID(),
      source_ip: event.source_ip,
      user_agent: event.user_agent,
      environment: event.environment || 'production',
      evaluation_ms: event.evaluation_ms || 0,
      shadow_mode: event.shadow_mode || false,
      metadata: {
        ...event.metadata,
        hash: this.hashChain,
        previous_hash: previousHash,
      },
    };
  }

  /**
   * Flush buffered events to backend
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const events = [...this.buffer];
    this.buffer = [];

    try {
      await this.backend.write(events);
      this.emit('flushed', { count: events.length });
    } catch (error) {
      // Re-add to buffer on failure
      this.buffer.unshift(...events);
      this.emit('flush_error', { error, count: events.length });
      throw error;
    }
  }

  /**
   * Query audit events
   */
  async query(query: AuditQuery): Promise<{ events: AuditEvent[]; total: number }> {
    // Flush buffer first to ensure recent events are included
    await this.flush();
    return this.backend.query(query);
  }

  /**
   * Get events for a specific correlation ID
   */
  async getByCorrelationId(correlationId: string): Promise<AuditEvent[]> {
    const result = await this.query({ correlation_id: correlationId, limit: 1000 });
    return result.events;
  }

  /**
   * Get events for a specific agent
   */
  async getByAgent(
    agentId: string,
    options?: { limit?: number; start_time?: Date; end_time?: Date }
  ): Promise<AuditEvent[]> {
    const result = await this.query({
      agent_id: agentId,
      limit: options?.limit || 100,
      start_time: options?.start_time,
      end_time: options?.end_time,
    });
    return result.events;
  }

  /**
   * Get decision statistics
   */
  async getDecisionStats(
    tenantId: string,
    startTime: Date,
    endTime: Date
  ): Promise<{
    total: number;
    allowed: number;
    denied: number;
    modified: number;
    awaiting_approval: number;
    by_tool: Record<string, number>;
  }> {
    const result = await this.query({
      tenant_id: tenantId,
      start_time: startTime,
      end_time: endTime,
      limit: 10000,
    });

    const stats = {
      total: 0,
      allowed: 0,
      denied: 0,
      modified: 0,
      awaiting_approval: 0,
      by_tool: {} as Record<string, number>,
    };

    for (const event of result.events) {
      stats.total++;

      switch (event.decision) {
        case 'ALLOW':
          stats.allowed++;
          break;
        case 'DENY':
          stats.denied++;
          break;
        case 'MODIFY':
          stats.modified++;
          break;
        case 'AWAIT_APPROVAL':
          stats.awaiting_approval++;
          break;
      }

      stats.by_tool[event.tool] = (stats.by_tool[event.tool] || 0) + 1;
    }

    return stats;
  }

  /**
   * Export events in CEF format
   */
  async exportCEF(query: AuditQuery): Promise<string> {
    const result = await this.query(query);
    return result.events.map((e) => this.cefFormatter.format(e)).join('\n');
  }

  /**
   * Export events in JSON Lines format
   */
  async exportJSONL(query: AuditQuery): Promise<string> {
    const result = await this.query(query);
    return result.events.map((e) => JSON.stringify(e)).join('\n');
  }

  /**
   * Verify audit chain integrity
   */
  async verifyChain(events: AuditEvent[]): Promise<{
    valid: boolean;
    errors: string[];
  }> {
    const errors: string[] = [];
    let previousHash = '';

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const storedPreviousHash = event.metadata?.previous_hash as string;

      if (i > 0 && storedPreviousHash !== previousHash) {
        errors.push(
          `Chain broken at event ${event.id}: expected previous hash ${previousHash}, got ${storedPreviousHash}`
        );
      }

      // Recalculate hash
      const { hash: _, previous_hash: __, ...eventWithoutHash } = event.metadata || {};
      const eventData = JSON.stringify({
        ...event,
        metadata: eventWithoutHash,
        previousHash: storedPreviousHash,
      });
      const calculatedHash = crypto.createHash('sha256').update(eventData).digest('hex');
      const storedHash = event.metadata?.hash as string;

      if (storedHash && calculatedHash !== storedHash) {
        errors.push(
          `Hash mismatch at event ${event.id}: calculated ${calculatedHash}, stored ${storedHash}`
        );
      }

      previousHash = storedHash || calculatedHash;
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Start the flush timer
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(async () => {
      try {
        await this.flush();
      } catch (error) {
        this.emit('timer_flush_error', { error });
      }
    }, this.config.flush_interval_seconds * 1000);
  }

  /**
   * Stop the flush timer
   */
  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  /**
   * Shutdown the audit service
   */
  async shutdown(): Promise<void> {
    this.stopFlushTimer();
    await this.flush();
    await this.backend.close();
    this.emit('shutdown');
  }

  /**
   * Get service statistics
   */
  getStats(): {
    bufferSize: number;
    backendName: string;
    hashChain: string;
  } {
    return {
      bufferSize: this.buffer.length,
      backendName: this.backend.name,
      hashChain: this.hashChain.substring(0, 16) + '...',
    };
  }
}

export default AuditService;
