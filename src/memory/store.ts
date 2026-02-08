/**
 * Memory Store
 */

import { execute, queryAll } from '../core/database.js';
import { generateId } from '../core/ids.js';
import type { MemoryEntry, MemoryQuery, MemoryType } from './types.js';

export function writeMemory(
  namespaceId: string,
  memoryType: MemoryType,
  key: string,
  value: Record<string, unknown>,
  options: {
    validFrom?: string;
    validTo?: string;
    confidence?: number;
    source?: string;
    metadata?: Record<string, unknown>;
  } = {}
): MemoryEntry {
  const entry: MemoryEntry = {
    entryId: generateId(),
    namespaceId,
    memoryType,
    key,
    value,
    createdAt: new Date().toISOString(),
    recordedAt: new Date().toISOString(),
    validFrom: options.validFrom,
    validTo: options.validTo,
    confidence: options.confidence,
    source: options.source,
    metadata: options.metadata ?? {},
  };

  execute(
    `INSERT INTO memory_entries
     (entry_id, namespace_id, memory_type, key, value_json, created_at, valid_from, valid_to,
      recorded_at, confidence, source, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.entryId,
      entry.namespaceId,
      entry.memoryType,
      entry.key,
      JSON.stringify(entry.value),
      entry.createdAt,
      entry.validFrom ?? null,
      entry.validTo ?? null,
      entry.recordedAt,
      entry.confidence ?? null,
      entry.source ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ]
  );

  return entry;
}

export function queryMemory(query: MemoryQuery): MemoryEntry[] {
  const conditions: string[] = ['namespace_id = ?'];
  const params: unknown[] = [query.namespaceId];

  if (query.memoryType) {
    conditions.push('memory_type = ?');
    params.push(query.memoryType);
  }
  if (query.keyPrefix) {
    conditions.push('key LIKE ?');
    params.push(`${query.keyPrefix}%`);
  }
  if (query.validAt) {
    conditions.push('(valid_from IS NULL OR valid_from <= ?)');
    conditions.push('(valid_to IS NULL OR valid_to >= ?)');
    params.push(query.validAt, query.validAt);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const limit = query.limit ?? 100;
  const offset = query.offset ?? 0;

  const rows = queryAll<{
    entry_id: string;
    namespace_id: string;
    memory_type: MemoryType;
    key: string;
    value_json: string;
    created_at: string;
    valid_from: string | null;
    valid_to: string | null;
    recorded_at: string;
    confidence: number | null;
    source: string | null;
    metadata: string | null;
  }>(
    `SELECT * FROM memory_entries ${whereClause} ORDER BY recorded_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return rows.map((row) => ({
    entryId: row.entry_id,
    namespaceId: row.namespace_id,
    memoryType: row.memory_type,
    key: row.key,
    value: JSON.parse(row.value_json),
    createdAt: row.created_at,
    validFrom: row.valid_from ?? undefined,
    validTo: row.valid_to ?? undefined,
    recordedAt: row.recorded_at,
    confidence: row.confidence ?? undefined,
    source: row.source ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  }));
}
