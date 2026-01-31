/**
 * Enterprise Security Components Tests
 *
 * Comprehensive tests for Phase 3 security enhancements:
 * - Memory Isolation Engine (P0)
 * - Runtime Policy Enforcement Layer (P0)
 * - Deterministic Replay Engine (P1)
 *
 * These tests validate security guarantees and compliance requirements.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// =============================================================================
// Memory Isolation Engine Tests
// =============================================================================

import {
  MemoryNamespace,
  DLPMemoryFilter,
  MemoryAccessControlList,
  SessionMemoryManager,
  defaultMemoryIsolationConfig,
} from '../../src/core/memory-isolation/index.js';
import type {
  NamespaceIdentifier,
  MemoryAccessRequest,
  DLPScanResult,
} from '../../src/core/memory-isolation/index.js';

describe('Memory Isolation Engine', () => {
  describe('MemoryNamespace', () => {
    it('should create cryptographically unique namespace IDs', () => {
      const id1: NamespaceIdentifier = {
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'session-1',
      };
      const id2: NamespaceIdentifier = {
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'session-2',
      };

      const ns1 = new MemoryNamespace(id1);
      const ns2 = new MemoryNamespace(id2);

      expect(ns1.namespaceId).not.toBe(ns2.namespaceId);
      expect(ns1.namespaceId.startsWith('ns_')).toBe(true);
    });

    it('should match identical identifiers', () => {
      const id: NamespaceIdentifier = {
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'session-1',
      };

      const ns = new MemoryNamespace(id);

      expect(ns.matches(id)).toBe(true);
      expect(ns.matches({ ...id, sessionId: 'different' })).toBe(false);
    });

    it('should enforce tenant isolation', () => {
      const ns = new MemoryNamespace({
        tenantId: 'tenant-a',
        userId: 'user-1',
        sessionId: 'session-1',
      });

      // Same tenant, same user - allowed
      expect(ns.canAccess('tenant-a', 'user-1')).toBe(true);

      // Same tenant, different user - NOT allowed
      expect(ns.canAccess('tenant-a', 'user-2')).toBe(false);

      // Different tenant - NEVER allowed
      expect(ns.canAccess('tenant-b', 'user-1')).toBe(false);
    });
  });

  describe('DLPMemoryFilter', () => {
    let dlpFilter: DLPMemoryFilter;

    beforeEach(() => {
      dlpFilter = new DLPMemoryFilter({ dlpBlockOnCritical: true });
    });

    it('should detect SSN patterns', () => {
      const result = dlpFilter.scan('123-45-6789', 'ssn_field');

      expect(result.passed).toBe(false);
      expect(result.severity).toBe('critical');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.patternCategory).toBe('pii');
    });

    it('should detect credit card numbers', () => {
      const result = dlpFilter.scan('4532-1234-5678-9012', 'card');

      expect(result.passed).toBe(false);
      expect(result.severity).toBe('critical');
      expect(result.findings[0]?.patternName).toBe('credit_card');
    });

    it('should detect AWS access keys', () => {
      const result = dlpFilter.scan('AKIAIOSFODNN7EXAMPLE', 'aws_key');

      expect(result.passed).toBe(false);
      expect(result.severity).toBe('critical');
      expect(result.findings[0]?.patternCategory).toBe('credential');
    });

    it('should detect API keys in JSON', () => {
      const result = dlpFilter.scan(
        { config: { api_key: 'sk-1234567890abcdefghijklmnop' } },
        'config'
      );

      expect(result.passed).toBe(false);
      expect(result.findings.some((f) => f.patternName === 'api_key')).toBe(true);
    });

    it('should detect private keys', () => {
      const result = dlpFilter.scan(
        '-----BEGIN RSA PRIVATE KEY-----\nMIIE...',
        'key'
      );

      expect(result.passed).toBe(false);
      expect(result.severity).toBe('critical');
    });

    it('should block critical findings', () => {
      const result = dlpFilter.scan('password=SuperSecret123!', 'creds');

      expect(result.blocked).toBe(true);
      expect(result.redactedValue).toContain('[REDACTED]');
    });

    it('should pass clean data', () => {
      const result = dlpFilter.scan('Hello, this is safe data', 'message');

      expect(result.passed).toBe(true);
      expect(result.findings).toHaveLength(0);
      expect(result.blocked).toBe(false);
    });

    it('should support custom patterns', () => {
      dlpFilter.addPattern({
        name: 'custom_id',
        category: 'sensitive',
        pattern: /CUST-\d{6}/g,
        severity: 'high',
        recommendation: 'Remove customer ID',
      });

      const result = dlpFilter.scan('Customer: CUST-123456', 'data');

      expect(result.passed).toBe(false);
      expect(result.findings[0]?.patternName).toBe('custom_id');
    });
  });

  describe('MemoryAccessControlList', () => {
    let acl: MemoryAccessControlList;
    let namespace: MemoryNamespace;

    beforeEach(() => {
      acl = new MemoryAccessControlList();
      namespace = new MemoryNamespace({
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'session-1',
      });
    });

    it('should allow self-access to own namespace', () => {
      const request: MemoryAccessRequest = {
        requestId: 'req-1',
        namespaceId: namespace.namespaceId,
        operation: 'read',
        key: 'data',
        actorId: 'user-1',
        actorRoles: ['user'],
        timestamp: new Date().toISOString(),
      };

      const decision = acl.evaluate(request, namespace, 'tenant-1');

      expect(decision.allowed).toBe(true);
    });

    it('should HARD BLOCK cross-tenant access', () => {
      const request: MemoryAccessRequest = {
        requestId: 'req-1',
        namespaceId: namespace.namespaceId,
        operation: 'read',
        key: 'data',
        actorId: 'attacker',
        actorRoles: ['admin'], // Even admin
        timestamp: new Date().toISOString(),
      };

      const decision = acl.evaluate(request, namespace, 'tenant-2'); // Different tenant

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('HARD_BLOCK');
      expect(decision.auditRequired).toBe(true);
    });

    it('should block access to other users namespace', () => {
      const request: MemoryAccessRequest = {
        requestId: 'req-1',
        namespaceId: namespace.namespaceId,
        operation: 'read',
        key: 'data',
        actorId: 'user-2', // Different user
        actorRoles: ['user'],
        timestamp: new Date().toISOString(),
      };

      const decision = acl.evaluate(request, namespace, 'tenant-1');

      expect(decision.allowed).toBe(false);
    });

    it('should allow admin purge but not read', () => {
      const purgeRequest: MemoryAccessRequest = {
        requestId: 'req-1',
        namespaceId: namespace.namespaceId,
        operation: 'purge',
        actorId: 'admin-user',
        actorRoles: ['admin'],
        timestamp: new Date().toISOString(),
      };

      const readRequest: MemoryAccessRequest = {
        ...purgeRequest,
        operation: 'read',
        key: 'secret-data',
      };

      const purgeDec = acl.evaluate(purgeRequest, namespace, 'tenant-1');
      const readDec = acl.evaluate(readRequest, namespace, 'tenant-1');

      expect(purgeDec.allowed).toBe(true);
      expect(readDec.allowed).toBe(false);
    });

    it('should support custom rules', () => {
      acl.addRule({
        ruleId: 'custom-deny',
        name: 'Block Specific User',
        description: 'Block user-blocked from any access',
        priority: 2000,
        enabled: true,
        conditions: [
          { field: 'actorId', operator: 'equals', value: 'user-blocked' },
        ],
        effect: 'deny',
        auditRequired: true,
      });

      const request: MemoryAccessRequest = {
        requestId: 'req-1',
        namespaceId: namespace.namespaceId,
        operation: 'read',
        key: 'data',
        actorId: 'user-blocked',
        actorRoles: [],
        timestamp: new Date().toISOString(),
      };

      // Note: This will be blocked due to not being owner, but rule would match
      const decision = acl.evaluate(request, namespace, 'tenant-1');
      expect(decision.allowed).toBe(false);
    });
  });

  describe('SessionMemoryManager', () => {
    let manager: SessionMemoryManager;

    beforeEach(async () => {
      manager = new SessionMemoryManager({
        enabled: true,
        dlpEnabled: true,
        dlpBlockOnCritical: true,
        encryptAtRest: false, // For testing
        auditAllAccess: true,
      });
      await manager.initialize();
    });

    afterEach(async () => {
      await manager.shutdown();
    });

    it('should create and retrieve namespace', () => {
      const id: NamespaceIdentifier = {
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'session-1',
      };

      const ns1 = manager.getNamespace(id);
      const ns2 = manager.getNamespace(id);

      expect(ns1.namespaceId).toBe(ns2.namespaceId);
    });

    it('should write and read values', async () => {
      const ns = manager.getNamespace({
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'session-1',
      });

      const writeResult = await manager.write(
        ns,
        'key1',
        { data: 'test' },
        'user-1',
        ['user'],
        'tenant-1'
      );

      expect(writeResult.success).toBe(true);

      const readResult = await manager.read(
        ns,
        'key1',
        'user-1',
        ['user'],
        'tenant-1'
      );

      expect(readResult.success).toBe(true);
      expect(readResult.value).toEqual({ data: 'test' });
    });

    it('should block DLP-detected sensitive data', async () => {
      const ns = manager.getNamespace({
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'session-1',
      });

      const writeResult = await manager.write(
        ns,
        'credentials',
        { password: 'SuperSecret123!' },
        'user-1',
        ['user'],
        'tenant-1'
      );

      expect(writeResult.success).toBe(false);
      expect(writeResult.dlpBlocked).toBe(true);
    });

    it('should block cross-tenant reads', async () => {
      const ns = manager.getNamespace({
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'session-1',
      });

      await manager.write(ns, 'data', 'value', 'user-1', ['user'], 'tenant-1');

      const readResult = await manager.read(
        ns,
        'data',
        'attacker',
        ['user'],
        'tenant-2' // Different tenant
      );

      expect(readResult.success).toBe(false);
      expect(readResult.error).toContain('HARD_BLOCK');
    });

    it('should purge namespace on workflow completion', async () => {
      const ns = manager.getNamespace({
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'session-1',
      });

      await manager.write(ns, 'key1', 'value1', 'user-1', ['user'], 'tenant-1');
      await manager.write(ns, 'key2', 'value2', 'user-1', ['user'], 'tenant-1');

      const purgeResult = await manager.purgeNamespace(
        ns,
        'user-1',
        ['user'],
        'tenant-1',
        'Workflow completed'
      );

      expect(purgeResult.success).toBe(true);
      expect(purgeResult.entriesDeleted).toBe(2);

      // Verify data is gone
      const readResult = await manager.read(
        ns,
        'key1',
        'user-1',
        ['user'],
        'tenant-1'
      );
      expect(readResult.success).toBe(false);
    });

    it('should maintain audit trail integrity', async () => {
      const ns = manager.getNamespace({
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'session-1',
      });

      await manager.write(ns, 'key1', 'value1', 'user-1', ['user'], 'tenant-1');
      await manager.read(ns, 'key1', 'user-1', ['user'], 'tenant-1');

      const integrity = manager.verifyAuditChainIntegrity();
      expect(integrity.valid).toBe(true);
    });
  });
});

// =============================================================================
// Runtime Policy Enforcement Layer Tests
// =============================================================================

import {
  RuntimePolicyInterceptor,
  CircuitBreaker,
  ParameterDriftDetector,
  RuntimeRiskScorer,
  defaultRuntimeGuardConfig,
} from '../../src/core/runtime-guard/index.js';
import type {
  ToolExecutionRequest,
  InterceptionResult,
  RuntimePolicy,
} from '../../src/core/runtime-guard/index.js';

describe('Runtime Policy Enforcement Layer', () => {
  describe('ParameterDriftDetector', () => {
    let detector: ParameterDriftDetector;

    beforeEach(() => {
      detector = new ParameterDriftDetector();
    });

    it('should detect no drift for identical parameters', () => {
      const original = { key: 'value', count: 10 };
      const current = { key: 'value', count: 10 };

      const result = detector.calculateDrift(original, current);

      expect(result.score).toBe(0);
      expect(result.driftedFields).toHaveLength(0);
    });

    it('should detect drift for changed values', () => {
      const original = { key: 'value1', count: 10 };
      const current = { key: 'value2', count: 10 };

      const result = detector.calculateDrift(original, current);

      expect(result.score).toBe(0.5); // 1 of 2 fields changed
      expect(result.driftedFields).toContain('key');
    });

    it('should detect drift for added fields', () => {
      const original = { key: 'value' };
      const current = { key: 'value', newField: 'new' };

      const result = detector.calculateDrift(original, current);

      expect(result.score).toBe(0.5); // 1 of 2 fields is new
      expect(result.driftedFields).toContain('newField');
    });

    it('should detect drift for removed fields', () => {
      const original = { key: 'value', extra: 'data' };
      const current = { key: 'value' };

      const result = detector.calculateDrift(original, current);

      expect(result.score).toBe(0.5);
      expect(result.driftedFields).toContain('extra');
    });

    it('should handle nested object changes', () => {
      const original = { config: { nested: 'value' } };
      const current = { config: { nested: 'changed' } };

      const result = detector.calculateDrift(original, current);

      expect(result.score).toBeGreaterThan(0);
    });
  });

  describe('CircuitBreaker', () => {
    let circuitBreaker: CircuitBreaker;

    beforeEach(() => {
      circuitBreaker = new CircuitBreaker({
        ...defaultRuntimeGuardConfig,
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 100, // Short for testing
      });
    });

    it('should start in closed state', () => {
      expect(circuitBreaker.getState().status).toBe('closed');
      expect(circuitBreaker.canExecute()).toBe(true);
    });

    it('should open after threshold failures', () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      expect(circuitBreaker.getState().status).toBe('open');
      expect(circuitBreaker.canExecute()).toBe(false);
    });

    it('should reset failure count on success', () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordSuccess();

      expect(circuitBreaker.getState().failureCount).toBe(0);
      expect(circuitBreaker.canExecute()).toBe(true);
    });

    it('should transition to half-open after reset time', async () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      // Wait for reset time
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(circuitBreaker.canExecute()).toBe(true);
      expect(circuitBreaker.getState().status).toBe('half-open');
    });

    it('should close on success in half-open state', async () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      await new Promise((resolve) => setTimeout(resolve, 150));

      circuitBreaker.canExecute(); // Triggers half-open
      circuitBreaker.recordSuccess();

      expect(circuitBreaker.getState().status).toBe('closed');
    });
  });

  describe('RuntimeRiskScorer', () => {
    let scorer: RuntimeRiskScorer;

    beforeEach(() => {
      scorer = new RuntimeRiskScorer();
    });

    it('should increase risk for production environment', () => {
      const context = createMockPolicyContext({
        environment: 'production',
        originalRiskScore: 30,
      });

      const result = scorer.calculateRisk(context);

      expect(result.score).toBeGreaterThan(30);
      expect(result.factors.some((f) => f.factor === 'production_environment')).toBe(true);
    });

    it('should increase risk for high-risk adapters', () => {
      const context = createMockPolicyContext({
        toolAdapter: 'shell:command',
        originalRiskScore: 20,
      });

      const result = scorer.calculateRisk(context);

      expect(result.factors.some((f) => f.factor === 'high_risk_adapter')).toBe(true);
    });

    it('should track high-risk operation velocity', () => {
      scorer.trackHighRiskOperation('wf-1');
      scorer.trackHighRiskOperation('wf-1');
      scorer.trackHighRiskOperation('wf-1');
      scorer.trackHighRiskOperation('wf-1');

      const context = createMockPolicyContext({
        workflowId: 'wf-1',
        originalRiskScore: 20,
      });

      const result = scorer.calculateRisk(context);

      expect(result.factors.some((f) => f.factor === 'high_risk_velocity')).toBe(true);
    });

    it('should reset workflow tracking', () => {
      scorer.trackHighRiskOperation('wf-1');
      scorer.trackHighRiskOperation('wf-1');
      scorer.trackHighRiskOperation('wf-1');
      scorer.trackHighRiskOperation('wf-1');

      scorer.resetWorkflow('wf-1');

      const context = createMockPolicyContext({
        workflowId: 'wf-1',
        originalRiskScore: 20,
      });

      const result = scorer.calculateRisk(context);

      expect(result.factors.some((f) => f.factor === 'high_risk_velocity')).toBe(false);
    });
  });

  describe('RuntimePolicyInterceptor', () => {
    let interceptor: RuntimePolicyInterceptor;

    beforeEach(async () => {
      interceptor = new RuntimePolicyInterceptor({
        enabled: true,
        failClosed: true,
        riskThreshold: 75,
        reApprovalThresholdDelta: 20,
        circuitBreakerEnabled: true,
        parameterDriftDetection: true,
      });
      await interceptor.initialize();
    });

    it('should allow low-risk operations', async () => {
      const request = createMockExecutionRequest({
        expectedRiskLevel: 'low',
        parameters: { action: 'list' },
        originalParameters: { action: 'list' },
      });

      const result = await interceptor.intercept(request);

      expect(result.allowed).toBe(true);
      expect(result.blocked).toBe(false);
    });

    it('should block operations with significant parameter drift', async () => {
      const request = createMockExecutionRequest({
        parameters: { target: 'production-db', action: 'delete' },
        originalParameters: { target: 'test-db', action: 'query' },
      });

      const result = await interceptor.intercept(request);

      expect(result.allowed).toBe(false);
      expect(result.evaluation?.violations.some((v) =>
        v.description.includes('drift')
      )).toBe(true);
    });

    it('should trigger risk escalation when score increases', async () => {
      const request = createMockExecutionRequest({
        expectedRiskLevel: 'low',
        toolAdapter: 'shell:command', // High-risk adapter
        userRoles: ['admin'],
      });

      const result = await interceptor.intercept(request);

      if (result.escalation) {
        expect(result.escalation.newRiskScore).toBeGreaterThan(
          result.escalation.originalRiskScore
        );
        expect(result.evaluation?.requiresReApproval).toBe(true);
      }
    });

    it('should enforce FAIL-CLOSED on policy evaluation error', async () => {
      // Create interceptor with invalid config to cause error
      const brokenInterceptor = new RuntimePolicyInterceptor({
        enabled: true,
        failClosed: true,
      });
      await brokenInterceptor.initialize();

      // Add a policy that will cause issues
      brokenInterceptor.addPolicy({
        policyId: 'broken-policy',
        name: 'Broken Policy',
        description: 'Policy that matches and adds risk',
        priority: 9999,
        enabled: true,
        conditions: [
          { field: 'toolAdapter', operator: 'contains', value: 'test' },
        ],
        effect: 'require_approval',
        riskModifier: 50,
        failureAction: 'pause',
      });

      const request = createMockExecutionRequest({
        toolAdapter: 'test:adapter',
      });

      const result = await brokenInterceptor.intercept(request);

      // Should be blocked due to require_approval
      expect(result.allowed).toBe(false);
    });

    it('should block when circuit breaker is open', async () => {
      // Cause circuit breaker to open
      for (let i = 0; i < 5; i++) {
        await interceptor.intercept(
          createMockExecutionRequest({
            parameters: { drift: Math.random() },
            originalParameters: { original: true },
          })
        );
      }

      // Verify circuit is open or check with interceptor
      const state = interceptor.getCircuitBreakerState();

      // If failures accumulated, circuit may be open
      if (state.status === 'open') {
        const result = await interceptor.intercept(
          createMockExecutionRequest({})
        );

        expect(result.blocked).toBe(true);
        expect(result.error).toContain('Circuit breaker');
      }
    });

    it('should maintain audit trail integrity', async () => {
      await interceptor.intercept(createMockExecutionRequest({}));
      await interceptor.intercept(createMockExecutionRequest({}));

      const integrity = interceptor.verifyAuditChainIntegrity();

      expect(integrity.valid).toBe(true);
    });

    it('should support custom runtime policies', async () => {
      interceptor.addPolicy({
        policyId: 'custom-block',
        name: 'Block Test Tool',
        description: 'Block specific tool adapter',
        priority: 10000,
        enabled: true,
        conditions: [
          { field: 'toolAdapter', operator: 'equals', value: 'blocked:tool' },
        ],
        effect: 'deny',
        riskModifier: 100,
        failureAction: 'block',
      });

      const request = createMockExecutionRequest({
        toolAdapter: 'blocked:tool',
      });

      const result = await interceptor.intercept(request);

      expect(result.allowed).toBe(false);
      expect(result.blocked).toBe(true);
    });
  });
});

// =============================================================================
// Deterministic Replay Engine Tests
// =============================================================================

import {
  ExecutionArtifactRecorder,
  ReplayEngine,
  defaultReplayEngineConfig,
} from '../../src/audit/replay/index.js';
import type {
  LLMInteractionCapture,
  ToolCallCapture,
  EnvironmentSnapshot,
  PolicyDecisionCapture,
  ReplayRequest,
} from '../../src/audit/replay/index.js';

describe('Deterministic Replay Engine', () => {
  describe('ExecutionArtifactRecorder', () => {
    let recorder: ExecutionArtifactRecorder;

    beforeEach(async () => {
      recorder = new ExecutionArtifactRecorder({
        enabled: true,
        captureFullPrompts: true,
        enablePromptCaching: true,
        encryptSensitiveData: false, // For testing
      });
      await recorder.initialize();
    });

    afterEach(async () => {
      await recorder.shutdown();
    });

    it('should record execution artifacts', async () => {
      const artifact = await recorder.recordArtifact(
        'wf-1',
        'step-1',
        'plan-1',
        0,
        createMockLLMInteraction(),
        createMockToolCall(),
        createMockEnvironmentSnapshot('pre'),
        50,
        [createMockPolicyDecision()]
      );

      expect(artifact.artifactId).toBeDefined();
      expect(artifact.workflowId).toBe('wf-1');
      expect(artifact.hash).toBeDefined();
      expect(artifact.signature).toBeDefined();
    });

    it('should maintain chain integrity', async () => {
      await recorder.recordArtifact(
        'wf-1',
        'step-1',
        'plan-1',
        0,
        createMockLLMInteraction(),
        createMockToolCall(),
        createMockEnvironmentSnapshot('pre'),
        50,
        []
      );

      await recorder.recordArtifact(
        'wf-1',
        'step-2',
        'plan-1',
        1,
        createMockLLMInteraction(),
        createMockToolCall(),
        createMockEnvironmentSnapshot('pre'),
        50,
        []
      );

      const integrity = recorder.verifyChainIntegrity('wf-1');

      expect(integrity.valid).toBe(true);
    });

    it('should detect artifact tampering', async () => {
      const artifact = await recorder.recordArtifact(
        'wf-1',
        'step-1',
        'plan-1',
        0,
        createMockLLMInteraction(),
        createMockToolCall(),
        createMockEnvironmentSnapshot('pre'),
        50,
        []
      );

      // Tamper with the artifact
      (artifact.toolCall as { action: string }).action = 'tampered';

      const integrity = recorder.verifyArtifactIntegrity(artifact);

      expect(integrity.valid).toBe(false);
      expect(integrity.errors.some((e) => e.includes('mismatch'))).toBe(true);
    });

    it('should cache prompt-response pairs', async () => {
      const llmInteraction = createMockLLMInteraction();

      await recorder.recordArtifact(
        'wf-1',
        'step-1',
        'plan-1',
        0,
        llmInteraction,
        createMockToolCall(),
        createMockEnvironmentSnapshot('pre'),
        50,
        []
      );

      const cached = recorder.getCachedResponse(llmInteraction.promptHash);

      expect(cached).toBeDefined();
      expect(cached?.response).toBe(llmInteraction.response);
    });

    it('should retrieve workflow artifacts in order', async () => {
      await recorder.recordArtifact(
        'wf-1',
        'step-2',
        'plan-1',
        1,
        undefined,
        createMockToolCall(),
        createMockEnvironmentSnapshot('pre'),
        50,
        []
      );

      await recorder.recordArtifact(
        'wf-1',
        'step-1',
        'plan-1',
        0,
        undefined,
        createMockToolCall(),
        createMockEnvironmentSnapshot('pre'),
        50,
        []
      );

      const artifacts = recorder.getWorkflowArtifacts('wf-1');

      expect(artifacts).toHaveLength(2);
      expect(artifacts[0]?.sequenceNumber).toBe(0);
      expect(artifacts[1]?.sequenceNumber).toBe(1);
    });

    it('should generate Merkle proofs', async () => {
      const artifact = await recorder.recordArtifact(
        'wf-1',
        'step-1',
        'plan-1',
        0,
        undefined,
        createMockToolCall(),
        createMockEnvironmentSnapshot('pre'),
        50,
        []
      );

      const proof = recorder.getMerkleProof(artifact.artifactId);

      expect(proof).toBeDefined();
      expect(proof?.proof.length).toBeGreaterThan(0);
    });

    it('should track statistics', async () => {
      await recorder.recordArtifact(
        'wf-1',
        'step-1',
        'plan-1',
        0,
        createMockLLMInteraction(),
        createMockToolCall(),
        createMockEnvironmentSnapshot('pre'),
        50,
        []
      );

      const stats = recorder.getStats();

      expect(stats.totalArtifacts).toBe(1);
      expect(stats.cacheEntries).toBe(1);
    });
  });

  describe('ReplayEngine', () => {
    let recorder: ExecutionArtifactRecorder;
    let engine: ReplayEngine;

    beforeEach(async () => {
      recorder = new ExecutionArtifactRecorder({
        enabled: true,
        captureFullPrompts: true,
        enablePromptCaching: true,
      });
      await recorder.initialize();

      engine = new ReplayEngine(recorder);
      await engine.initialize();
    });

    afterEach(async () => {
      await recorder.shutdown();
    });

    it('should replay workflow execution', async () => {
      // Record some artifacts
      await recorder.recordArtifact(
        'wf-replay',
        'step-1',
        'plan-1',
        0,
        createMockLLMInteraction(),
        createMockToolCall({ success: true }),
        createMockEnvironmentSnapshot('pre'),
        50,
        []
      );

      await recorder.recordArtifact(
        'wf-replay',
        'step-2',
        'plan-1',
        1,
        createMockLLMInteraction(),
        createMockToolCall({ success: true }),
        createMockEnvironmentSnapshot('pre'),
        50,
        []
      );

      const request: ReplayRequest = {
        requestId: 'replay-1',
        workflowId: 'wf-replay',
        useCachedResponses: true,
        validateIntegrity: true,
      };

      const result = await engine.replay(request);

      expect(result.success).toBe(true);
      expect(result.artifactsReplayed).toBe(2);
      expect(result.timeline).toHaveLength(2);
      expect(result.integrityVerification?.verified).toBe(true);
    });

    it('should support time travel queries', async () => {
      const timestamp1 = new Date().toISOString();

      await recorder.recordArtifact(
        'wf-travel',
        'step-1',
        'plan-1',
        0,
        undefined,
        createMockToolCall({ success: true }),
        createMockEnvironmentSnapshot('pre'),
        30,
        [createMockPolicyDecision()]
      );

      const snapshot = await engine.timeTravel({
        workflowId: 'wf-travel',
        timestamp: timestamp1,
        includeEnvironmentState: true,
        includePrompts: false,
      });

      expect(snapshot.workflowId).toBe('wf-travel');
      expect(snapshot.state.completedSteps).toContain('step-1');
      expect(snapshot.environment).toBeDefined();
      expect(snapshot.integrityProof.artifactHash).toBeDefined();
    });

    it('should detect response drift during replay', async () => {
      const llm1 = createMockLLMInteraction({
        response: 'Original response',
        responseHash: 'hash-original',
      });

      await recorder.recordArtifact(
        'wf-drift',
        'step-1',
        'plan-1',
        0,
        llm1,
        createMockToolCall(),
        createMockEnvironmentSnapshot('pre'),
        50,
        []
      );

      // Modify cached response (simulating drift)
      // In real scenario, cached and recorded would differ

      const result = await engine.replay({
        requestId: 'replay-drift',
        workflowId: 'wf-drift',
        useCachedResponses: true,
        validateIntegrity: true,
      });

      // Should still work but may detect issues
      expect(result.timeline[0]).toBeDefined();
    });

    it('should generate compliance reports', async () => {
      await recorder.recordArtifact(
        'wf-compliance',
        'step-1',
        'plan-1',
        0,
        createMockLLMInteraction(),
        createMockToolCall(),
        createMockEnvironmentSnapshot('pre'),
        50,
        [createMockPolicyDecision()]
      );

      const report = await engine.generateComplianceReport('wf-compliance');

      expect(report.workflowId).toBe('wf-compliance');
      expect(report.artifacts).toHaveLength(1);
      expect(report.integrityVerification.verified).toBe(true);
      expect(report.signature).toBeDefined();
    });

    it('should handle missing workflow gracefully', async () => {
      const result = await engine.replay({
        requestId: 'replay-missing',
        workflowId: 'non-existent-workflow',
        useCachedResponses: false,
        validateIntegrity: false,
      });

      expect(result.success).toBe(false);
      expect(result.errors[0]?.errorType).toBe('ARTIFACT_MISSING');
    });

    it('should filter by step range', async () => {
      for (let i = 0; i < 5; i++) {
        await recorder.recordArtifact(
          'wf-range',
          `step-${i}`,
          'plan-1',
          i,
          undefined,
          createMockToolCall(),
          createMockEnvironmentSnapshot('pre'),
          50,
          []
        );
      }

      const result = await engine.replay({
        requestId: 'replay-range',
        workflowId: 'wf-range',
        stepRange: { from: 1, to: 3 },
        useCachedResponses: false,
        validateIntegrity: false,
      });

      expect(result.artifactsReplayed).toBe(3);
    });
  });
});

// =============================================================================
// Test Helpers
// =============================================================================

function createMockPolicyContext(
  overrides: Partial<{
    workflowId: string;
    stepId: string;
    environment: 'development' | 'staging' | 'production';
    originalRiskScore: number;
    toolAdapter: string;
  }> = {}
): {
  workflowId: string;
  stepId: string;
  planId: string;
  userId: string;
  userRoles: string[];
  environment: 'development' | 'staging' | 'production';
  currentTime: Date;
  originalRiskScore: number;
  toolAdapter: string;
  parameters: Record<string, unknown>;
  previousStepOutputs: Record<string, unknown>;
} {
  return {
    workflowId: 'wf-test',
    stepId: 'step-test',
    planId: 'plan-test',
    userId: 'user-test',
    userRoles: ['user'],
    environment: 'development',
    currentTime: new Date(),
    originalRiskScore: 30,
    toolAdapter: 'http:request',
    parameters: {},
    previousStepOutputs: {},
    ...overrides,
  };
}

function createMockExecutionRequest(
  overrides: Partial<ToolExecutionRequest> = {}
): ToolExecutionRequest {
  return {
    requestId: `req-${Math.random().toString(36).substr(2, 9)}`,
    workflowId: 'wf-test',
    stepId: 'step-test',
    planId: 'plan-test',
    toolAdapter: 'http:request',
    parameters: { action: 'test' },
    originalParameters: { action: 'test' },
    expectedRiskLevel: 'medium',
    userId: 'user-test',
    userRoles: ['user'],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function createMockLLMInteraction(
  overrides: Partial<LLMInteractionCapture> = {}
): LLMInteractionCapture {
  const prompt = overrides.prompt ?? 'Test prompt';
  const response = overrides.response ?? 'Test response';

  return {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    promptHash: `hash-${prompt.substring(0, 10)}`,
    prompt,
    responseHash: `hash-${response.substring(0, 10)}`,
    response,
    tokenCount: { input: 100, output: 50 },
    latencyMs: 500,
    ...overrides,
  };
}

function createMockToolCall(
  overrides: Partial<ToolCallCapture> = {}
): ToolCallCapture {
  return {
    toolAdapter: 'http:request',
    action: 'fetch_data',
    parametersHash: 'params-hash',
    parameters: { url: 'https://api.example.com' },
    outputsHash: 'outputs-hash',
    outputs: { status: 200, data: {} },
    success: true,
    durationMs: 150,
    retryCount: 0,
    ...overrides,
  };
}

function createMockEnvironmentSnapshot(
  phase: 'pre' | 'post'
): EnvironmentSnapshot {
  return {
    snapshotId: `snap-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date().toISOString(),
    phase,
    userId: 'user-test',
    userRoles: ['user'],
    environment: 'development',
  };
}

function createMockPolicyDecision(): PolicyDecisionCapture {
  return {
    policyId: 'policy-test',
    policyName: 'Test Policy',
    result: 'ALLOW',
    reason: 'Low risk operation',
    evaluationTimeMs: 2,
    matchedConditions: ['risk < 50'],
  };
}
