/**
 * AEGIS-T2A Adversarial Simulation Engine
 *
 * Performs Monte Carlo simulations with injected failures and adversarial
 * scenarios to evaluate worst-case behavior and system resilience.
 */

import { EventEmitter } from 'events';
import {
  PlanManifest,
  PlanStep,
  SimulationResult,
  RiskLevel,
} from '../core/types.js';
import { generateSimulationId, generateId } from '../core/ids.js';
import { componentLogger } from '../core/logger.js';

const logger = componentLogger('adversarial-simulator');

// =============================================================================
// Types
// =============================================================================

export interface AdversarialConfig {
  /** Number of Monte Carlo iterations */
  monte_carlo_iterations: number;
  /** Base failure probability for each step */
  base_failure_probability: number;
  /** Probability of cascading failures */
  cascade_probability: number;
  /** Enable network partition simulation */
  enable_network_partition: boolean;
  /** Enable resource exhaustion simulation */
  enable_resource_exhaustion: boolean;
  /** Enable timing attack simulation */
  enable_timing_attacks: boolean;
  /** Enable race condition simulation */
  enable_race_conditions: boolean;
  /** Enable data corruption simulation */
  enable_data_corruption: boolean;
  /** Maximum simulation time in milliseconds */
  max_simulation_time_ms: number;
  /** Confidence level for statistical analysis */
  confidence_level: number;
  /** Random seed for reproducibility (optional) */
  random_seed?: number;
}

export interface FailureScenario {
  id: string;
  name: string;
  description: string;
  category: FailureCategory;
  probability: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  affected_components: string[];
  recovery_possible: boolean;
  recovery_time_ms?: number;
}

export type FailureCategory =
  | 'network'
  | 'resource'
  | 'timing'
  | 'race_condition'
  | 'data_corruption'
  | 'external_dependency'
  | 'authentication'
  | 'authorization'
  | 'cascade'
  | 'partial_failure';

export interface AdversarialSimulationResult {
  simulation_id: string;
  plan_id: string;
  timestamp: string;
  config: AdversarialConfig;
  iterations_completed: number;
  total_time_ms: number;

  /** Statistical summary */
  statistics: SimulationStatistics;

  /** Individual iteration results */
  iteration_results: IterationResult[];

  /** Failure analysis */
  failure_analysis: FailureAnalysis;

  /** Resilience assessment */
  resilience: ResilienceAssessment;

  /** Recommendations */
  recommendations: AdversarialRecommendation[];

  /** Overall risk assessment */
  risk_assessment: AdversarialRiskAssessment;
}

export interface SimulationStatistics {
  success_rate: number;
  partial_failure_rate: number;
  complete_failure_rate: number;
  mean_risk_score: number;
  std_dev_risk_score: number;
  min_risk_score: number;
  max_risk_score: number;
  p95_risk_score: number;
  p99_risk_score: number;
  mean_completion_time_ms: number;
  mean_cost: number;
  max_cost: number;
}

export interface IterationResult {
  iteration: number;
  seed: number;
  status: 'success' | 'partial_fail' | 'fail';
  risk_score: number;
  completion_time_ms: number;
  cost: number;
  injected_failures: InjectedFailure[];
  step_results: StepIterationResult[];
  compensation_triggered: boolean;
  recovery_succeeded: boolean;
}

export interface InjectedFailure {
  step_id: string;
  scenario: FailureScenario;
  trigger_time_ms: number;
  recovered: boolean;
  recovery_time_ms?: number;
}

export interface StepIterationResult {
  step_id: string;
  status: 'success' | 'failed' | 'skipped' | 'timeout';
  execution_time_ms: number;
  failure_injected: boolean;
  failure_scenario?: string;
  retry_count: number;
}

export interface FailureAnalysis {
  most_vulnerable_steps: VulnerableStep[];
  failure_correlations: FailureCorrelation[];
  cascade_patterns: CascadePattern[];
  single_points_of_failure: string[];
  recovery_effectiveness: number;
}

export interface VulnerableStep {
  step_id: string;
  failure_rate: number;
  mean_recovery_time_ms: number;
  cascade_trigger_rate: number;
  criticality: 'low' | 'medium' | 'high' | 'critical';
}

export interface FailureCorrelation {
  step_a: string;
  step_b: string;
  correlation: number;
  direction: 'unidirectional' | 'bidirectional';
}

export interface CascadePattern {
  trigger_step: string;
  affected_steps: string[];
  cascade_probability: number;
  blast_radius: 'limited' | 'moderate' | 'wide' | 'total';
}

export interface ResilienceAssessment {
  overall_score: number;
  mttr_ms: number; // Mean Time To Recovery
  mtbf_ms: number; // Mean Time Between Failures
  availability: number;
  fault_tolerance_level: 'none' | 'basic' | 'moderate' | 'high' | 'very_high';
  recovery_capabilities: RecoveryCapability[];
}

export interface RecoveryCapability {
  capability: string;
  present: boolean;
  effectiveness: number;
  details: string;
}

export interface AdversarialRecommendation {
  priority: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  title: string;
  description: string;
  affected_steps: string[];
  estimated_improvement: number;
  implementation_complexity: 'low' | 'medium' | 'high';
}

export interface AdversarialRiskAssessment {
  worst_case_risk: RiskLevel;
  expected_risk: RiskLevel;
  confidence: number;
  variance: number;
  tail_risk: number; // Probability of worst-case scenarios
  recommendation: 'proceed' | 'proceed_with_caution' | 'require_review' | 'block';
}

