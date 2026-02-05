/**
 * AEGIS-T2A Quantitative Blast Radius Engine
 *
 * Generates metric-based impact assessments during simulation phase.
 * Provides human-readable summaries for approvers and machine-readable
 * data for policy enforcement.
 */

import { EventEmitter } from 'events';
import {
  PlanManifest,
  PlanStep,
  RiskLevel,
} from '../core/types.js';
import { componentLogger } from '../core/logger.js';
import { hashObject } from '../core/crypto.js';
import { generateId } from '../core/ids.js';

const logger = componentLogger('blast-radius-analyzer');

// =============================================================================
// Types
// =============================================================================

export interface BlastRadiusConfig {
  /** Enable cascading failure analysis */
  analyze_cascading_failures: boolean;
  /** Maximum depth for dependency analysis */
  max_dependency_depth: number;
  /** Enable user impact estimation */
  estimate_user_impact: boolean;
  /** Enable recovery time estimation */
  estimate_recovery_time: boolean;
  /** Default data sensitivity for unknown resources */
  default_data_sensitivity: DataSensitivityTier;
  /** Default system criticality for unknown resources */
  default_system_criticality: SystemCriticalityTier;
}

export type DataSensitivityTier = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
export type SystemCriticalityTier = 'TIER_1' | 'TIER_2' | 'TIER_3' | 'NON_CRITICAL';
export type BlastRadiusSize = 'LIMITED' | 'MODERATE' | 'WIDE' | 'TOTAL';

export interface BlastRadiusMetrics {
  /** Estimated users impacted */
  affected_user_count?: number;
  /** Downstream systems affected */
  affected_system_count?: number;
  /** Highest data sensitivity tier touched */
  data_sensitivity_tier: DataSensitivityTier;
  /** Approximate data volume affected (bytes) */
  data_volume_bytes?: number;
  /** System criticality tier */
  system_criticality: SystemCriticalityTier;
  /** Cascading failure paths identified */
  cascading_failure_paths: CascadingPath[];
  /** Estimated recovery time in seconds */
  recovery_time_estimate_seconds?: number;
  /** Overall blast radius size */
  blast_radius_size: BlastRadiusSize;
  /** Cryptographic binding for integrity */
  metrics_hash: string;
}

export interface CascadingPath {
  trigger_resource: string;
  affected_resources: string[];
  path_description: string;
  cascade_probability: number;
  impact_severity: RiskLevel;
}

export interface BlastRadiusAnalysisReport {
  workflow_id: string;
  plan_id: string;
  step_analyses: Map<string, StepBlastRadius>;
  aggregate_metrics: BlastRadiusMetrics;
  analysis_timestamp: string;
  analysis_session_id: string;
  recommendations: BlastRadiusRecommendation[];
  report_hash: string;
}

export interface StepBlastRadius {
  step_id: string;
  action: string;
  target_resources: ResourceTarget[];
  metrics: BlastRadiusMetrics;
  resource_metadata: ResourceMetadata[];
}

export interface ResourceTarget {
  type: string;
  identifier: string;
  environment?: string;
}

export interface ResourceMetadata {
  resource_type: string;
  resource_identifier: string;
  environment: string;
  user_count?: number;
  data_sensitivity: DataSensitivityTier;
  criticality_tier: SystemCriticalityTier;
  downstream_dependencies: string[];
  data_volume_bytes?: number;
  last_updated: string;
  metadata_hash: string;
}

export interface BlastRadiusRecommendation {
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  category: string;
  title: string;
  description: string;
  affected_steps: string[];
}

export interface BlastRadiusThreshold {
  max_affected_users?: number;
  max_data_sensitivity?: DataSensitivityTier;
  max_system_criticality?: SystemCriticalityTier;
  max_blast_radius_size?: BlastRadiusSize;
  require_multi_signer: boolean;
}

export interface AnalysisContext {
  workflow_id: string;
  user_id: string;
  environment: 'development' | 'staging' | 'production';
}

// =============================================================================
// Default Configuration
// =============================================================================

