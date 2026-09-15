import { describe, it, expect, beforeEach } from 'vitest';
import {
  LLMGuardrails,
  SafetyViolationType,
} from '../../src/security/llm-guardrails.js';

describe('LLMGuardrails', () => {
  let guardrails: LLMGuardrails;

  beforeEach(() => {
    guardrails = new LLMGuardrails({
      enableRateLimiting: false,
      logAllDetections: false,
    } as never);
  });

  it('passes benign output as safe', async () => {
    const result = await guardrails.checkOutput(
      'Here is a summary of the Q3 incident report with three action items.'
    );
    expect(result.safe).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('detects and redacts PII', async () => {
    const result = await guardrails.checkOutput(
      'Contact the customer at 123-45-6789 for follow-up.'
    );
    expect(result.violations.some((v) => v.type === SafetyViolationType.PII_EXPOSURE)).toBe(true);
    expect(result.sanitizedOutput).toBeDefined();
    expect(result.sanitizedOutput).not.toContain('123-45-6789');
  });

  it('blocks output containing secrets as critical', async () => {
    const result = await guardrails.checkOutput(
      'Deploy with key AKIAIOSFODNN7EXAMPLE immediately.'
    );
    expect(result.safe).toBe(false);
    expect(
      result.violations.some((v) => v.type === SafetyViolationType.SECRET_EXPOSURE && v.severity === 'critical')
    ).toBe(true);
  });

  it('tracks request statistics accurately', async () => {
    await guardrails.checkOutput('benign output');
    await guardrails.checkOutput('key AKIAIOSFODNN7EXAMPLE leaked');
    await guardrails.checkOutput('another benign output with ssn 123-45-6789 inside');

    const stats = guardrails.getStats();
    expect(stats.totalRequests).toBe(3);
    expect(stats.blockedRequests).toBe(1);
    expect(stats.warningRequests).toBe(1);
  });

  it('enforces cost limits', async () => {
    const result = await guardrails.checkOutput('output', { estimatedCost: 999 });
    expect(result.violations.some((v) => v.type === SafetyViolationType.EXCESSIVE_COST)).toBe(true);
  });
});