// =============================================================================
// Default Configuration
// =============================================================================

export const defaultAdversarialConfig: AdversarialConfig = {
  monte_carlo_iterations: 100,
  base_failure_probability: 0.05,
  cascade_probability: 0.3,
  enable_network_partition: true,
  enable_resource_exhaustion: true,
  enable_timing_attacks: true,
  enable_race_conditions: true,
  enable_data_corruption: true,
  max_simulation_time_ms: 60000,
  confidence_level: 0.95,
};

// =============================================================================
// Built-in Failure Scenarios
// =============================================================================

const FAILURE_SCENARIOS: FailureScenario[] = [
  // Network failures
  {
    id: 'network-timeout',
    name: 'Network Timeout',
    description: 'Network request times out',
    category: 'network',
    probability: 0.1,
    severity: 'medium',
    affected_components: ['http', 'aws', 'github', 'external'],
    recovery_possible: true,
    recovery_time_ms: 5000,
  },
  {
    id: 'network-partition',
    name: 'Network Partition',
    description: 'Network becomes temporarily unavailable',
    category: 'network',
    probability: 0.02,
    severity: 'high',
    affected_components: ['all'],
    recovery_possible: true,
    recovery_time_ms: 30000,
  },
  {
    id: 'dns-failure',
    name: 'DNS Resolution Failure',
    description: 'DNS lookup fails',
    category: 'network',
    probability: 0.01,
    severity: 'medium',
    affected_components: ['http', 'external'],
    recovery_possible: true,
    recovery_time_ms: 10000,
  },

  // Resource failures
  {
    id: 'memory-exhaustion',
    name: 'Memory Exhaustion',
    description: 'System runs out of available memory',
    category: 'resource',
    probability: 0.01,
    severity: 'high',
    affected_components: ['all'],
    recovery_possible: true,
    recovery_time_ms: 60000,
  },
  {
    id: 'disk-full',
    name: 'Disk Full',
    description: 'Disk space exhausted',
    category: 'resource',
    probability: 0.005,
    severity: 'high',
    affected_components: ['file', 'database', 'audit'],
    recovery_possible: false,
  },
  {
    id: 'cpu-throttle',
    name: 'CPU Throttling',
    description: 'CPU resources throttled',
    category: 'resource',
    probability: 0.03,
    severity: 'medium',
    affected_components: ['all'],
    recovery_possible: true,
    recovery_time_ms: 10000,
  },
  {
    id: 'rate-limit-hit',
    name: 'Rate Limit Exceeded',
    description: 'External API rate limit reached',
    category: 'resource',
    probability: 0.08,
    severity: 'medium',
    affected_components: ['http', 'aws', 'github'],
    recovery_possible: true,
    recovery_time_ms: 60000,
  },

  // Timing issues
  {
    id: 'slow-response',
    name: 'Slow Response',
    description: 'Response takes significantly longer than expected',
    category: 'timing',
    probability: 0.15,
    severity: 'low',
    affected_components: ['all'],
    recovery_possible: true,
    recovery_time_ms: 0,
  },
  {
    id: 'deadline-exceeded',
    name: 'Deadline Exceeded',
    description: 'Operation exceeds its timeout',
    category: 'timing',
    probability: 0.05,
    severity: 'medium',
    affected_components: ['all'],
    recovery_possible: true,
    recovery_time_ms: 0,
  },

  // Race conditions
  {
    id: 'concurrent-modification',
    name: 'Concurrent Modification',
    description: 'Resource modified by another process',
    category: 'race_condition',
    probability: 0.03,
    severity: 'high',
    affected_components: ['database', 'file', 'aws'],
    recovery_possible: true,
    recovery_time_ms: 1000,
  },
  {
    id: 'lock-contention',
    name: 'Lock Contention',
    description: 'Resource lock held by another process',
    category: 'race_condition',
    probability: 0.02,
    severity: 'medium',
    affected_components: ['database', 'file'],
    recovery_possible: true,
    recovery_time_ms: 5000,
  },

  // Data corruption
  {
    id: 'checksum-mismatch',
    name: 'Checksum Mismatch',
    description: 'Data integrity check fails',
    category: 'data_corruption',
    probability: 0.005,
    severity: 'critical',
    affected_components: ['all'],
    recovery_possible: false,
  },
  {
    id: 'partial-write',
    name: 'Partial Write',
    description: 'Write operation completes partially',
    category: 'data_corruption',
    probability: 0.002,
    severity: 'critical',
    affected_components: ['file', 'database'],
    recovery_possible: true,
    recovery_time_ms: 0,
  },

  // External dependency failures
  {
    id: 'service-unavailable',
    name: 'Service Unavailable',
    description: 'External service returns 503',
    category: 'external_dependency',
    probability: 0.05,
    severity: 'medium',
    affected_components: ['http', 'aws', 'github'],
    recovery_possible: true,
    recovery_time_ms: 30000,
  },
  {
    id: 'api-version-mismatch',
    name: 'API Version Mismatch',
    description: 'External API version incompatibility',
    category: 'external_dependency',
    probability: 0.01,
    severity: 'high',
    affected_components: ['http', 'aws', 'github'],
    recovery_possible: false,
  },

  // Auth failures
  {
    id: 'token-expired',
    name: 'Token Expired',
    description: 'Authentication token has expired',
    category: 'authentication',
    probability: 0.02,
    severity: 'medium',
    affected_components: ['all'],
    recovery_possible: true,
    recovery_time_ms: 2000,
  },
  {
    id: 'permission-denied',
    name: 'Permission Denied',
    description: 'Insufficient permissions for operation',
    category: 'authorization',
    probability: 0.01,
    severity: 'high',
    affected_components: ['all'],
    recovery_possible: false,
  },

  // Cascade failures
  {
    id: 'cascade-trigger',
    name: 'Cascade Failure',
    description: 'Failure triggers cascading failures',
    category: 'cascade',
    probability: 0.01,
    severity: 'critical',
    affected_components: ['all'],
    recovery_possible: true,
    recovery_time_ms: 120000,
  },
];

