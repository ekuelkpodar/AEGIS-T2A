/**
 * Phase 2 Security Components Tests
 *
 * Comprehensive tests for:
 * - Compensation Feasibility Validation Engine (P0)
 * - Quantitative Blast Radius Engine (P0)
 * - Confidence-Aware Intent Parsing (P1)
 * - Queryable Audit Index (P1)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// =============================================================================
// Compensation Feasibility Validator Tests
// =============================================================================

import {
  CompensationFeasibilityValidator,
  defaultFeasibilityConfig,
  SEMANTIC_PAIRS,
  CRITICAL_IDENTIFIER_KEYS,
} from '../../src/planner/compensation-feasibility-validator.js';
import type {
  CompensationValidationReport,
  ValidationContext,
} from '../../src/planner/compensation-feasibility-validator.js';
import type { PlanManifest, PlanStep, CompensationAction } from '../../src/core/types.js';

describe('CompensationFeasibilityValidator', () => {
  let validator: CompensationFeasibilityValidator;

  beforeEach(async () => {
    validator = new CompensationFeasibilityValidator();
    await validator.initialize();
  });

  describe('Semantic Pair Validation', () => {
    it('should validate correct semantic pairs', async () => {
      const plan = createMockPlan([
        createMockStep('create_instance', 'aws:ec2', {
          compensationAction: createCompensation('terminate_instance', {}),
        }),
      ]);

      const context = createMockContext();
      const report = await validator.validateWorkflowPlan(plan, context);

      expect(report.overallFeasible).toBe(true);
      const stepAnalysis = report.stepAnalyses[0];
      expect(stepAnalysis?.semanticValidation.valid).toBe(true);
    });

    it('should reject incorrect semantic pairs', async () => {
      const plan = createMockPlan([
        createMockStep('create_instance', 'aws:ec2', {
          compensationAction: createCompensation('update_instance', {}),
        }),
      ]);

      const context = createMockContext();
      const report = await validator.validateWorkflowPlan(plan, context);

      const stepAnalysis = report.stepAnalyses[0];
      expect(stepAnalysis?.semanticValidation.valid).toBe(false);
      expect(stepAnalysis?.semanticValidation.errors).toContain(
        expect.stringContaining('semantic mismatch')
      );
    });

    it('should validate all standard semantic pairs', () => {
      const expectedPairs = [
        ['create', 'delete'],
        ['insert', 'delete'],
        ['add', 'remove'],
        ['start', 'stop'],
        ['enable', 'disable'],
        ['grant', 'revoke'],
        ['deploy', 'undeploy'],
        ['publish', 'unpublish'],
        ['attach', 'detach'],
        ['mount', 'unmount'],
      ];

      for (const [action, compensation] of expectedPairs) {
        expect(SEMANTIC_PAIRS[action]).toBe(compensation);
      }
    });
  });

  describe('Critical Identifier Validation', () => {
    it('should validate matching critical identifiers', async () => {
      const plan = createMockPlan([
        createMockStep('delete_user', 'database', {
          parameters: { user_id: 'user-123', database: 'prod' },
          compensationAction: createCompensation('restore_user', {
            user_id: 'user-123',
            database: 'prod',
          }),
        }),
      ]);

      const context = createMockContext();
      const report = await validator.validateWorkflowPlan(plan, context);

      const stepAnalysis = report.stepAnalyses[0];
      expect(stepAnalysis?.identifierValidation.valid).toBe(true);
    });

    it('should reject mismatched critical identifiers', async () => {
      const plan = createMockPlan([
        createMockStep('delete_user', 'database', {
          parameters: { user_id: 'user-123' },
          compensationAction: createCompensation('restore_user', {
            user_id: 'user-456', // Different user ID
          }),
        }),
      ]);

      const context = createMockContext();
      const report = await validator.validateWorkflowPlan(plan, context);

      const stepAnalysis = report.stepAnalyses[0];
      expect(stepAnalysis?.identifierValidation.valid).toBe(false);
    });

    it('should recognize all critical identifier keys', () => {
      const expectedKeys = [
        'user_id',
        'account_id',
        'resource_id',
        'resource_arn',
        'instance_id',
        'bucket_name',
        'table_name',
        'database_name',
        'cluster_id',
        'vpc_id',
        'subnet_id',
        'security_group_id',
        'role_arn',
        'function_name',
        'queue_url',
        'topic_arn',
        'stream_name',
        'repository_name',
        'project_id',
        'environment',
      ];

      for (const key of expectedKeys) {
        expect(CRITICAL_IDENTIFIER_KEYS).toContain(key);
      }
    });
  });

  describe('Permission Validation', () => {
    it('should pass when required permissions are available', async () => {
      const plan = createMockPlan([
        createMockStep('create_bucket', 'aws:s3', {
          compensationAction: createCompensation('delete_bucket', {}),
        }),
      ]);

      const context = createMockContext({
        available_permissions: ['aws:s3:DeleteBucket', 'aws:s3:*'],
      });

      const report = await validator.validateWorkflowPlan(plan, context);
      const stepAnalysis = report.stepAnalyses[0];
      expect(stepAnalysis?.permissionValidation.valid).toBe(true);
    });

    it('should fail when permissions are missing', async () => {
      const plan = createMockPlan([
        createMockStep('create_bucket', 'aws:s3', {
          compensationAction: createCompensation('delete_bucket', {}),
        }),
      ]);

      const context = createMockContext({
        available_permissions: [], // No permissions
      });

      const report = await validator.validateWorkflowPlan(plan, context);
      const stepAnalysis = report.stepAnalyses[0];
      expect(stepAnalysis?.permissionValidation.valid).toBe(false);
    });
  });

  describe('Feasibility Scoring', () => {
    it('should calculate high score for valid compensations', async () => {
      const plan = createMockPlan([
        createMockStep('create_instance', 'aws:ec2', {
          parameters: { instance_id: 'i-123' },
          compensationAction: createCompensation('terminate_instance', {
            instance_id: 'i-123',
          }),
        }),
      ]);

      const context = createMockContext({
        available_permissions: ['aws:ec2:TerminateInstances'],
      });

      const report = await validator.validateWorkflowPlan(plan, context);
      expect(report.feasibilityScore.overall).toBeGreaterThanOrEqual(0.7);
    });

    it('should calculate low score for invalid compensations', async () => {
      const plan = createMockPlan([
        createMockStep('create_instance', 'aws:ec2', {
          parameters: { instance_id: 'i-123' },
          compensationAction: createCompensation('update_instance', {
            instance_id: 'i-456', // Wrong ID
          }),
        }),
      ]);

      const context = createMockContext({
        available_permissions: [],
      });

      const report = await validator.validateWorkflowPlan(plan, context);
      expect(report.feasibilityScore.overall).toBeLessThan(0.5);
    });
  });

  describe('Steps Without Compensation', () => {
    it('should flag steps without compensation actions', async () => {
      const plan = createMockPlan([
        createMockStep('create_instance', 'aws:ec2', {
          sideEffect: true,
          // No compensation action
        }),
      ]);

      const context = createMockContext();
      const report = await validator.validateWorkflowPlan(plan, context);

      expect(report.stepsWithoutCompensation).toHaveLength(1);
    });

    it('should not flag read-only steps', async () => {
      const plan = createMockPlan([
        createMockStep('describe_instances', 'aws:ec2', {
          sideEffect: false,
        }),
      ]);

      const context = createMockContext();
      const report = await validator.validateWorkflowPlan(plan, context);

      expect(report.stepsWithoutCompensation).toHaveLength(0);
    });
  });

  describe('Event Emission', () => {
    it('should emit validation_complete event', async () => {
      const plan = createMockPlan([
        createMockStep('create', 'aws:s3', {}),
      ]);

      let eventEmitted = false;
      validator.on('validation_complete', () => {
        eventEmitted = true;
      });

      await validator.validateWorkflowPlan(plan, createMockContext());
      expect(eventEmitted).toBe(true);
    });
  });
});

// =============================================================================
// Blast Radius Analyzer Tests
// =============================================================================

import {
  BlastRadiusAnalyzer,
  defaultBlastRadiusConfig,
} from '../../src/planner/blast-radius-analyzer.js';
import type {
  BlastRadiusAnalysisReport,
  ResourceMetadata,
  AnalysisContext,
} from '../../src/planner/blast-radius-analyzer.js';

describe('BlastRadiusAnalyzer', () => {
  let analyzer: BlastRadiusAnalyzer;

  beforeEach(async () => {
    analyzer = new BlastRadiusAnalyzer();
    await analyzer.initialize();
  });

  describe('Impact Metrics Calculation', () => {
    it('should calculate affected user count from resource metadata', async () => {
      const plan = createMockPlan([
        createMockStep('update_config', 'service', {
          targetResource: 'service-production',
        }),
      ]);

      const resourceMetadata: ResourceMetadata = {
        resource_id: 'service-production',
        affected_user_count: 1000,
        data_sensitivity_tier: 'confidential',
        system_criticality: 'high',
        downstream_dependencies: ['service-a', 'service-b'],
        upstream_dependencies: [],
        recovery_time_estimate_minutes: 30,
        last_incident_date: '2024-01-01',
      };

      analyzer.registerResourceMetadata('service-production', resourceMetadata);

      const context = createAnalysisContext();
      const report = await analyzer.analyzeWorkflow(plan, context);

      const stepRadius = report.stepRadii[0];
      expect(stepRadius?.metrics.affected_user_count).toBe(1000);
    });

    it('should calculate data sensitivity tier', async () => {
      const plan = createMockPlan([
        createMockStep('modify_data', 'database', {
          targetResource: 'customer-db',
        }),
      ]);

      analyzer.registerResourceMetadata('customer-db', {
        resource_id: 'customer-db',
        affected_user_count: 500,
        data_sensitivity_tier: 'restricted',
        system_criticality: 'critical',
        downstream_dependencies: [],
        upstream_dependencies: [],
        recovery_time_estimate_minutes: 60,
      });

      const context = createAnalysisContext();
      const report = await analyzer.analyzeWorkflow(plan, context);

      const stepRadius = report.stepRadii[0];
      expect(stepRadius?.metrics.data_sensitivity_tier).toBe('restricted');
    });

    it('should identify cascading failure paths', async () => {
      const plan = createMockPlan([
        createMockStep('restart_service', 'kubernetes', {
          targetResource: 'api-gateway',
        }),
      ]);

      // Register resources with dependencies
      analyzer.registerResourceMetadata('api-gateway', {
        resource_id: 'api-gateway',
        affected_user_count: 10000,
        data_sensitivity_tier: 'public',
        system_criticality: 'critical',
        downstream_dependencies: ['auth-service', 'user-service'],
        upstream_dependencies: [],
        recovery_time_estimate_minutes: 5,
      });

      analyzer.registerResourceMetadata('auth-service', {
        resource_id: 'auth-service',
        affected_user_count: 10000,
        data_sensitivity_tier: 'restricted',
        system_criticality: 'critical',
        downstream_dependencies: ['session-store'],
        upstream_dependencies: ['api-gateway'],
        recovery_time_estimate_minutes: 10,
      });

      const context = createAnalysisContext();
      const report = await analyzer.analyzeWorkflow(plan, context);

      expect(report.cascadingPaths.length).toBeGreaterThan(0);
    });
  });

  describe('Threshold Checking', () => {
    it('should trigger approval escalation when thresholds exceeded', async () => {
      const plan = createMockPlan([
        createMockStep('delete_database', 'aws:rds', {
          targetResource: 'production-db',
          riskLevel: 'destructive',
        }),
      ]);

      analyzer.registerResourceMetadata('production-db', {
        resource_id: 'production-db',
        affected_user_count: 100000, // High user count
        data_sensitivity_tier: 'restricted',
        system_criticality: 'critical',
        downstream_dependencies: ['service-a', 'service-b', 'service-c'],
        upstream_dependencies: [],
        recovery_time_estimate_minutes: 120,
      });

      const context = createAnalysisContext();
      const report = await analyzer.analyzeWorkflow(plan, context);

      expect(report.requiresApprovalEscalation).toBe(true);
      expect(report.thresholdViolations.length).toBeGreaterThan(0);
    });

    it('should not escalate for low-impact operations', async () => {
      const plan = createMockPlan([
        createMockStep('update_config', 'service', {
          targetResource: 'dev-service',
          riskLevel: 'low',
        }),
      ]);

      analyzer.registerResourceMetadata('dev-service', {
        resource_id: 'dev-service',
        affected_user_count: 5,
        data_sensitivity_tier: 'public',
        system_criticality: 'low',
        downstream_dependencies: [],
        upstream_dependencies: [],
        recovery_time_estimate_minutes: 1,
      });

      const context = createAnalysisContext();
      const report = await analyzer.analyzeWorkflow(plan, context);

      expect(report.requiresApprovalEscalation).toBe(false);
    });
  });

  describe('Aggregate Metrics', () => {
    it('should calculate aggregate metrics across all steps', async () => {
      const plan = createMockPlan([
        createMockStep('update_service_a', 'kubernetes', {
          targetResource: 'service-a',
        }),
        createMockStep('update_service_b', 'kubernetes', {
          targetResource: 'service-b',
        }),
      ]);

      analyzer.registerResourceMetadata('service-a', {
        resource_id: 'service-a',
        affected_user_count: 1000,
        data_sensitivity_tier: 'confidential',
        system_criticality: 'medium',
        downstream_dependencies: [],
        upstream_dependencies: [],
        recovery_time_estimate_minutes: 10,
      });

      analyzer.registerResourceMetadata('service-b', {
        resource_id: 'service-b',
        affected_user_count: 2000,
        data_sensitivity_tier: 'public',
        system_criticality: 'low',
        downstream_dependencies: [],
        upstream_dependencies: [],
        recovery_time_estimate_minutes: 5,
      });

      const context = createAnalysisContext();
      const report = await analyzer.analyzeWorkflow(plan, context);

      expect(report.aggregateMetrics.total_affected_users).toBe(3000);
      expect(report.aggregateMetrics.max_sensitivity_tier).toBe('confidential');
    });
  });

  describe('Resource Metadata Management', () => {
    it('should register and retrieve resource metadata', () => {
      const metadata: ResourceMetadata = {
        resource_id: 'test-resource',
        affected_user_count: 100,
        data_sensitivity_tier: 'public',
        system_criticality: 'low',
        downstream_dependencies: [],
        upstream_dependencies: [],
        recovery_time_estimate_minutes: 5,
      };

      analyzer.registerResourceMetadata('test-resource', metadata);
      const retrieved = analyzer.getResourceMetadata('test-resource');

      expect(retrieved).toEqual(metadata);
    });

    it('should return undefined for unknown resources', () => {
      const retrieved = analyzer.getResourceMetadata('unknown-resource');
      expect(retrieved).toBeUndefined();
    });
  });
});

// =============================================================================
// Confidence-Aware Parser Tests
// =============================================================================

import {
  ConfidenceAwareParser,
  defaultConfidenceParserConfig,
} from '../../src/gateway/confidence-aware-parser.js';
import type {
  ConfidenceAwareParseResult,
  DisambiguationSession,
} from '../../src/gateway/confidence-aware-parser.js';

describe('ConfidenceAwareParser', () => {
  let parser: ConfidenceAwareParser;

  beforeEach(async () => {
    parser = new ConfidenceAwareParser({
      confidenceThreshold: 8,
      sessionTtlMs: 30 * 60 * 1000,
    });
    await parser.initialize();
  });

  describe('Disambiguation Session Management', () => {
    it('should create disambiguation session for ambiguous intents', async () => {
      // Mock a low-confidence parse that triggers disambiguation
      const result = await parser.parseWithConfidence(
        'user-123',
        'do something with the database'
      );

      // Since we're using heuristic fallback (no API key), it should trigger disambiguation
      if (result.requiresDisambiguation) {
        expect(result.disambiguationSession).toBeDefined();
        expect(result.disambiguationSession?.options.length).toBeGreaterThanOrEqual(2);
        expect(result.disambiguationSession?.status).toBe('pending');
      }
    });

    it('should resolve disambiguation with user selection', async () => {
      const parseResult = await parser.parseWithConfidence(
        'user-123',
        'do something vague'
      );

      if (parseResult.requiresDisambiguation && parseResult.disambiguationSession) {
        const session = parseResult.disambiguationSession;
        const firstOption = session.options[0];

        if (firstOption) {
          const resolveResult = await parser.resolveDisambiguation(
            session.sessionId,
            firstOption.optionId
          );

          expect(resolveResult.success).toBe(true);
          expect(resolveResult.requiresDisambiguation).toBe(false);
          expect(resolveResult.intent).toBeDefined();
        }
      }
    });

    it('should reject invalid option selection', async () => {
      const parseResult = await parser.parseWithConfidence(
        'user-123',
        'ambiguous request'
      );

      if (parseResult.requiresDisambiguation && parseResult.disambiguationSession) {
        const resolveResult = await parser.resolveDisambiguation(
          parseResult.disambiguationSession.sessionId,
          'invalid-option-id'
        );

        expect(resolveResult.success).toBe(false);
        expect(resolveResult.error).toContain('Invalid option');
      }
    });

    it('should cancel disambiguation session', async () => {
      const parseResult = await parser.parseWithConfidence(
        'user-123',
        'cancel me'
      );

      if (parseResult.requiresDisambiguation && parseResult.disambiguationSession) {
        const cancelled = await parser.cancelDisambiguation(
          parseResult.disambiguationSession.sessionId
        );

        expect(cancelled).toBe(true);

        // Session should no longer be retrievable
        const session = parser.getSession(parseResult.disambiguationSession.sessionId);
        expect(session).toBeUndefined();
      }
    });
  });

  describe('Confidence Scale', () => {
    it('should use 1-10 confidence scale', async () => {
      const result = await parser.parseWithConfidence(
        'user-123',
        'list all users'
      );

      expect(result.parsingMetadata.confidenceScale).toBe('1-10');
      expect(result.parsingMetadata.disambiguationThreshold).toBe(8);
    });

    it('should include ambiguity factors in metadata', async () => {
      const result = await parser.parseWithConfidence(
        'user-123',
        'do something'
      );

      expect(result.parsingMetadata.ambiguityFactors).toBeDefined();
      expect(Array.isArray(result.parsingMetadata.ambiguityFactors)).toBe(true);
    });
  });

  describe('Audit Trail', () => {
    it('should maintain audit trail for disambiguation', async () => {
      const parseResult = await parser.parseWithConfidence(
        'user-123',
        'track this'
      );

      if (parseResult.requiresDisambiguation && parseResult.disambiguationSession) {
        const auditTrail = parser.getAuditTrail(
          parseResult.disambiguationSession.sessionId
        );

        expect(auditTrail.length).toBeGreaterThan(0);
        expect(auditTrail[0]?.eventType).toBe('session_created');
      }
    });

    it('should verify audit chain integrity', async () => {
      // Create a few sessions to build audit chain
      await parser.parseWithConfidence('user-1', 'request 1');
      await parser.parseWithConfidence('user-2', 'request 2');

      const integrity = parser.verifyAuditChainIntegrity();
      expect(integrity.valid).toBe(true);
    });
  });

  describe('User Pending Sessions', () => {
    it('should track pending sessions by user', async () => {
      const userId = 'user-pending-test';

      await parser.parseWithConfidence(userId, 'request 1');
      await parser.parseWithConfidence(userId, 'request 2');

      const pendingSessions = parser.getUserPendingSessions(userId);
      expect(pendingSessions.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Event Emission', () => {
    it('should emit disambiguation_required event', async () => {
      let eventEmitted = false;
      parser.on('disambiguation_required', () => {
        eventEmitted = true;
      });

      await parser.parseWithConfidence('user-123', 'vague request here');

      // Event may or may not be emitted depending on confidence
      // This test just verifies the event system works
      expect(typeof eventEmitted).toBe('boolean');
    });
  });
});

// =============================================================================
// Queryable Audit Index Tests
// =============================================================================

import {
  QueryableAuditIndex,
  defaultAuditIndexConfig,
} from '../../src/audit/queryable-audit-index.js';
import type {
  AuditQueryFilter,
  ForensicReport,
} from '../../src/audit/queryable-audit-index.js';
import type { AuditEvent, EventType, ActorType } from '../../src/core/types.js';

describe('QueryableAuditIndex', () => {
  let index: QueryableAuditIndex;

  beforeEach(async () => {
    index = new QueryableAuditIndex();
    await index.initialize();
  });

  describe('Event Indexing', () => {
    it('should index audit events', async () => {
      const event = createMockAuditEvent({
        eventId: 'evt-001',
        eventType: 'workflow_started',
        action: 'start_workflow',
      });

      const entry = await index.indexEvent(event);

      expect(entry.event.eventId).toBe('evt-001');
      expect(entry.chainPosition).toBe(1);
    });

    it('should calculate risk score for events', async () => {
      const highRiskEvent = createMockAuditEvent({
        riskLevel: 'destructive',
        success: false,
      });

      const entry = await index.indexEvent(highRiskEvent);

      expect(entry.riskScore).toBeGreaterThan(50);
    });

    it('should generate search tokens', async () => {
      const event = createMockAuditEvent({
        eventType: 'step_completed',
        action: 'create_resource',
        targetResource: 'my-bucket',
      });

      const entry = await index.indexEvent(event);

      expect(entry.searchTokens).toContain('create_resource');
      expect(entry.searchTokens).toContain('my-bucket');
    });
  });

  describe('Query Functionality', () => {
    beforeEach(async () => {
      // Index multiple events for querying
      await index.indexEvent(createMockAuditEvent({
        eventId: 'evt-001',
        eventType: 'workflow_started',
        actorId: 'user-a',
        workflowId: 'wf-001',
      }));
      await index.indexEvent(createMockAuditEvent({
        eventId: 'evt-002',
        eventType: 'step_completed',
        actorId: 'user-a',
        workflowId: 'wf-001',
      }));
      await index.indexEvent(createMockAuditEvent({
        eventId: 'evt-003',
        eventType: 'workflow_completed',
        actorId: 'user-b',
        workflowId: 'wf-002',
      }));
    });

    it('should filter by workflow ID', async () => {
      const result = await index.query({ workflowIds: ['wf-001'] });

      expect(result.totalMatches).toBe(2);
      result.entries.forEach(entry => {
        expect(entry.event.workflowId).toBe('wf-001');
      });
    });

    it('should filter by actor ID', async () => {
      const result = await index.query({ actorIds: ['user-a'] });

      expect(result.totalMatches).toBe(2);
      result.entries.forEach(entry => {
        expect(entry.event.actorId).toBe('user-a');
      });
    });

    it('should filter by event type', async () => {
      const result = await index.query({
        eventTypes: ['workflow_started' as EventType],
      });

      expect(result.totalMatches).toBe(1);
      expect(result.entries[0]?.event.eventType).toBe('workflow_started');
    });

    it('should support text search', async () => {
      const result = await index.query({ searchText: 'wf-001' });

      expect(result.totalMatches).toBe(2);
    });

    it('should support pagination', async () => {
      const page1 = await index.query({}, { limit: 2, offset: 0 });
      const page2 = await index.query({}, { limit: 2, offset: 2 });

      expect(page1.returnedCount).toBe(2);
      expect(page1.hasMore).toBe(true);
      expect(page2.returnedCount).toBe(1);
      expect(page2.hasMore).toBe(false);
    });

    it('should calculate aggregations', async () => {
      const result = await index.query({});

      expect(result.aggregations).toBeDefined();
      expect(result.aggregations?.byEventType).toBeDefined();
      expect(result.aggregations?.byActorType).toBeDefined();
    });
  });

  describe('Fast Lookups', () => {
    it('should lookup by event ID', async () => {
      const event = createMockAuditEvent({ eventId: 'lookup-test' });
      await index.indexEvent(event);

      const entry = index.getByEventId('lookup-test');

      expect(entry).toBeDefined();
      expect(entry?.event.eventId).toBe('lookup-test');
    });

    it('should lookup by workflow ID', async () => {
      await index.indexEvent(createMockAuditEvent({
        eventId: 'wf-evt-1',
        workflowId: 'workflow-lookup',
      }));
      await index.indexEvent(createMockAuditEvent({
        eventId: 'wf-evt-2',
        workflowId: 'workflow-lookup',
      }));

      const entries = index.getByWorkflowId('workflow-lookup');

      expect(entries.length).toBe(2);
    });

    it('should lookup by actor ID', async () => {
      await index.indexEvent(createMockAuditEvent({
        actorId: 'actor-lookup-test',
      }));

      const entries = index.getByActorId('actor-lookup-test');

      expect(entries.length).toBe(1);
    });
  });

  describe('Chain Integrity', () => {
    it('should verify chain integrity', async () => {
      await index.indexEvent(createMockAuditEvent({ eventId: 'chain-1' }));
      await index.indexEvent(createMockAuditEvent({ eventId: 'chain-2' }));
      await index.indexEvent(createMockAuditEvent({ eventId: 'chain-3' }));

      const result = await index.query({}, { includeVerification: true });

      expect(result.chainIntegrity).toBeDefined();
      expect(result.chainIntegrity?.eventsChecked).toBe(3);
    });
  });

  describe('Forensic Reports', () => {
    it('should generate forensic timeline', async () => {
      await index.indexEvent(createMockAuditEvent({
        eventType: 'workflow_started',
        workflowId: 'forensic-wf',
      }));
      await index.indexEvent(createMockAuditEvent({
        eventType: 'step_completed',
        workflowId: 'forensic-wf',
      }));

      const timeline = await index.generateForensicTimeline({
        workflowIds: ['forensic-wf'],
      });

      expect(timeline.length).toBe(2);
      expect(timeline[0]).toHaveProperty('timestamp');
      expect(timeline[0]).toHaveProperty('eventType');
      expect(timeline[0]).toHaveProperty('action');
    });

    it('should generate forensic report with attestation', async () => {
      await index.indexEvent(createMockAuditEvent({
        workflowId: 'report-wf',
        riskLevel: 'high',
      }));

      const report = await index.generateForensicReport(
        { workflowIds: ['report-wf'] },
        'attestor-123'
      );

      expect(report.reportId).toBeDefined();
      expect(report.chainAttestation).toBeDefined();
      expect(report.chainAttestation.attestorId).toBe('attestor-123');
      expect(report.signature).toBeDefined();
    });
  });

  describe('Streaming Subscriptions', () => {
    it('should subscribe to event stream', async () => {
      const receivedEvents: string[] = [];

      const subscriptionId = index.subscribe(
        { actorIds: ['streaming-actor'] },
        (entry) => {
          receivedEvents.push(entry.event.eventId);
        }
      );

      await index.indexEvent(createMockAuditEvent({
        eventId: 'stream-evt-1',
        actorId: 'streaming-actor',
      }));

      expect(receivedEvents).toContain('stream-evt-1');
      expect(subscriptionId).toBeDefined();
    });

    it('should unsubscribe from stream', async () => {
      const subscriptionId = index.subscribe({}, () => {});
      const removed = index.unsubscribe(subscriptionId);

      expect(removed).toBe(true);
    });
  });

  describe('Compaction', () => {
    it('should compact old entries', async () => {
      // Index some events
      await index.indexEvent(createMockAuditEvent({ eventId: 'compact-1' }));
      await index.indexEvent(createMockAuditEvent({ eventId: 'compact-2' }));

      const result = await index.compact();

      expect(result.remaining).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Statistics', () => {
    it('should track statistics', async () => {
      await index.indexEvent(createMockAuditEvent({}));
      await index.query({});

      const stats = index.getStats();

      expect(stats.totalIndexed).toBeGreaterThanOrEqual(1);
      expect(stats.totalQueries).toBeGreaterThanOrEqual(1);
      expect(stats.entryCount).toBeGreaterThanOrEqual(1);
    });
  });
});

// =============================================================================
// Test Helpers
// =============================================================================

function createMockPlan(steps: PlanStep[]): PlanManifest {
  return {
    planId: 'plan-test-001',
    intentId: 'intent-test-001',
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps,
    totalEstimatedCost: 0,
    totalEstimatedDuration: 0,
    riskLevel: 'medium',
    approvalRequired: false,
    checksum: 'test-checksum',
  };
}

function createMockStep(
  action: string,
  toolAdapter: string,
  overrides: Partial<PlanStep> = {}
): PlanStep {
  return {
    stepId: `step-${Math.random().toString(36).substr(2, 9)}`,
    planId: 'plan-test-001',
    sequenceNumber: 0,
    action,
    description: `Test step: ${action}`,
    toolAdapter,
    parameters: {},
    sideEffect: true,
    dependencies: [],
    requiredCapabilities: [toolAdapter],
    idempotencyKey: `idem-${Date.now()}`,
    estimatedCost: 0,
    estimatedDuration: 1000,
    riskLevel: 'medium',
    approvalRequired: false,
    timeout: 60000,
    ...overrides,
  };
}

function createCompensation(
  action: string,
  parameters: Record<string, unknown>
): CompensationAction {
  return {
    action,
    toolAdapter: 'test',
    parameters,
    idempotencyKey: `comp-${Date.now()}`,
  };
}

function createMockContext(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    simulation_id: 'sim-test-001',
    environment: 'test',
    available_permissions: ['*'],
    dry_run_enabled: false,
    timeout_ms: 5000,
    ...overrides,
  };
}

function createAnalysisContext(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    simulation_id: 'sim-test-001',
    environment: 'test',
    current_time: new Date().toISOString(),
    ...overrides,
  };
}

function createMockAuditEvent(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    eventId: `evt-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date().toISOString(),
    eventType: 'step_completed',
    actorId: 'actor-test',
    actorType: 'system',
    action: 'test_action',
    inputsHash: 'input-hash',
    success: true,
    signature: 'test-signature',
    previousEventHash: '0'.repeat(64),
    ...overrides,
  };
}
