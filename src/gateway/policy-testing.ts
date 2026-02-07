/**
 * Policy Testing Framework
 *
 * Test policies before deployment to catch errors and unintended consequences.
 * Supports unit tests, integration tests, and regression tests.
 *
 * Features:
 * - Test case management
 * - Assertion framework
 * - Coverage analysis
 * - Regression detection
 * - Performance testing
 *
 * References:
 * - OPA Testing
 * - AWS IAM Policy Simulator
 * - HashiCorp Sentinel testing
 */

import { EventEmitter } from 'events';
import { componentLogger } from '../core/logger.js';
import type { PolicyRule, TypedIntent, RiskLevel } from '../core/types.js';
import type { PolicyContext, PolicyEvaluationResult } from './policy-engine.js';

const logger = componentLogger('policy-testing');

// =============================================================================
// Types
// =============================================================================

export interface PolicyTestCase {
  testId: string;
  name: string;
  description: string;
  ruleId: string;
  input: {
    intent: Partial<TypedIntent>;
    context: PolicyContext;
  };
  expected: {
    allowed?: boolean;
    requiresApproval?: boolean;
    violations?: number;
    effectiveRiskLevel?: RiskLevel;
  };
  tags: string[];
}

export interface PolicyTestResult {
  testId: string;
  passed: boolean;
  actual: PolicyEvaluationResult;
  expected: PolicyTestCase['expected'];
  failures: TestFailure[];
  durationMs: number;
}

export interface TestFailure {
  field: string;
  expected: unknown;
  actual: unknown;
  message: string;
}

export interface PolicyTestSuite {
  suiteId: string;
  name: string;
  description: string;
  ruleId: string;
  tests: PolicyTestCase[];
  createdAt: Date;
  updatedAt: Date;
}

export interface TestSuiteResult {
  suiteId: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  coverage: number;
  duration: number;
  results: PolicyTestResult[];
}

export interface PolicyCoverage {
  ruleId: string;
  totalConditions: number;
  coveredConditions: number;
  uncoveredConditions: string[];
  coveragePercentage: number;
}

// =============================================================================
// Policy Testing Framework
// =============================================================================

export class PolicyTestingFramework extends EventEmitter {
  private testSuites = new Map<string, PolicyTestSuite>();
  private testResults = new Map<string, TestSuiteResult>();

