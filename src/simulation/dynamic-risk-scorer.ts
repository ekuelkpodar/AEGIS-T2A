/**
 * AEGIS-T2A Dynamic Risk Scoring Engine
 *
 * Real-time, context-aware risk scoring with adaptive thresholds
 * and ML-ready feature extraction.
 */

import { EventEmitter } from 'events';
import {
  TypedIntent,
  PlanManifest,
  PlanStep,
  RiskLevel,
  Sensitivity,
} from '../core/types.js';
import { componentLogger } from '../core/logger.js';

const logger = componentLogger('dynamic-risk-scorer');

// =============================================================================
// Types
// =============================================================================

export interface RiskScorerConfig {
  /** Base weights for risk factors */
  factor_weights: FactorWeights;
  /** Risk thresholds for levels */
  thresholds: RiskThresholds;
  /** Enable adaptive thresholds */
  adaptive_thresholds: boolean;
  /** Time window for historical analysis (ms) */
  history_window_ms: number;
  /** Maximum history entries to keep */
  max_history_entries: number;
  /** Enable contextual adjustments */
  contextual_adjustments: boolean;
  /** Enable temporal patterns */
  temporal_patterns: boolean;
  /** Enable behavioral analysis */
  behavioral_analysis: boolean;
  /** Custom scoring rules */
  custom_rules: ScoringRule[];
}

export interface FactorWeights {
  /** Weight for action type risk */
  action_type: number;
  /** Weight for data sensitivity */
  data_sensitivity: number;
  /** Weight for target resource count */
  resource_count: number;
  /** Weight for blast radius */
  blast_radius: number;
  /** Weight for reversibility */
  reversibility: number;
  /** Weight for user trust level */
  user_trust: number;
  /** Weight for environmental factors */
  environment: number;
  /** Weight for temporal factors */
  temporal: number;
  /** Weight for historical patterns */
  historical: number;
  /** Weight for capability requirements */
  capabilities: number;
}

export interface RiskThresholds {
  low_max: number;
  medium_max: number;
  high_max: number;
  // Above high_max is destructive
}

export interface ScoringRule {
  id: string;
  name: string;
  description: string;
  condition: (context: ScoringContext) => boolean;
  score_adjustment: number;
  max_applications: number;
}

export interface ScoringContext {
  intent?: TypedIntent;
  plan?: PlanManifest;
  step?: PlanStep;
  user_id: string;
  user_roles: string[];
  environment: 'development' | 'staging' | 'production';
  timestamp: Date;
  session_id?: string;
  previous_actions?: ActionRecord[];
  metadata?: Record<string, unknown>;
}

export interface ActionRecord {
  action_type: string;
  risk_level: RiskLevel;
  timestamp: Date;
  success: boolean;
  user_id: string;
}

export interface RiskScore {
  score_id: string;
  timestamp: string;
  entity_type: 'intent' | 'plan' | 'step';
  entity_id: string;
  raw_score: number;
  adjusted_score: number;
  risk_level: RiskLevel;
  confidence: number;
  factors: ScoreFactor[];
  adjustments: ScoreAdjustment[];
  recommendations: string[];
  features: RiskFeatures;
}

export interface ScoreFactor {
  name: string;
  weight: number;
  raw_value: number;
  weighted_value: number;
  description: string;
}

export interface ScoreAdjustment {
  rule_id: string;
  rule_name: string;
  adjustment: number;
  reason: string;
}

export interface RiskFeatures {
  // Numeric features for ML
  action_risk_base: number;
  data_sensitivity_level: number;
  resource_count: number;
  capability_count: number;
  dependency_depth: number;
  estimated_cost: number;
  estimated_duration_ms: number;
  user_trust_score: number;
  environment_risk: number;
  time_of_day_risk: number;
  day_of_week_risk: number;
  session_action_count: number;
  recent_failure_rate: number;
  blast_radius_score: number;
  reversibility_score: number;

  // Categorical features
  action_type: string;
  sensitivity: Sensitivity;
  environment: string;
  has_side_effects: boolean;
  requires_approval: boolean;
  has_compensation: boolean;
}

export interface HistoricalAnalysis {
  total_actions: number;
  success_rate: number;
  avg_risk_score: number;
  risk_trend: 'increasing' | 'stable' | 'decreasing';
  anomaly_detected: boolean;
  anomaly_score: number;
}

