/**
 * Confidence Telemetry
 *
 * Real-time tracking and analysis of confidence scoring metrics.
 * Provides insights into model performance, drift detection, and anomalies.
 *
 * Metrics Tracked:
 * - Confidence distribution over time
 * - Model agreement trends
 * - Rejection/escalation rates
 * - Confidence drift detection
 * - Per-user/per-action-type statistics
 *
 * Features:
 * - Sliding window statistics
 * - Anomaly detection
 * - Real-time alerting
 * - Exportable metrics for monitoring systems
 */

import { EventEmitter } from 'events';
import { componentLogger } from '../core/logger.js';
import type { RiskLevel } from '../core/types.js';

const logger = componentLogger('confidence-telemetry');

// =============================================================================
// Types
// =============================================================================

export interface ConfidenceMetric {
  timestamp: Date;
  intentId: string;
  userId: string;
  actionType: string;
  riskLevel: RiskLevel;
  confidence: number;
  modelAgreement?: number;
  ensembleSize?: number;
  responseTimeMs: number;
  decision: 'approve' | 'clarify' | 'escalate' | 'reject';
  metadata: Record<string, unknown>;
}

export interface TelemetrySnapshot {
  timestamp: Date;
  windowSizeMs: number;
  metricsCount: number;
  statistics: {
    avgConfidence: number;
    medianConfidence: number;
    stdDevConfidence: number;
    minConfidence: number;
    maxConfidence: number;
    p50: number;
    p95: number;
    p99: number;
  };
  distribution: {
    byDecision: Record<string, number>;
    byRisk: Record<RiskLevel, number>;
    byActionType: Record<string, number>;
  };
  trends: {
    confidenceDrift: number; // -1 to 1, negative = decreasing
    rejectionRate: number;
    escalationRate: number;
    avgModelAgreement: number;
    avgResponseTime: number;
  };
  anomalies: TelemetryAnomaly[];
}

export interface TelemetryAnomaly {
  type: 'low_confidence_spike' | 'high_rejection_rate' | 'model_disagreement' | 'performance_degradation';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  value: number;
  threshold: number;
  timestamp: Date;
  affectedMetrics: number;
}

export interface TelemetryConfig {
  windowSizeMs: number;
  maxMetricsStored: number;
  anomalyThresholds: {
    lowConfidenceSpike: number;
    highRejectionRate: number;
    lowModelAgreement: number;
    slowResponseTime: number;
  };
  enableRealTimeAlerts: boolean;
  snapshotIntervalMs: number;
}

export interface UserStatistics {
  userId: string;
  totalIntents: number;
  avgConfidence: number;
  rejectionRate: number;
  clarificationRate: number;
  mostCommonAction: string;
  confidenceTrend: 'improving' | 'stable' | 'declining';
}

// =============================================================================
// Default Configuration
// =============================================================================

const defaultTelemetryConfig: TelemetryConfig = {
  windowSizeMs: 60 * 60 * 1000, // 1 hour
  maxMetricsStored: 10000,
  anomalyThresholds: {
    lowConfidenceSpike: 0.4, // Alert if > 20% of intents below this
    highRejectionRate: 0.3, // Alert if rejection rate > 30%
    lowModelAgreement: 0.6, // Alert if agreement < 60%
    slowResponseTime: 5000, // Alert if avg response > 5s
  },
  enableRealTimeAlerts: true,
  snapshotIntervalMs: 5 * 60 * 1000, // 5 minutes
};

// =============================================================================
// Confidence Telemetry Tracker
// =============================================================================

export class ConfidenceTelemetry extends EventEmitter {
  private config: TelemetryConfig;
  private metrics: ConfidenceMetric[] = [];
  private snapshots: TelemetrySnapshot[] = [];
  private snapshotInterval: NodeJS.Timeout | null = null;
  private startTime = new Date();

  constructor(config: Partial<TelemetryConfig> = {}) {
    super();
    this.config = { ...defaultTelemetryConfig, ...config };
  }

  /**
   * Start telemetry tracking
   */
  start(): void {
    if (this.snapshotInterval) {
      return; // Already started
    }

    this.snapshotInterval = setInterval(() => {
      this.captureSnapshot();
    }, this.config.snapshotIntervalMs);

    logger.info('Confidence telemetry started', {
      windowSizeMs: this.config.windowSizeMs,
      snapshotIntervalMs: this.config.snapshotIntervalMs,
    });
  }

  /**
   * Stop telemetry tracking
   */
  stop(): void {
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }

