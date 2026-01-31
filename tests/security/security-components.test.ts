/**
 * AEGIS-T2A Security Components Test Suite
 *
 * Comprehensive tests for:
 * - Intent Validation Sandbox
 * - Adversarial Simulation Engine
 * - Schema-Aware DLP Filter
 * - Compensation Verification Engine
 * - Dynamic Risk Scoring
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  IntentValidationSandbox,
  initializeIntentSandbox,
  SandboxContext,
  defaultSandboxConfig,
} from '../../src/gateway/intent-sandbox';
import {
  AdversarialSimulator,
  initializeAdversarialSimulator,
  defaultAdversarialConfig,
} from '../../src/simulation/adversarial-simulator';
import {
  DLPFilter,
  initializeDLPFilter,
  defaultDLPConfig,
} from '../../src/executor/dlp-filter';
import {
  CompensationVerifier,
  initializeCompensationVerifier,
  defaultVerifierConfig,
} from '../../src/workflow/compensation-verifier';
import {
  DynamicRiskScorer,
  initializeDynamicRiskScorer,
  defaultRiskScorerConfig,
} from '../../src/simulation/dynamic-risk-scorer';
import { TypedIntent, PlanManifest, PlanStep, Sensitivity } from '../../src/core/types';

// =============================================================================
// Test Fixtures
// =============================================================================

const createTestIntent = (overrides: Partial<TypedIntent> = {}): TypedIntent => ({
  intentId: 'test-intent-1',
  userId: 'user-1',
  timestamp: new Date().toISOString(),
  nlText: 'Delete all production database records',
  actionType: 'delete',
  riskLevel: 'high',
  sensitivity: Sensitivity.CONFIDENTIAL,
  budget: { currency: 'USD', limit: 100, spent: 0 },
  requiredCapabilities: ['database:write', 'database:delete'],
  sideEffect: true,
  idempotencyKey: 'idem-1',
  policyStatus: 'pending',
  approvalRequired: true,
  confidence: 0.85,
  metadata: {
    targetResources: ['prod-db-1', 'prod-db-2'],
    parameters: { table: 'users', condition: 'all' },
  },
  ...overrides,
});

const createTestStep = (overrides: Partial<PlanStep> = {}): PlanStep => ({
  stepId: 'step-1',
  planId: 'plan-1',
  sequenceNumber: 1,
  action: 'delete_records',
  description: 'Delete all records from table',
  toolAdapter: 'database:delete',
  parameters: { table: 'users', where: '*' },
  sideEffect: true,
  dependencies: [],
  requiredCapabilities: ['database:write'],
  idempotencyKey: 'step-idem-1',
  estimatedCost: 0,
  estimatedDuration: 5000,
  riskLevel: 'high',
  approvalRequired: true,
  timeout: 30000,
  ...overrides,
});

const createTestPlan = (overrides: Partial<PlanManifest> = {}): PlanManifest => ({
  planId: 'plan-1',
  intentId: 'intent-1',
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: 'pending',
  steps: [
    createTestStep({ stepId: 'step-1', sequenceNumber: 1 }),
    createTestStep({
      stepId: 'step-2',
      sequenceNumber: 2,
      action: 'log_deletion',
      riskLevel: 'low',
      sideEffect: false,
      dependencies: ['step-1'],
      compensationAction: {
        action: 'restore_log',
        toolAdapter: 'database:insert',
        parameters: {},
        idempotencyKey: 'comp-1',
      },
    }),
  ],
  totalEstimatedCost: 10,
  totalEstimatedDuration: 10000,
  approvalRequired: true,
  riskLevel: 'high',
  ...overrides,
});

const createSandboxContext = (overrides: Partial<SandboxContext> = {}): SandboxContext => ({
  user_id: 'user-1',
  user_roles: ['operator'],
  environment: 'staging',
  session_id: 'session-1',
  ...overrides,
});

// =============================================================================
// Intent Validation Sandbox Tests
// =============================================================================

describe('IntentValidationSandbox', () => {
  let sandbox: IntentValidationSandbox;

  beforeAll(async () => {
    sandbox = await initializeIntentSandbox();
  });

  describe('initialization', () => {
    it('should initialize with default config', async () => {
      const newSandbox = new IntentValidationSandbox();
      await newSandbox.initialize();
      const stats = newSandbox.getStats();
      expect(stats.patternCount).toBeGreaterThan(0);
    });

    it('should accept custom config', async () => {
      const customSandbox = new IntentValidationSandbox({
        shadow_mode: true,
        max_resources_per_intent: 10,
      });
      await customSandbox.initialize();
      expect(customSandbox.getStats().config.shadow_mode).toBe(true);
    });
  });

  describe('pattern detection', () => {
    it('should detect SQL injection patterns', async () => {
      const intent = createTestIntent({
        nlText: "SELECT * FROM users; DROP TABLE users;--",
      });
      const result = await sandbox.validate(intent, createSandboxContext());

      expect(result.violations.some(v => v.category === 'injection')).toBe(true);
    });

    it('should detect command injection patterns', async () => {
      const intent = createTestIntent({
        nlText: 'Run command: ls -la; rm -rf /',
        metadata: {
          parameters: { command: '$(cat /etc/passwd)' },
        },
      });
      const result = await sandbox.validate(intent, createSandboxContext());

      expect(result.violations.some(v => v.category === 'injection')).toBe(true);
    });

    it('should detect credential exposure', async () => {
      const intent = createTestIntent({
        nlText: 'Use API key AKIA1234567890ABCDEF',
      });
      const result = await sandbox.validate(intent, createSandboxContext());

      expect(result.violations.some(v => v.category === 'credential_exposure')).toBe(true);
    });

    it('should detect destructive operations', async () => {
      const intent = createTestIntent({
        nlText: 'Delete all production data permanently',
        actionType: 'delete',
        riskLevel: 'destructive',
      });
      const result = await sandbox.validate(intent, createSandboxContext({
        environment: 'production',
      }));

      expect(result.violations.some(v => v.category === 'destructive_operation')).toBe(true);
    });
  });

  describe('validation checks', () => {
    it('should pass valid intents', async () => {
      const intent = createTestIntent({
        nlText: 'List all users in staging database',
        actionType: 'query',
        riskLevel: 'low',
        sideEffect: false,
      });
      const result = await sandbox.validate(intent, createSandboxContext());

      expect(result.valid).toBe(true);
      expect(result.violations.length).toBe(0);
    });

    it('should validate parameter depth', async () => {
      const deepParams: Record<string, unknown> = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: 'deep' } } } } } } } } } } };
      const intent = createTestIntent({
        metadata: { parameters: deepParams },
      });

      const strictSandbox = new IntentValidationSandbox({ max_parameter_depth: 5 });
      await strictSandbox.initialize();

      const result = await strictSandbox.validate(intent, createSandboxContext());
      expect(result.violations.some(v => v.description.includes('depth'))).toBe(true);
    });

    it('should validate resource count', async () => {
      const resources = Array.from({ length: 100 }, (_, i) => `resource-${i}`);
      const intent = createTestIntent({
        metadata: { targetResources: resources },
      });

      const result = await sandbox.validate(intent, createSandboxContext());
      expect(result.violations.some(v => v.description.includes('resource'))).toBe(true);
    });

    it('should require approval for destructive production operations', async () => {
      const intent = createTestIntent({
        riskLevel: 'destructive',
        approvalRequired: false,
      });

      const result = await sandbox.validate(intent, createSandboxContext({
        environment: 'production',
      }));

      expect(result.violations.some(v =>
        v.description.includes('Destructive') && v.description.includes('approval')
      )).toBe(true);
    });
  });

  describe('risk assessment', () => {
    it('should calculate risk score', async () => {
      const intent = createTestIntent();
      const result = await sandbox.validate(intent, createSandboxContext());

      expect(result.risk_assessment).toBeDefined();
      expect(result.risk_assessment.score).toBeGreaterThanOrEqual(0);
      expect(result.risk_assessment.score).toBeLessThanOrEqual(100);
      expect(result.risk_assessment.factors.length).toBeGreaterThan(0);
    });

    it('should generate recommendations', async () => {
      const intent = createTestIntent({
        riskLevel: 'destructive',
      });
      const result = await sandbox.validate(intent, createSandboxContext({
        environment: 'production',
      }));

      expect(result.recommendations.length).toBeGreaterThan(0);
    });
  });

  describe('shadow mode', () => {
    it('should not block in shadow mode', async () => {
      const shadowSandbox = new IntentValidationSandbox({ shadow_mode: true });
      await shadowSandbox.initialize();

      const intent = createTestIntent({
        nlText: "SELECT * FROM users; DROP TABLE users;--",
      });

      const result = await shadowSandbox.validate(intent, createSandboxContext());
      expect(result.valid).toBe(true); // Valid because shadow mode
      expect(result.violations.length).toBeGreaterThan(0); // But violations still detected
    });
  });
});

// =============================================================================
// Adversarial Simulation Engine Tests
// =============================================================================

describe('AdversarialSimulator', () => {
  let simulator: AdversarialSimulator;

  beforeAll(async () => {
    simulator = await initializeAdversarialSimulator({
      monte_carlo_iterations: 10, // Reduced for test speed
    });
  });

  describe('initialization', () => {
    it('should initialize with default config', async () => {
      const newSim = new AdversarialSimulator();
      await newSim.initialize();
      expect(newSim.getConfig().monte_carlo_iterations).toBe(defaultAdversarialConfig.monte_carlo_iterations);
    });
  });

  describe('simulation', () => {
    it('should run Monte Carlo simulation', async () => {
      const plan = createTestPlan();
      const result = await simulator.runSimulation(plan);

      expect(result.simulation_id).toBeDefined();
      expect(result.iterations_completed).toBe(10);
      expect(result.statistics).toBeDefined();
      expect(result.statistics.success_rate).toBeGreaterThanOrEqual(0);
      expect(result.statistics.success_rate).toBeLessThanOrEqual(1);
    });

    it('should calculate statistics', async () => {
      const plan = createTestPlan();
      const result = await simulator.runSimulation(plan);

      const stats = result.statistics;
      expect(stats.mean_risk_score).toBeGreaterThanOrEqual(0);
      expect(stats.mean_risk_score).toBeLessThanOrEqual(100);
      expect(stats.std_dev_risk_score).toBeGreaterThanOrEqual(0);
      expect(stats.success_rate + stats.partial_failure_rate + stats.complete_failure_rate).toBeCloseTo(1, 1);
    });

    it('should analyze failures', async () => {
      const plan = createTestPlan();
      const result = await simulator.runSimulation(plan);

      expect(result.failure_analysis).toBeDefined();
      expect(result.failure_analysis.recovery_effectiveness).toBeGreaterThanOrEqual(0);
      expect(result.failure_analysis.recovery_effectiveness).toBeLessThanOrEqual(1);
    });

    it('should assess resilience', async () => {
      const plan = createTestPlan();
      const result = await simulator.runSimulation(plan);

      expect(result.resilience).toBeDefined();
      expect(result.resilience.overall_score).toBeGreaterThanOrEqual(0);
      expect(result.resilience.overall_score).toBeLessThanOrEqual(100);
      expect(['none', 'basic', 'moderate', 'high', 'very_high']).toContain(
        result.resilience.fault_tolerance_level
      );
    });

    it('should provide risk assessment', async () => {
      const plan = createTestPlan();
      const result = await simulator.runSimulation(plan);

      expect(result.risk_assessment).toBeDefined();
      expect(['low', 'medium', 'high', 'destructive']).toContain(result.risk_assessment.worst_case_risk);
      expect(['proceed', 'proceed_with_caution', 'require_review', 'block']).toContain(
        result.risk_assessment.recommendation
      );
    });

    it('should generate recommendations', async () => {
      const plan = createTestPlan({
        steps: [
          createTestStep({
            riskLevel: 'destructive',
            compensationAction: undefined, // No compensation
          }),
        ],
      });

      const result = await simulator.runSimulation(plan);
      expect(result.recommendations.length).toBeGreaterThan(0);
    });
  });

  describe('reproducibility', () => {
    it('should produce same results with same seed', async () => {
      const plan = createTestPlan();

      const result1 = await simulator.runSimulation(plan, { random_seed: 12345 });
      const result2 = await simulator.runSimulation(plan, { random_seed: 12345 });

      expect(result1.statistics.mean_risk_score).toBeCloseTo(result2.statistics.mean_risk_score, 1);
    });
  });
});

// =============================================================================
// DLP Filter Tests
// =============================================================================

describe('DLPFilter', () => {
  let filter: DLPFilter;

  beforeAll(async () => {
    filter = await initializeDLPFilter();
  });

  beforeEach(() => {
    filter.resetStats();
  });

  describe('initialization', () => {
    it('should initialize with default config', async () => {
      const newFilter = new DLPFilter();
      await newFilter.initialize();
      expect(newFilter.getStats().patterns).toBeGreaterThan(0);
    });

    it('should respect enabled/disabled config', async () => {
      const disabledFilter = new DLPFilter({ enabled: false });
      await disabledFilter.initialize();

      const result = await disabledFilter.filter({ password: 'secret123' });
      expect(result.scan_result.findings.length).toBe(0);
    });
  });

  describe('PII detection', () => {
    it('should detect email addresses', async () => {
      const data = { email: 'user@example.com', name: 'John' };
      const result = await filter.filter(data);

      expect(result.scan_result.findings.some(f => f.data_type === 'pii_email')).toBe(true);
    });

    it('should detect phone numbers', async () => {
      const data = { contact: '555-123-4567', name: 'John' };
      const result = await filter.filter(data);

      expect(result.scan_result.findings.some(f => f.data_type === 'pii_phone')).toBe(true);
    });

    it('should detect SSN', async () => {
      const data = { ssn: '123-45-6789' };
      const result = await filter.filter(data);

      expect(result.scan_result.findings.some(f => f.data_type === 'pii_ssn')).toBe(true);
    });
  });

  describe('credential detection', () => {
    it('should detect AWS access keys', async () => {
      const data = { key: 'AKIAIOSFODNN7EXAMPLE' };
      const result = await filter.filter(data);

      expect(result.scan_result.findings.some(f => f.data_type === 'credential_api_key')).toBe(true);
    });

    it('should detect private keys', async () => {
      const data = { key: '-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg...' };
      const result = await filter.filter(data);

      expect(result.scan_result.findings.some(f => f.data_type === 'credential_private_key')).toBe(true);
    });

    it('should detect JWT tokens', async () => {
      const data = { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' };
      const result = await filter.filter(data);

      expect(result.scan_result.findings.some(f => f.data_type === 'credential_token')).toBe(true);
    });
  });

  describe('financial data detection', () => {
    it('should detect credit card numbers', async () => {
      const data = { card: '4111111111111111' };
      const result = await filter.filter(data);

      expect(result.scan_result.findings.some(f => f.data_type === 'financial_card')).toBe(true);
    });

    it('should detect formatted credit cards', async () => {
      const data = { card: '4111-1111-1111-1111' };
      const result = await filter.filter(data);

      expect(result.scan_result.findings.some(f => f.data_type === 'financial_card')).toBe(true);
    });
  });

  describe('redaction', () => {
    it('should redact sensitive data by default', async () => {
      const data = { password: 'mysecretpassword123' };
      const result = await filter.filter(data);

      expect((result.data as Record<string, string>).password).not.toBe('mysecretpassword123');
    });

    it('should support different redaction methods', async () => {
      const maskFilter = new DLPFilter({ redaction_method: 'mask' });
      await maskFilter.initialize();

      const data = { secret: 'topsecret' };
      const result = await maskFilter.filter(data);

      expect((result.data as Record<string, string>).secret).toMatch(/^\*+$/);
    });

    it('should not redact allowlisted fields', async () => {
      const data = { id: 'user@example.com', email: 'user@example.com' };
      const result = await filter.filter(data);

      expect((result.data as Record<string, string>).id).toBe('user@example.com');
      expect((result.data as Record<string, string>).email).not.toBe('user@example.com');
    });
  });

  describe('nested data', () => {
    it('should scan nested objects', async () => {
      const data = {
        user: {
          profile: {
            contact: {
              email: 'nested@example.com',
            },
          },
        },
      };
      const result = await filter.filter(data);

      expect(result.scan_result.findings.some(f => f.data_type === 'pii_email')).toBe(true);
    });

    it('should scan arrays', async () => {
      const data = {
        contacts: [
          { email: 'user1@example.com' },
          { email: 'user2@example.com' },
        ],
      };
      const result = await filter.filter(data);

      expect(result.scan_result.findings.filter(f => f.data_type === 'pii_email').length).toBe(2);
    });
  });

  describe('shadow mode', () => {
    it('should not redact in shadow mode', async () => {
      const shadowFilter = new DLPFilter({ shadow_mode: true });
      await shadowFilter.initialize();

      const data = { password: 'secret123' };
      const result = await shadowFilter.filter(data);

      expect((result.data as Record<string, string>).password).toBe('secret123');
      expect(result.scan_result.findings.length).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// Compensation Verification Engine Tests
// =============================================================================

describe('CompensationVerifier', () => {
  let verifier: CompensationVerifier;

  beforeAll(async () => {
    verifier = await initializeCompensationVerifier();
  });

  describe('initialization', () => {
    it('should initialize with default config', async () => {
      const newVerifier = new CompensationVerifier();
      await newVerifier.initialize();
      expect(newVerifier.getStats().verifications).toBe(0);
    });
  });

  describe('verification', () => {
    it('should detect missing compensation for side effect steps', async () => {
      const plan = createTestPlan({
        steps: [
          createTestStep({
            sideEffect: true,
            compensationAction: undefined,
          }),
        ],
      });

      const result = await verifier.verify(plan);
      expect(result.gaps.length).toBeGreaterThan(0);
      expect(result.issues.some(i => i.category === 'missing_compensation')).toBe(true);
    });

    it('should validate compensation idempotency', async () => {
      const plan = createTestPlan({
        steps: [
          createTestStep({
            compensationAction: {
              action: 'restore',
              toolAdapter: 'database:insert',
              parameters: {},
              idempotencyKey: undefined as any, // Missing idempotency key
            },
          }),
        ],
      });

      const result = await verifier.verify(plan);
      expect(result.issues.some(i => i.category === 'missing_idempotency')).toBe(true);
    });

    it('should validate compensation timeout', async () => {
      const plan = createTestPlan({
        steps: [
          createTestStep({
            compensationAction: {
              action: 'restore',
              toolAdapter: 'database:insert',
              parameters: {},
              idempotencyKey: 'comp-1',
              timeout: 1000000, // Too long
            },
          }),
        ],
      });

      const result = await verifier.verify(plan);
      expect(result.issues.some(i => i.category === 'timeout_issue')).toBe(true);
    });

    it('should pass valid compensated plans', async () => {
      const plan = createTestPlan({
        steps: [
          createTestStep({
            sideEffect: true,
            compensationAction: {
              action: 'restore',
              toolAdapter: 'database:insert',
              parameters: { data: '{deleted_data}' },
              idempotencyKey: 'comp-1',
              timeout: 60000,
            },
          }),
        ],
      });

      const result = await verifier.verify(plan);
      expect(result.valid).toBe(true);
    });
  });

  describe('coverage calculation', () => {
    it('should calculate coverage percentage', async () => {
      const plan = createTestPlan({
        steps: [
          createTestStep({ sideEffect: true, compensationAction: { action: 'a', toolAdapter: 't', parameters: {}, idempotencyKey: 'k' } }),
          createTestStep({ stepId: 'step-2', sideEffect: true, compensationAction: undefined }),
          createTestStep({ stepId: 'step-3', sideEffect: false }),
        ],
      });

      const result = await verifier.verify(plan);
      expect(result.coverage.coverage_percentage).toBe(50); // 1 of 2 side effect steps
    });

    it('should track high-risk coverage', async () => {
      const plan = createTestPlan({
        steps: [
          createTestStep({ riskLevel: 'high', compensationAction: { action: 'a', toolAdapter: 't', parameters: {}, idempotencyKey: 'k' } }),
          createTestStep({ stepId: 'step-2', riskLevel: 'high', compensationAction: undefined }),
        ],
      });

      const result = await verifier.verify(plan);
      expect(result.coverage.high_risk_coverage).toBe(50);
    });
  });

  describe('risk assessment', () => {
    it('should assess uncompensated risk', async () => {
      const plan = createTestPlan({
        steps: [
          createTestStep({ riskLevel: 'destructive', sideEffect: true, compensationAction: undefined }),
        ],
      });

      const result = await verifier.verify(plan);
      expect(result.risk_assessment.overall_risk).toBe('critical');
    });

    it('should generate recommendations', async () => {
      const plan = createTestPlan({
        steps: [
          createTestStep({ sideEffect: true, compensationAction: undefined }),
        ],
      });

      const result = await verifier.verify(plan);
      expect(result.recommendations.length).toBeGreaterThan(0);
    });
  });

  describe('suggested compensations', () => {
    it('should suggest compensations for common operations', async () => {
      const plan = createTestPlan({
        steps: [
          createTestStep({
            action: 'insert_record',
            toolAdapter: 'database:insert',
            sideEffect: true,
            compensationAction: undefined,
          }),
        ],
      });

      const result = await verifier.verify(plan);
      expect(result.gaps[0]?.suggested_compensation).toBeDefined();
    });
  });
});

// =============================================================================
// Dynamic Risk Scorer Tests
// =============================================================================

describe('DynamicRiskScorer', () => {
  let scorer: DynamicRiskScorer;

  beforeAll(async () => {
    scorer = await initializeDynamicRiskScorer();
  });

  beforeEach(() => {
    scorer.clearHistory();
  });

  describe('initialization', () => {
    it('should initialize with default config', async () => {
      const newScorer = new DynamicRiskScorer();
      await newScorer.initialize();
      expect(newScorer.getStats().scores_calculated).toBe(0);
    });
  });

  describe('intent scoring', () => {
    it('should score intents', async () => {
      const intent = createTestIntent();
      const score = await scorer.scoreIntent(intent);

      expect(score.score_id).toBeDefined();
      expect(score.raw_score).toBeGreaterThanOrEqual(0);
      expect(score.raw_score).toBeLessThanOrEqual(100);
      expect(score.adjusted_score).toBeGreaterThanOrEqual(0);
      expect(['low', 'medium', 'high', 'destructive']).toContain(score.risk_level);
    });

    it('should score based on action type', async () => {
      const lowRiskIntent = createTestIntent({ actionType: 'read', riskLevel: 'low' });
      const highRiskIntent = createTestIntent({ actionType: 'delete', riskLevel: 'destructive' });

      const lowScore = await scorer.scoreIntent(lowRiskIntent);
      const highScore = await scorer.scoreIntent(highRiskIntent);

      expect(highScore.adjusted_score).toBeGreaterThan(lowScore.adjusted_score);
    });

    it('should consider environment', async () => {
      const intent = createTestIntent();

      const devScore = await scorer.scoreIntent(intent, { environment: 'development' });
      const prodScore = await scorer.scoreIntent(intent, { environment: 'production' });

      expect(prodScore.adjusted_score).toBeGreaterThan(devScore.adjusted_score);
    });

    it('should consider user roles', async () => {
      const intent = createTestIntent();

      const adminScore = await scorer.scoreIntent(intent, { user_roles: ['admin'] });
      const guestScore = await scorer.scoreIntent(intent, { user_roles: ['guest'] });

      expect(guestScore.adjusted_score).toBeGreaterThan(adminScore.adjusted_score);
    });
  });

  describe('plan scoring', () => {
    it('should score plans', async () => {
      const plan = createTestPlan();
      const score = await scorer.scorePlan(plan);

      expect(score.entity_type).toBe('plan');
      expect(score.factors.length).toBeGreaterThan(0);
    });

    it('should consider plan complexity', async () => {
      const simplePlan = createTestPlan({ steps: [createTestStep()] });
      const complexPlan = createTestPlan({
        steps: Array.from({ length: 10 }, (_, i) =>
          createTestStep({
            stepId: `step-${i}`,
            dependencies: i > 0 ? [`step-${i - 1}`] : [],
          })
        ),
      });

      const simpleScore = await scorer.scorePlan(simplePlan);
      const complexScore = await scorer.scorePlan(complexPlan);

      expect(complexScore.adjusted_score).toBeGreaterThan(simpleScore.adjusted_score);
    });
  });

  describe('step scoring', () => {
    it('should score steps', async () => {
      const step = createTestStep();
      const score = await scorer.scoreStep(step);

      expect(score.entity_type).toBe('step');
      expect(score.risk_level).toBeDefined();
    });
  });

  describe('risk factors', () => {
    it('should include all configured factors', async () => {
      const intent = createTestIntent();
      const score = await scorer.scoreIntent(intent);

      expect(score.factors.length).toBeGreaterThan(5);
      expect(score.factors.some(f => f.name === 'Action Type Risk')).toBe(true);
      expect(score.factors.some(f => f.name === 'Data Sensitivity')).toBe(true);
      expect(score.factors.some(f => f.name === 'Environment Risk')).toBe(true);
    });

    it('should weight factors correctly', async () => {
      const intent = createTestIntent();
      const score = await scorer.scoreIntent(intent);

      const totalWeight = score.factors.reduce((sum, f) => sum + f.weight, 0);
      expect(totalWeight).toBeCloseTo(1, 1);
    });
  });

  describe('adjustments', () => {
    it('should apply production destructive adjustment', async () => {
      const intent = createTestIntent({ riskLevel: 'destructive' });
      const score = await scorer.scoreIntent(intent, { environment: 'production' });

      expect(score.adjustments.some(a => a.rule_id === 'prod-destructive')).toBe(true);
    });
  });

  describe('feature extraction', () => {
    it('should extract ML features', async () => {
      const intent = createTestIntent();
      const score = await scorer.scoreIntent(intent);

      expect(score.features).toBeDefined();
      expect(typeof score.features.action_risk_base).toBe('number');
      expect(typeof score.features.has_side_effects).toBe('boolean');
      expect(score.features.action_type).toBe('delete');
    });
  });

  describe('adaptive thresholds', () => {
    it('should adjust thresholds for production', async () => {
      const intent = createTestIntent({ riskLevel: 'medium' });

      // Same intent might get different risk level based on environment
      const devScore = await scorer.scoreIntent(intent, { environment: 'development' });
      const prodScore = await scorer.scoreIntent(intent, { environment: 'production' });

      // Production should have tighter thresholds
      expect(prodScore.adjusted_score).toBeGreaterThanOrEqual(devScore.adjusted_score);
    });
  });

  describe('historical analysis', () => {
    it('should track action history', async () => {
      const intent = createTestIntent();

      await scorer.scoreIntent(intent);
      await scorer.scoreIntent(intent);
      await scorer.scoreIntent(intent);

      expect(scorer.getStats().history_size).toBe(3);
    });

    it('should analyze patterns in history', async () => {
      // Create history
      for (let i = 0; i < 5; i++) {
        const intent = createTestIntent({ actionType: i < 3 ? 'read' : 'delete' });
        await scorer.scoreIntent(intent);
      }

      const intent = createTestIntent();
      const score = await scorer.scoreIntent(intent);

      expect(score.factors.some(f => f.name === 'Historical Patterns')).toBe(true);
    });
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('Security Components Integration', () => {
  it('should work together in a pipeline', async () => {
    // 1. Validate intent
    const sandbox = await initializeIntentSandbox();
    const intent = createTestIntent({
      nlText: 'Delete all records from users table',
    });
    const validationResult = await sandbox.validate(intent, createSandboxContext());

    // 2. Score risk
    const scorer = await initializeDynamicRiskScorer();
    const riskScore = await scorer.scoreIntent(intent);

    // 3. Create plan and verify compensation
    const plan = createTestPlan();
    const verifier = await initializeCompensationVerifier();
    const verificationResult = await verifier.verify(plan);

    // 4. Run adversarial simulation
    const simulator = await initializeAdversarialSimulator({ monte_carlo_iterations: 5 });
    const simulationResult = await simulator.runSimulation(plan);

    // 5. Filter outputs with DLP
    const dlp = await initializeDLPFilter();
    const filtered = await dlp.filter({ result: 'success', email: 'test@example.com' });

    // All components should work
    expect(validationResult.validation_id).toBeDefined();
    expect(riskScore.score_id).toBeDefined();
    expect(verificationResult.verification_id).toBeDefined();
    expect(simulationResult.simulation_id).toBeDefined();
    expect(filtered.scan_result.scan_id).toBeDefined();
  });
});
