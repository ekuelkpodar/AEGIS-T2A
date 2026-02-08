/**
 * AEGIS-T2A Planner Agent
 *
 * Converts typed intents into executable plan manifests.
 */

import { z } from 'zod';
import {
  TypedIntent,
  PlanManifest,
  PlanStep,
  CompensationAction,
  RiskLevel,
} from '../core/types.js';
import {
  generatePlanId,
  generateStepId,
  generateStepIdempotencyKey,
  generateCompensationIdempotencyKey,
} from '../core/ids.js';
import { componentLogger, logPlan } from '../core/logger.js';
import { computePlanChecksum, signObject } from '../core/crypto.js';
import { execute, queryOne, queryAll } from '../core/database.js';
import { getConfig } from '../core/config.js';
import Anthropic from '@anthropic-ai/sdk';

const logger = componentLogger('planner');

// =============================================================================
// Types
// =============================================================================

export interface PlanningResult {
  success: boolean;
  plan?: PlanManifest;
  error?: string;
  warnings?: string[];
}

interface LLMPlanStep {
  action: string;
  description: string;
  toolAdapter: string;
  parameters: Record<string, unknown>;
  targetResource?: string;
  hasSideEffects: boolean;
  estimatedCost: number;
  estimatedDurationSeconds: number;
  riskLevel: 'low' | 'medium' | 'high' | 'destructive';
  dependencies: number[];
  compensationAction?: {
    action: string;
    parameters: Record<string, unknown>;
  };
}

// =============================================================================
// LLM Client
// =============================================================================

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    const config = getConfig();
    if (!config.anthropicApiKey) {
      throw new Error('Anthropic API key not configured');
    }
    anthropicClient = new Anthropic({
      apiKey: config.anthropicApiKey,
    });
  }
  return anthropicClient;
}

// =============================================================================
// Planning Prompt
// =============================================================================

const PLANNING_PROMPT = `You are a task planner for AEGIS-T2A, a secure automation platform.
Your job is to decompose user intents into a sequence of executable steps.

Each step must specify:
1. action: The operation to perform
2. description: Human-readable description
3. toolAdapter: The tool/adapter to use (e.g., "aws:ec2", "github:api", "http:request", "shell:command")
4. parameters: Parameters for the tool
5. targetResource: The resource being acted upon (optional)
6. hasSideEffects: Whether this step modifies state (true/false)
7. estimatedCost: Estimated cost in USD
8. estimatedDurationSeconds: Estimated time to complete
9. riskLevel: "low", "medium", "high", or "destructive"
10. dependencies: Array of step indices this step depends on (0-indexed)
11. compensationAction: For side-effect steps, how to undo (optional but recommended)

Available tool adapters:
- http:request - Make HTTP API calls
- shell:command - Execute shell commands
- aws:* - AWS services (ec2, s3, lambda, rds, etc.)
- github:api - GitHub API operations
- database:query - Database operations
- file:* - File system operations
- notification:* - Send notifications (email, slack, etc.)
- webhook:invoke - Invoke external webhooks
- zapier:mcp - Execute Zapier MCP actions

Guidelines:
- Break complex tasks into atomic, idempotent steps
- Include compensation actions for all side-effect steps
- Order steps respecting dependencies
- Estimate costs conservatively
- Assign appropriate risk levels
- Keep steps granular for better rollback capability

Respond with a JSON array of steps:
[
  {
    "action": "string",
    "description": "string",
    "toolAdapter": "string",
    "parameters": {},
    "targetResource": "string or null",
    "hasSideEffects": boolean,
    "estimatedCost": number,
    "estimatedDurationSeconds": number,
    "riskLevel": "low|medium|high|destructive",
    "dependencies": [number],
    "compensationAction": { "action": "string", "parameters": {} } or null
  }
]`;

const LLMPlanStepSchema = z.object({
  action: z.string(),
  description: z.string(),
  toolAdapter: z.string(),
  parameters: z.record(z.unknown()),
  targetResource: z.string().optional().transform(v => v ?? undefined),
  hasSideEffects: z.boolean(),
  estimatedCost: z.number().min(0),
  estimatedDurationSeconds: z.number().int().min(0),
  riskLevel: z.enum(['low', 'medium', 'high', 'destructive']),
  dependencies: z.array(z.number().int().min(0)),
  compensationAction: z.object({
    action: z.string(),
    parameters: z.record(z.unknown()),
  }).optional(),
});

const LLMPlanResponseSchema = z.array(LLMPlanStepSchema);

// =============================================================================
// Planner Agent
// =============================================================================

export class PlannerAgent {
  private initialized = false;