    logger.info('Confidence telemetry stopped');
  }

  /**
   * Record a confidence metric
   */
  record(metric: ConfidenceMetric): void {
    this.metrics.push(metric);

    // Trim old metrics
    if (this.metrics.length > this.config.maxMetricsStored) {
      this.metrics = this.metrics.slice(-this.config.maxMetricsStored);
    }

    // Check for immediate anomalies
    if (this.config.enableRealTimeAlerts) {
      this.checkAnomalies([metric]);
    }

    this.emit('metric_recorded', metric);
  }

  /**
   * Get current snapshot
   */
  getCurrentSnapshot(): TelemetrySnapshot {
    const cutoff = new Date(Date.now() - this.config.windowSizeMs);
    const windowMetrics = this.metrics.filter(m => m.timestamp >= cutoff);

    return this.buildSnapshot(windowMetrics, this.config.windowSizeMs);
  }

  /**
   * Get historical snapshots
   */
  getSnapshots(limit?: number): TelemetrySnapshot[] {
    if (limit) {
      return this.snapshots.slice(-limit);
    }
    return [...this.snapshots];
  }

  /**
   * Get statistics for a specific user
   */
  getUserStatistics(userId: string): UserStatistics {
    const userMetrics = this.metrics.filter(m => m.userId === userId);

    if (userMetrics.length === 0) {
      return {
        userId,
        totalIntents: 0,
        avgConfidence: 0,
        rejectionRate: 0,
        clarificationRate: 0,
        mostCommonAction: 'unknown',
        confidenceTrend: 'stable',
      };
    }

    const avgConfidence = userMetrics.reduce((sum, m) => sum + m.confidence, 0) / userMetrics.length;
    const rejections = userMetrics.filter(m => m.decision === 'reject').length;
    const clarifications = userMetrics.filter(m => m.decision === 'clarify').length;

    // Find most common action
    const actionCounts = new Map<string, number>();
    for (const metric of userMetrics) {
      actionCounts.set(metric.actionType, (actionCounts.get(metric.actionType) || 0) + 1);
    }

    let mostCommonAction = 'unknown';
    let maxCount = 0;
    for (const [action, count] of actionCounts.entries()) {
      if (count > maxCount) {
        maxCount = count;
        mostCommonAction = action;
      }
    }

    // Calculate trend
    const confidenceTrend = this.calculateTrend(userMetrics.map(m => m.confidence));

    return {
      userId,
      totalIntents: userMetrics.length,
      avgConfidence,
      rejectionRate: rejections / userMetrics.length,
      clarificationRate: clarifications / userMetrics.length,
      mostCommonAction,
      confidenceTrend,
    };
  }

  /**
   * Get statistics by action type
   */
  getActionTypeStatistics(actionType: string): {
    actionType: string;
    count: number;
    avgConfidence: number;
    avgResponseTime: number;
    successRate: number;
  } {
    const actionMetrics = this.metrics.filter(m => m.actionType === actionType);

    if (actionMetrics.length === 0) {
      return {
        actionType,
        count: 0,
        avgConfidence: 0,
        avgResponseTime: 0,
        successRate: 0,
      };
    }

    const avgConfidence = actionMetrics.reduce((sum, m) => sum + m.confidence, 0) / actionMetrics.length;
    const avgResponseTime = actionMetrics.reduce((sum, m) => sum + m.responseTimeMs, 0) / actionMetrics.length;
    const approvals = actionMetrics.filter(m => m.decision === 'approve').length;

    return {
      actionType,
      count: actionMetrics.length,
      avgConfidence,
      avgResponseTime,
      successRate: approvals / actionMetrics.length,
    };
  }

  /**
   * Export metrics for external monitoring (Prometheus, Datadog, etc.)
   */
  exportMetrics(): {
    name: string;
    type: 'counter' | 'gauge' | 'histogram';
    value: number;
    labels?: Record<string, string>;
  }[] {
    const snapshot = this.getCurrentSnapshot();

    return [
      { name: 'aegis_confidence_avg', type: 'gauge', value: snapshot.statistics.avgConfidence },
      { name: 'aegis_confidence_p50', type: 'gauge', value: snapshot.statistics.p50 },
      { name: 'aegis_confidence_p95', type: 'gauge', value: snapshot.statistics.p95 },
      { name: 'aegis_confidence_p99', type: 'gauge', value: snapshot.statistics.p99 },
      { name: 'aegis_rejection_rate', type: 'gauge', value: snapshot.trends.rejectionRate },
      { name: 'aegis_escalation_rate', type: 'gauge', value: snapshot.trends.escalationRate },
      { name: 'aegis_model_agreement_avg', type: 'gauge', value: snapshot.trends.avgModelAgreement },
      { name: 'aegis_response_time_avg', type: 'gauge', value: snapshot.trends.avgResponseTime },
      { name: 'aegis_anomalies_count', type: 'counter', value: snapshot.anomalies.length },
      { name: 'aegis_metrics_total', type: 'counter', value: snapshot.metricsCount },
    ];
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Capture a snapshot of current metrics
   */
  private captureSnapshot(): void {
    const snapshot = this.getCurrentSnapshot();
    this.snapshots.push(snapshot);

    // Trim snapshots to last 100
    if (this.snapshots.length > 100) {
      this.snapshots = this.snapshots.slice(-100);
    }

    // Check for anomalies in the snapshot
    if (snapshot.anomalies.length > 0) {
      this.emit('anomalies_detected', snapshot.anomalies);

      for (const anomaly of snapshot.anomalies) {
        logger.warn('Telemetry anomaly detected', {
          type: anomaly.type,
          severity: anomaly.severity,
          description: anomaly.description,
          value: anomaly.value,
          threshold: anomaly.threshold,
        });
      }
    }

    this.emit('snapshot_captured', snapshot);
  }

  /**
   * Build a telemetry snapshot from metrics
   */
  private buildSnapshot(metrics: ConfidenceMetric[], windowSizeMs: number): TelemetrySnapshot {
    const confidences = metrics.map(m => m.confidence).sort((a, b) => a - b);

    const statistics = {
      avgConfidence: this.average(confidences),
      medianConfidence: this.percentile(confidences, 50),
      stdDevConfidence: this.stdDev(confidences),
      minConfidence: confidences[0] || 0,
      maxConfidence: confidences[confidences.length - 1] || 0,
      p50: this.percentile(confidences, 50),
      p95: this.percentile(confidences, 95),
      p99: this.percentile(confidences, 99),
    };

    const distribution = {
      byDecision: this.countByField(metrics, 'decision'),
      byRisk: this.countByField(metrics, 'riskLevel'),
      byActionType: this.countByField(metrics, 'actionType'),
    };

    const trends = {
      confidenceDrift: this.calculateTrendValue(confidences),
      rejectionRate: metrics.filter(m => m.decision === 'reject').length / (metrics.length || 1),
      escalationRate: metrics.filter(m => m.decision === 'escalate').length / (metrics.length || 1),
      avgModelAgreement: this.average(metrics.filter(m => m.modelAgreement !== undefined).map(m => m.modelAgreement!)),
      avgResponseTime: this.average(metrics.map(m => m.responseTimeMs)),
    };

    const anomalies = this.detectAnomalies(metrics, trends);

    return {
      timestamp: new Date(),
      windowSizeMs,
      metricsCount: metrics.length,
      statistics,
      distribution,
      trends,
      anomalies,
    };
  }

  /**
   * Detect anomalies in metrics
   */
  private detectAnomalies(metrics: ConfidenceMetric[], trends: TelemetrySnapshot['trends']): TelemetryAnomaly[] {
    const anomalies: TelemetryAnomaly[] = [];

    // Low confidence spike
    const lowConfidenceCount = metrics.filter(m => m.confidence < this.config.anomalyThresholds.lowConfidenceSpike).length;
    const lowConfidenceRate = lowConfidenceCount / (metrics.length || 1);

    if (lowConfidenceRate > 0.2) {
      anomalies.push({
        type: 'low_confidence_spike',
        severity: lowConfidenceRate > 0.4 ? 'critical' : lowConfidenceRate > 0.3 ? 'high' : 'medium',
        description: `${(lowConfidenceRate * 100).toFixed(1)}% of intents have confidence < ${this.config.anomalyThresholds.lowConfidenceSpike}`,
        value: lowConfidenceRate,
        threshold: 0.2,
        timestamp: new Date(),
        affectedMetrics: lowConfidenceCount,
      });
    }

    // High rejection rate
    if (trends.rejectionRate > this.config.anomalyThresholds.highRejectionRate) {
      anomalies.push({
        type: 'high_rejection_rate',
        severity: trends.rejectionRate > 0.5 ? 'critical' : trends.rejectionRate > 0.4 ? 'high' : 'medium',
        description: `Rejection rate is ${(trends.rejectionRate * 100).toFixed(1)}%`,
        value: trends.rejectionRate,
        threshold: this.config.anomalyThresholds.highRejectionRate,
        timestamp: new Date(),
        affectedMetrics: Math.floor(metrics.length * trends.rejectionRate),
      });
    }

    // Low model agreement
    if (trends.avgModelAgreement > 0 && trends.avgModelAgreement < this.config.anomalyThresholds.lowModelAgreement) {
      anomalies.push({
        type: 'model_disagreement',
        severity: trends.avgModelAgreement < 0.4 ? 'high' : 'medium',
        description: `Average model agreement is only ${(trends.avgModelAgreement * 100).toFixed(1)}%`,
        value: trends.avgModelAgreement,
        threshold: this.config.anomalyThresholds.lowModelAgreement,
        timestamp: new Date(),
        affectedMetrics: metrics.filter(m => m.modelAgreement !== undefined).length,
      });
    }

    // Slow response time
    if (trends.avgResponseTime > this.config.anomalyThresholds.slowResponseTime) {
      anomalies.push({
        type: 'performance_degradation',
        severity: trends.avgResponseTime > 10000 ? 'high' : 'medium',
        description: `Average response time is ${trends.avgResponseTime.toFixed(0)}ms`,
        value: trends.avgResponseTime,
        threshold: this.config.anomalyThresholds.slowResponseTime,
        timestamp: new Date(),
        affectedMetrics: metrics.length,
      });
    }

    return anomalies;
  }

  /**
   * Check for immediate anomalies in recent metrics
   */
  private checkAnomalies(recentMetrics: ConfidenceMetric[]): void {
    // Simple immediate checks
    for (const metric of recentMetrics) {
      if (metric.confidence < 0.3 && metric.riskLevel !== 'low') {
        this.emit('immediate_alert', {
          type: 'very_low_confidence',
          severity: 'high',
          metric,
        });
      }

      if (metric.responseTimeMs > 10000) {
        this.emit('immediate_alert', {
          type: 'slow_response',
          severity: 'medium',
          metric,
        });
      }
    }
  }

  /**
   * Calculate average
   */
  private average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  /**
   * Calculate percentile
   */
  private percentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;
    const index = Math.ceil((p / 100) * sortedValues.length) - 1;
    return sortedValues[Math.max(0, index)]!;
  }

  /**
   * Calculate standard deviation
   */
  private stdDev(values: number[]): number {
    if (values.length === 0) return 0;
    const avg = this.average(values);
    const squaredDiffs = values.map(v => Math.pow(v - avg, 2));
    return Math.sqrt(this.average(squaredDiffs));
  }

  /**
   * Count metrics by field
   */
  private countByField<T extends ConfidenceMetric, K extends keyof T>(
    metrics: T[],
    field: K
  ): Record<string, number> {
    const counts: Record<string, number> = {};

    for (const metric of metrics) {
      const value = String(metric[field]);
      counts[value] = (counts[value] || 0) + 1;
    }

    return counts;
  }

  /**
   * Calculate trend (simple linear regression slope)
   */
  private calculateTrendValue(values: number[]): number {
    if (values.length < 2) return 0;

    const n = values.length;
    const sumX = (n * (n - 1)) / 2;
    const sumY = values.reduce((sum, v) => sum + v, 0);
    const sumXY = values.reduce((sum, v, i) => sum + i * v, 0);
    const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    // Normalize to [-1, 1] range
    return Math.max(-1, Math.min(1, slope));
  }

  /**
   * Calculate trend category
   */
  private calculateTrend(values: number[]): 'improving' | 'stable' | 'declining' {
    const trend = this.calculateTrendValue(values);

    if (trend > 0.1) return 'improving';
    if (trend < -0.1) return 'declining';
    return 'stable';
  }
}

// =============================================================================
// Singleton
// =============================================================================

let confidenceTelemetry: ConfidenceTelemetry | null = null;

export function getConfidenceTelemetry(): ConfidenceTelemetry {
  if (!confidenceTelemetry) {
    confidenceTelemetry = new ConfidenceTelemetry();
    confidenceTelemetry.start();
  }
  return confidenceTelemetry;
}

export function initializeConfidenceTelemetry(
  config?: Partial<TelemetryConfig>
): ConfidenceTelemetry {
  if (!confidenceTelemetry) {
    confidenceTelemetry = new ConfidenceTelemetry(config);
    confidenceTelemetry.start();
  }
  return confidenceTelemetry;
}
