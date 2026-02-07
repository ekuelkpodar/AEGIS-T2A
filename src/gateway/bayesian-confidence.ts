/**
 * Bayesian Confidence Scoring
 *
 * Calculates confidence using Bayes' theorem: P(A|B) = P(B|A) * P(A) / P(B)
 *
 * Components:
 * - Prior: Historical action type distribution
 * - Likelihood: LLM confidence given action type
 * - Posterior: Updated confidence after evidence
 *
 * References:
 * - Bayesian Inference for NLP
 * - Probabilistic Intent Classification
 */

import { componentLogger } from '../core/logger.js';
import type { RiskLevel } from '../core/types.js';

const logger = componentLogger('bayesian-confidence');

// =============================================================================
// Types
// =============================================================================

export interface PriorDistribution {
  actionType: string;
  frequency: number;
  totalObservations: number;
  prior: number;
}

export interface LikelihoodEvidence {
  actionType: string;
  llmConfidence: number;
  keywordMatches: number;
  contextRelevance: number;
  historicalSuccess: number;
}

export interface BayesianScore {
  actionType: string;
  prior: number;
  likelihood: number;
  posterior: number;
  evidenceStrength: 'weak' | 'moderate' | 'strong';
  confidenceInterval: { lower: number; upper: number };
}

export interface BayesianConfidenceResult {
  scores: BayesianScore[];
  topChoice: BayesianScore;
  confidence: number;
  entropy: number;
  needsMoreEvidence: boolean;
  metadata: {
    totalEvidence: number;
    priorWeight: number;
    likelihoodWeight: number;
    calculationMethod: 'bayesian' | 'laplace-smoothing';
  };
}

// =============================================================================
// Bayesian Confidence Calculator
// =============================================================================

export class BayesianConfidenceCalculator {
  private priorDistribution = new Map<string, PriorDistribution>();
  private totalObservations = 0;
  private smoothingFactor = 1.0; // Laplace smoothing

  constructor(smoothingFactor = 1.0) {
    this.smoothingFactor = smoothingFactor;
    this.initializeDefaultPriors();
  }

  /**
   * Calculate Bayesian confidence scores for multiple action types
   */
  calculateConfidence(
    actionTypes: string[],
    evidence: LikelihoodEvidence[]
  ): BayesianConfidenceResult {
    const scores: BayesianScore[] = [];

    // Calculate posterior for each action type
    for (const actionType of actionTypes) {
      const score = this.calculatePosterior(actionType, evidence);
      scores.push(score);
    }

    // Normalize posteriors to sum to 1
    const totalPosterior = scores.reduce((sum, s) => sum + s.posterior, 0);
    for (const score of scores) {
      score.posterior = score.posterior / (totalPosterior || 1);
    }

    // Sort by posterior (highest first)
    scores.sort((a, b) => b.posterior - a.posterior);

    const topChoice = scores[0]!;

    // Calculate Shannon entropy (measure of uncertainty)
    const entropy = this.calculateEntropy(scores.map(s => s.posterior));

    // Convert posterior to 0-1 confidence scale
    const confidence = topChoice.posterior;

    // Determine if more evidence is needed
    const needsMoreEvidence =
      entropy > 0.7 || // High uncertainty
      topChoice.posterior < 0.6 || // Low top choice confidence
      (scores[1] && topChoice.posterior - scores[1].posterior < 0.15); // Close second choice

    return {
      scores,
      topChoice,
      confidence,
      entropy,
      needsMoreEvidence,
      metadata: {
        totalEvidence: evidence.length,
        priorWeight: 0.3,
        likelihoodWeight: 0.7,
        calculationMethod: this.totalObservations > 10 ? 'bayesian' : 'laplace-smoothing',
      },
    };
  }

  /**
   * Update priors based on new observations
   */
  updatePrior(actionType: string, success: boolean): void {
    let prior = this.priorDistribution.get(actionType);

    if (!prior) {
      prior = {
        actionType,
        frequency: 0,
        totalObservations: 0,
        prior: 0,
      };
      this.priorDistribution.set(actionType, prior);
    }

    if (success) {
      prior.frequency++;
    }
    prior.totalObservations++;
    this.totalObservations++;

    // Recalculate prior with Laplace smoothing
    const vocabularySize = this.priorDistribution.size;
    prior.prior =
      (prior.frequency + this.smoothingFactor) /
      (prior.totalObservations + this.smoothingFactor * vocabularySize);

    logger.debug('Updated prior', {
      actionType,
      frequency: prior.frequency,
      totalObservations: prior.totalObservations,
      prior: prior.prior,
    });
  }

  /**
   * Get prior distribution
   */
  getPriorDistribution(): PriorDistribution[] {
    return Array.from(this.priorDistribution.values());
  }

