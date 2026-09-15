/**
 * Token Usage Accounting
 *
 * Measures real LLM token consumption per agent (not estimates) and
 * attributes cost to agent/tenant budgets. Prices are approximate public
 * list prices (USD per 1M tokens) and should be reviewed periodically —
 * they are configurable via `setModelPricing`.
 */

import { EventEmitter } from 'events';
import { componentLogger } from '../../core/logger.js';

const logger = componentLogger('token-usage');

export interface TokenPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Approximate public list prices, USD per 1M tokens. Review quarterly.
 */
const DEFAULT_PRICING: Record<string, TokenPricing> = {
  // OpenAI
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  // Anthropic
  'claude-3-5-sonnet': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-3-5-haiku': { inputPerMillion: 0.8, outputPerMillion: 4 },
  'claude-3-opus': { inputPerMillion: 15, outputPerMillion: 75 },
  // Google
  'gemini-1.5-pro': { inputPerMillion: 1.25, outputPerMillion: 5 },
  'gemini-1.5-flash': { inputPerMillion: 0.075, outputPerMillion: 0.3 },
};

const FALLBACK_PRICING: TokenPricing = { inputPerMillion: 3, outputPerMillion: 15 };

let pricing: Record<string, TokenPricing> = { ...DEFAULT_PRICING };

export function setModelPricing(overrides: Record<string, TokenPricing>): void {
  pricing = { ...DEFAULT_PRICING, ...overrides };
}

export function estimateTokenCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const normalized = model.toLowerCase();
  const entry =
    pricing[normalized] ??
    Object.entries(pricing).find(([name]) => normalized.includes(name))?.[1] ??
    FALLBACK_PRICING;
  return (
    (inputTokens / 1_000_000) * entry.inputPerMillion +
    (outputTokens / 1_000_000) * entry.outputPerMillion
  );
}

export interface TokenUsageRecord {
  agentId: string;
  tenantId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  timestamp: Date;
}

export interface BudgetRecorder {
  recordUsage(agentId: string, tenantId: string, units: number, action?: string): Promise<void>;
}

/**
 * Tracks measured token usage per agent and per model, and forwards the
 * computed cost to a budget recorder (e.g. BudgetService) when one is
 * attached.
 */
export class TokenUsageTracker extends EventEmitter {
  private records: TokenUsageRecord[] = [];
  private budgetRecorder: BudgetRecorder | null = null;

  attachBudgetRecorder(recorder: BudgetRecorder): void {
    this.budgetRecorder = recorder;
  }

  async record(
    agentId: string,
    tenantId: string,
    model: string,
    inputTokens: number,
    outputTokens: number
  ): Promise<TokenUsageRecord> {
    const estimatedCostUsd = estimateTokenCost(model, inputTokens, outputTokens);
    const record: TokenUsageRecord = {
      agentId,
      tenantId,
      model,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      timestamp: new Date(),
    };
    this.records.push(record);
    if (this.records.length > 10_000) {
      this.records = this.records.slice(-5_000);
    }

    if (this.budgetRecorder) {
      await this.budgetRecorder.recordUsage(agentId, tenantId, estimatedCostUsd, 'llm');
    }

    this.emit('usage_recorded', record);
    logger.debug(
      { agentId, tenantId, model, inputTokens, outputTokens, estimatedCostUsd },
      'LLM token usage recorded'
    );
    return record;
  }

  getStats(): {
    totalRecords: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    byAgent: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
    byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
  } {
    const byAgent: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }> = {};
    const byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }> = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;

    for (const r of this.records) {
      totalInputTokens += r.inputTokens;
      totalOutputTokens += r.outputTokens;
      totalCostUsd += r.estimatedCostUsd;

      const a = (byAgent[r.agentId] ??= { inputTokens: 0, outputTokens: 0, costUsd: 0 });
      a.inputTokens += r.inputTokens;
      a.outputTokens += r.outputTokens;
      a.costUsd += r.estimatedCostUsd;

      const m = (byModel[r.model] ??= { inputTokens: 0, outputTokens: 0, costUsd: 0 });
      m.inputTokens += r.inputTokens;
      m.outputTokens += r.outputTokens;
      m.costUsd += r.estimatedCostUsd;
    }

    return {
      totalRecords: this.records.length,
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd,
      byAgent,
      byModel,
    };
  }
}

let tracker: TokenUsageTracker | null = null;

export function getTokenUsageTracker(): TokenUsageTracker {
  if (!tracker) {
    tracker = new TokenUsageTracker();
  }
  return tracker;
}