export const defaultBlastRadiusConfig: BlastRadiusConfig = {
  analyze_cascading_failures: true,
  max_dependency_depth: 3,
  estimate_user_impact: true,
  estimate_recovery_time: true,
  default_data_sensitivity: 'INTERNAL',
  default_system_criticality: 'TIER_2',
};

// =============================================================================
// Resource Pattern Matchers
// =============================================================================

interface ResourcePattern {
  pattern: RegExp;
  type: string;
  extractor: (params: Record<string, unknown>) => ResourceTarget[];
}

const RESOURCE_PATTERNS: ResourcePattern[] = [
  {
    pattern: /s3/i,
    type: 's3_object',
    extractor: (params) => {
      const targets: ResourceTarget[] = [];
      if (params['bucket'] && params['key']) {
        targets.push({
          type: 's3_object',
          identifier: `${params['bucket']}/${params['key']}`,
        });
      } else if (params['bucket']) {
        targets.push({
          type: 's3_bucket',
          identifier: String(params['bucket']),
        });
      }
      return targets;
    },
  },
  {
    pattern: /ec2|instance/i,
    type: 'ec2_instance',
    extractor: (params) => {
      const targets: ResourceTarget[] = [];
      if (params['instance_id']) {
        targets.push({
          type: 'ec2_instance',
          identifier: String(params['instance_id']),
        });
      }
      if (params['instance_ids'] && Array.isArray(params['instance_ids'])) {
        for (const id of params['instance_ids']) {
          targets.push({ type: 'ec2_instance', identifier: String(id) });
        }
      }
      return targets;
    },
  },
  {
    pattern: /rds|database/i,
    type: 'database',
    extractor: (params) => {
      const targets: ResourceTarget[] = [];
      if (params['database'] && params['table']) {
        targets.push({
          type: 'database_table',
          identifier: `${params['database']}.${params['table']}`,
        });
      } else if (params['database']) {
        targets.push({
          type: 'database',
          identifier: String(params['database']),
        });
      }
      if (params['db_instance_identifier']) {
        targets.push({
          type: 'rds_instance',
          identifier: String(params['db_instance_identifier']),
        });
      }
      return targets;
    },
  },
  {
    pattern: /lambda|function/i,
    type: 'lambda_function',
    extractor: (params) => {
      const targets: ResourceTarget[] = [];
      if (params['function_name']) {
        targets.push({
          type: 'lambda_function',
          identifier: String(params['function_name']),
        });
      }
      return targets;
    },
  },
  {
    pattern: /service/i,
    type: 'service',
    extractor: (params) => {
      const targets: ResourceTarget[] = [];
      if (params['service'] || params['service_name']) {
        targets.push({
          type: 'service',
          identifier: String(params['service'] || params['service_name']),
        });
      }
      return targets;
    },
  },
  {
    pattern: /user/i,
    type: 'user',
    extractor: (params) => {
      const targets: ResourceTarget[] = [];
      if (params['user_id']) {
        targets.push({
          type: 'user',
          identifier: String(params['user_id']),
        });
      }
      return targets;
    },
  },
];

// =============================================================================
// Simulated Resource Metadata Store
// =============================================================================

const SAMPLE_RESOURCE_METADATA: Map<string, ResourceMetadata> = new Map([
  ['prod-user-data', {
    resource_type: 's3_bucket',
    resource_identifier: 'prod-user-data',
    environment: 'production',
    user_count: 50000,
    data_sensitivity: 'CONFIDENTIAL',
    criticality_tier: 'TIER_1',
    downstream_dependencies: ['user-service', 'analytics-service'],
    data_volume_bytes: 5 * 1024 * 1024 * 1024, // 5GB
    last_updated: new Date().toISOString(),
    metadata_hash: '',
  }],
  ['auth-service', {
    resource_type: 'service',
    resource_identifier: 'auth-service',
    environment: 'production',
    user_count: 100000,
    data_sensitivity: 'RESTRICTED',
    criticality_tier: 'TIER_1',
    downstream_dependencies: ['api-gateway', 'user-service', 'payment-service', 'notification-service'],
    last_updated: new Date().toISOString(),
    metadata_hash: '',
  }],
  ['api-gateway', {
    resource_type: 'service',
    resource_identifier: 'api-gateway',
    environment: 'production',
    user_count: 100000,
    data_sensitivity: 'INTERNAL',
    criticality_tier: 'TIER_1',
    downstream_dependencies: [],
    last_updated: new Date().toISOString(),
    metadata_hash: '',
  }],
]);