  /**
   * Initialize the planner
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    logger.info('Planner agent initialized');
  }

  /**
   * Generate a plan from a typed intent
   */
  async generatePlan(intent: TypedIntent): Promise<PlanningResult> {
    const startTime = Date.now();
    logPlan('generating', 'plan_started', { intentId: intent.intentId });

    try {
      // Get LLM to generate plan steps
      const llmSteps = await this.generateStepsWithLLM(intent);

      if (!llmSteps || llmSteps.length === 0) {
        return {
          success: false,
          error: 'Failed to generate plan steps',
        };
      }

      // Convert to PlanSteps
      const planId = generatePlanId();
      const now = new Date().toISOString();
      const warnings: string[] = [];

      const steps: PlanStep[] = llmSteps.map((llmStep, index) => {
        const stepId = generateStepId();

        // Validate compensation for side-effect steps
        if (llmStep.hasSideEffects && !llmStep.compensationAction) {
          warnings.push(
            `Step ${index + 1} (${llmStep.action}) has side effects but no compensation action`
          );
        }

        // Build compensation action if provided
        let compensation: CompensationAction | undefined;
        if (llmStep.compensationAction) {
          compensation = {
            action: llmStep.compensationAction.action,
            toolAdapter: llmStep.toolAdapter,
            parameters: llmStep.compensationAction.parameters,
            idempotencyKey: generateCompensationIdempotencyKey(planId, stepId),
          };
        }

        // Map dependencies from indices to step IDs
        const dependencyIds: string[] = [];
        // Dependencies will be resolved after all steps are created

        const step: PlanStep = {
          stepId,
          planId,
          sequenceNumber: index,
          action: llmStep.action,
          description: llmStep.description,
          toolAdapter: llmStep.toolAdapter,
          parameters: llmStep.parameters,
          targetResource: llmStep.targetResource ?? undefined,
          sideEffect: llmStep.hasSideEffects,
          compensationAction: compensation,
          dependencies: dependencyIds,
          requiredCapabilities: this.extractCapabilities(llmStep.toolAdapter),
          idempotencyKey: generateStepIdempotencyKey(planId, stepId, 1),
          estimatedCost: llmStep.estimatedCost,
          estimatedDuration: llmStep.estimatedDurationSeconds * 1000,
          riskLevel: llmStep.riskLevel,
          approvalRequired: this.requiresApproval(llmStep.riskLevel, intent),
          timeout: Math.max(llmStep.estimatedDurationSeconds * 2000, 60000),
          retryPolicy: {
            maxRetries: llmStep.hasSideEffects ? 1 : 3,
            backoffMs: 1000,
            backoffMultiplier: 2,
          },
        };

        return step;
      });

      // Resolve dependencies (convert indices to step IDs)
      for (let i = 0; i < steps.length; i++) {
        const llmStep = llmSteps[i];
        if (llmStep) {
          const step = steps[i];
          if (step) {
            step.dependencies = llmStep.dependencies
              .filter((depIdx) => depIdx < i && depIdx >= 0)
              .map((depIdx) => steps[depIdx]?.stepId)
              .filter((id): id is string => id !== undefined);
          }
        }
      }

      // Calculate totals
      const totalCost = steps.reduce((sum, s) => sum + s.estimatedCost, 0);
      const totalDuration = this.calculateTotalDuration(steps, llmSteps);
      const maxRisk = this.calculateMaxRisk(steps);

      // Build plan manifest
      const plan: PlanManifest = {
        planId,
        intentId: intent.intentId,
        version: 1,
        createdAt: now,
        updatedAt: now,
        steps,
        totalEstimatedCost: totalCost,
        totalEstimatedDuration: totalDuration,
        riskLevel: maxRisk,
        approvalRequired: maxRisk !== 'low' || intent.approvalRequired,
        checksum: '',
        signature: undefined,
      };

      // Compute checksum and sign
      plan.checksum = computePlanChecksum(plan);
      plan.signature = signObject(plan);

      // Persist the plan
      await this.persistPlan(plan);

      logPlan(planId, 'plan_generated', {
        intentId: intent.intentId,
        stepCount: steps.length,
        totalCost,
        riskLevel: maxRisk,
        planningTimeMs: Date.now() - startTime,
      });

      return {
        success: true,
        plan,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      logger.error({ error, intentId: intent.intentId }, 'Plan generation failed');

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Plan generation failed',
      };
    }
  }

