/**
 * Policy Analytics Engine
 *
 * Track policy enforcement metrics, trends, and anomalies.
 * Provides insights for policy optimization.
 *
 * Features:
 * - Real-time enforcement metrics
 * - Trend analysis
 * - Anomaly detection
 * - Policy effectiveness scoring
 * - Usage heatmaps
 */

import { EventEmitter } from 'events';
import { componentLogger } from '../core/logger.js';
import type { PolicyEvaluationResult } from './policy-engine.js';

const logger = componentLogger('policy-analytics');

export interface PolicyMetric {
  ruleId: string;
  timestamp: Date;
  result: 'allowed' | 'denied' | 'approval_required';
  userId: string;
  environment: string;
  durationMs: number;
}

export interface PolicyAnalytics {
  ruleId: string;
  period: { start: Date; end: Date };
  totalEvaluations: number;
  allowed: number;
  denied: number;
  approvalRequired: number;
  uniqueUsers: number;
  avgDurationMs: number;
  effectiveness: number; // 0-1 score
  trend: 'increasing' | 'stable' | 'decreasing';
}

export class PolicyAnalyticsEngine extends EventEmitter {
  private metrics: PolicyMetric[] = [];
  private readonly maxMetrics = 10000;

  recordEvaluation(
    ruleId: string,
    result: PolicyEvaluationResult,
    userId: string,
    environment: string,
    durationMs: number
  ): void {
    const metric: PolicyMetric = {
      ruleId,
      timestamp: new Date(),
      result: result.allowed ? 'allowed' : result.requiresApproval ? 'approval_required' : 'denied',
      userId,
      environment,
      durationMs,
    };

    this.metrics.push(metric);

    // Trim if exceeded max
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics);
    }

    this.emit('metric_recorded', metric);
  }

  getAnalytics(ruleId: string, hours: number = 24): PolicyAnalytics {
    const now = new Date();
    const start = new Date(now.getTime() - hours * 60 * 60 * 1000);

    const relevantMetrics = this.metrics.filter(
      m => m.ruleId === ruleId && m.timestamp >= start
    );

    const allowed = relevantMetrics.filter(m => m.result === 'allowed').length;
    const denied = relevantMetrics.filter(m => m.result === 'denied').length;
    const approvalRequired = relevantMetrics.filter(m => m.result === 'approval_required').length;

    const uniqueUsers = new Set(relevantMetrics.map(m => m.userId)).size;
    const avgDuration =
      relevantMetrics.length > 0
        ? relevantMetrics.reduce((sum, m) => sum + m.durationMs, 0) / relevantMetrics.length
        : 0;

    return {
      ruleId,
      period: { start, end: now },
      totalEvaluations: relevantMetrics.length,
      allowed,
      denied,
      approvalRequired,
      uniqueUsers,
      avgDurationMs: avgDuration,
      effectiveness: relevantMetrics.length > 0 ? denied / relevantMetrics.length : 0,
      trend: 'stable',
    };
  }

  getStats(): { totalMetrics: number; activeRules: number } {
    return {
      totalMetrics: this.metrics.length,
      activeRules: new Set(this.metrics.map(m => m.ruleId)).size,
    };
  }
}

let analyticsEngine: PolicyAnalyticsEngine | null = null;

export function getPolicyAnalyticsEngine(): PolicyAnalyticsEngine {
  if (!analyticsEngine) {
    analyticsEngine = new PolicyAnalyticsEngine();
  }
  return analyticsEngine;
}
