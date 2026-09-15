/**
 * AEGIS-T2A Core Tests
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  generateId,
  generateIntentId,
  generatePlanId,
  generateWorkflowId,
  generateIdempotencyKey,
  isValidUuid,
} from '../src/core/ids.js';
import {
  sha256,
  hashObject,
  sign,
  verifySignature,
  signObject,
  chainHash,
  encrypt,
  decrypt,
  initializeSigningKey,
  initializeEncryptionKey,
} from '../src/core/crypto.js';
import {
  TypedIntentSchema,
  PlanStepSchema,
  RiskLevel,
  Sensitivity,
} from '../src/core/types.js';

describe('ID Generation', () => {
  it('generates valid UUIDs', () => {
    const id = generateId();
    expect(isValidUuid(id)).toBe(true);
  });

  it('generates prefixed IDs', () => {
    const intentId = generateIntentId();
    const planId = generatePlanId();
    const workflowId = generateWorkflowId();

    expect(intentId).toMatch(/^int_/);
    expect(planId).toMatch(/^pln_/);
    expect(workflowId).toMatch(/^wfl_/);
  });

  it('generates deterministic idempotency keys', () => {
    const key1 = generateIdempotencyKey('test', 'a', 'b');
    const key2 = generateIdempotencyKey('test', 'a', 'b');
    const key3 = generateIdempotencyKey('test', 'a', 'c');

    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
  });
});

describe('Cryptography', () => {
  beforeAll(() => {
    initializeSigningKey();
    initializeEncryptionKey();
  });

  it('computes SHA-256 hashes', () => {
    const hash = sha256('hello');
    expect(hash).toHaveLength(64);
    expect(hash).toBe(sha256('hello')); // Deterministic
  });

  it('hashes objects deterministically', () => {
    const obj1 = { b: 2, a: 1 };
    const obj2 = { a: 1, b: 2 };

    expect(hashObject(obj1)).toBe(hashObject(obj2));
  });

  it('hashes nested objects deterministically regardless of key order', () => {
    const obj1 = { b: { d: 4, c: 3 }, a: [{ y: 2, x: 1 }] };
    const obj2 = { a: [{ x: 1, y: 2 }], b: { c: 3, d: 4 } };

    expect(hashObject(obj1)).toBe(hashObject(obj2));
  });

  it('preserves nested keys that are absent at the top level', () => {
    // Regression test: the old replacer-array implementation silently
    // dropped nested keys not present at the top level, producing
    // collisions between structurally different payloads.
    const withNested = { tool: 'aws', parameters: { instanceId: 'i-123' } };
    const withoutNested = { tool: 'aws', parameters: {} };

    expect(hashObject(withNested)).not.toBe(hashObject(withoutNested));
  });

  it('handles null, arrays, and primitives without throwing', () => {
    expect(hashObject(null)).toHaveLength(64);
    expect(hashObject([3, 2, 1])).not.toBe(hashObject([1, 2, 3]));
    expect(hashObject('x')).toBe(hashObject('x'));
  });

  it('signs and verifies data', () => {
    const data = 'test data';
    const signature = sign(data);

    expect(verifySignature(data, signature)).toBe(true);
    expect(verifySignature('wrong data', signature)).toBe(false);
  });

  it('signs and verifies objects', () => {
    const obj = { foo: 'bar', num: 42 };
    const signature = signObject(obj);

    expect(signature).toHaveLength(64);
  });

  it('chains hashes correctly', () => {
    const prev = sha256('previous');
    const current = sha256('current');
    const chained = chainHash(prev, current);

    expect(chained).toHaveLength(64);
    expect(chained).not.toBe(prev);
    expect(chained).not.toBe(current);
  });

  it('encrypts and decrypts data', () => {
    const plaintext = 'secret message';
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);

    expect(encrypted).not.toBe(plaintext);
    expect(decrypted).toBe(plaintext);
  });
});

describe('Type Schemas', () => {
  it('validates TypedIntent schema', () => {
    const validIntent = {
      intentId: generateId(),
      userId: generateId(),
      timestamp: new Date().toISOString(),
      nlText: 'Create a new EC2 instance',
      actionType: 'create',
      riskLevel: 'medium' as RiskLevel,
      sensitivity: 'confidential' as Sensitivity,
      budget: { currency: 'USD', limit: 100, spent: 0 },
      requiredCapabilities: ['aws:ec2'],
      sideEffect: true,
      idempotencyKey: generateIdempotencyKey('test', 'intent'),
      policyStatus: 'pending' as const,
      approvalRequired: true,
      confidence: 0.9,
    };

    const result = TypedIntentSchema.safeParse(validIntent);
    expect(result.success).toBe(true);
  });

  it('validates PlanStep schema', () => {
    const validStep = {
      stepId: generateId(),
      planId: generateId(),
      sequenceNumber: 0,
      action: 'create_instance',
      description: 'Create an EC2 instance',
      toolAdapter: 'aws:ec2',
      parameters: { instanceType: 't2.micro' },
      sideEffect: true,
      dependencies: [],
      requiredCapabilities: ['aws:ec2'],
      idempotencyKey: generateIdempotencyKey('test', 'step'),
      estimatedCost: 0.1,
      estimatedDuration: 60000,
      riskLevel: 'medium' as RiskLevel,
      approvalRequired: false,
      timeout: 120000,
    };

    const result = PlanStepSchema.safeParse(validStep);
    expect(result.success).toBe(true);
  });

  it('rejects invalid schemas', () => {
    const invalidIntent = {
      intentId: 'not-a-uuid',
      // Missing required fields
    };

    const result = TypedIntentSchema.safeParse(invalidIntent);
    expect(result.success).toBe(false);
  });
});
