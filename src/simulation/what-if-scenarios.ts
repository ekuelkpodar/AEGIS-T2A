/**
 * What-If Scenario Testing
 *
 * Allows operators to test hypothetical scenarios before execution:
 * - "What if this step fails?"
 * - "What if we skip step X?"
 * - "What if resource Y is unavailable?"
 * - "What if we change parameter Z?"
 *
 * Features:
 * - Scenario branching and comparison
 * - Counterfactual analysis
 * - Impact prediction
 * - A/B testing for execution strategies
 */

import { EventEmitter } from 'events';
import { componentLogger } from '../core/logger.js';
import { generateId } from '../core/ids.js';
import type { PlanManifest, PlanStep } from '../core/types.js';
import { getShadowExecutor } from './shadow-executor.js';

const logger = componentLogger('what-if-scenarios');

// =============================================================================
// Types
// =============================================================================

export interface WhatIfScenario {
  scenarioId: string;
  name: string;
  description: string;
  basePlan: PlanManifest;
  modifications: ScenarioModification[];
  createdAt: Date;
  createdBy: string;
}

export interface ScenarioModification {
  type: 'fail_step' | 'skip_step' | 'modify_parameter' | 'add_resource_constraint' | 'change_order';
  target: string; // stepId or resourceId
  description: string;
  parameters: Record<string, unknown>;
}

export interface ScenarioResult {
  scenarioId: string;
  executionId: string;
  outcome: 'success' | 'failure' | 'partial';
  impactSummary: {
    stepsAffected: number;
    resourcesAffected: number;
    estimatedDuration: number;
    riskIncrease: number;
  };
  divergencePoints: DivergencePoint[];
  recommendations: string[];
  comparisonToBaseline?: ScenarioComparison;
}

export interface DivergencePoint {
  stepId: string;
  divergenceType: 'success_vs_failure' | 'parameter_change' | 'timing_difference';
  description: string;
  impact: 'negligible' | 'minor' | 'moderate' | 'significant';
}

export interface ScenarioComparison {
  baselineExecutionId: string;
  scenarioExecutionId: string;
  differences: {
    totalStepsDifferent: number;
    successRateDelta: number;
    durationDelta: number;
    riskScoreDelta: number;
  };
  betterChoice: 'baseline' | 'scenario' | 'equivalent';
  reasoning: string;
}

export interface WhatIfQuestion {
  question: string;
  scenarioType: 'failure' | 'optimization' | 'constraint' | 'alternative';
  suggestedModifications: ScenarioModification[];
}

// =============================================================================
// What-If Scenario Engine
// =============================================================================

export class WhatIfScenarioEngine extends EventEmitter {
  private scenarios = new Map<string, WhatIfScenario>();
  private results = new Map<string, ScenarioResult>();

  /**
   * Create a new what-if scenario
   */
  createScenario(
    name: string,
    description: string,
    basePlan: PlanManifest,
    modifications: ScenarioModification[],
    createdBy: string
  ): WhatIfScenario {
    const scenario: WhatIfScenario = {
      scenarioId: generateId(),
      name,
      description,
      basePlan,
      modifications,
      createdAt: new Date(),
      createdBy,
    };

    this.scenarios.set(scenario.scenarioId, scenario);

    logger.info(
      { scenarioId: scenario.scenarioId, name, modifications: modifications.length },
      'Created what-if scenario'
    );

    return scenario;
  }

  /**
   * Run what-if scenario
   */
  async runScenario(
    scenarioId: string,
    userId: string,
    compareToBaseline = true
  ): Promise<ScenarioResult> {
    const scenario = this.scenarios.get(scenarioId);

    if (!scenario) {
      throw new Error(`Scenario not found: ${scenarioId}`);
    }

    logger.info({ scenarioId, userId }, 'Running what-if scenario');

    // Apply modifications to create modified plan
    const modifiedPlan = this.applyModifications(scenario.basePlan, scenario.modifications);

    // Execute in shadow environment
    const shadowExecutor = getShadowExecutor();
    const executionResult = await shadowExecutor.execute(modifiedPlan, userId);

    // Analyze results
    const divergencePoints = this.analyzeDivergence(scenario, executionResult);

    const impactSummary = {
      stepsAffected: executionResult.executionTrace.filter(e => e.result !== 'success').length,
      resourcesAffected: new Set(executionResult.executionTrace.flatMap(e => e.resourcesMutated)).size,
      estimatedDuration: executionResult.totalDurationMs,
      riskIncrease: this.calculateRiskIncrease(scenario, executionResult),
    };

    const recommendations = this.generateRecommendations(scenario, executionResult, divergencePoints);

    let comparisonToBaseline: ScenarioComparison | undefined;

    if (compareToBaseline) {
      // Run baseline for comparison
      const baselineResult = await shadowExecutor.execute(scenario.basePlan, userId);

      comparisonToBaseline = this.compareResults(
        baselineResult.executionId,
        executionResult.executionId,
        baselineResult,
        executionResult
      );
    }

    const result: ScenarioResult = {
      scenarioId,
      executionId: executionResult.executionId,
      outcome: executionResult.status,
      impactSummary,
      divergencePoints,
      recommendations,
      comparisonToBaseline,
    };

    this.results.set(scenarioId, result);

    this.emit('scenario_complete', {
      scenarioId,
      outcome: result.outcome,
      stepsAffected: impactSummary.stepsAffected,
    });

    logger.info(
      {
        scenarioId,
        outcome: result.outcome,
        stepsAffected: impactSummary.stepsAffected,
        comparedToBaseline: !!comparisonToBaseline,
      },
      'What-if scenario completed'
    );

    return result;
  }

