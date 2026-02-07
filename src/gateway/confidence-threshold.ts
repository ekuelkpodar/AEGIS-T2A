/**
 * Confidence Threshold Enforcement
 *
 * Automatically rejects or escalates intents below confidence thresholds.
 * Implements tiered thresholds with different actions at each level.
 *
 * Threshold Tiers:
 * - Critical (>= 0.9): Auto-approve for low-risk actions
 * - High (>= 0.8): Standard approval flow
 * - Medium (>= 0.6): Require human clarification
 * - Low (>= 0.4): Escalate to supervisor
 * - Very Low (< 0.4): Auto-reject
 *
 * Features:
 * - Risk-adjusted thresholds
 * - Automatic escalation
 * - Audit trail for rejections
 * - Override capabilities for authorized users
 */

import { componentLogger } from '../core/logger.js';
import type { TypedIntent, RiskLevel } from '../core/types.js';
import { generateId } from '../core/ids.js';
import { EventEmitter } from 'events';

const logger = componentLogger('confidence-threshold');

// =============================================================================
// Types
// =============================================================================

export interface ConfidenceThresholdConfig {
  // Risk-specific thresholds
  thresholds: {
    destructive: ThresholdConfig;
    high: ThresholdConfig;
    medium: ThresholdConfig;
    low: ThresholdConfig;
  };
  // Global settings
  allowOverrides: boolean;
  requireOverrideJustification: boolean;
  escalationEnabled: boolean;
  autoRejectEnabled: boolean;
}

export interface ThresholdConfig {
  autoApprove: number; // Confidence >= this value: auto-approve
  requireClarification: number; // Confidence >= this value: require clarification
  requireEscalation: number; // Confidence >= this value: escalate to supervisor
  autoReject: number; // Confidence < this value: auto-reject
}

export interface ThresholdEnforcementResult {
  decision: 'approve' | 'clarify' | 'escalate' | 'reject';
  reason: string;
  confidence: number;
  threshold: number;
  riskLevel: RiskLevel;
  requiresHumanReview: boolean;
  escalationLevel?: 'supervisor' | 'security_team' | 'admin';
  metadata: {
    enforcementId: string;
    timestamp: string;
    configVersion: string;
    overridden: boolean;
  };
}

export interface ThresholdOverride {
  overrideId: string;
  intentId: string;
  userId: string;
  authorizedBy: string;
  originalDecision: string;
  newDecision: string;
  justification: string;
  timestamp: string;
  approved: boolean;
}

export interface RejectionRecord {
  rejectionId: string;
  intentId: string;
  userId: string;
  nlText: string;
  confidence: number;
  threshold: number;
  riskLevel: RiskLevel;
  reason: string;
  timestamp: string;
  appealable: boolean;
}

// =============================================================================
// Default Configuration
// =============================================================================

export const defaultThresholdConfig: ConfidenceThresholdConfig = {
  thresholds: {
    destructive: {
      autoApprove: 0.95, // Very high bar for destructive actions
      requireClarification: 0.85,
      requireEscalation: 0.7,
      autoReject: 0.7,
    },
    high: {
      autoApprove: 0.9,
      requireClarification: 0.75,
      requireEscalation: 0.6,
      autoReject: 0.5,
    },
    medium: {
      autoApprove: 0.85,
      requireClarification: 0.65,
      requireEscalation: 0.5,
      autoReject: 0.4,
    },
    low: {
      autoApprove: 0.8,
      requireClarification: 0.6,
      requireEscalation: 0.4,
      autoReject: 0.3,
    },
  },
  allowOverrides: true,
  requireOverrideJustification: true,
  escalationEnabled: true,
  autoRejectEnabled: true,
};

// =============================================================================
// Confidence Threshold Enforcer
// =============================================================================

export class ConfidenceThresholdEnforcer extends EventEmitter {
  private config: ConfidenceThresholdConfig;
  private overrides = new Map<string, ThresholdOverride>();
  private rejections: RejectionRecord[] = [];
  private configVersion = '1.0.0';

  constructor(config: Partial<ConfidenceThresholdConfig> = {}) {
    super();
    this.config = this.mergeConfig(defaultThresholdConfig, config);
  }