export interface AdaptiveThresholds {
  current_thresholds: RiskThresholds;
  adjustment_reason: string;
  confidence: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

export const defaultRiskScorerConfig: RiskScorerConfig = {
  factor_weights: {
    action_type: 0.20,
    data_sensitivity: 0.15,
    resource_count: 0.10,
    blast_radius: 0.15,
    reversibility: 0.10,
    user_trust: 0.10,
    environment: 0.10,
    temporal: 0.05,
    historical: 0.05,
    capabilities: 0.05,
  },
  thresholds: {
    low_max: 25,
    medium_max: 50,
    high_max: 75,
  },
  adaptive_thresholds: true,
  history_window_ms: 3600000, // 1 hour
  max_history_entries: 1000,
  contextual_adjustments: true,
  temporal_patterns: true,
  behavioral_analysis: true,
  custom_rules: [],
};

// =============================================================================
// Risk Score Mappings
// =============================================================================

const ACTION_RISK_SCORES: Record<string, number> = {
  // Low risk
  'read': 10,
  'get': 10,
  'list': 10,
  'query': 15,
  'search': 15,
  'view': 10,
  'describe': 10,

  // Medium risk
  'create': 40,
  'add': 40,
  'insert': 40,
  'put': 45,
  'post': 45,
  'update': 50,
  'modify': 50,
  'patch': 45,
  'configure': 55,
  'enable': 45,
  'disable': 50,

  // High risk
  'delete': 70,
  'remove': 70,
  'drop': 75,
  'truncate': 80,
  'stop': 65,
  'terminate': 75,
  'shutdown': 70,
  'revoke': 65,

  // Destructive
  'destroy': 90,
  'purge': 90,
  'wipe': 95,
  'format': 95,
  'force_delete': 95,
};

const SENSITIVITY_SCORES: Record<Sensitivity, number> = {
  [Sensitivity.PUBLIC]: 10,
  [Sensitivity.INTERNAL]: 30,
  [Sensitivity.CONFIDENTIAL]: 60,
  [Sensitivity.RESTRICTED]: 90,
};

const ENVIRONMENT_SCORES: Record<string, number> = {
  'development': 20,
  'staging': 50,
  'production': 90,
};

const CAPABILITY_RISK_SCORES: Record<string, number> = {
  'admin': 90,
  'root': 95,
  'system': 90,
  'delete': 70,
  'write': 50,
  'create': 40,
  'read': 10,
  'execute': 60,
  'deploy': 75,
  'financial': 80,
  'pii': 75,
  'secrets': 85,
};

// =============================================================================
// Dynamic Risk Scorer
// =============================================================================

export class DynamicRiskScorer extends EventEmitter {
  private config: RiskScorerConfig;
  private actionHistory: ActionRecord[] = [];
  private currentThresholds: RiskThresholds;
  private initialized = false;
  private scoreCount = 0;

  constructor(config: Partial<RiskScorerConfig> = {}) {
    super();
    this.config = { ...defaultRiskScorerConfig, ...config };
    this.currentThresholds = { ...this.config.thresholds };
  }

  /**
   * Initialize the scorer
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    logger.info('Dynamic risk scorer initialized');
  }

  /**
   * Score an intent
   */
  async scoreIntent(intent: TypedIntent, context: Partial<ScoringContext> = {}): Promise<RiskScore> {
    const fullContext: ScoringContext = {
      intent,
      user_id: intent.userId,
      user_roles: context.user_roles || [],
      environment: context.environment || 'development',
      timestamp: new Date(),
      session_id: context.session_id,
      previous_actions: this.getRecentActions(intent.userId),
      ...context,
    };

    return this.calculateScore('intent', intent.intentId, fullContext);
  }

  /**
   * Score a plan
   */
  async scorePlan(plan: PlanManifest, context: Partial<ScoringContext> = {}): Promise<RiskScore> {
    const fullContext: ScoringContext = {
      plan,
      user_id: context.user_id || 'unknown',
      user_roles: context.user_roles || [],
      environment: context.environment || 'development',
      timestamp: new Date(),
      session_id: context.session_id,
      previous_actions: context.user_id ? this.getRecentActions(context.user_id) : [],
      ...context,
    };

    return this.calculateScore('plan', plan.planId, fullContext);
  }

  /**
   * Score a step
   */
  async scoreStep(step: PlanStep, context: Partial<ScoringContext> = {}): Promise<RiskScore> {
    const fullContext: ScoringContext = {
      step,
      user_id: context.user_id || 'unknown',
      user_roles: context.user_roles || [],
      environment: context.environment || 'development',
      timestamp: new Date(),
      session_id: context.session_id,
      previous_actions: context.user_id ? this.getRecentActions(context.user_id) : [],
      ...context,
    };

    return this.calculateScore('step', step.stepId, fullContext);
  }

