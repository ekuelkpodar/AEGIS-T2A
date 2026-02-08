/**
 * Records of Processing Activities (RoPA) store.
 */

import { execute, queryAll, queryOne } from '../core/database.js';
import { generateId } from '../core/ids.js';

export interface RopaRecord {
  ropaId: string;
  tenantId: string;
  systemName: string;
  purpose: string;
  dataCategories: string[];
  dataSubjects: string[];
  recipients: string[];
  retentionPeriod?: string;
  processingBasis?: string;
  crossBorderTransfers: boolean;
  securityMeasures?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RopaInput {
  tenantId: string;
  systemName: string;
  purpose: string;
  dataCategories: string[];
  dataSubjects: string[];
  recipients: string[];
  retentionPeriod?: string;
  processingBasis?: string;
  crossBorderTransfers?: boolean;
  securityMeasures?: string;
}

export function createRopaRecord(input: RopaInput): RopaRecord {
  const ropaId = generateId();
  const now = new Date().toISOString();

  execute(
    `INSERT INTO ropa_records
     (ropa_id, tenant_id, system_name, purpose, data_categories, data_subjects, recipients,
      retention_period, processing_basis, cross_border_transfers, security_measures, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ropaId,
      input.tenantId,
      input.systemName,
      input.purpose,
      JSON.stringify(input.dataCategories),
      JSON.stringify(input.dataSubjects),
      JSON.stringify(input.recipients),
      input.retentionPeriod ?? null,
      input.processingBasis ?? null,
      input.crossBorderTransfers ? 1 : 0,
      input.securityMeasures ?? null,
      now,
      now,
    ]
  );

  return {
    ropaId,
    tenantId: input.tenantId,
    systemName: input.systemName,
    purpose: input.purpose,
    dataCategories: input.dataCategories,
    dataSubjects: input.dataSubjects,
    recipients: input.recipients,
    retentionPeriod: input.retentionPeriod,
    processingBasis: input.processingBasis,
    crossBorderTransfers: input.crossBorderTransfers ?? false,
    securityMeasures: input.securityMeasures,
    createdAt: now,
    updatedAt: now,
  };
}

export function listRopaRecords(tenantId?: string): RopaRecord[] {
  const rows = queryAll<{
    ropa_id: string;
    tenant_id: string;
    system_name: string;
    purpose: string;
    data_categories: string;
    data_subjects: string;
    recipients: string;
    retention_period: string | null;
    processing_basis: string | null;
    cross_border_transfers: number;
    security_measures: string | null;
    created_at: string;
    updated_at: string;
  }>(
    tenantId
      ? `SELECT * FROM ropa_records WHERE tenant_id = ? ORDER BY updated_at DESC`
      : `SELECT * FROM ropa_records ORDER BY updated_at DESC`,
    tenantId ? [tenantId] : []
  );

  return rows.map((row) => ({
    ropaId: row.ropa_id,
    tenantId: row.tenant_id,
    systemName: row.system_name,
    purpose: row.purpose,
    dataCategories: JSON.parse(row.data_categories),
    dataSubjects: JSON.parse(row.data_subjects),
    recipients: JSON.parse(row.recipients),
    retentionPeriod: row.retention_period ?? undefined,
    processingBasis: row.processing_basis ?? undefined,
    crossBorderTransfers: row.cross_border_transfers === 1,
    securityMeasures: row.security_measures ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getRopaRecord(ropaId: string): RopaRecord | null {
  const row = queryOne<{
    ropa_id: string;
    tenant_id: string;
    system_name: string;
    purpose: string;
    data_categories: string;
    data_subjects: string;
    recipients: string;
    retention_period: string | null;
    processing_basis: string | null;
    cross_border_transfers: number;
    security_measures: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT * FROM ropa_records WHERE ropa_id = ?`,
    [ropaId]
  );

  if (!row) return null;

  return {
    ropaId: row.ropa_id,
    tenantId: row.tenant_id,
    systemName: row.system_name,
    purpose: row.purpose,
    dataCategories: JSON.parse(row.data_categories),
    dataSubjects: JSON.parse(row.data_subjects),
    recipients: JSON.parse(row.recipients),
    retentionPeriod: row.retention_period ?? undefined,
    processingBasis: row.processing_basis ?? undefined,
    crossBorderTransfers: row.cross_border_transfers === 1,
    securityMeasures: row.security_measures ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
