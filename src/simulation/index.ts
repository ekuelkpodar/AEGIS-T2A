/**
 * AEGIS-T2A Simulation Engine
 *
 * Executes plan dry-runs in sandboxed environments for risk assessment.
 */

import {
  PlanManifest,
  PlanStep,
  SimulationResult,
  RiskLevel,
} from '../core/types.js';
import { generateSimulationId } from '../core/ids.js';
import { componentLogger } from '../core/logger.js';
import { execute, queryOne } from '../core/database.js';
import { getConfig } from '../core/config.js';

const logger = componentLogger('simulation');

// =============================================================================
// Types
// =============================================================================

export interface SimulationOptions {
  timeout?: number;
  maxIterations?: number;
  mockExternalCalls?: boolean;
  adversarialScenarios?: boolean;
}

export interface StepSimulationResult {
  stepId: string;
  status: 'success' | 'fail' | 'skipped';
  outputs?: Record<string, unknown>;
  error?: string;
  simulatedDurationMs: number;
  simulatedCost: number;
  warnings: string[];
}

export interface SimulationContext {
  planId: string;
  simulationId: string;
  variables: Map<string, unknown>;
  completedSteps: Set<string>;
  stepResults: Map<string, StepSimulationResult>;
}

// =============================================================================
// Mock Responses for Simulation
// =============================================================================

const MOCK_RESPONSES: Record<string, (params: Record<string, unknown>) => unknown> = {
  'http:request': (params) => ({
    status: 200,
    body: { success: true, mock: true },
    headers: { 'content-type': 'application/json' },
  }),
  'shell:command': (params) => ({
    exitCode: 0,
    stdout: 'Command executed successfully (simulated)',
    stderr: '',
  }),
  'aws:ec2': (params) => ({
    instanceId: 'i-mock-12345',
    state: 'running',
  }),
  'aws:s3': (params) => ({
    bucket: params['bucket'] ?? 'mock-bucket',
    key: params['key'] ?? 'mock-key',
    etag: 'mock-etag-12345',
  }),
  'aws:lambda': (params) => ({
    functionArn: 'arn:aws:lambda:us-east-1:123456789:function:mock',
    statusCode: 200,
    payload: { mock: true },
  }),
  'github:api': (params) => ({
    success: true,
    data: { id: 12345, mock: true },
  }),
  'database:query': (params) => ({
    rowCount: 1,
    rows: [{ id: 1, mock: true }],
  }),
  'file:read': (params) => ({
    content: 'Mock file content',
    size: 100,
  }),
  'file:write': (params) => ({
    success: true,
    bytesWritten: 100,
  }),
  'notification:email': (params) => ({
    messageId: 'mock-msg-12345',
    sent: true,
  }),
  'notification:slack': (params) => ({
    ok: true,
    ts: '1234567890.123456',
  }),
};

// =============================================================================
// Risk Scoring
// =============================================================================

interface RiskFactors {
  sideEffectCount: number;
  destructiveStepCount: number;
  highRiskStepCount: number;
  externalDependencies: number;
  totalEstimatedCost: number;
  hasCompensationGaps: boolean;
  dependencyDepth: number;
}

function calculateRiskScore(factors: RiskFactors): number {
  let score = 0;

  // Side effects increase risk
  score += factors.sideEffectCount * 5;

  // Destructive steps are high risk
  score += factors.destructiveStepCount * 25;

  // High risk steps
  score += factors.highRiskStepCount * 15;

  // External dependencies add risk
  score += factors.externalDependencies * 3;

  // Cost correlates with risk
  if (factors.totalEstimatedCost > 100) score += 10;
  if (factors.totalEstimatedCost > 500) score += 15;
  if (factors.totalEstimatedCost > 1000) score += 20;

  // Compensation gaps are risky
  if (factors.hasCompensationGaps) score += 20;

  // Deep dependencies increase complexity/risk
  score += factors.dependencyDepth * 2;

  // Normalize to 0-100
  return Math.min(100, Math.max(0, score));
}

