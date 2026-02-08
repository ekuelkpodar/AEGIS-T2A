/**
 * Workflow Payload Store (Claim-Check Pattern)
 */

import { execute, queryOne } from '../../core/database.js';
import { generateId } from '../../core/ids.js';
import type { PlanManifest } from '../../core/types.js';

export interface PayloadRecord {
  payloadId: string;
  planId: string;
  intentId: string;
  payloadJson: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt?: string;
}

export function savePlanPayload(
  plan: PlanManifest,
  expiresAt?: string
): string {
  const payloadId = generateId();
  const payloadJson = JSON.stringify(plan);
  const sizeBytes = Buffer.byteLength(payloadJson, 'utf8');
  const createdAt = new Date().toISOString();

  execute(
    `INSERT INTO workflow_payloads
     (payload_id, plan_id, intent_id, payload_json, size_bytes, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      payloadId,
      plan.planId,
      plan.intentId,
      payloadJson,
      sizeBytes,
      createdAt,
      expiresAt ?? null,
    ]
  );

  return payloadId;
}

export function loadPlanPayload(payloadId: string): PlanManifest | null {
  const row = queryOne<PayloadRecord>(
    `SELECT payload_id AS payloadId, plan_id AS planId, intent_id AS intentId,
            payload_json AS payloadJson, size_bytes AS sizeBytes,
            created_at AS createdAt, expires_at AS expiresAt
     FROM workflow_payloads
     WHERE payload_id = ?`,
    [payloadId]
  );

  if (!row) return null;
  return JSON.parse(row.payloadJson) as PlanManifest;
}