// =============================================================================
// Blast Radius Analyzer
// =============================================================================

export class BlastRadiusAnalyzer extends EventEmitter {
  private config: BlastRadiusConfig;
  private resourceMetadataStore: Map<string, ResourceMetadata>;
  private dependencyGraph: Map<string, string[]>;
  private initialized = false;

  constructor(config: Partial<BlastRadiusConfig> = {}) {
    super();
    this.config = { ...defaultBlastRadiusConfig, ...config };
    this.resourceMetadataStore = new Map(SAMPLE_RESOURCE_METADATA);
    this.dependencyGraph = new Map();
  }

  /**
   * Initialize the analyzer
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Build dependency graph from metadata
    this.buildDependencyGraph();

    this.initialized = true;
    logger.info('Blast radius analyzer initialized');
  }

  /**
   * Build dependency graph from resource metadata
   */
  private buildDependencyGraph(): void {
    for (const [id, metadata] of this.resourceMetadataStore) {
      this.dependencyGraph.set(id, metadata.downstream_dependencies);
    }
  }

  /**
   * Analyze workflow blast radius
   */
  async analyzeWorkflow(
    plan: PlanManifest,
    context: AnalysisContext
  ): Promise<BlastRadiusAnalysisReport> {
    const sessionId = generateId();
    const startTime = Date.now();

    logger.info(
      { sessionId, planId: plan.planId },
      'Starting blast radius analysis'
    );

    const stepAnalyses = new Map<string, StepBlastRadius>();
    const aggregateBuilder = new BlastRadiusMetricsBuilder(this.config);

    for (const step of plan.steps) {
      const stepAnalysis = await this.analyzeStep(step, context);
      stepAnalyses.set(step.stepId, stepAnalysis);
      aggregateBuilder.accumulate(stepAnalysis.metrics);
    }

    const aggregateMetrics = aggregateBuilder.build();
    const recommendations = this.generateRecommendations(stepAnalyses, aggregateMetrics);

    const report: BlastRadiusAnalysisReport = {
      workflow_id: context.workflow_id,
      plan_id: plan.planId,
      step_analyses: stepAnalyses,
      aggregate_metrics: aggregateMetrics,
      analysis_timestamp: new Date().toISOString(),
      analysis_session_id: sessionId,
      recommendations,
      report_hash: '',
    };

    // Compute report hash
    report.report_hash = hashObject({
      workflow_id: report.workflow_id,
      plan_id: report.plan_id,
      metrics_hash: aggregateMetrics.metrics_hash,
      session_id: sessionId,
    });

    // Emit completion event
    this.emit('analysis_complete', {
      session_id: sessionId,
      plan_id: plan.planId,
      blast_radius_size: aggregateMetrics.blast_radius_size,
      affected_users: aggregateMetrics.affected_user_count,
      data_sensitivity: aggregateMetrics.data_sensitivity_tier,
      duration_ms: Date.now() - startTime,
    });

    logger.info(
      {
        sessionId,
        planId: plan.planId,
        blastRadiusSize: aggregateMetrics.blast_radius_size,
        affectedUsers: aggregateMetrics.affected_user_count,
        durationMs: Date.now() - startTime,
      },
      'Blast radius analysis completed'
    );

    return report;
  }