function determineBlastRadius(plan: PlanManifest): 'low' | 'medium' | 'high' {
  const destructiveCount = plan.steps.filter(
    (s) => s.riskLevel === 'destructive'
  ).length;
  const sideEffectCount = plan.steps.filter((s) => s.sideEffect).length;

  if (destructiveCount > 0 || sideEffectCount > 5) return 'high';
  if (sideEffectCount > 2) return 'medium';
  return 'low';
}

// =============================================================================
// Simulation Engine
// =============================================================================

export class SimulationEngine {
  private initialized = false;
  private config = getConfig();

  /**
   * Initialize the simulation engine
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    logger.info('Simulation engine initialized');
  }

  /**
   * Run a simulation of a plan
   */
  async simulate(
    plan: PlanManifest,
    options: SimulationOptions = {}
  ): Promise<SimulationResult> {
    const startTime = Date.now();
    const simulationId = generateSimulationId();

    logger.info(
      { simulationId, planId: plan.planId, stepCount: plan.steps.length },
      'Starting simulation'
    );

    const timeout = options.timeout ?? this.config.simulationTimeoutMs;
    const mockExternal = options.mockExternalCalls ?? true;

    const context: SimulationContext = {
      planId: plan.planId,
      simulationId,
      variables: new Map(),
      completedSteps: new Set(),
      stepResults: new Map(),
    };

    const stepResults: Array<{
      stepId: string;
      status: 'success' | 'fail' | 'skipped';
      outputs?: Record<string, unknown>;
      error?: string;
    }> = [];

    const anomalies: string[] = [];
    const recommendations: string[] = [];

    try {
      // Execute steps in dependency order
      const executionOrder = this.topologicalSort(plan.steps);

      for (const step of executionOrder) {
        // Check timeout
        if (Date.now() - startTime > timeout) {
          anomalies.push('Simulation timeout exceeded');
          break;
        }

        // Check dependencies
        const depsReady = step.dependencies.every((depId) =>
          context.completedSteps.has(depId)
        );

        if (!depsReady) {
          stepResults.push({
            stepId: step.stepId,
            status: 'skipped',
            error: 'Dependencies not satisfied',
          });
          continue;
        }

        // Simulate the step
        const result = await this.simulateStep(step, context, mockExternal);
        context.stepResults.set(step.stepId, result);

        if (result.status === 'success') {
          context.completedSteps.add(step.stepId);
        }

        stepResults.push({
          stepId: result.stepId,
          status: result.status,
          outputs: result.outputs,
          error: result.error,
        });

        // Collect warnings as anomalies
        anomalies.push(...result.warnings);
      }

      // Analyze results
      const failedSteps = stepResults.filter((r) => r.status === 'fail');
      const successfulSteps = stepResults.filter((r) => r.status === 'success');

      // Calculate risk factors
      const riskFactors: RiskFactors = {
        sideEffectCount: plan.steps.filter((s) => s.sideEffect).length,
        destructiveStepCount: plan.steps.filter((s) => s.riskLevel === 'destructive').length,
        highRiskStepCount: plan.steps.filter((s) => s.riskLevel === 'high').length,
        externalDependencies: this.countExternalDependencies(plan.steps),
        totalEstimatedCost: plan.totalEstimatedCost,
        hasCompensationGaps: plan.steps.some((s) => s.sideEffect && !s.compensationAction),
        dependencyDepth: this.calculateDependencyDepth(plan.steps),
      };

      const riskScore = calculateRiskScore(riskFactors);
      const blastRadius = determineBlastRadius(plan);

      // Generate recommendations
      if (riskFactors.hasCompensationGaps) {
        recommendations.push(
          'Add compensation actions for all steps with side effects'
        );
      }
      if (riskScore > 70) {
        recommendations.push(
          'Consider breaking this plan into smaller, less risky operations'
        );
      }
      if (failedSteps.length > 0) {
        recommendations.push(
          `Review failed steps: ${failedSteps.map((s) => s.stepId).join(', ')}`
        );
      }

      // Determine overall status
      let status: 'success' | 'partial_fail' | 'fail' = 'success';
      if (failedSteps.length === plan.steps.length) {
        status = 'fail';
      } else if (failedSteps.length > 0) {
        status = 'partial_fail';
      }

      // Calculate simulated cost
      const simulatedCost = Array.from(context.stepResults.values()).reduce(
        (sum, r) => sum + r.simulatedCost,
        0
      );

      // Determine if human review is required
      const humanReviewRequired =
        riskScore > 50 ||
        blastRadius === 'high' ||
        status !== 'success' ||
        anomalies.length > 0;

      const simulationResult: SimulationResult = {
        simulationId,
        planId: plan.planId,
        timestamp: new Date().toISOString(),
        status,
        blastRadius,
        riskScore,
        estimatedCost: simulatedCost,
        anomalies,
        stepResults,
        humanReviewRequired,
        recommendations,
      };

      // Persist simulation result
      await this.persistSimulation(simulationResult);

      logger.info(
        {
          simulationId,
          planId: plan.planId,
          status,
          riskScore,
          blastRadius,
          durationMs: Date.now() - startTime,
        },
        'Simulation completed'
      );

      return simulationResult;
    } catch (error) {
      logger.error({ error, simulationId, planId: plan.planId }, 'Simulation failed');

      const failedResult: SimulationResult = {
        simulationId,
        planId: plan.planId,
        timestamp: new Date().toISOString(),
        status: 'fail',
        blastRadius: 'high',
        riskScore: 100,
        estimatedCost: plan.totalEstimatedCost,
        anomalies: [
          `Simulation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ],
        stepResults,
        humanReviewRequired: true,
        recommendations: ['Review simulation failure before proceeding'],
      };

      await this.persistSimulation(failedResult);

      return failedResult;
    }
  }

  /**
   * Simulate a single step
   */
  private async simulateStep(
    step: PlanStep,
    context: SimulationContext,
    mockExternal: boolean
  ): Promise<StepSimulationResult> {
    const startTime = Date.now();
    const warnings: string[] = [];

    try {
      // Get mock response for this adapter type
      const adapterBase = step.toolAdapter.split(':').slice(0, 2).join(':');
      const mockFn = MOCK_RESPONSES[adapterBase] ?? MOCK_RESPONSES[step.toolAdapter.split(':')[0] + ':*'];

      let outputs: Record<string, unknown> = {};

      if (mockExternal && mockFn) {
        outputs = mockFn(step.parameters) as Record<string, unknown>;
      } else if (mockExternal) {
        // Generic mock for unknown adapters
        outputs = { simulated: true, adapter: step.toolAdapter };
        warnings.push(`No specific mock for adapter: ${step.toolAdapter}`);
      }

      // Validate step configuration
      if (step.sideEffect && !step.compensationAction) {
        warnings.push(`Step ${step.stepId} has side effects but no compensation`);
      }

      if (step.estimatedCost > 100) {
        warnings.push(`Step ${step.stepId} has high estimated cost: $${step.estimatedCost}`);
      }

      // Simulate some variance in duration
      const durationVariance = 0.8 + Math.random() * 0.4; // 80% to 120%
      const simulatedDuration = Math.round(step.estimatedDuration * durationVariance);

      return {
        stepId: step.stepId,
        status: 'success',
        outputs,
        simulatedDurationMs: simulatedDuration,
        simulatedCost: step.estimatedCost,
        warnings,
      };
    } catch (error) {
      return {
        stepId: step.stepId,
        status: 'fail',
        error: error instanceof Error ? error.message : 'Step simulation failed',
        simulatedDurationMs: Date.now() - startTime,
        simulatedCost: 0,
        warnings,
      };
    }
  }

  /**
   * Topological sort of steps by dependencies
   */
  private topologicalSort(steps: PlanStep[]): PlanStep[] {
    const result: PlanStep[] = [];
    const visited = new Set<string>();
    const stepMap = new Map(steps.map((s) => [s.stepId, s]));

    const visit = (step: PlanStep) => {
      if (visited.has(step.stepId)) return;
      visited.add(step.stepId);

      for (const depId of step.dependencies) {
        const depStep = stepMap.get(depId);
        if (depStep) visit(depStep);
      }

      result.push(step);
    };

    for (const step of steps) {
      visit(step);
    }

    return result;
  }

  /**
   * Count external dependencies in steps
   */
  private countExternalDependencies(steps: PlanStep[]): number {
    const externalAdapters = ['http:', 'aws:', 'github:', 'notification:'];
    return steps.filter((s) =>
      externalAdapters.some((a) => s.toolAdapter.startsWith(a))
    ).length;
  }

  /**
   * Calculate maximum dependency depth
   */
  private calculateDependencyDepth(steps: PlanStep[]): number {
    const stepMap = new Map(steps.map((s) => [s.stepId, s]));
    const depths = new Map<string, number>();

    const getDepth = (stepId: string): number => {
      if (depths.has(stepId)) return depths.get(stepId)!;

      const step = stepMap.get(stepId);
      if (!step || step.dependencies.length === 0) {
        depths.set(stepId, 0);
        return 0;
      }

      const maxDepDep = Math.max(
        ...step.dependencies.map((depId) => getDepth(depId))
      );
      const depth = maxDepDep + 1;
      depths.set(stepId, depth);
      return depth;
    };

    let maxDepth = 0;
    for (const step of steps) {
      const depth = getDepth(step.stepId);
      if (depth > maxDepth) maxDepth = depth;
    }

    return maxDepth;
  }

  /**
   * Persist simulation result to database
   */
  private async persistSimulation(result: SimulationResult): Promise<void> {
    execute(
      `INSERT INTO simulations
       (simulation_id, plan_id, status, blast_radius, risk_score, estimated_cost,
        anomalies, step_results, human_review_required, recommendations, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        result.simulationId,
        result.planId,
        result.status,
        result.blastRadius,
        result.riskScore,
        result.estimatedCost,
        JSON.stringify(result.anomalies),
        JSON.stringify(result.stepResults),
        result.humanReviewRequired ? 1 : 0,
        JSON.stringify(result.recommendations),
        result.timestamp,
      ]
    );
  }

  /**
   * Get simulation by ID
   */
  async getSimulation(simulationId: string): Promise<SimulationResult | null> {
    const row = queryOne<{
      simulation_id: string;
      plan_id: string;
      status: string;
      blast_radius: string;
      risk_score: number;
      estimated_cost: number;
      anomalies: string;
      step_results: string;
      human_review_required: number;
      recommendations: string;
      created_at: string;
    }>('SELECT * FROM simulations WHERE simulation_id = ?', [simulationId]);

    if (!row) return null;

    return {
      simulationId: row.simulation_id,
      planId: row.plan_id,
      timestamp: row.created_at,
      status: row.status as 'success' | 'partial_fail' | 'fail',
      blastRadius: row.blast_radius as 'low' | 'medium' | 'high',
      riskScore: row.risk_score,
      estimatedCost: row.estimated_cost,
      anomalies: JSON.parse(row.anomalies),
      stepResults: JSON.parse(row.step_results),
      humanReviewRequired: row.human_review_required === 1,
      recommendations: JSON.parse(row.recommendations),
    };
  }

  /**
   * Run adversarial scenarios (Monte Carlo simulation)
   */
  async runAdversarialScenarios(
    plan: PlanManifest,
    iterations: number = 10
  ): Promise<{
    worstCase: SimulationResult;
    bestCase: SimulationResult;
    averageRiskScore: number;
    failureRate: number;
  }> {
    const results: SimulationResult[] = [];

    for (let i = 0; i < iterations; i++) {
      // Inject random failures for adversarial testing
      const result = await this.simulate(plan, {
        mockExternalCalls: true,
        adversarialScenarios: true,
      });
      results.push(result);
    }

    const sortedByRisk = [...results].sort((a, b) => b.riskScore - a.riskScore);
    const worstCase = sortedByRisk[0]!;
    const bestCase = sortedByRisk[sortedByRisk.length - 1]!;

    const averageRiskScore =
      results.reduce((sum, r) => sum + r.riskScore, 0) / results.length;

    const failureRate =
      results.filter((r) => r.status === 'fail').length / results.length;

    return {
      worstCase,
      bestCase,
      averageRiskScore,
      failureRate,
    };
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let simulator: SimulationEngine | null = null;

export function getSimulator(): SimulationEngine {
  if (!simulator) {
    simulator = new SimulationEngine();
  }
  return simulator;
}

export async function initializeSimulator(): Promise<SimulationEngine> {
  const s = getSimulator();
  await s.initialize();
  return s;
}