  /**
   * Calculate risk score
   */
  private calculateScore(
    entityType: 'intent' | 'plan' | 'step',
    entityId: string,
    context: ScoringContext
  ): RiskScore {
    const scoreId = `score_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    this.scoreCount++;

    const factors: ScoreFactor[] = [];
    const adjustments: ScoreAdjustment[] = [];

    // Calculate each factor
    factors.push(this.calculateActionTypeFactor(context));
    factors.push(this.calculateDataSensitivityFactor(context));
    factors.push(this.calculateResourceCountFactor(context));
    factors.push(this.calculateBlastRadiusFactor(context));
    factors.push(this.calculateReversibilityFactor(context));
    factors.push(this.calculateUserTrustFactor(context));
    factors.push(this.calculateEnvironmentFactor(context));

    if (this.config.temporal_patterns) {
      factors.push(this.calculateTemporalFactor(context));
    }

    if (this.config.behavioral_analysis) {
      factors.push(this.calculateHistoricalFactor(context));
    }

    factors.push(this.calculateCapabilitiesFactor(context));

    // Calculate raw score
    let rawScore = factors.reduce((sum, f) => sum + f.weighted_value, 0);

    // Apply custom rules
    if (this.config.contextual_adjustments) {
      for (const rule of this.config.custom_rules) {
        let applications = 0;
        if (rule.condition(context) && applications < rule.max_applications) {
          adjustments.push({
            rule_id: rule.id,
            rule_name: rule.name,
            adjustment: rule.score_adjustment,
            reason: rule.description,
          });
          applications++;
        }
      }
    }

    // Apply built-in adjustments
    const builtInAdjustments = this.calculateBuiltInAdjustments(context);
    adjustments.push(...builtInAdjustments);

    // Calculate adjusted score
    const totalAdjustment = adjustments.reduce((sum, a) => sum + a.adjustment, 0);
    const adjustedScore = Math.max(0, Math.min(100, rawScore + totalAdjustment));

    // Determine risk level using thresholds
    const thresholds = this.config.adaptive_thresholds
      ? this.getAdaptiveThresholds(context)
      : this.currentThresholds;

    const riskLevel = this.scoreToRiskLevel(adjustedScore, thresholds);

    // Calculate confidence
    const confidence = this.calculateConfidence(factors, context);

    // Generate recommendations
    const recommendations = this.generateRecommendations(factors, adjustedScore, riskLevel);

    // Extract features for ML
    const features = this.extractFeatures(context, factors, adjustedScore);

    const score: RiskScore = {
      score_id: scoreId,
      timestamp: new Date().toISOString(),
      entity_type: entityType,
      entity_id: entityId,
      raw_score: rawScore,
      adjusted_score: adjustedScore,
      risk_level: riskLevel,
      confidence,
      factors,
      adjustments,
      recommendations,
      features,
    };

    // Record action for history
    this.recordAction(context, riskLevel);

    // Emit event
    this.emit('score_calculated', {
      score_id: scoreId,
      entity_type: entityType,
      entity_id: entityId,
      risk_level: riskLevel,
      score: adjustedScore,
    });

    logger.info(
      {
        scoreId,
        entityType,
        entityId,
        rawScore,
        adjustedScore,
        riskLevel,
        confidence,
      },
      'Risk score calculated'
    );

    return score;
  }

  /**
   * Calculate action type factor
   */
  private calculateActionTypeFactor(context: ScoringContext): ScoreFactor {
    let actionType = 'unknown';
    let rawValue = 50; // Default medium risk

    if (context.intent) {
      actionType = context.intent.actionType.toLowerCase();
    } else if (context.step) {
      actionType = context.step.action.toLowerCase();
    } else if (context.plan) {
      // Aggregate from steps
      const stepRisks = context.plan.steps.map((s) => {
        const action = s.action.toLowerCase();
        for (const [key, score] of Object.entries(ACTION_RISK_SCORES)) {
          if (action.includes(key)) return score;
        }
        return 50;
      });
      rawValue = Math.max(...stepRisks, 50);
    }

    // Match against known action types
    for (const [key, score] of Object.entries(ACTION_RISK_SCORES)) {
      if (actionType.includes(key)) {
        rawValue = score;
        break;
      }
    }

    const weight = this.config.factor_weights.action_type;

    return {
      name: 'Action Type Risk',
      weight,
      raw_value: rawValue,
      weighted_value: rawValue * weight,
      description: `Action '${actionType}' has base risk score ${rawValue}`,
    };
  }

  /**
   * Calculate data sensitivity factor
   */
  private calculateDataSensitivityFactor(context: ScoringContext): ScoreFactor {
    let sensitivity: Sensitivity = Sensitivity.PUBLIC;
    let rawValue = SENSITIVITY_SCORES[Sensitivity.PUBLIC];

    if (context.intent) {
      sensitivity = context.intent.sensitivity;
      rawValue = SENSITIVITY_SCORES[sensitivity];
    } else if (context.plan) {
      // Use highest sensitivity from steps
      // For now, estimate from plan metadata
      rawValue = 30; // Default internal
    } else if (context.step) {
      // Estimate from step parameters
      const params = JSON.stringify(context.step.parameters).toLowerCase();
      if (params.includes('secret') || params.includes('credential')) {
        rawValue = SENSITIVITY_SCORES[Sensitivity.RESTRICTED];
      } else if (params.includes('pii') || params.includes('personal')) {
        rawValue = SENSITIVITY_SCORES[Sensitivity.CONFIDENTIAL];
      } else if (params.includes('internal')) {
        rawValue = SENSITIVITY_SCORES[Sensitivity.INTERNAL];
      }
    }

    const weight = this.config.factor_weights.data_sensitivity;

    return {
      name: 'Data Sensitivity',
      weight,
      raw_value: rawValue,
      weighted_value: rawValue * weight,
      description: `Data classified as ${sensitivity} with sensitivity score ${rawValue}`,
    };
  }

  /**
   * Calculate resource count factor
   */
  private calculateResourceCountFactor(context: ScoringContext): ScoreFactor {
    let resourceCount = 1;
    let rawValue = 10;

    if (context.intent?.metadata) {
      const metadata = context.intent.metadata as Record<string, unknown>;
      const resources = metadata.targetResources as string[] | undefined;
      resourceCount = resources?.length ?? 1;
    } else if (context.plan) {
      resourceCount = context.plan.steps.length;
    }

    // Scale: 1 resource = 10, 10+ resources = 50, 50+ = 80, 100+ = 100
    if (resourceCount <= 1) rawValue = 10;
    else if (resourceCount <= 5) rawValue = 20;
    else if (resourceCount <= 10) rawValue = 40;
    else if (resourceCount <= 50) rawValue = 60;
    else if (resourceCount <= 100) rawValue = 80;
    else rawValue = 100;

    const weight = this.config.factor_weights.resource_count;

    return {
      name: 'Resource Count',
      weight,
      raw_value: rawValue,
      weighted_value: rawValue * weight,
      description: `${resourceCount} resources affected`,
    };
  }

  /**
   * Calculate blast radius factor
   */
  private calculateBlastRadiusFactor(context: ScoringContext): ScoreFactor {
    let rawValue = 30; // Default moderate

    if (context.plan) {
      // Calculate based on dependency depth and scope
      const maxDepth = this.calculateMaxDepth(context.plan.steps);
      const destructiveCount = context.plan.steps.filter(
        (s) => s.riskLevel === 'destructive'
      ).length;
      const sideEffectCount = context.plan.steps.filter((s) => s.sideEffect).length;

      rawValue = Math.min(100,
        maxDepth * 10 +
        destructiveCount * 20 +
        (sideEffectCount / context.plan.steps.length) * 50
      );
    } else if (context.step) {
      if (context.step.riskLevel === 'destructive') rawValue = 90;
      else if (context.step.riskLevel === 'high') rawValue = 70;
      else if (context.step.riskLevel === 'medium') rawValue = 40;
      else rawValue = 20;
    } else if (context.intent) {
      if (context.intent.riskLevel === 'destructive') rawValue = 85;
      else if (context.intent.riskLevel === 'high') rawValue = 65;
      else if (context.intent.riskLevel === 'medium') rawValue = 35;
      else rawValue = 15;
    }

    const weight = this.config.factor_weights.blast_radius;

    return {
      name: 'Blast Radius',
      weight,
      raw_value: rawValue,
      weighted_value: rawValue * weight,
      description: `Potential impact scope score: ${rawValue}`,
    };
  }

  /**
   * Calculate reversibility factor
   */
  private calculateReversibilityFactor(context: ScoringContext): ScoreFactor {
    let rawValue = 50; // Default partially reversible

    if (context.plan) {
      const withCompensation = context.plan.steps.filter((s) => s.compensationAction).length;
      const withSideEffects = context.plan.steps.filter((s) => s.sideEffect).length;

      if (withSideEffects === 0) {
        rawValue = 10; // Fully reversible (no side effects)
      } else {
        const coverage = withCompensation / Math.max(withSideEffects, 1);
        rawValue = 100 - coverage * 80; // 0% coverage = 100, 100% = 20
      }
    } else if (context.step) {
      if (!context.step.sideEffect) {
        rawValue = 10;
      } else if (context.step.compensationAction) {
        rawValue = 30;
      } else if (context.step.riskLevel === 'destructive') {
        rawValue = 95;
      } else {
        rawValue = 70;
      }
    } else if (context.intent) {
      rawValue = context.intent.sideEffect ? 60 : 20;
    }

    const weight = this.config.factor_weights.reversibility;

    return {
      name: 'Reversibility',
      weight,
      raw_value: rawValue,
      weighted_value: rawValue * weight,
      description: `Reversibility difficulty score: ${rawValue}`,
    };
  }

  /**
   * Calculate user trust factor
   */
  private calculateUserTrustFactor(context: ScoringContext): ScoreFactor {
    let rawValue = 50; // Default neutral trust

    // Higher trust = lower risk
    const roles = context.user_roles;

    if (roles.includes('system') || roles.includes('admin')) {
      rawValue = 20; // High trust
    } else if (roles.includes('operator') || roles.includes('developer')) {
      rawValue = 40;
    } else if (roles.includes('user')) {
      rawValue = 60;
    } else if (roles.includes('guest') || roles.length === 0) {
      rawValue = 80; // Low trust
    }

    // Adjust based on historical behavior
    if (this.config.behavioral_analysis) {
      const history = this.analyzeHistory(context.user_id);
      if (history.success_rate > 0.95 && history.total_actions > 10) {
        rawValue = Math.max(10, rawValue - 20);
      } else if (history.success_rate < 0.7 && history.total_actions > 5) {
        rawValue = Math.min(100, rawValue + 20);
      }
    }

    const weight = this.config.factor_weights.user_trust;

    return {
      name: 'User Trust Level',
      weight,
      raw_value: rawValue,
      weighted_value: rawValue * weight,
      description: `User trust risk score: ${rawValue}`,
    };
  }

  /**
   * Calculate environment factor
   */
  private calculateEnvironmentFactor(context: ScoringContext): ScoreFactor {
    const env = context.environment;
    const rawValue = ENVIRONMENT_SCORES[env] || 50;
    const weight = this.config.factor_weights.environment;

    return {
      name: 'Environment Risk',
      weight,
      raw_value: rawValue,
      weighted_value: rawValue * weight,
      description: `${env} environment risk score: ${rawValue}`,
    };
  }

  /**
   * Calculate temporal factor
   */
  private calculateTemporalFactor(context: ScoringContext): ScoreFactor {
    let rawValue = 30; // Default normal hours

    const hour = context.timestamp.getHours();
    const dayOfWeek = context.timestamp.getDay();

    // Higher risk outside business hours (9-17) and weekends
    if (hour < 9 || hour > 17) {
      rawValue += 20; // Off-hours
    }
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      rawValue += 30; // Weekend
    }

    // Very late night is highest risk
    if (hour >= 0 && hour < 6) {
      rawValue += 20;
    }

    rawValue = Math.min(100, rawValue);

    const weight = this.config.factor_weights.temporal;

    return {
      name: 'Temporal Risk',
      weight,
      raw_value: rawValue,
      weighted_value: rawValue * weight,
      description: `Time-based risk score: ${rawValue} (hour: ${hour}, day: ${dayOfWeek})`,
    };
  }

  /**
   * Calculate historical factor
   */
  private calculateHistoricalFactor(context: ScoringContext): ScoreFactor {
    const history = this.analyzeHistory(context.user_id);
    let rawValue = 50;

    if (history.total_actions === 0) {
      rawValue = 60; // No history = slightly higher risk
    } else {
      // Combine factors
      rawValue = 30; // Base for users with history

      // Adjust for trend
      if (history.risk_trend === 'increasing') {
        rawValue += 20;
      } else if (history.risk_trend === 'decreasing') {
        rawValue -= 10;
      }

      // Adjust for anomalies
      if (history.anomaly_detected) {
        rawValue += history.anomaly_score * 30;
      }

      // Adjust for success rate
      rawValue += (1 - history.success_rate) * 30;
    }

    rawValue = Math.max(0, Math.min(100, rawValue));

    const weight = this.config.factor_weights.historical;

    return {
      name: 'Historical Patterns',
      weight,
      raw_value: rawValue,
      weighted_value: rawValue * weight,
      description: `Historical pattern risk: ${rawValue} (${history.total_actions} actions, ${(history.success_rate * 100).toFixed(1)}% success)`,
    };
  }

  /**
   * Calculate capabilities factor
   */
  private calculateCapabilitiesFactor(context: ScoringContext): ScoreFactor {
    let capabilities: string[] = [];
    let rawValue = 30;

    if (context.intent) {
      capabilities = context.intent.requiredCapabilities;
    } else if (context.step) {
      capabilities = context.step.requiredCapabilities;
    } else if (context.plan) {
      capabilities = [...new Set(context.plan.steps.flatMap((s) => s.requiredCapabilities))];
    }

    if (capabilities.length > 0) {
      const capScores = capabilities.map((cap) => {
        const lower = cap.toLowerCase();
        for (const [key, score] of Object.entries(CAPABILITY_RISK_SCORES)) {
          if (lower.includes(key)) return score;
        }
        return 30;
      });
      rawValue = Math.max(...capScores);
    }

    const weight = this.config.factor_weights.capabilities;

    return {
      name: 'Required Capabilities',
      weight,
      raw_value: rawValue,
      weighted_value: rawValue * weight,
      description: `Capability risk: ${rawValue} (${capabilities.length} capabilities)`,
    };
  }

  /**
   * Calculate built-in adjustments
   */
  private calculateBuiltInAdjustments(context: ScoringContext): ScoreAdjustment[] {
    const adjustments: ScoreAdjustment[] = [];

    // First action of session
    if (context.previous_actions && context.previous_actions.length === 0) {
      adjustments.push({
        rule_id: 'first-action',
        rule_name: 'First Action Bonus',
        adjustment: -5,
        reason: 'First action in session typically lower risk',
      });
    }

    // Rapid successive high-risk actions
    const recentHighRisk = context.previous_actions?.filter(
      (a) => a.risk_level === 'high' || a.risk_level === 'destructive'
    ).length ?? 0;

    if (recentHighRisk >= 3) {
      adjustments.push({
        rule_id: 'rapid-high-risk',
        rule_name: 'Rapid High-Risk Activity',
        adjustment: 15,
        reason: `${recentHighRisk} recent high-risk actions detected`,
      });
    }

    // Production + destructive
    if (context.environment === 'production') {
      if (context.intent?.riskLevel === 'destructive' ||
          context.step?.riskLevel === 'destructive' ||
          context.plan?.steps.some((s) => s.riskLevel === 'destructive')) {
        adjustments.push({
          rule_id: 'prod-destructive',
          rule_name: 'Production Destructive',
          adjustment: 20,
          reason: 'Destructive operation in production environment',
        });
      }
    }

    // No approval required for high-risk
    if (context.intent?.riskLevel === 'high' && !context.intent.approvalRequired) {
      adjustments.push({
        rule_id: 'no-approval-high',
        rule_name: 'Missing Approval Requirement',
        adjustment: 10,
        reason: 'High-risk intent without approval requirement',
      });
    }

    return adjustments;
  }

  /**
   * Get adaptive thresholds
   */
  private getAdaptiveThresholds(context: ScoringContext): RiskThresholds {
    // Adjust thresholds based on context
    const thresholds = { ...this.config.thresholds };

    // Tighter thresholds for production
    if (context.environment === 'production') {
      thresholds.low_max *= 0.8;
      thresholds.medium_max *= 0.8;
      thresholds.high_max *= 0.8;
    }

    // Looser thresholds for development
    if (context.environment === 'development') {
      thresholds.low_max *= 1.2;
      thresholds.medium_max *= 1.2;
      thresholds.high_max *= 1.1;
    }

    // Tighter thresholds for low-trust users
    if (!context.user_roles.includes('admin') && !context.user_roles.includes('operator')) {
      thresholds.low_max *= 0.9;
      thresholds.medium_max *= 0.9;
    }

    return thresholds;
  }

  /**
   * Convert score to risk level
   */
  private scoreToRiskLevel(score: number, thresholds: RiskThresholds): RiskLevel {
    if (score <= thresholds.low_max) return 'low';
    if (score <= thresholds.medium_max) return 'medium';
    if (score <= thresholds.high_max) return 'high';
    return 'destructive';
  }

  /**
   * Calculate confidence in score
   */
  private calculateConfidence(factors: ScoreFactor[], context: ScoringContext): number {
    let confidence = 0.7; // Base confidence

    // More factors = higher confidence
    confidence += factors.length * 0.02;

    // More history = higher confidence
    const historyCount = context.previous_actions?.length ?? 0;
    confidence += Math.min(0.1, historyCount * 0.01);

    // Known user roles = higher confidence
    if (context.user_roles.length > 0) {
      confidence += 0.05;
    }

    // Intent has explicit risk level = higher confidence
    if (context.intent?.riskLevel) {
      confidence += 0.05;
    }

    return Math.min(1, confidence);
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(
    factors: ScoreFactor[],
    score: number,
    riskLevel: RiskLevel
  ): string[] {
    const recommendations: string[] = [];

    // High-contributing factors
    const sorted = [...factors].sort((a, b) => b.weighted_value - a.weighted_value);
    const topFactor = sorted[0];

    if (topFactor && topFactor.weighted_value > 20) {
      recommendations.push(`Consider mitigating ${topFactor.name} (contributing ${topFactor.weighted_value.toFixed(1)} to risk)`);
    }

    // Risk level based recommendations
    if (riskLevel === 'destructive') {
      recommendations.push('This action requires explicit approval and audit logging');
      recommendations.push('Consider running in simulation mode first');
      recommendations.push('Ensure compensation actions are defined');
    } else if (riskLevel === 'high') {
      recommendations.push('Consider adding human review before execution');
      recommendations.push('Verify idempotency and compensation capabilities');
    } else if (riskLevel === 'medium') {
      recommendations.push('Monitor execution closely');
    }

    return recommendations;
  }

  /**
   * Extract ML features
   */
  private extractFeatures(
    context: ScoringContext,
    factors: ScoreFactor[],
    score: number
  ): RiskFeatures {
    const actionFactor = factors.find((f) => f.name === 'Action Type Risk');
    const sensitivityFactor = factors.find((f) => f.name === 'Data Sensitivity');
    const resourceFactor = factors.find((f) => f.name === 'Resource Count');
    const blastFactor = factors.find((f) => f.name === 'Blast Radius');
    const reversibilityFactor = factors.find((f) => f.name === 'Reversibility');
    const userFactor = factors.find((f) => f.name === 'User Trust Level');
    const envFactor = factors.find((f) => f.name === 'Environment Risk');
    const temporalFactor = factors.find((f) => f.name === 'Temporal Risk');

    const hour = context.timestamp.getHours();
    const dayOfWeek = context.timestamp.getDay();

    return {
      action_risk_base: actionFactor?.raw_value ?? 50,
      data_sensitivity_level: sensitivityFactor?.raw_value ?? 30,
      resource_count: context.plan?.steps.length ?? 1,
      capability_count: context.intent?.requiredCapabilities.length ?? 0,
      dependency_depth: context.plan ? this.calculateMaxDepth(context.plan.steps) : 0,
      estimated_cost: context.plan?.totalEstimatedCost ?? context.step?.estimatedCost ?? 0,
      estimated_duration_ms: context.plan?.steps.reduce((sum, s) => sum + s.estimatedDuration, 0) ??
        context.step?.estimatedDuration ?? 0,
      user_trust_score: userFactor?.raw_value ?? 50,
      environment_risk: envFactor?.raw_value ?? 50,
      time_of_day_risk: hour < 9 || hour > 17 ? 70 : 30,
      day_of_week_risk: dayOfWeek === 0 || dayOfWeek === 6 ? 70 : 30,
      session_action_count: context.previous_actions?.length ?? 0,
      recent_failure_rate: this.analyzeHistory(context.user_id).success_rate,
      blast_radius_score: blastFactor?.raw_value ?? 50,
      reversibility_score: reversibilityFactor?.raw_value ?? 50,

      action_type: context.intent?.actionType ?? context.step?.action ?? 'unknown',
      sensitivity: context.intent?.sensitivity ?? Sensitivity.PUBLIC,
      environment: context.environment,
      has_side_effects: context.intent?.sideEffect ?? context.step?.sideEffect ?? false,
      requires_approval: context.intent?.approvalRequired ?? context.step?.approvalRequired ?? false,
      has_compensation: context.step?.compensationAction !== undefined,
    };
  }

  /**
   * Analyze user history
   */
  private analyzeHistory(userId: string): HistoricalAnalysis {
    const userActions = this.actionHistory.filter((a) => a.user_id === userId);

    if (userActions.length === 0) {
      return {
        total_actions: 0,
        success_rate: 1,
        avg_risk_score: 0,
        risk_trend: 'stable',
        anomaly_detected: false,
        anomaly_score: 0,
      };
    }

    const successCount = userActions.filter((a) => a.success).length;
    const riskScores = userActions.map((a) => {
      switch (a.risk_level) {
        case 'low': return 25;
        case 'medium': return 50;
        case 'high': return 75;
        case 'destructive': return 100;
      }
    });

    // Calculate trend
    const recentRisk = riskScores.slice(-5);
    const olderRisk = riskScores.slice(0, -5);
    const recentAvg = recentRisk.reduce((a, b) => a + b, 0) / Math.max(recentRisk.length, 1);
    const olderAvg = olderRisk.reduce((a, b) => a + b, 0) / Math.max(olderRisk.length, 1);

    let trend: 'increasing' | 'stable' | 'decreasing' = 'stable';
    if (recentAvg > olderAvg + 10) trend = 'increasing';
    else if (recentAvg < olderAvg - 10) trend = 'decreasing';

    // Simple anomaly detection
    const avgRisk = riskScores.reduce((a, b) => a + b, 0) / riskScores.length;
    const stdDev = Math.sqrt(
      riskScores.reduce((sum, r) => sum + Math.pow(r - avgRisk, 2), 0) / riskScores.length
    );
    const latestRisk = riskScores[riskScores.length - 1] ?? 0;
    const anomalyScore = stdDev > 0 ? (latestRisk - avgRisk) / stdDev : 0;
    const anomalyDetected = Math.abs(anomalyScore) > 2;

    return {
      total_actions: userActions.length,
      success_rate: successCount / userActions.length,
      avg_risk_score: avgRisk,
      risk_trend: trend,
      anomaly_detected: anomalyDetected,
      anomaly_score: Math.abs(anomalyScore),
    };
  }

  /**
   * Get recent actions for a user
   */
  private getRecentActions(userId: string): ActionRecord[] {
    const cutoff = Date.now() - this.config.history_window_ms;
    return this.actionHistory.filter(
      (a) => a.user_id === userId && a.timestamp.getTime() > cutoff
    );
  }

  /**
   * Record an action
   */
  private recordAction(context: ScoringContext, riskLevel: RiskLevel): void {
    const actionType = context.intent?.actionType ?? context.step?.action ?? 'unknown';

    this.actionHistory.push({
      action_type: actionType,
      risk_level: riskLevel,
      timestamp: context.timestamp,
      success: true, // Will be updated later when we know outcome
      user_id: context.user_id,
    });

    // Prune old history
    while (this.actionHistory.length > this.config.max_history_entries) {
      this.actionHistory.shift();
    }
  }

  /**
   * Calculate max dependency depth
   */
  private calculateMaxDepth(steps: PlanStep[]): number {
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
   * Update outcome for recorded action
   */
  updateActionOutcome(userId: string, actionType: string, success: boolean): void {
    // Find and update the most recent matching action
    for (let i = this.actionHistory.length - 1; i >= 0; i--) {
      const action = this.actionHistory[i]!;
      if (action.user_id === userId && action.action_type === actionType) {
        action.success = success;
        break;
      }
    }
  }

  /**
   * Add custom scoring rule
   */
  addRule(rule: ScoringRule): void {
    this.config.custom_rules.push(rule);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<RiskScorerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get configuration
   */
  getConfig(): RiskScorerConfig {
    return { ...this.config };
  }

  /**
   * Get statistics
   */
  getStats(): {
    scores_calculated: number;
    history_size: number;
    rules_count: number;
  } {
    return {
      scores_calculated: this.scoreCount,
      history_size: this.actionHistory.length,
      rules_count: this.config.custom_rules.length,
    };
  }

  /**
   * Clear history
   */
  clearHistory(): void {
    this.actionHistory = [];
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let scorer: DynamicRiskScorer | null = null;

export function getDynamicRiskScorer(): DynamicRiskScorer {
  if (!scorer) {
    scorer = new DynamicRiskScorer();
  }
  return scorer;
}

export async function initializeDynamicRiskScorer(
  config?: Partial<RiskScorerConfig>
): Promise<DynamicRiskScorer> {
  const s = config ? new DynamicRiskScorer(config) : getDynamicRiskScorer();
  await s.initialize();
  scorer = s;
  return s;
}
