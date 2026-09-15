import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync } from 'fs';
import { resetConfig } from '../../src/core/config.js';
import { execute, queryOne } from '../../src/core/database.js';
import {
  savePlanPayload,
  loadPlanPayload,
  purgeExpiredPayloads,
} from '../../src/workflow/temporal/payload-store.js';
import type { PlanManifest } from '../../src/core/types.js';

const dbPath = join(tmpdir(), `aegis-payload-test-${randomUUID()}.db`);

function makePlan(): PlanManifest {
  const now = new Date().toISOString();
  return {
    planId: randomUUID(),
    intentId: randomUUID(),
    version: 1,
    createdAt: now,
    updatedAt: now,
    steps: [],
    totalEstimatedCost: 0,
    totalEstimatedDuration: 0,
    riskLevel: 'low',
    approvalRequired: false,
    checksum: 'test-checksum',
  };
}

describe('Temporal payload store', () => {
  beforeAll(() => {
    process.env['DATABASE_PATH'] = dbPath;
    resetConfig();
    execute(`CREATE TABLE IF NOT EXISTS workflow_payloads (
      payload_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT
    )`);
  });

  afterAll(() => {
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
  });

  it('round-trips a plan payload', () => {
    const plan = makePlan();
    const payloadId = savePlanPayload(plan);
    const loaded = loadPlanPayload(payloadId);
    expect(loaded).not.toBeNull();
    expect(loaded?.planId).toBe(plan.planId);
    expect(loaded?.intentId).toBe(plan.intentId);
  });

  it('applies a default 7-day TTL when no expiry is given', () => {
    const payloadId = savePlanPayload(makePlan());
    const row = queryOne<{ expiresAt: string }>(
      `SELECT expires_at AS expiresAt FROM workflow_payloads WHERE payload_id = ?`,
      [payloadId]
    );
    expect(row?.expiresAt).toBeDefined();
    const ttlMs = new Date(row!.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });

  it('treats expired payloads as missing and removes them on load', () => {
    const payloadId = savePlanPayload(
      makePlan(),
      new Date(Date.now() - 1000).toISOString()
    );
    expect(loadPlanPayload(payloadId)).toBeNull();
    const row = queryOne<{ payloadId: string }>(
      `SELECT payload_id AS payloadId FROM workflow_payloads WHERE payload_id = ?`,
      [payloadId]
    );
    expect(row).toBeUndefined();
  });

  it('purgeExpiredPayloads removes expired rows and reports the count', () => {
    savePlanPayload(makePlan(), new Date(Date.now() - 5000).toISOString());
    savePlanPayload(makePlan(), new Date(Date.now() - 5000).toISOString());
    savePlanPayload(makePlan()); // not expired

    const removed = purgeExpiredPayloads();
    expect(removed).toBe(2);

    const remaining = queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM workflow_payloads`
    );
    expect(remaining?.count).toBeGreaterThanOrEqual(1);
  });
});