  /**
   * Generate plan steps using LLM
   */
  private async generateStepsWithLLM(intent: TypedIntent): Promise<LLMPlanStep[]> {
    const client = getAnthropicClient();

    const intentContext = `
Intent ID: ${intent.intentId}
Action Type: ${intent.actionType}
Risk Level: ${intent.riskLevel}
Budget Limit: $${intent.budget.limit}
Required Capabilities: ${intent.requiredCapabilities.join(', ') || 'None specified'}
Has Side Effects: ${intent.sideEffect}

User Request: "${intent.nlText}"

Additional Context:
${JSON.stringify(intent.metadata ?? {}, null, 2)}
`;

    const response = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `${PLANNING_PROMPT}\n\n${intentContext}`,
        },
      ],
    });

    const content = response.content[0];
    if (!content || content.type !== 'text') {
      throw new Error('Unexpected response type from LLM');
    }

    // Extract JSON array from response
    const jsonMatch = (content as { type: 'text'; text: string }).text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('No valid JSON array found in LLM response');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return LLMPlanResponseSchema.parse(parsed) as LLMPlanStep[];
  }

  /**
   * Extract required capabilities from tool adapter string
   */
  private extractCapabilities(toolAdapter: string): string[] {
    const parts = toolAdapter.split(':');
    if (parts.length >= 2) {
      return [`${parts[0]}:${parts[1]}`];
    }
    return [toolAdapter];
  }

  /**
   * Determine if a step requires approval
   */
  private requiresApproval(riskLevel: RiskLevel, intent: TypedIntent): boolean {
    if (intent.approvalRequired) return true;
    return riskLevel === 'high' || riskLevel === 'destructive';
  }

  /**
   * Calculate total duration considering parallelism
   */
  private calculateTotalDuration(steps: PlanStep[], _llmSteps: LLMPlanStep[]): number {
    // Simple calculation: sum of all durations (conservative)
    // A more sophisticated version would analyze the dependency graph
    return steps.reduce((sum, s) => sum + s.estimatedDuration, 0);
  }

  /**
   * Calculate the maximum risk level across all steps
   */
  private calculateMaxRisk(steps: PlanStep[]): RiskLevel {
    const riskOrder: RiskLevel[] = ['low', 'medium', 'high', 'destructive'];
    let maxIdx = 0;

    for (const step of steps) {
      const idx = riskOrder.indexOf(step.riskLevel);
      if (idx > maxIdx) maxIdx = idx;
    }

    return riskOrder[maxIdx] ?? 'low';
  }

  /**
   * Persist a plan to the database
   */
  private async persistPlan(plan: PlanManifest): Promise<void> {
    execute(
      `INSERT INTO plans
       (plan_id, intent_id, version, steps, total_estimated_cost, total_estimated_duration,
        risk_level, approval_required, checksum, signature, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        plan.planId,
        plan.intentId,
        plan.version,
        JSON.stringify(plan.steps),
        plan.totalEstimatedCost,
        plan.totalEstimatedDuration,
        plan.riskLevel,
        plan.approvalRequired ? 1 : 0,
        plan.checksum,
        plan.signature ?? null,
        plan.createdAt,
        plan.updatedAt,
      ]
    );
  }

  /**
   * Get a plan by ID
   */
  async getPlan(planId: string): Promise<PlanManifest | null> {
    const row = queryOne<{
      plan_id: string;
      intent_id: string;
      version: number;
      steps: string;
      total_estimated_cost: number;
      total_estimated_duration: number;
      risk_level: string;
      approval_required: number;
      checksum: string;
      signature: string | null;
      created_at: string;
      updated_at: string;
    }>('SELECT * FROM plans WHERE plan_id = ?', [planId]);

    if (!row) return null;

    return {
      planId: row.plan_id,
      intentId: row.intent_id,
      version: row.version,
      steps: JSON.parse(row.steps) as PlanStep[],
      totalEstimatedCost: row.total_estimated_cost,
      totalEstimatedDuration: row.total_estimated_duration,
      riskLevel: row.risk_level as RiskLevel,
      approvalRequired: row.approval_required === 1,
      checksum: row.checksum,
      signature: row.signature ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Get plans by intent ID
   */
  async getPlansByIntent(intentId: string): Promise<PlanManifest[]> {
    const rows = queryAll<{
      plan_id: string;
      intent_id: string;
      version: number;
      steps: string;
      total_estimated_cost: number;
      total_estimated_duration: number;
      risk_level: string;
      approval_required: number;
      checksum: string;
      signature: string | null;
      created_at: string;
      updated_at: string;
    }>('SELECT * FROM plans WHERE intent_id = ? ORDER BY version DESC', [intentId]);

    return rows.map((row) => ({
      planId: row.plan_id,
      intentId: row.intent_id,
      version: row.version,
      steps: JSON.parse(row.steps) as PlanStep[],
      totalEstimatedCost: row.total_estimated_cost,
      totalEstimatedDuration: row.total_estimated_duration,
      riskLevel: row.risk_level as RiskLevel,
      approvalRequired: row.approval_required === 1,
      checksum: row.checksum,
      signature: row.signature ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Create a new version of a plan
   */
  async createPlanVersion(
    basePlanId: string,
    modifications: Partial<{ steps: PlanStep[] }>
  ): Promise<PlanningResult> {
    const basePlan = await this.getPlan(basePlanId);
    if (!basePlan) {
      return { success: false, error: 'Base plan not found' };
    }

    const now = new Date().toISOString();
    const newPlanId = generatePlanId();
    const newVersion = basePlan.version + 1;

    const steps = modifications.steps ?? basePlan.steps;

    // Update step IDs and idempotency keys for new version
    const updatedSteps = steps.map((step, _index) => ({
      ...step,
      planId: newPlanId,
      idempotencyKey: generateStepIdempotencyKey(newPlanId, step.stepId, newVersion),
    }));

    const newPlan: PlanManifest = {
      ...basePlan,
      planId: newPlanId,
      version: newVersion,
      steps: updatedSteps,
      createdAt: now,
      updatedAt: now,
      checksum: '',
    };

    newPlan.checksum = computePlanChecksum(newPlan);
    newPlan.signature = signObject(newPlan);

    await this.persistPlan(newPlan);

    return { success: true, plan: newPlan };
  }

  /**
   * Validate a plan's integrity
   */
  validatePlan(plan: PlanManifest): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Verify checksum
    const expectedChecksum = computePlanChecksum(plan);
    if (plan.checksum !== expectedChecksum) {
      errors.push('Plan checksum mismatch - plan may have been tampered with');
    }

    // Validate step dependencies
    const stepIds = new Set(plan.steps.map((s) => s.stepId));
    for (const step of plan.steps) {
      for (const depId of step.dependencies) {
        if (!stepIds.has(depId)) {
          errors.push(`Step ${step.stepId} has invalid dependency: ${depId}`);
        }
      }
    }

    // Check for circular dependencies
    if (this.hasCircularDependencies(plan.steps)) {
      errors.push('Plan contains circular dependencies');
    }

    // Validate side-effect steps have compensation
    for (const step of plan.steps) {
      if (step.sideEffect && !step.compensationAction) {
        errors.push(`Step ${step.stepId} has side effects but no compensation action`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Check for circular dependencies in steps
   */
  private hasCircularDependencies(steps: PlanStep[]): boolean {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const stepMap = new Map(steps.map((s) => [s.stepId, s]));

    const dfs = (stepId: string): boolean => {
      visited.add(stepId);
      recursionStack.add(stepId);

      const step = stepMap.get(stepId);
      if (step) {
        for (const depId of step.dependencies) {
          if (!visited.has(depId)) {
            if (dfs(depId)) return true;
          } else if (recursionStack.has(depId)) {
            return true;
          }
        }
      }

      recursionStack.delete(stepId);
      return false;
    };

    for (const step of steps) {
      if (!visited.has(step.stepId)) {
        if (dfs(step.stepId)) return true;
      }
    }

    return false;
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let planner: PlannerAgent | null = null;

export function getPlanner(): PlannerAgent {
  if (!planner) {
    planner = new PlannerAgent();
  }
  return planner;
}

export async function initializePlanner(): Promise<PlannerAgent> {
  const p = getPlanner();
  await p.initialize();
  return p;
}

// Compensation Feasibility Validation
export {
  CompensationFeasibilityValidator,
  getCompensationFeasibilityValidator,
  initializeCompensationFeasibilityValidator,
  defaultFeasibilityConfig,
  UnrecoverablePlanError,
} from './compensation-feasibility-validator.js';
export type {
  FeasibilityValidatorConfig,
  CompensationValidationResult,
  CompensationValidationReport,
  SimulationContext,
  SimulationResult,
  SemanticPair,
} from './compensation-feasibility-validator.js';

// Blast Radius Analysis
export {
  BlastRadiusAnalyzer,
  getBlastRadiusAnalyzer,
  initializeBlastRadiusAnalyzer,
  defaultBlastRadiusConfig,
  formatBlastRadiusSummary,
} from './blast-radius-analyzer.js';
export type {
  BlastRadiusConfig,
  BlastRadiusAnalysisReport,
  StepBlastRadius,
  BlastRadiusMetrics,
  CascadingPath,
  ResourceMetadata,
  BlastRadiusThreshold,
  AnalysisContext,
  BlastRadiusSize,
  DataSensitivityTier,
  SystemCriticalityTier,
} from './blast-radius-analyzer.js';
