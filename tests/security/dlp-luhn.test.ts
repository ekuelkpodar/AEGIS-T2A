import { describe, it, expect, beforeEach } from 'vitest';
import { DLPFilter, luhnCheck } from '../../src/executor/dlp-filter.js';

describe('luhnCheck', () => {
  it('accepts Luhn-valid card numbers', () => {
    // Well-known test card numbers (not real accounts)
    expect(luhnCheck('4111111111111111')).toBe(true);
    expect(luhnCheck('4111 1111 1111 1111')).toBe(true);
    expect(luhnCheck('4111-1111-1111-1111')).toBe(true);
    expect(luhnCheck('5500000000000004')).toBe(true);
  });

  it('rejects card-shaped numbers that fail Luhn', () => {
    expect(luhnCheck('4111111111111112')).toBe(false);
    expect(luhnCheck('1234567812345678')).toBe(false);
    expect(luhnCheck('9999999999999999')).toBe(false);
  });
});

describe('DLPFilter credit-card Luhn validation', () => {
  let filter: DLPFilter;

  beforeEach(async () => {
    filter = new DLPFilter({ enabled: true });
    await filter.initialize();
  });

  it('flags Luhn-valid card numbers', async () => {
    const result = await filter.filter({
      note: 'charge 4111111111111111 for the invoice',
    });
    const findings = result.scan_result.findings.filter((f) =>
      f.data_type.includes('card')
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it('does not flag card-shaped numbers that fail Luhn', async () => {
    const result = await filter.filter({
      note: 'reference 1234567812345678 is not a card',
    });
    const findings = result.scan_result.findings.filter((f) =>
      f.data_type.includes('card')
    );
    expect(findings).toHaveLength(0);
  });
});
