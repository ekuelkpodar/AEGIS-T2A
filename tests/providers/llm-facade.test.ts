import { describe, it, expect, beforeEach } from 'vitest';
import { resetConfig } from '../../src/core/config.js';
import {
  complete,
  setActiveProvider,
  setUsageReporter,
  LLMSafetyError,
  type LLMProvider,
  type LLMCompletionOptions,
  type UsageReport,
} from '../../src/providers/llm/index.js';

const fakeProvider: LLMProvider = {
  name: 'fake-test-provider',
  async complete(options: LLMCompletionOptions) {
    void options;
    return {
      content: 'All tasks completed successfully.',
      usage: { inputTokens: 100, outputTokens: 50 },
      model: 'gpt-4o-mini',
      finishReason: 'stop',
    };
  },
};

const leakingProvider: LLMProvider = {
  name: 'fake-leaking-provider',
  async complete() {
    return {
      content: 'Here is the secret: AKIAIOSFODNN7EXAMPLE do not share.',
      usage: { inputTokens: 10, outputTokens: 10 },
      model: 'gpt-4o-mini',
      finishReason: 'stop',
    };
  },
};

describe('LLM provider facade: usage reporting + guardrails', () => {
  beforeEach(() => {
    setActiveProvider(fakeProvider);
    setUsageReporter(null);
    process.env['LLM_GUARDRAILS_ENABLED'] = 'false';
    resetConfig();
  });

  it('reports measured token usage to the registered reporter', async () => {
    const reports: UsageReport[] = [];
    setUsageReporter((r) => {
      reports.push(r);
    });

    await complete({
      messages: [{ role: 'user', content: 'hi' }],
      agentContext: { agentId: 'agent-1', tenantId: 'tenant-a' },
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      agentId: 'agent-1',
      tenantId: 'tenant-a',
      model: 'gpt-4o-mini',
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it('skips reporting when no agent context is provided', async () => {
    const reports: UsageReport[] = [];
    setUsageReporter((r) => {
      reports.push(r);
    });

    await complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(reports).toHaveLength(0);
  });

  it('blocks responses with critical safety violations', async () => {
    setActiveProvider(leakingProvider);
    process.env['LLM_GUARDRAILS_ENABLED'] = 'true';
    resetConfig();

    await expect(
      complete({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toBeInstanceOf(LLMSafetyError);
  });
});