  /**
   * Suggest what-if questions based on plan
   */
  suggestQuestions(plan: PlanManifest): WhatIfQuestion[] {
    const questions: WhatIfQuestion[] = [];

    // Find high-risk steps
    const highRiskSteps = plan.steps.filter(s => s.riskLevel === 'high' || s.riskLevel === 'destructive');

    for (const step of highRiskSteps) {
      questions.push({
        question: `What if step "${step.action}" fails?`,
        scenarioType: 'failure',
        suggestedModifications: [
          {
            type: 'fail_step',
            target: step.stepId,
            description: `Force step ${step.stepId} to fail`,
            parameters: { reason: 'simulated_failure' },
          },
        ],
      });
    }

    // Find steps with compensation
    const compensatableSteps = plan.steps.filter(s => s.compensationAction);

    if (compensatableSteps.length > 0) {
      questions.push({
        question: `What if we skip optional steps with compensation?`,
        scenarioType: 'optimization',
        suggestedModifications: compensatableSteps.map(step => ({
          type: 'skip_step',
          target: step.stepId,
          description: `Skip step ${step.stepId} (has compensation)`,
          parameters: {},
        })),
      });
    }

    // Find parallel execution opportunities
    const independentSteps = plan.steps.filter(s => s.dependencies.length === 0);

    if (independentSteps.length > 2) {
      questions.push({
        question: `What if we reorder independent steps for better performance?`,
        scenarioType: 'optimization',
        suggestedModifications: [
          {
            type: 'change_order',
            target: 'plan',
            description: 'Reorder steps for parallelization',
            parameters: { strategy: 'parallelize_independent' },
          },
        ],
      });
    }

    return questions;
  }