// =============================================================================
// Random Number Generator (for reproducibility)
// =============================================================================

class SeededRandom {
  private seed: number;

  constructor(seed?: number) {
    this.seed = seed ?? Date.now();
  }

  next(): number {
    // Simple LCG
    this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
    return this.seed / 4294967296;
  }

  getSeed(): number {
    return this.seed;
  }
}

// =============================================================================
// Adversarial Simulation Engine
// =============================================================================

export class AdversarialSimulator extends EventEmitter {
  private config: AdversarialConfig;
  private failureScenarios: FailureScenario[];
  private initialized = false;

  constructor(config: Partial<AdversarialConfig> = {}) {
    super();
    this.config = { ...defaultAdversarialConfig, ...config };
    this.failureScenarios = [...FAILURE_SCENARIOS];
  }

  /**
   * Initialize the simulator
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.filterScenariosByConfig();
    this.initialized = true;
    logger.info('Adversarial simulator initialized');
  }

  /**
   * Filter scenarios based on config
   */
  private filterScenariosByConfig(): void {
    this.failureScenarios = FAILURE_SCENARIOS.filter((scenario) => {
      switch (scenario.category) {
        case 'network':
          return this.config.enable_network_partition;
        case 'resource':
          return this.config.enable_resource_exhaustion;
        case 'timing':
          return this.config.enable_timing_attacks;
        case 'race_condition':
          return this.config.enable_race_conditions;
        case 'data_corruption':
          return this.config.enable_data_corruption;
        default:
          return true;
      }
    });
  }

  /**
   * Run adversarial simulation
   */
  async runSimulation(
    plan: PlanManifest,
    config?: Partial<AdversarialConfig>
  ): Promise<AdversarialSimulationResult> {
    const startTime = Date.now();
    const simulationId = generateSimulationId();
    const mergedConfig = { ...this.config, ...config };

    logger.info(
      { simulationId, planId: plan.planId, iterations: mergedConfig.monte_carlo_iterations },
      'Starting adversarial simulation'
    );

    const iterationResults: IterationResult[] = [];
    const rng = new SeededRandom(mergedConfig.random_seed);

    // Run Monte Carlo iterations
    for (let i = 0; i < mergedConfig.monte_carlo_iterations; i++) {
      // Check time limit
      if (Date.now() - startTime > mergedConfig.max_simulation_time_ms) {
        logger.warn({ iteration: i }, 'Simulation time limit reached');
        break;
      }

      const iterationResult = await this.runIteration(plan, i, rng, mergedConfig);
      iterationResults.push(iterationResult);

      // Emit progress
      this.emit('iteration_complete', {
        simulation_id: simulationId,
        iteration: i,
        total: mergedConfig.monte_carlo_iterations,
        status: iterationResult.status,
      });
    }

    // Calculate statistics
    const statistics = this.calculateStatistics(iterationResults);

    // Analyze failures
    const failureAnalysis = this.analyzeFailures(plan, iterationResults);

    // Assess resilience
    const resilience = this.assessResilience(plan, iterationResults, failureAnalysis);

    // Generate recommendations
    const recommendations = this.generateRecommendations(
      plan,
      statistics,
      failureAnalysis,
      resilience
    );

    // Overall risk assessment
    const riskAssessment = this.assessRisk(statistics, failureAnalysis, resilience);

    const result: AdversarialSimulationResult = {
      simulation_id: simulationId,
      plan_id: plan.planId,
      timestamp: new Date().toISOString(),
      config: mergedConfig,
      iterations_completed: iterationResults.length,
      total_time_ms: Date.now() - startTime,
      statistics,
      iteration_results: iterationResults,
      failure_analysis: failureAnalysis,
      resilience,
      recommendations,
      risk_assessment: riskAssessment,
    };

    this.emit('simulation_complete', {
      simulation_id: simulationId,
      plan_id: plan.planId,
      risk_assessment: riskAssessment,
    });

    logger.info(
      {
        simulationId,
        planId: plan.planId,
        iterations: iterationResults.length,
        successRate: statistics.success_rate,
        meanRiskScore: statistics.mean_risk_score,
        durationMs: result.total_time_ms,
      },
      'Adversarial simulation completed'
    );

    return result;
  }