  /**
   * Analyze single step blast radius
   */
  private async analyzeStep(
    step: PlanStep,
    context: AnalysisContext
  ): Promise<StepBlastRadius> {
    const targets = this.extractResourceTargets(step);
    const metadataList: ResourceMetadata[] = [];
    const metricsBuilder = new BlastRadiusMetricsBuilder(this.config);

    for (const target of targets) {
      // Get metadata from store (NEVER live production query)
      const metadata = this.getResourceMetadata(target, context);
      if (metadata) {
        metadataList.push(metadata);
        metricsBuilder.addFromMetadata(metadata);
      }

      // Analyze cascading failures
      if (this.config.analyze_cascading_failures) {
        const cascadingPaths = this.analyzeCascadingFailures(target, step);
        metricsBuilder.addCascadingPaths(cascadingPaths);
      }
    }

    // Estimate recovery time
    if (this.config.estimate_recovery_time && step.compensationAction) {
      const recoveryTime = this.estimateRecoveryTime(step);
      metricsBuilder.setRecoveryTimeEstimate(recoveryTime);
    }

    return {
      step_id: step.stepId,
      action: step.action,
      target_resources: targets,
      metrics: metricsBuilder.build(),
      resource_metadata: metadataList,
    };
  }

  /**
   * Extract resource targets from step
   */
  private extractResourceTargets(step: PlanStep): ResourceTarget[] {
    const targets: ResourceTarget[] = [];
    const toolAdapter = step.toolAdapter;
    const params = step.parameters;

    // Match against known patterns
    for (const pattern of RESOURCE_PATTERNS) {
      if (pattern.pattern.test(toolAdapter) || pattern.pattern.test(step.action)) {
        targets.push(...pattern.extractor(params));
      }
    }

    // Fallback: extract from common parameter names
    if (targets.length === 0) {
      if (params['resource_id']) {
        targets.push({ type: 'generic', identifier: String(params['resource_id']) });
      }
      if (params['target']) {
        targets.push({ type: 'generic', identifier: String(params['target']) });
      }
    }

    return targets;
  }

  /**
   * Get resource metadata from pre-registered store
   */
  private getResourceMetadata(
    target: ResourceTarget,
    context: AnalysisContext
  ): ResourceMetadata | undefined {
    // Try exact match
    let metadata = this.resourceMetadataStore.get(target.identifier);

    // Try with environment prefix
    if (!metadata) {
      metadata = this.resourceMetadataStore.get(`${context.environment}-${target.identifier}`);
    }

    // Return default metadata if not found
    if (!metadata) {
      return {
        resource_type: target.type,
        resource_identifier: target.identifier,
        environment: context.environment,
        data_sensitivity: this.config.default_data_sensitivity,
        criticality_tier: this.config.default_system_criticality,
        downstream_dependencies: [],
        last_updated: new Date().toISOString(),
        metadata_hash: hashObject({ identifier: target.identifier }),
      };
    }

    return metadata;
  }

  /**
   * Analyze cascading failure paths
   */
  private analyzeCascadingFailures(
    target: ResourceTarget,
    step: PlanStep
  ): CascadingPath[] {
    const paths: CascadingPath[] = [];
    const visited = new Set<string>();

    const traverse = (resourceId: string, currentPath: string[], depth: number): void => {
      if (depth > this.config.max_dependency_depth) return;
      if (visited.has(resourceId)) return;

      visited.add(resourceId);
      const dependencies = this.dependencyGraph.get(resourceId) || [];

      if (dependencies.length > 0) {
        paths.push({
          trigger_resource: target.identifier,
          affected_resources: [...currentPath, ...dependencies],
          path_description: `${target.identifier} → ${dependencies.join(' → ')}`,
          cascade_probability: this.estimateCascadeProbability(step, dependencies),
          impact_severity: this.estimateImpactSeverity(dependencies),
        });

        for (const dep of dependencies) {
          traverse(dep, [...currentPath, resourceId], depth + 1);
        }
      }
    };

    traverse(target.identifier, [], 0);
    return paths;
  }

  /**
   * Estimate cascade probability based on action and dependencies
   */
  private estimateCascadeProbability(step: PlanStep, dependencies: string[]): number {
    let probability = 0.3; // Base probability

    // Higher probability for destructive actions
    if (step.riskLevel === 'destructive') probability += 0.4;
    else if (step.riskLevel === 'high') probability += 0.2;

    // More dependencies = higher cascade probability
    probability += Math.min(0.3, dependencies.length * 0.1);

    return Math.min(1, probability);
  }