  /**
   * Compare two scenarios
   */
  async compareScenarios(
    scenarioId1: string,
    scenarioId2: string,
    userId: string
  ): Promise<{
    scenario1: ScenarioResult;
    scenario2: ScenarioResult;
    comparison: string[];
    recommendation: string;
  }> {
    const result1 = await this.runScenario(scenarioId1, userId, false);
    const result2 = await this.runScenario(scenarioId2, userId, false);

    const comparison: string[] = [];

    // Compare outcomes
    if (result1.outcome !== result2.outcome) {
      comparison.push(`Outcome: Scenario 1 (${result1.outcome}) vs Scenario 2 (${result2.outcome})`);
    }

    // Compare steps affected
    if (result1.impactSummary.stepsAffected !== result2.impactSummary.stepsAffected) {
      comparison.push(
        `Steps Affected: Scenario 1 (${result1.impactSummary.stepsAffected}) vs Scenario 2 (${result2.impactSummary.stepsAffected})`
      );
    }

    // Compare duration
    const durationDiff = result1.impactSummary.estimatedDuration - result2.impactSummary.estimatedDuration;
    comparison.push(`Duration Difference: ${Math.abs(durationDiff)}ms (Scenario ${durationDiff > 0 ? '2' : '1'} faster)`);

    // Generate recommendation
    let recommendation = 'Both scenarios have similar outcomes.';

    if (result1.outcome === 'success' && result2.outcome !== 'success') {
      recommendation = 'Scenario 1 is recommended (successful execution).';
    } else if (result2.outcome === 'success' && result1.outcome !== 'success') {
      recommendation = 'Scenario 2 is recommended (successful execution).';
    } else if (result1.impactSummary.riskIncrease < result2.impactSummary.riskIncrease) {
      recommendation = 'Scenario 1 is recommended (lower risk increase).';
    } else if (result2.impactSummary.riskIncrease < result1.impactSummary.riskIncrease) {
      recommendation = 'Scenario 2 is recommended (lower risk increase).';
    }

    return {
      scenario1: result1,
      scenario2: result2,
      comparison,
      recommendation,
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Apply modifications to plan
   */
  private applyModifications(
    basePlan: PlanManifest,
    modifications: ScenarioModification[]
  ): PlanManifest {
    const modifiedPlan: PlanManifest = {
      ...basePlan,
      steps: [...basePlan.steps],
    };

    for (const mod of modifications) {
      switch (mod.type) {
        case 'fail_step':
          this.applyFailStep(modifiedPlan, mod);
          break;
        case 'skip_step':
          this.applySkipStep(modifiedPlan, mod);
          break;
        case 'modify_parameter':
          this.applyModifyParameter(modifiedPlan, mod);
          break;
        case 'change_order':
          this.applyChangeOrder(modifiedPlan, mod);
          break;
      }
    }

    return modifiedPlan;
  }

  /**
   * Apply fail step modification
   */
  private applyFailStep(plan: PlanManifest, mod: ScenarioModification): void {
    const stepIndex = plan.steps.findIndex(s => s.stepId === mod.target);

    if (stepIndex !== -1) {
      // Mark step to fail by injecting failure simulation metadata
      plan.steps[stepIndex] = {
        ...plan.steps[stepIndex]!,
        parameters: {
          ...plan.steps[stepIndex]!.parameters,
          __simulateFailure: true,
          __failureReason: mod.parameters['reason'] || 'simulated',
        },
      };
    }
  }

  /**
   * Apply skip step modification
   */
  private applySkipStep(plan: PlanManifest, mod: ScenarioModification): void {
    plan.steps = plan.steps.filter(s => s.stepId !== mod.target);
  }

  /**
   * Apply parameter modification
   */
  private applyModifyParameter(plan: PlanManifest, mod: ScenarioModification): void {
    const stepIndex = plan.steps.findIndex(s => s.stepId === mod.target);

    if (stepIndex !== -1) {
      plan.steps[stepIndex] = {
        ...plan.steps[stepIndex]!,
        parameters: {
          ...plan.steps[stepIndex]!.parameters,
          ...mod.parameters,
        },
      };
    }
  }

  /**
   * Apply change order modification
   */
  private applyChangeOrder(plan: PlanManifest, mod: ScenarioModification): void {
    const strategy = mod.parameters['strategy'] as string;

    if (strategy === 'parallelize_independent') {
      // Move independent steps to front
      const independent = plan.steps.filter(s => s.dependencies.length === 0);
      const dependent = plan.steps.filter(s => s.dependencies.length > 0);
      plan.steps = [...independent, ...dependent];
    }
  }

  /**
   * Analyze divergence from baseline
   */
  private analyzeDivergence(
    _scenario: WhatIfScenario,
    _executionResult: any
  ): DivergencePoint[] {
    // Simplified for demonstration
    return [];
  }

  /**
   * Calculate risk increase
   */
  private calculateRiskIncrease(_scenario: WhatIfScenario, executionResult: any): number {
    return executionResult.failedSteps > 0 ? 0.3 : 0;
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(
    _scenario: WhatIfScenario,
    executionResult: any,
    _divergencePoints: DivergencePoint[]
  ): string[] {
    const recommendations: string[] = [];

    if (executionResult.status === 'success') {
      recommendations.push('Scenario executed successfully. Consider this alternative approach.');
    } else {
      recommendations.push('Scenario resulted in failures. Review modifications before production.');
    }

    if (executionResult.resourceConflicts?.length > 0) {
      recommendations.push(`${executionResult.resourceConflicts.length} resource conflicts detected.`);
    }

    return recommendations;
  }

  /**
   * Compare execution results
   */
  private compareResults(
    baselineId: string,
    scenarioId: string,
    baseline: any,
    scenario: any
  ): ScenarioComparison {
    const differences = {
      totalStepsDifferent: Math.abs(baseline.executedSteps - scenario.executedSteps),
      successRateDelta:
        scenario.successfulSteps / scenario.executedSteps -
        baseline.successfulSteps / baseline.executedSteps,
      durationDelta: scenario.totalDurationMs - baseline.totalDurationMs,
      riskScoreDelta: scenario.confidenceScore - baseline.confidenceScore,
    };

    let betterChoice: 'baseline' | 'scenario' | 'equivalent' = 'equivalent';
    let reasoning = 'Both approaches have similar outcomes.';

    if (scenario.status === 'success' && baseline.status !== 'success') {
      betterChoice = 'scenario';
      reasoning = 'Scenario approach succeeded while baseline failed.';
    } else if (baseline.status === 'success' && scenario.status !== 'success') {
      betterChoice = 'baseline';
      reasoning = 'Baseline approach succeeded while scenario failed.';
    } else if (differences.successRateDelta > 0.1) {
      betterChoice = 'scenario';
      reasoning = 'Scenario has significantly higher success rate.';
    } else if (differences.successRateDelta < -0.1) {
      betterChoice = 'baseline';
      reasoning = 'Baseline has significantly higher success rate.';
    }

    return {
      baselineExecutionId: baselineId,
      scenarioExecutionId: scenarioId,
      differences,
      betterChoice,
      reasoning,
    };
  }

  /**
   * Get scenario by ID
   */
  getScenario(scenarioId: string): WhatIfScenario | undefined {
    return this.scenarios.get(scenarioId);
  }

  /**
   * Get result by scenario ID
   */
  getResult(scenarioId: string): ScenarioResult | undefined {
    return this.results.get(scenarioId);
  }

  /**
   * List all scenarios
   */
  listScenarios(): WhatIfScenario[] {
    return Array.from(this.scenarios.values());
  }
}

// =============================================================================
// Singleton
// =============================================================================

let scenarioEngine: WhatIfScenarioEngine | null = null;

export function getWhatIfScenarioEngine(): WhatIfScenarioEngine {
  if (!scenarioEngine) {
    scenarioEngine = new WhatIfScenarioEngine();
  }
  return scenarioEngine;
}