  /**
   * Run a single iteration
   */
  private async runIteration(
    plan: PlanManifest,
    iteration: number,
    rng: SeededRandom,
    config: AdversarialConfig
  ): Promise<IterationResult> {
    const iterationSeed = rng.getSeed();
    const injectedFailures: InjectedFailure[] = [];
    const stepResults: StepIterationResult[] = [];
    let totalCost = 0;
    let totalTime = 0;
    let compensationTriggered = false;
    let recoverySucceeded = true;

    const completedSteps = new Set<string>();
    const failedSteps = new Set<string>();

    // Topologically sort steps
    const executionOrder = this.topologicalSort(plan.steps);

    for (const step of executionOrder) {
      // Check dependencies
      const depsReady = step.dependencies.every((d) => completedSteps.has(d));
      if (!depsReady) {
        stepResults.push({
          step_id: step.stepId,
          status: 'skipped',
          execution_time_ms: 0,
          failure_injected: false,
          retry_count: 0,
        });
        continue;
      }

      // Determine if we inject a failure
      const shouldInjectFailure = rng.next() < config.base_failure_probability;
      let failureScenario: FailureScenario | undefined;

      if (shouldInjectFailure) {
        failureScenario = this.selectFailureScenario(step, rng);
      }

      // Simulate step execution
      const stepResult = this.simulateStepWithFailure(step, failureScenario, rng);
      stepResults.push(stepResult);

      if (failureScenario) {
        const recovered = failureScenario.recovery_possible && rng.next() < 0.7;
        injectedFailures.push({
          step_id: step.stepId,
          scenario: failureScenario,
          trigger_time_ms: totalTime,
          recovered,
          recovery_time_ms: recovered ? failureScenario.recovery_time_ms : undefined,
        });

        if (!recovered) {
          recoverySucceeded = false;
        }
      }

      totalTime += stepResult.execution_time_ms;

      if (stepResult.status === 'success') {
        completedSteps.add(step.stepId);
        totalCost += step.estimatedCost;
      } else {
        failedSteps.add(step.stepId);

        // Check for cascade
        if (rng.next() < config.cascade_probability) {
          // Mark dependent steps as likely to fail
          for (const otherStep of executionOrder) {
            if (otherStep.dependencies.includes(step.stepId)) {
              failedSteps.add(otherStep.stepId);
            }
          }
        }

        // Trigger compensation if step has side effects
        if (step.sideEffect && step.compensationAction) {
          compensationTriggered = true;
        }
      }
    }

    // Calculate overall status
    let status: 'success' | 'partial_fail' | 'fail';
    if (failedSteps.size === 0) {
      status = 'success';
    } else if (failedSteps.size === executionOrder.length) {
      status = 'fail';
    } else {
      status = 'partial_fail';
    }

    // Calculate risk score
    const riskScore = this.calculateIterationRiskScore(
      plan,
      stepResults,
      injectedFailures,
      completedSteps.size,
      failedSteps.size
    );

    return {
      iteration,
      seed: iterationSeed,
      status,
      risk_score: riskScore,
      completion_time_ms: totalTime,
      cost: totalCost,
      injected_failures: injectedFailures,
      step_results: stepResults,
      compensation_triggered: compensationTriggered,
      recovery_succeeded: recoverySucceeded,
    };
  }

  /**
   * Select a failure scenario for a step
   */
  private selectFailureScenario(
    step: PlanStep,
    rng: SeededRandom
  ): FailureScenario | undefined {
    const adapterType = step.toolAdapter.split(':')[0];

    // Filter applicable scenarios
    const applicable = this.failureScenarios.filter(
      (scenario) =>
        scenario.affected_components.includes('all') ||
        scenario.affected_components.includes(adapterType!)
    );

    if (applicable.length === 0) return undefined;

    // Weight by probability
    const totalWeight = applicable.reduce((sum, s) => sum + s.probability, 0);
    let random = rng.next() * totalWeight;

    for (const scenario of applicable) {
      random -= scenario.probability;
      if (random <= 0) {
        return scenario;
      }
    }

    return applicable[applicable.length - 1];
  }

  /**
   * Simulate step execution with potential failure
   */
  private simulateStepWithFailure(
    step: PlanStep,
    failure: FailureScenario | undefined,
    rng: SeededRandom
  ): StepIterationResult {
    const baseTime = step.estimatedDuration;
    const variability = 0.5 + rng.next() * 1.0; // 50% to 150%
    let executionTime = Math.round(baseTime * variability);

    if (failure) {
      // Apply failure effects
      switch (failure.category) {
        case 'timing':
          executionTime *= 3; // Triple the time
          break;
        case 'network':
          executionTime += failure.recovery_time_ms || 5000;
          break;
        case 'resource':
          executionTime += 10000;
          break;
      }

      // Determine if we retry
      const maxRetries = step.retryPolicy?.maxRetries ?? 3;
      const retryCount = failure.recovery_possible
        ? Math.floor(rng.next() * maxRetries)
        : 0;

      // After retries, determine final status
      const recovers = failure.recovery_possible && retryCount > 0 && rng.next() < 0.6;

      return {
        step_id: step.stepId,
        status: recovers ? 'success' : 'failed',
        execution_time_ms: executionTime + retryCount * 1000,
        failure_injected: true,
        failure_scenario: failure.id,
        retry_count: retryCount,
      };
    }

    return {
      step_id: step.stepId,
      status: 'success',
      execution_time_ms: executionTime,
      failure_injected: false,
      retry_count: 0,
    };
  }

