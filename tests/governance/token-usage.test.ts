import { describe, it, expect, beforeEach } from 'vitest';
import {
  TokenUsageTracker,
  estimateTokenCost,
  setModelPricing,
} from '../../src/governance/budget/token-usage.js';

describe('estimateTokenCost', () => {
  it('computes cost from per-model pricing', () => {
    // gpt-4o-mini: $0.15 / $0.60 per 1M
    const cost = estimateTokenCost('gpt-4o-mini', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.75, 6);
  });

  it('falls back to generic pricing for unknown models', () => {
    const cost = estimateTokenCost('some-future-model', 1_000_000, 0);
    expect(cost).toBeGreaterThan(0);
  });

  it('supports pricing overrides', () => {
    setModelPricing({ 'custom-model': { inputPerMillion: 1, outputPerMillion: 2 } });
    expect(estimateTokenCost('custom-model', 1_000_000, 1_000_000)).toBeCloseTo(3, 6);
  });
});

describe('TokenUsageTracker', () => {
  let tracker: TokenUsageTracker;

  beforeEach(() => {
    tracker = new TokenUsageTracker();
  });

  it('records usage and aggregates per agent and model', async () => {
    await tracker.record('agent-1', 'tenant-a', 'gpt-4o-mini', 1000, 500);
    await tracker.record('agent-1', 'tenant-a', 'gpt-4o', 2000, 1000);
    await tracker.record('agent-2', 'tenant-a', 'gpt-4o-mini', 500, 250);

    const stats = tracker.getStats();
    expect(stats.totalRecords).toBe(3);
    expect(stats.totalInputTokens).toBe(3500);
    expect(stats.totalOutputTokens).toBe(1750);
    expect(stats.byAgent['agent-1'].inputTokens).toBe(3000);
    expect(stats.byModel['gpt-4o-mini'].outputTokens).toBe(750);
    expect(stats.totalCostUsd).toBeGreaterThan(0);
  });

  it('forwards cost to an attached budget recorder', async () => {
    const calls: Array<{ agentId: string; tenantId: string; units: number; action?: string }> = [];
    tracker.attachBudgetRecorder({
      recordUsage: async (agentId, tenantId, units, action) => {
        calls.push({ agentId, tenantId, units, action });
      },
    });

    await tracker.record('agent-1', 'tenant-a', 'gpt-4o-mini', 1_000_000, 1_000_000);

    expect(calls).toHaveLength(1);
    expect(calls[0].agentId).toBe('agent-1');
    expect(calls[0].action).toBe('llm');
    expect(calls[0].units).toBeCloseTo(0.75, 6);
  });
});