  /**
   * Create a test suite
   */
  createTestSuite(
    suiteId: string,
    name: string,
    description: string,
    ruleId: string
  ): PolicyTestSuite {
    const suite: PolicyTestSuite = {
      suiteId,
      name,
      description,
      ruleId,
      tests: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.testSuites.set(suiteId, suite);

    logger.info({ suiteId, ruleId }, 'Test suite created');

    return suite;
  }

  /**
   * Add test case to suite
   */
  addTestCase(suiteId: string, testCase: PolicyTestCase): void {
    const suite = this.testSuites.get(suiteId);

    if (!suite) {
      throw new Error(`Test suite not found: ${suiteId}`);
    }

    suite.tests.push(testCase);
    suite.updatedAt = new Date();

    logger.debug({ suiteId, testId: testCase.testId }, 'Test case added');
  }

  /**
   * Run a single test case
   */
  async runTest(
    testCase: PolicyTestCase,
    evaluateFn: (intent: TypedIntent, context: PolicyContext) => PolicyEvaluationResult
  ): Promise<PolicyTestResult> {
    const startTime = Date.now();

    // Create full intent from partial
    const intent: TypedIntent = {
      intentId: 'test-intent',
      userId: testCase.input.context.userId,
      timestamp: new Date().toISOString(),
      nlText: 'Test intent',
      actionType: testCase.input.intent.actionType || 'unknown',
      riskLevel: testCase.input.intent.riskLevel || 'low',
      sensitivity: testCase.input.intent.sensitivity || 'public',
      budget: testCase.input.intent.budget || { currency: 'USD', limit: 0, spent: 0 },
      requiredCapabilities: testCase.input.intent.requiredCapabilities || [],
      sideEffect: testCase.input.intent.sideEffect ?? false,
      policyStatus: 'pending',
      approvalRequired: testCase.input.intent.approvalRequired ?? false,
      confidence: testCase.input.intent.confidence || 1.0,
      ...testCase.input.intent,
    };

    // Evaluate policy
    const actual = evaluateFn(intent, testCase.input.context);

    // Check assertions
    const failures: TestFailure[] = [];

    if (testCase.expected.allowed !== undefined && actual.allowed !== testCase.expected.allowed) {
      failures.push({
        field: 'allowed',
        expected: testCase.expected.allowed,
        actual: actual.allowed,
        message: `Expected allowed=${testCase.expected.allowed}, got ${actual.allowed}`,
      });
    }

    if (
      testCase.expected.requiresApproval !== undefined &&
      actual.requiresApproval !== testCase.expected.requiresApproval
    ) {
      failures.push({
        field: 'requiresApproval',
        expected: testCase.expected.requiresApproval,
        actual: actual.requiresApproval,
        message: `Expected requiresApproval=${testCase.expected.requiresApproval}, got ${actual.requiresApproval}`,
      });
    }

    if (
      testCase.expected.violations !== undefined &&
      actual.violations.length !== testCase.expected.violations
    ) {
      failures.push({
        field: 'violations',
        expected: testCase.expected.violations,
        actual: actual.violations.length,
        message: `Expected ${testCase.expected.violations} violations, got ${actual.violations.length}`,
      });
    }

    if (
      testCase.expected.effectiveRiskLevel !== undefined &&
      actual.effectiveRiskLevel !== testCase.expected.effectiveRiskLevel
    ) {
      failures.push({
        field: 'effectiveRiskLevel',
        expected: testCase.expected.effectiveRiskLevel,
        actual: actual.effectiveRiskLevel,
        message: `Expected riskLevel=${testCase.expected.effectiveRiskLevel}, got ${actual.effectiveRiskLevel}`,
      });
    }

    const durationMs = Date.now() - startTime;

    return {
      testId: testCase.testId,
      passed: failures.length === 0,
      actual,
      expected: testCase.expected,
      failures,
      durationMs,
    };
  }

  /**
   * Run an entire test suite
   */
  async runTestSuite(
    suiteId: string,
    evaluateFn: (intent: TypedIntent, context: PolicyContext) => PolicyEvaluationResult
  ): Promise<TestSuiteResult> {
    const suite = this.testSuites.get(suiteId);

    if (!suite) {
      throw new Error(`Test suite not found: ${suiteId}`);
    }

    const startTime = Date.now();
    const results: PolicyTestResult[] = [];

    for (const testCase of suite.tests) {
      const result = await this.runTest(testCase, evaluateFn);
      results.push(result);

      this.emit('test_completed', {
        testId: testCase.testId,
        passed: result.passed,
      });
    }

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    const suiteResult: TestSuiteResult = {
      suiteId,
      totalTests: suite.tests.length,
      passed,
      failed,
      skipped: 0,
      coverage: this.calculateCoverage(suite, results),
      duration: Date.now() - startTime,
      results,
    };

    this.testResults.set(suiteId, suiteResult);

    this.emit('suite_completed', {
      suiteId,
      passed,
      failed,
      coverage: suiteResult.coverage,
    });

    logger.info(
      {
        suiteId,
        totalTests: suiteResult.totalTests,
        passed: suiteResult.passed,
        failed: suiteResult.failed,
      },
      'Test suite completed'
    );

    return suiteResult;
  }

  /**
   * Calculate code coverage
   */
  private calculateCoverage(suite: PolicyTestSuite, results: PolicyTestResult[]): number {
    // Simple coverage: % of tests that passed
    if (suite.tests.length === 0) return 0;

    const passed = results.filter(r => r.passed).length;
    return (passed / suite.tests.length) * 100;
  }

  /**
   * Analyze policy coverage
   */
  analyzeCoverage(rule: PolicyRule, testSuite: PolicyTestSuite): PolicyCoverage {
    // Parse condition for branches
    const condition = rule.condition;
    const branches = this.extractBranches(condition);

    // Check which branches are covered by tests
    const coveredBranches = new Set<string>();

    for (const test of testSuite.tests) {
      // Simplified: assume each test covers one branch
      coveredBranches.add(test.testId);
    }

    const totalConditions = branches.length;
    const coveredConditions = Math.min(testSuite.tests.length, totalConditions);

    return {
      ruleId: rule.ruleId,
      totalConditions,
      coveredConditions,
      uncoveredConditions: branches.slice(coveredConditions),
      coveragePercentage: totalConditions > 0 ? (coveredConditions / totalConditions) * 100 : 0,
    };
  }

  /**
   * Extract branches from condition
   */
  private extractBranches(condition: string): string[] {
    const branches: string[] = [];

    // Split on && and ||
    const parts = condition.split(/&&|\|\|/);

    for (const part of parts) {
      branches.push(part.trim());
    }

    return branches;
  }

  /**
   * Create standard test cases for a rule
   */
  generateStandardTests(rule: PolicyRule): PolicyTestCase[] {
    const tests: PolicyTestCase[] = [];

    // Test 1: Should trigger the rule
    tests.push({
      testId: `${rule.ruleId}_should_trigger`,
      name: `${rule.name} - Should Trigger`,
      description: 'Test that the rule triggers when conditions are met',
      ruleId: rule.ruleId,
      input: {
        intent: {
          riskLevel: rule.riskLevel || 'medium',
          sideEffect: true,
        },
        context: {
          userId: 'test-user',
          environment: 'production',
        },
      },
      expected: {
        allowed: rule.action !== 'deny',
        requiresApproval: rule.action === 'require_approval',
      },
      tags: ['auto-generated', 'positive'],
    });

    // Test 2: Should not trigger the rule
    tests.push({
      testId: `${rule.ruleId}_should_not_trigger`,
      name: `${rule.name} - Should Not Trigger`,
      description: 'Test that the rule does not trigger when conditions are not met',
      ruleId: rule.ruleId,
      input: {
        intent: {
          riskLevel: 'low',
          sideEffect: false,
        },
        context: {
          userId: 'test-user',
          environment: 'development',
        },
      },
      expected: {
        allowed: true,
        requiresApproval: false,
      },
      tags: ['auto-generated', 'negative'],
    });

    return tests;
  }

  /**
   * Detect regressions by comparing to previous results
   */
  detectRegressions(
    currentResult: TestSuiteResult,
    previousResult: TestSuiteResult
  ): Array<{ testId: string; wasPassing: boolean; isNowPassing: boolean }> {
    const regressions: Array<{
      testId: string;
      wasPassing: boolean;
      isNowPassing: boolean;
    }> = [];

    for (const currentTest of currentResult.results) {
      const previousTest = previousResult.results.find(r => r.testId === currentTest.testId);

      if (previousTest && previousTest.passed !== currentTest.passed) {
        regressions.push({
          testId: currentTest.testId,
          wasPassing: previousTest.passed,
          isNowPassing: currentTest.passed,
        });
      }
    }

    return regressions;
  }

  /**
   * Get test suite
   */
  getTestSuite(suiteId: string): PolicyTestSuite | undefined {
    return this.testSuites.get(suiteId);
  }

  /**
   * Get test results
   */
  getTestResults(suiteId: string): TestSuiteResult | undefined {
    return this.testResults.get(suiteId);
  }

  /**
   * Get all test suites
   */
  getAllTestSuites(): PolicyTestSuite[] {
    return Array.from(this.testSuites.values());
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalSuites: number;
    totalTests: number;
    avgTestsPerSuite: number;
    avgCoverage: number;
  } {
    const suites = Array.from(this.testSuites.values());
    const totalSuites = suites.length;
    const totalTests = suites.reduce((sum, s) => sum + s.tests.length, 0);

    const results = Array.from(this.testResults.values());
    const avgCoverage =
      results.length > 0
        ? results.reduce((sum, r) => sum + r.coverage, 0) / results.length
        : 0;

    return {
      totalSuites,
      totalTests,
      avgTestsPerSuite: totalSuites > 0 ? totalTests / totalSuites : 0,
      avgCoverage,
    };
  }

  /**
   * Clear all tests (for testing)
   */
  clear(): void {
    this.testSuites.clear();
    this.testResults.clear();
  }
}

// =============================================================================
// Singleton
// =============================================================================

let testingFramework: PolicyTestingFramework | null = null;

export function getPolicyTestingFramework(): PolicyTestingFramework {
  if (!testingFramework) {
    testingFramework = new PolicyTestingFramework();
  }
  return testingFramework;
}