  /**
   * Calculate risk score for an iteration
   */
  private calculateIterationRiskScore(
    plan: PlanManifest,
    stepResults: StepIterationResult[],
    failures: InjectedFailure[],
    completedCount: number,
    failedCount: number
  ): number {
    let score = 0;

    // Base score from plan risk
    const baseScores: Record<RiskLevel, number> = {
      'low': 10,
      'medium': 30,
      'high': 60,
      'destructive': 80,
    };

    for (const step of plan.steps) {
      const result = stepResults.find((r) => r.step_id === step.stepId);
      if (result?.status === 'failed') {
        score += baseScores[step.riskLevel] || 30;
      }
    }

    // Add score for critical failures
    const criticalFailures = failures.filter((f) => f.scenario.severity === 'critical');
    score += criticalFailures.length * 25;

    // Add score for unrecovered failures
    const unrecoveredFailures = failures.filter((f) => !f.recovered);
    score += unrecoveredFailures.length * 15;

    // Factor in completion rate
    const totalSteps = stepResults.length;
    const completionRate = totalSteps > 0 ? completedCount / totalSteps : 0;
    score += (1 - completionRate) * 30;

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Calculate statistics from iteration results
   */
  private calculateStatistics(results: IterationResult[]): SimulationStatistics {
    const successCount = results.filter((r) => r.status === 'success').length;
    const partialCount = results.filter((r) => r.status === 'partial_fail').length;
    const failCount = results.filter((r) => r.status === 'fail').length;

    const riskScores = results.map((r) => r.risk_score).sort((a, b) => a - b);
    const costs = results.map((r) => r.cost);
    const times = results.map((r) => r.completion_time_ms);

    const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const stdDev = (arr: number[]) => {
      const m = mean(arr);
      return Math.sqrt(arr.reduce((sum, x) => sum + Math.pow(x - m, 2), 0) / arr.length);
    };

    const percentile = (arr: number[], p: number) => {
      const idx = Math.ceil((p / 100) * arr.length) - 1;
      return arr[Math.max(0, idx)] ?? 0;
    };

    return {
      success_rate: results.length > 0 ? successCount / results.length : 0,
      partial_failure_rate: results.length > 0 ? partialCount / results.length : 0,
      complete_failure_rate: results.length > 0 ? failCount / results.length : 0,
      mean_risk_score: mean(riskScores),
      std_dev_risk_score: stdDev(riskScores),
      min_risk_score: riskScores[0] ?? 0,
      max_risk_score: riskScores[riskScores.length - 1] ?? 0,
      p95_risk_score: percentile(riskScores, 95),
      p99_risk_score: percentile(riskScores, 99),
      mean_completion_time_ms: mean(times),
      mean_cost: mean(costs),
      max_cost: Math.max(...costs, 0),
    };
  }

  /**
   * Analyze failures from iterations
   */
  private analyzeFailures(
    plan: PlanManifest,
    results: IterationResult[]
  ): FailureAnalysis {
    // Calculate failure rates per step
    const stepFailureCounts: Map<string, number> = new Map();
    const stepRecoveryTimes: Map<string, number[]> = new Map();
    const stepCascadeTriggers: Map<string, number> = new Map();

    for (const step of plan.steps) {
      stepFailureCounts.set(step.stepId, 0);
      stepRecoveryTimes.set(step.stepId, []);
      stepCascadeTriggers.set(step.stepId, 0);
    }

    for (const result of results) {
      for (const stepResult of result.step_results) {
        if (stepResult.status === 'failed') {
          stepFailureCounts.set(
            stepResult.step_id,
            (stepFailureCounts.get(stepResult.step_id) ?? 0) + 1
          );
        }
      }

      for (const failure of result.injected_failures) {
        if (failure.recovery_time_ms !== undefined) {
          const times = stepRecoveryTimes.get(failure.step_id) ?? [];
          times.push(failure.recovery_time_ms);
          stepRecoveryTimes.set(failure.step_id, times);
        }

        // Check if this failure triggered cascades
        if (failure.scenario.category === 'cascade') {
          stepCascadeTriggers.set(
            failure.step_id,
            (stepCascadeTriggers.get(failure.step_id) ?? 0) + 1
          );
        }
      }
    }

    // Build vulnerable steps list
    const mostVulnerableSteps: VulnerableStep[] = plan.steps
      .map((step) => {
        const failureCount = stepFailureCounts.get(step.stepId) ?? 0;
        const failureRate = results.length > 0 ? failureCount / results.length : 0;
        const recoveryTimes = stepRecoveryTimes.get(step.stepId) ?? [];
        const meanRecovery =
          recoveryTimes.length > 0
            ? recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length
            : 0;
        const cascadeTriggers = stepCascadeTriggers.get(step.stepId) ?? 0;

        return {
          step_id: step.stepId,
          failure_rate: failureRate,
          mean_recovery_time_ms: meanRecovery,
          cascade_trigger_rate: results.length > 0 ? cascadeTriggers / results.length : 0,
          criticality: this.determineCriticality(step, failureRate),
        };
      })
      .filter((v) => v.failure_rate > 0)
      .sort((a, b) => b.failure_rate - a.failure_rate)
      .slice(0, 10);

    // Find failure correlations
    const failureCorrelations = this.findFailureCorrelations(plan, results);

    // Identify cascade patterns
    const cascadePatterns = this.identifyCascadePatterns(plan, results);

    // Find single points of failure
    const singlePointsOfFailure = plan.steps
      .filter((step) => {
        // A step is a SPOF if many other steps depend on it
        const dependentCount = plan.steps.filter((s) =>
          s.dependencies.includes(step.stepId)
        ).length;
        return dependentCount >= plan.steps.length * 0.3;
      })
      .map((s) => s.stepId);

    // Calculate recovery effectiveness
    const totalFailures = results.reduce(
      (sum, r) => sum + r.injected_failures.length,
      0
    );
    const recoveredFailures = results.reduce(
      (sum, r) => sum + r.injected_failures.filter((f) => f.recovered).length,
      0
    );
    const recoveryEffectiveness =
      totalFailures > 0 ? recoveredFailures / totalFailures : 1;

    return {
      most_vulnerable_steps: mostVulnerableSteps,
      failure_correlations: failureCorrelations,
      cascade_patterns: cascadePatterns,
      single_points_of_failure: singlePointsOfFailure,
      recovery_effectiveness: recoveryEffectiveness,
    };
  }

  /**
   * Determine step criticality
   */
  private determineCriticality(
    step: PlanStep,
    failureRate: number
  ): 'low' | 'medium' | 'high' | 'critical' {
    if (step.riskLevel === 'destructive' || failureRate > 0.5) return 'critical';
    if (step.riskLevel === 'high' || failureRate > 0.3) return 'high';
    if (step.riskLevel === 'medium' || failureRate > 0.1) return 'medium';
    return 'low';
  }

  /**
   * Find failure correlations between steps
   */
  private findFailureCorrelations(
    plan: PlanManifest,
    results: IterationResult[]
  ): FailureCorrelation[] {
    const correlations: FailureCorrelation[] = [];
    const stepIds = plan.steps.map((s) => s.stepId);

    for (let i = 0; i < stepIds.length; i++) {
      for (let j = i + 1; j < stepIds.length; j++) {
        const stepA = stepIds[i]!;
        const stepB = stepIds[j]!;

        // Calculate co-failure rate
        let bothFailed = 0;
        let aFailed = 0;
        let bFailed = 0;

        for (const result of results) {
          const aResult = result.step_results.find((r) => r.step_id === stepA);
          const bResult = result.step_results.find((r) => r.step_id === stepB);

          if (aResult?.status === 'failed') aFailed++;
          if (bResult?.status === 'failed') bFailed++;
          if (aResult?.status === 'failed' && bResult?.status === 'failed') bothFailed++;
        }

        // Calculate correlation
        const n = results.length;
        if (aFailed > 0 && bFailed > 0) {
          const correlation = (bothFailed * n - aFailed * bFailed) /
            Math.sqrt(aFailed * (n - aFailed) * bFailed * (n - bFailed));

          if (!isNaN(correlation) && Math.abs(correlation) > 0.3) {
            correlations.push({
              step_a: stepA,
              step_b: stepB,
              correlation,
              direction: correlation > 0.5 ? 'unidirectional' : 'bidirectional',
            });
          }
        }
      }
    }

    return correlations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
  }

  /**
   * Identify cascade failure patterns
   */
  private identifyCascadePatterns(
    plan: PlanManifest,
    results: IterationResult[]
  ): CascadePattern[] {
    const patterns: CascadePattern[] = [];
    const stepDependents: Map<string, string[]> = new Map();

    // Build dependency graph
    for (const step of plan.steps) {
      for (const dep of step.dependencies) {
        const dependents = stepDependents.get(dep) ?? [];
        dependents.push(step.stepId);
        stepDependents.set(dep, dependents);
      }
    }

    // Find cascade triggers
    for (const step of plan.steps) {
      const dependents = stepDependents.get(step.stepId) ?? [];
      if (dependents.length === 0) continue;

      // Count how often this step's failure caused dependent failures
      let cascadeCount = 0;

      for (const result of results) {
        const stepResult = result.step_results.find((r) => r.step_id === step.stepId);
        if (stepResult?.status !== 'failed') continue;

        const dependentFailures = dependents.filter((depId) => {
          const depResult = result.step_results.find((r) => r.step_id === depId);
          return depResult?.status === 'failed' || depResult?.status === 'skipped';
        });

        if (dependentFailures.length === dependents.length) {
          cascadeCount++;
        }
      }

      const cascadeProbability = results.length > 0 ? cascadeCount / results.length : 0;
      if (cascadeProbability > 0.1) {
        const blastRadius =
          dependents.length > plan.steps.length * 0.5
            ? 'total'
            : dependents.length > plan.steps.length * 0.3
              ? 'wide'
              : dependents.length > plan.steps.length * 0.1
                ? 'moderate'
                : 'limited';

        patterns.push({
          trigger_step: step.stepId,
          affected_steps: dependents,
          cascade_probability: cascadeProbability,
          blast_radius: blastRadius,
        });
      }
    }

    return patterns.sort((a, b) => b.cascade_probability - a.cascade_probability);
  }

  /**
   * Assess system resilience
   */
  private assessResilience(
    plan: PlanManifest,
    results: IterationResult[],
    failureAnalysis: FailureAnalysis
  ): ResilienceAssessment {
    // Calculate MTTR (Mean Time To Recovery)
    const recoveryTimes = results
      .flatMap((r) => r.injected_failures)
      .filter((f) => f.recovered && f.recovery_time_ms)
      .map((f) => f.recovery_time_ms!);
    const mttr =
      recoveryTimes.length > 0
        ? recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length
        : 0;

    // Calculate MTBF (Mean Time Between Failures) - simulated
    const failureCounts = results.map(
      (r) => r.injected_failures.filter((f) => !f.recovered).length
    );
    const avgFailuresPerRun =
      failureCounts.length > 0
        ? failureCounts.reduce((a, b) => a + b, 0) / failureCounts.length
        : 0;
    const avgRunTime =
      results.length > 0
        ? results.reduce((sum, r) => sum + r.completion_time_ms, 0) / results.length
        : 0;
    const mtbf = avgFailuresPerRun > 0 ? avgRunTime / avgFailuresPerRun : avgRunTime * 10;

    // Calculate availability
    const availability = mtbf > 0 ? mtbf / (mtbf + mttr) : 0.99;

    // Assess fault tolerance level
    let faultToleranceLevel: 'none' | 'basic' | 'moderate' | 'high' | 'very_high';
    const hasRetries = plan.steps.some((s) => s.retryPolicy);
    const hasCompensation = plan.steps.some((s) => s.compensationAction);
    const compensationTriggered = results.some((r) => r.compensation_triggered);
    const compensationSucceeded = results.filter(
      (r) => r.compensation_triggered && r.recovery_succeeded
    ).length;

    if (!hasRetries && !hasCompensation) {
      faultToleranceLevel = 'none';
    } else if (hasRetries && !hasCompensation) {
      faultToleranceLevel = 'basic';
    } else if (hasCompensation && failureAnalysis.recovery_effectiveness < 0.5) {
      faultToleranceLevel = 'moderate';
    } else if (failureAnalysis.recovery_effectiveness >= 0.8) {
      faultToleranceLevel = 'very_high';
    } else {
      faultToleranceLevel = 'high';
    }

    // Calculate overall resilience score
    const resilienceScore =
      failureAnalysis.recovery_effectiveness * 40 +
      (1 - failureAnalysis.single_points_of_failure.length / Math.max(plan.steps.length, 1)) * 30 +
      availability * 30;

    // Assess recovery capabilities
    const recoveryCapabilities: RecoveryCapability[] = [
      {
        capability: 'Retry Logic',
        present: hasRetries,
        effectiveness: hasRetries ? 0.7 : 0,
        details: hasRetries ? 'Retry policies configured' : 'No retry policies defined',
      },
      {
        capability: 'Compensation Actions',
        present: hasCompensation,
        effectiveness: compensationTriggered
          ? compensationSucceeded / Math.max(results.filter((r) => r.compensation_triggered).length, 1)
          : hasCompensation ? 0.8 : 0,
        details: hasCompensation
          ? 'Compensation actions defined'
          : 'No compensation actions',
      },
      {
        capability: 'Idempotency',
        present: plan.steps.every((s) => s.idempotencyKey),
        effectiveness: plan.steps.filter((s) => s.idempotencyKey).length / plan.steps.length,
        details: `${plan.steps.filter((s) => s.idempotencyKey).length}/${plan.steps.length} steps have idempotency keys`,
      },
      {
        capability: 'Graceful Degradation',
        present: failureAnalysis.single_points_of_failure.length === 0,
        effectiveness: 1 - failureAnalysis.single_points_of_failure.length / Math.max(plan.steps.length, 1),
        details:
          failureAnalysis.single_points_of_failure.length === 0
            ? 'No single points of failure'
            : `${failureAnalysis.single_points_of_failure.length} single points of failure`,
      },
    ];

    return {
      overall_score: resilienceScore,
      mttr_ms: mttr,
      mtbf_ms: mtbf,
      availability,
      fault_tolerance_level: faultToleranceLevel,
      recovery_capabilities: recoveryCapabilities,
    };
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(
    plan: PlanManifest,
    statistics: SimulationStatistics,
    failureAnalysis: FailureAnalysis,
    resilience: ResilienceAssessment
  ): AdversarialRecommendation[] {
    const recommendations: AdversarialRecommendation[] = [];

    // High failure rate
    if (statistics.complete_failure_rate > 0.1) {
      recommendations.push({
        priority: 'critical',
        category: 'reliability',
        title: 'High Complete Failure Rate',
        description: `${(statistics.complete_failure_rate * 100).toFixed(1)}% of simulations resulted in complete failure. Consider adding redundancy and fallback mechanisms.`,
        affected_steps: failureAnalysis.most_vulnerable_steps.slice(0, 5).map((v) => v.step_id),
        estimated_improvement: 0.3,
        implementation_complexity: 'high',
      });
    }

    // Single points of failure
    if (failureAnalysis.single_points_of_failure.length > 0) {
      recommendations.push({
        priority: 'high',
        category: 'architecture',
        title: 'Single Points of Failure Detected',
        description: `${failureAnalysis.single_points_of_failure.length} steps are single points of failure that could take down the entire workflow.`,
        affected_steps: failureAnalysis.single_points_of_failure,
        estimated_improvement: 0.25,
        implementation_complexity: 'high',
      });
    }

    // Missing compensation
    const stepsWithoutCompensation = plan.steps.filter(
      (s) => s.sideEffect && !s.compensationAction
    );
    if (stepsWithoutCompensation.length > 0) {
      recommendations.push({
        priority: 'high',
        category: 'resilience',
        title: 'Missing Compensation Actions',
        description: `${stepsWithoutCompensation.length} steps have side effects but no compensation actions defined.`,
        affected_steps: stepsWithoutCompensation.map((s) => s.stepId),
        estimated_improvement: 0.2,
        implementation_complexity: 'medium',
      });
    }

    // Missing retry policies
    const stepsWithoutRetry = plan.steps.filter((s) => !s.retryPolicy);
    if (stepsWithoutRetry.length > plan.steps.length * 0.5) {
      recommendations.push({
        priority: 'medium',
        category: 'reliability',
        title: 'Missing Retry Policies',
        description: `${stepsWithoutRetry.length} steps lack retry policies for transient failures.`,
        affected_steps: stepsWithoutRetry.slice(0, 10).map((s) => s.stepId),
        estimated_improvement: 0.15,
        implementation_complexity: 'low',
      });
    }

    // High cascade risk
    const highCascadePatterns = failureAnalysis.cascade_patterns.filter(
      (p) => p.blast_radius === 'wide' || p.blast_radius === 'total'
    );
    if (highCascadePatterns.length > 0) {
      recommendations.push({
        priority: 'high',
        category: 'architecture',
        title: 'High Cascade Failure Risk',
        description: `${highCascadePatterns.length} steps can trigger wide or total cascade failures.`,
        affected_steps: highCascadePatterns.map((p) => p.trigger_step),
        estimated_improvement: 0.2,
        implementation_complexity: 'high',
      });
    }

    // Low recovery effectiveness
    if (failureAnalysis.recovery_effectiveness < 0.5) {
      recommendations.push({
        priority: 'medium',
        category: 'resilience',
        title: 'Low Recovery Effectiveness',
        description: `Only ${(failureAnalysis.recovery_effectiveness * 100).toFixed(1)}% of failures were successfully recovered.`,
        affected_steps: failureAnalysis.most_vulnerable_steps.map((v) => v.step_id),
        estimated_improvement: 0.2,
        implementation_complexity: 'medium',
      });
    }

    // High risk variance
    if (statistics.std_dev_risk_score > 20) {
      recommendations.push({
        priority: 'medium',
        category: 'predictability',
        title: 'High Risk Score Variance',
        description: `Risk scores vary significantly (std dev: ${statistics.std_dev_risk_score.toFixed(1)}), indicating unpredictable behavior.`,
        affected_steps: [],
        estimated_improvement: 0.1,
        implementation_complexity: 'high',
      });
    }

    return recommendations.sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  /**
   * Assess overall risk
   */
  private assessRisk(
    statistics: SimulationStatistics,
    failureAnalysis: FailureAnalysis,
    resilience: ResilienceAssessment
  ): AdversarialRiskAssessment {
    // Determine worst case risk level
    let worstCaseRisk: RiskLevel;
    if (statistics.max_risk_score >= 80) {
      worstCaseRisk = 'destructive';
    } else if (statistics.max_risk_score >= 60) {
      worstCaseRisk = 'high';
    } else if (statistics.max_risk_score >= 30) {
      worstCaseRisk = 'medium';
    } else {
      worstCaseRisk = 'low';
    }

    // Determine expected risk level
    let expectedRisk: RiskLevel;
    if (statistics.mean_risk_score >= 60) {
      expectedRisk = 'destructive';
    } else if (statistics.mean_risk_score >= 40) {
      expectedRisk = 'high';
    } else if (statistics.mean_risk_score >= 20) {
      expectedRisk = 'medium';
    } else {
      expectedRisk = 'low';
    }

    // Calculate confidence
    const confidence = 1 - statistics.std_dev_risk_score / 100;

    // Calculate variance
    const variance = Math.pow(statistics.std_dev_risk_score, 2);

    // Calculate tail risk (probability of worst case)
    const tailRisk = statistics.p99_risk_score >= 70 ? 0.01 : statistics.p95_risk_score >= 60 ? 0.05 : 0.01;

    // Determine recommendation
    let recommendation: 'proceed' | 'proceed_with_caution' | 'require_review' | 'block';
    if (
      statistics.complete_failure_rate > 0.2 ||
      worstCaseRisk === 'destructive' ||
      failureAnalysis.single_points_of_failure.length > 0
    ) {
      recommendation = 'block';
    } else if (
      statistics.complete_failure_rate > 0.1 ||
      expectedRisk === 'high' ||
      statistics.partial_failure_rate > 0.3
    ) {
      recommendation = 'require_review';
    } else if (
      statistics.partial_failure_rate > 0.1 ||
      expectedRisk === 'medium'
    ) {
      recommendation = 'proceed_with_caution';
    } else {
      recommendation = 'proceed';
    }

    return {
      worst_case_risk: worstCaseRisk,
      expected_risk: expectedRisk,
      confidence,
      variance,
      tail_risk: tailRisk,
      recommendation,
    };
  }

  /**
   * Topological sort of steps
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
   * Add custom failure scenario
   */
  addFailureScenario(scenario: FailureScenario): void {
    this.failureScenarios.push(scenario);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<AdversarialConfig>): void {
    this.config = { ...this.config, ...config };
    this.filterScenariosByConfig();
  }

  /**
   * Get configuration
   */
  getConfig(): AdversarialConfig {
    return { ...this.config };
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let simulator: AdversarialSimulator | null = null;

export function getAdversarialSimulator(): AdversarialSimulator {
  if (!simulator) {
    simulator = new AdversarialSimulator();
  }
  return simulator;
}

export async function initializeAdversarialSimulator(
  config?: Partial<AdversarialConfig>
): Promise<AdversarialSimulator> {
  const sim = config ? new AdversarialSimulator(config) : getAdversarialSimulator();
  await sim.initialize();
  simulator = sim;
  return sim;
}