  /**
   * Estimate impact severity based on affected resources
   */
  private estimateImpactSeverity(affectedResources: string[]): RiskLevel {
    // Check if any critical services are affected
    const criticalServices = ['auth-service', 'api-gateway', 'payment-service', 'database'];
    const hasCritical = affectedResources.some((r) =>
      criticalServices.some((c) => r.includes(c))
    );

    if (hasCritical) return 'destructive';
    if (affectedResources.length > 5) return 'high';
    if (affectedResources.length > 2) return 'medium';
    return 'low';
  }

  /**
   * Estimate recovery time in seconds
   */
  private estimateRecoveryTime(step: PlanStep): number {
    let baseTime = 30; // Base 30 seconds

    // Adjust for action type
    const action = step.action.toLowerCase();
    if (action.includes('database') || action.includes('migration')) {
      baseTime *= 5;
    }
    if (action.includes('deploy') || action.includes('provision')) {
      baseTime *= 3;
    }

    // Adjust for risk level
    if (step.riskLevel === 'destructive') baseTime *= 4;
    else if (step.riskLevel === 'high') baseTime *= 2;

    // Adjust for approval requirements
    if (step.approvalRequired) {
      baseTime += 300; // Add 5 minutes for approval
    }

    return Math.min(baseTime, 3600); // Cap at 1 hour
  }