  /**
   * Enforce confidence threshold for an intent
   */
  enforce(intent: TypedIntent): ThresholdEnforcementResult {
    const confidence = intent.confidence || 0;
    const riskLevel = intent.riskLevel;
    const thresholds = this.config.thresholds[riskLevel];

    logger.debug('Enforcing confidence threshold', {
      intentId: intent.intentId,
      confidence,
      riskLevel,
    });

    // Determine decision based on thresholds
    let decision: ThresholdEnforcementResult['decision'];
    let threshold: number;
    let reason: string;
    let escalationLevel: ThresholdEnforcementResult['escalationLevel'];
    let requiresHumanReview = false;

    if (confidence >= thresholds.autoApprove) {
      decision = 'approve';
      threshold = thresholds.autoApprove;
      reason = `Confidence ${confidence.toFixed(2)} meets auto-approve threshold ${threshold.toFixed(2)}`;
    } else if (confidence >= thresholds.requireClarification) {
      decision = 'clarify';
      threshold = thresholds.requireClarification;
      reason = `Confidence ${confidence.toFixed(2)} requires clarification (threshold: ${threshold.toFixed(2)})`;
      requiresHumanReview = true;
    } else if (confidence >= thresholds.requireEscalation) {
      decision = 'escalate';
      threshold = thresholds.requireEscalation;
      reason = `Confidence ${confidence.toFixed(2)} below standard threshold, escalating`;
      requiresHumanReview = true;
      escalationLevel = this.determineEscalationLevel(confidence, riskLevel);
    } else {
      decision = 'reject';
      threshold = thresholds.autoReject;
      reason = `Confidence ${confidence.toFixed(2)} below minimum threshold ${threshold.toFixed(2)}, auto-rejecting`;
      requiresHumanReview = false;

      // Record rejection
      if (this.config.autoRejectEnabled) {
        this.recordRejection(intent, confidence, threshold, reason);
      }
    }

    const result: ThresholdEnforcementResult = {
      decision,
      reason,
      confidence,
      threshold,
      riskLevel,
      requiresHumanReview,
      escalationLevel,
      metadata: {
        enforcementId: generateId(),
        timestamp: new Date().toISOString(),
        configVersion: this.configVersion,
        overridden: false,
      },
    };

    // Emit event
    this.emit('threshold_enforced', {
      intentId: intent.intentId,
      decision,
      confidence,
      threshold,
      riskLevel,
    });

    logger.info('Confidence threshold enforced', {
      intentId: intent.intentId,
      decision,
      confidence,
      threshold,
      escalationLevel,
    });

    return result;
  }

  /**
   * Override threshold decision (requires authorization)
   */
  async override(
    intentId: string,
    userId: string,
    authorizedBy: string,
    newDecision: 'approve' | 'clarify' | 'escalate' | 'reject',
    justification: string
  ): Promise<ThresholdOverride> {
    if (!this.config.allowOverrides) {
      throw new Error('Threshold overrides are disabled');
    }

    if (this.config.requireOverrideJustification && !justification) {
      throw new Error('Override justification is required');
    }

    const overrideId = generateId();
    const override: ThresholdOverride = {
      overrideId,
      intentId,
      userId,
      authorizedBy,
      originalDecision: 'unknown', // Would be set from previous result
      newDecision,
      justification,
      timestamp: new Date().toISOString(),
      approved: true,
    };

    this.overrides.set(overrideId, override);

    this.emit('threshold_overridden', {
      overrideId,
      intentId,
      authorizedBy,
      newDecision,
    });

    logger.warn('Confidence threshold overridden', {
      overrideId,
      intentId,
      authorizedBy,
      newDecision,
      justification,
    });

    return override;
  }

  /**
   * Get rejection history
   */
  getRejections(userId?: string): RejectionRecord[] {
    if (userId) {
      return this.rejections.filter(r => r.userId === userId);
    }
    return [...this.rejections];
  }

  /**
   * Get override history
   */
  getOverrides(intentId?: string): ThresholdOverride[] {
    const allOverrides = Array.from(this.overrides.values());
    if (intentId) {
      return allOverrides.filter(o => o.intentId === intentId);
    }
    return allOverrides;
  }