  /**
   * Reset priors (for testing or retraining)
   */
  resetPriors(): void {
    this.priorDistribution.clear();
    this.totalObservations = 0;
    this.initializeDefaultPriors();
    logger.info('Priors reset to defaults');
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Calculate posterior probability using Bayes' theorem
   * P(action|evidence) = P(evidence|action) * P(action) / P(evidence)
   */
  private calculatePosterior(
    actionType: string,
    evidenceList: LikelihoodEvidence[]
  ): BayesianScore {
    // Get prior P(action)
    const prior = this.getPrior(actionType);

    // Get likelihood P(evidence|action)
    const likelihood = this.calculateLikelihood(actionType, evidenceList);

    // Calculate posterior (unnormalized)
    // P(evidence) is calculated later during normalization
    const posterior = likelihood * prior;

    // Determine evidence strength
    const evidenceStrength = this.assessEvidenceStrength(evidenceList);

    // Calculate confidence interval (simplified Bayesian credible interval)
    const confidenceInterval = this.calculateConfidenceInterval(
      posterior,
      evidenceList.length
    );

    return {
      actionType,
      prior,
      likelihood,
      posterior,
      evidenceStrength,
      confidenceInterval,
    };
  }

  /**
   * Get prior probability for action type
   */
  private getPrior(actionType: string): number {
    const prior = this.priorDistribution.get(actionType);

    if (!prior) {
      // Uniform prior with Laplace smoothing for unseen action types
      const vocabularySize = this.priorDistribution.size || 10;
      return this.smoothingFactor / (this.totalObservations + this.smoothingFactor * vocabularySize);
    }

    return prior.prior;
  }

  /**
   * Calculate likelihood P(evidence|action)
   * Combines multiple evidence sources
   */
  private calculateLikelihood(
    actionType: string,
    evidenceList: LikelihoodEvidence[]
  ): number {
    const evidence = evidenceList.find(e => e.actionType === actionType);

    if (!evidence) {
      return 0.1; // Low likelihood for missing evidence
    }

    // Weighted combination of evidence sources
    const weights = {
      llmConfidence: 0.5,
      keywordMatches: 0.2,
      contextRelevance: 0.2,
      historicalSuccess: 0.1,
    };

    const likelihood =
      evidence.llmConfidence * weights.llmConfidence +
      evidence.keywordMatches * weights.keywordMatches +
      evidence.contextRelevance * weights.contextRelevance +
      evidence.historicalSuccess * weights.historicalSuccess;

    // Ensure likelihood is in [0, 1]
    return Math.max(0, Math.min(1, likelihood));
  }

  /**
   * Calculate Shannon entropy H = -Σ(p * log2(p))
   * Measures uncertainty in probability distribution
   */
  private calculateEntropy(probabilities: number[]): number {
    let entropy = 0;

    for (const p of probabilities) {
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }

    // Normalize to [0, 1] range
    const maxEntropy = Math.log2(probabilities.length);
    return maxEntropy > 0 ? entropy / maxEntropy : 0;
  }

  /**
   * Assess evidence strength based on multiple factors
   */
  private assessEvidenceStrength(evidence: LikelihoodEvidence[]): 'weak' | 'moderate' | 'strong' {
    if (evidence.length === 0) {
      return 'weak';
    }

    const avgConfidence = evidence.reduce((sum, e) => sum + e.llmConfidence, 0) / evidence.length;
    const avgKeywords = evidence.reduce((sum, e) => sum + e.keywordMatches, 0) / evidence.length;
    const avgContext = evidence.reduce((sum, e) => sum + e.contextRelevance, 0) / evidence.length;

    const score = (avgConfidence + avgKeywords + avgContext) / 3;

    if (score >= 0.75) return 'strong';
    if (score >= 0.5) return 'moderate';
    return 'weak';
  }

  /**
   * Calculate Bayesian credible interval
   * Simplified using normal approximation
   */
  private calculateConfidenceInterval(
    posterior: number,
    evidenceCount: number
  ): { lower: number; upper: number } {
    // Standard error decreases with more evidence
    const standardError = Math.sqrt(posterior * (1 - posterior) / Math.max(1, evidenceCount));

    // 95% confidence interval (±1.96 SE)
    const margin = 1.96 * standardError;

    return {
      lower: Math.max(0, posterior - margin),
      upper: Math.min(1, posterior + margin),
    };
  }

  /**
   * Initialize default priors for common action types
   */
  private initializeDefaultPriors(): void {
    const defaultActions = [
      { type: 'query', frequency: 50 },
      { type: 'create', frequency: 20 },
      { type: 'update', frequency: 15 },
      { type: 'delete', frequency: 5 },
      { type: 'deploy', frequency: 8 },
      { type: 'configure', frequency: 12 },
    ];

    const total = defaultActions.reduce((sum, a) => sum + a.frequency, 0);

    for (const action of defaultActions) {
      this.priorDistribution.set(action.type, {
        actionType: action.type,
        frequency: action.frequency,
        totalObservations: total,
        prior: (action.frequency + this.smoothingFactor) /
               (total + this.smoothingFactor * defaultActions.length),
      });
    }

    this.totalObservations = total;
  }
}

// =============================================================================
// Singleton
// =============================================================================

let bayesianCalculator: BayesianConfidenceCalculator | null = null;

export function getBayesianConfidenceCalculator(): BayesianConfidenceCalculator {
  if (!bayesianCalculator) {
    bayesianCalculator = new BayesianConfidenceCalculator();
  }
  return bayesianCalculator;
}

/**
 * Helper: Convert LLM confidence (0-10 scale) to normalized evidence
 */
export function createLikelihoodEvidence(
  actionType: string,
  llmConfidence: number,
  keywordCount: number = 0,
  contextScore: number = 0.5,
  historicalSuccessRate: number = 0.5
): LikelihoodEvidence {
  return {
    actionType,
    llmConfidence: llmConfidence / 10, // Normalize to [0, 1]
    keywordMatches: Math.min(1, keywordCount / 5), // Normalize to [0, 1]
    contextRelevance: contextScore,
    historicalSuccess: historicalSuccessRate,
  };
}