  /**
   * Generate recommendations based on analysis
   */
  private generateRecommendations(
    stepAnalyses: Map<string, StepBlastRadius>,
    aggregate: BlastRadiusMetrics
  ): BlastRadiusRecommendation[] {
    const recommendations: BlastRadiusRecommendation[] = [];

    // High user impact
    if (aggregate.affected_user_count && aggregate.affected_user_count > 10000) {
      recommendations.push({
        priority: 'CRITICAL',
        category: 'impact',
        title: 'High User Impact',
        description: `This workflow may affect ${aggregate.affected_user_count.toLocaleString()} users. Consider staged rollout.`,
        affected_steps: Array.from(stepAnalyses.keys()),
      });
    }

    // Restricted data
    if (aggregate.data_sensitivity_tier === 'RESTRICTED') {
      recommendations.push({
        priority: 'CRITICAL',
        category: 'data_sensitivity',
        title: 'Restricted Data Access',
        description: 'This workflow touches RESTRICTED data. Ensure compliance with data handling policies.',
        affected_steps: Array.from(stepAnalyses.entries())
          .filter(([_, s]) => s.metrics.data_sensitivity_tier === 'RESTRICTED')
          .map(([id]) => id),
      });
    }

    // Tier 1 systems
    if (aggregate.system_criticality === 'TIER_1') {
      recommendations.push({
        priority: 'HIGH',
        category: 'criticality',
        title: 'Tier 1 System Impact',
        description: 'This workflow affects Tier 1 critical systems. Ensure rollback procedures are tested.',
        affected_steps: Array.from(stepAnalyses.entries())
          .filter(([_, s]) => s.metrics.system_criticality === 'TIER_1')
          .map(([id]) => id),
      });
    }

    // Cascading failures
    if (aggregate.cascading_failure_paths.length > 3) {
      recommendations.push({
        priority: 'HIGH',
        category: 'cascading',
        title: 'Multiple Cascading Failure Paths',
        description: `${aggregate.cascading_failure_paths.length} potential cascade paths identified. Consider breaking into smaller operations.`,
        affected_steps: aggregate.cascading_failure_paths.map((p) => p.trigger_resource),
      });
    }

    // Long recovery time
    if (aggregate.recovery_time_estimate_seconds && aggregate.recovery_time_estimate_seconds > 1800) {
      recommendations.push({
        priority: 'MEDIUM',
        category: 'recovery',
        title: 'Long Recovery Time',
        description: `Estimated recovery time is ${Math.round(aggregate.recovery_time_estimate_seconds / 60)} minutes. Ensure on-call coverage.`,
        affected_steps: Array.from(stepAnalyses.keys()),
      });
    }

    return recommendations.sort((a, b) => {
      const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  /**
   * Check if metrics exceed threshold
   */
  checkThreshold(
    metrics: BlastRadiusMetrics,
    threshold: BlastRadiusThreshold
  ): { exceeds: boolean; reasons: string[] } {
    const reasons: string[] = [];

    if (threshold.max_affected_users && metrics.affected_user_count) {
      if (metrics.affected_user_count > threshold.max_affected_users) {
        reasons.push(`User impact (${metrics.affected_user_count}) exceeds threshold (${threshold.max_affected_users})`);
      }
    }

    if (threshold.max_data_sensitivity) {
      const tiers: DataSensitivityTier[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];
      if (tiers.indexOf(metrics.data_sensitivity_tier) > tiers.indexOf(threshold.max_data_sensitivity)) {
        reasons.push(`Data sensitivity (${metrics.data_sensitivity_tier}) exceeds threshold (${threshold.max_data_sensitivity})`);
      }
    }

    if (threshold.max_system_criticality) {
      const tiers: SystemCriticalityTier[] = ['NON_CRITICAL', 'TIER_3', 'TIER_2', 'TIER_1'];
      if (tiers.indexOf(metrics.system_criticality) > tiers.indexOf(threshold.max_system_criticality)) {
        reasons.push(`System criticality (${metrics.system_criticality}) exceeds threshold (${threshold.max_system_criticality})`);
      }
    }

    if (threshold.max_blast_radius_size) {
      const sizes: BlastRadiusSize[] = ['LIMITED', 'MODERATE', 'WIDE', 'TOTAL'];
      if (sizes.indexOf(metrics.blast_radius_size) > sizes.indexOf(threshold.max_blast_radius_size)) {
        reasons.push(`Blast radius (${metrics.blast_radius_size}) exceeds threshold (${threshold.max_blast_radius_size})`);
      }
    }

    return { exceeds: reasons.length > 0, reasons };
  }

  /**
   * Register resource metadata
   */
  registerResourceMetadata(metadata: ResourceMetadata): void {
    metadata.metadata_hash = hashObject({
      identifier: metadata.resource_identifier,
      user_count: metadata.user_count,
      sensitivity: metadata.data_sensitivity,
    });
    this.resourceMetadataStore.set(metadata.resource_identifier, metadata);

    if (metadata.downstream_dependencies.length > 0) {
      this.dependencyGraph.set(metadata.resource_identifier, metadata.downstream_dependencies);
    }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<BlastRadiusConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// =============================================================================
// Blast Radius Metrics Builder
// =============================================================================

class BlastRadiusMetricsBuilder {
  private affectedUserCount = 0;
  private affectedSystemCount = 0;
  private dataSensitivityTiers: DataSensitivityTier[] = [];
  private systemCriticalities: SystemCriticalityTier[] = [];
  private cascadingPaths: CascadingPath[] = [];
  private recoveryTimes: number[] = [];
  private dataVolumeBytes = 0;

  constructor(_config: BlastRadiusConfig) {
    // Config stored for future enhancements
  }

  accumulate(metrics: BlastRadiusMetrics): void {
    if (metrics.affected_user_count) {
      this.affectedUserCount += metrics.affected_user_count;
    }
    if (metrics.affected_system_count) {
      this.affectedSystemCount += metrics.affected_system_count;
    }
    this.dataSensitivityTiers.push(metrics.data_sensitivity_tier);
    this.systemCriticalities.push(metrics.system_criticality);
    this.cascadingPaths.push(...metrics.cascading_failure_paths);
    if (metrics.recovery_time_estimate_seconds) {
      this.recoveryTimes.push(metrics.recovery_time_estimate_seconds);
    }
    if (metrics.data_volume_bytes) {
      this.dataVolumeBytes += metrics.data_volume_bytes;
    }
  }

  addFromMetadata(metadata: ResourceMetadata): void {
    if (metadata.user_count) {
      this.affectedUserCount += metadata.user_count;
    }
    this.dataSensitivityTiers.push(metadata.data_sensitivity);
    this.systemCriticalities.push(metadata.criticality_tier);
    this.affectedSystemCount += 1 + metadata.downstream_dependencies.length;
    if (metadata.data_volume_bytes) {
      this.dataVolumeBytes += metadata.data_volume_bytes;
    }
  }

  addCascadingPaths(paths: CascadingPath[]): void {
    this.cascadingPaths.push(...paths);
  }

  setRecoveryTimeEstimate(seconds: number): void {
    this.recoveryTimes.push(seconds);
  }

  build(): BlastRadiusMetrics {
    const dataSensitivity = this.rollupTier(
      this.dataSensitivityTiers,
      ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']
    ) as DataSensitivityTier;

    const systemCriticality = this.rollupTier(
      this.systemCriticalities,
      ['NON_CRITICAL', 'TIER_3', 'TIER_2', 'TIER_1']
    ) as SystemCriticalityTier;

    const recoveryTime = this.recoveryTimes.length > 0
      ? this.recoveryTimes.reduce((a, b) => a + b, 0)
      : undefined;

    const blastRadiusSize = this.determineBlastRadiusSize();

    const metrics: BlastRadiusMetrics = {
      affected_user_count: this.affectedUserCount || undefined,
      affected_system_count: this.affectedSystemCount || undefined,
      data_sensitivity_tier: dataSensitivity,
      data_volume_bytes: this.dataVolumeBytes || undefined,
      system_criticality: systemCriticality,
      cascading_failure_paths: this.cascadingPaths,
      recovery_time_estimate_seconds: recoveryTime,
      blast_radius_size: blastRadiusSize,
      metrics_hash: '',
    };

    // Compute hash
    metrics.metrics_hash = hashObject({
      users: metrics.affected_user_count,
      systems: metrics.affected_system_count,
      sensitivity: metrics.data_sensitivity_tier,
      criticality: metrics.system_criticality,
    });

    return metrics;
  }

  private rollupTier<T extends string>(tiers: T[], tierOrder: T[]): T {
    if (tiers.length === 0) return tierOrder[0] as T;
    return tiers.reduce((max, tier) =>
      tierOrder.indexOf(tier) > tierOrder.indexOf(max) ? tier : max
    );
  }

  private determineBlastRadiusSize(): BlastRadiusSize {
    // Based on user count
    if (this.affectedUserCount > 100000) return 'TOTAL';
    if (this.affectedUserCount > 10000) return 'WIDE';
    if (this.affectedUserCount > 1000) return 'MODERATE';

    // Based on cascading paths
    if (this.cascadingPaths.length > 5) return 'WIDE';
    if (this.cascadingPaths.length > 2) return 'MODERATE';

    // Based on system count
    if (this.affectedSystemCount > 10) return 'WIDE';
    if (this.affectedSystemCount > 3) return 'MODERATE';

    return 'LIMITED';
  }
}

// =============================================================================
// Helper: Human-Readable Summary
// =============================================================================

export function formatBlastRadiusSummary(metrics: BlastRadiusMetrics): string {
  const parts: string[] = [];

  if (metrics.affected_user_count) {
    parts.push(`~${metrics.affected_user_count.toLocaleString()} users affected`);
  }

  parts.push(`Data: ${metrics.data_sensitivity_tier}`);
  parts.push(`Criticality: ${metrics.system_criticality}`);
  parts.push(`Blast radius: ${metrics.blast_radius_size}`);

  if (metrics.cascading_failure_paths.length > 0) {
    parts.push(`${metrics.cascading_failure_paths.length} cascade paths`);
  }

  if (metrics.recovery_time_estimate_seconds) {
    const mins = Math.round(metrics.recovery_time_estimate_seconds / 60);
    parts.push(`Recovery: ~${mins} min`);
  }

  return parts.join(' | ');
}

// =============================================================================
// Singleton Instance
// =============================================================================

let analyzer: BlastRadiusAnalyzer | null = null;

export function getBlastRadiusAnalyzer(): BlastRadiusAnalyzer {
  if (!analyzer) {
    analyzer = new BlastRadiusAnalyzer();
  }
  return analyzer;
}

export async function initializeBlastRadiusAnalyzer(
  config?: Partial<BlastRadiusConfig>
): Promise<BlastRadiusAnalyzer> {
  const a = config ? new BlastRadiusAnalyzer(config) : getBlastRadiusAnalyzer();
  await a.initialize();
  analyzer = a;
  return a;
}