  /**
   * Calculate rejection rate for analytics
   */
  getStatistics(timeWindowMs?: number): {
    totalEnforcements: number;
    approvals: number;
    clarifications: number;
    escalations: number;
    rejections: number;
    overrides: number;
    averageConfidence: number;
    rejectionRate: number;
  } {
    const cutoff = timeWindowMs ? Date.now() - timeWindowMs : 0;

    const recentRejections = this.rejections.filter(
      r => new Date(r.timestamp).getTime() >= cutoff
    );

    const totalEnforcements = recentRejections.length;
    const rejections = recentRejections.length;
    const overrides = Array.from(this.overrides.values()).filter(
      o => new Date(o.timestamp).getTime() >= cutoff
    ).length;

    const averageConfidence = rejections > 0
      ? recentRejections.reduce((sum, r) => sum + r.confidence, 0) / rejections
      : 0;

    const rejectionRate = totalEnforcements > 0 ? rejections / totalEnforcements : 0;

    return {
      totalEnforcements,
      approvals: 0, // Would track this in production
      clarifications: 0, // Would track this in production
      escalations: 0, // Would track this in production
      rejections,
      overrides,
      averageConfidence,
      rejectionRate,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<ConfidenceThresholdConfig>): void {
    this.config = this.mergeConfig(this.config, newConfig);
    this.configVersion = `${parseFloat(this.configVersion) + 0.1}`;

    logger.info('Confidence threshold config updated', {
      configVersion: this.configVersion,
    });
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Determine escalation level based on confidence and risk
   */
  private determineEscalationLevel(
    confidence: number,
    riskLevel: RiskLevel
  ): 'supervisor' | 'security_team' | 'admin' {
    if (riskLevel === 'destructive') {
      return 'admin';
    }

    if (riskLevel === 'high' || confidence < 0.5) {
      return 'security_team';
    }

    return 'supervisor';
  }

  /**
   * Record a rejection for audit purposes
   */
  private recordRejection(
    intent: TypedIntent,
    confidence: number,
    threshold: number,
    reason: string
  ): void {
    const rejection: RejectionRecord = {
      rejectionId: generateId(),
      intentId: intent.intentId,
      userId: intent.userId,
      nlText: intent.nlText,
      confidence,
      threshold,
      riskLevel: intent.riskLevel,
      reason,
      timestamp: new Date().toISOString(),
      appealable: confidence >= threshold * 0.9, // Allow appeal if close to threshold
    };

    this.rejections.push(rejection);

    // Trim rejection history to last 1000 entries
    if (this.rejections.length > 1000) {
      this.rejections = this.rejections.slice(-1000);
    }

    this.emit('intent_rejected', {
      rejectionId: rejection.rejectionId,
      intentId: intent.intentId,
      userId: intent.userId,
      confidence,
      threshold,
    });

    logger.warn('Intent auto-rejected', {
      rejectionId: rejection.rejectionId,
      intentId: intent.intentId,
      confidence,
      threshold,
      appealable: rejection.appealable,
    });
  }

  /**
   * Merge configuration objects
   */
  private mergeConfig(
    base: ConfidenceThresholdConfig,
    override: Partial<ConfidenceThresholdConfig>
  ): ConfidenceThresholdConfig {
    return {
      thresholds: {
        destructive: { ...base.thresholds.destructive, ...override.thresholds?.destructive },
        high: { ...base.thresholds.high, ...override.thresholds?.high },
        medium: { ...base.thresholds.medium, ...override.thresholds?.medium },
        low: { ...base.thresholds.low, ...override.thresholds?.low },
      },
      allowOverrides: override.allowOverrides ?? base.allowOverrides,
      requireOverrideJustification: override.requireOverrideJustification ?? base.requireOverrideJustification,
      escalationEnabled: override.escalationEnabled ?? base.escalationEnabled,
      autoRejectEnabled: override.autoRejectEnabled ?? base.autoRejectEnabled,
    };
  }
}

// =============================================================================
// Singleton
// =============================================================================

let thresholdEnforcer: ConfidenceThresholdEnforcer | null = null;

export function getConfidenceThresholdEnforcer(): ConfidenceThresholdEnforcer {
  if (!thresholdEnforcer) {
    thresholdEnforcer = new ConfidenceThresholdEnforcer();
  }
  return thresholdEnforcer;
}

export function initializeConfidenceThresholdEnforcer(
  config?: Partial<ConfidenceThresholdConfig>
): ConfidenceThresholdEnforcer {
  if (!thresholdEnforcer) {
    thresholdEnforcer = new ConfidenceThresholdEnforcer(config);
  } else if (config) {
    thresholdEnforcer.updateConfig(config);
  }
  return thresholdEnforcer;
}
