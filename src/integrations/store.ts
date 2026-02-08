/**
 * Integration catalog store backed by SQLite.
 */

import { execute, queryAll, queryOne } from '../core/database.js';
import { generateId } from '../core/ids.js';
import { getConfig } from '../core/config.js';
import { tokenize } from '../knowledge/tokenize.js';
import { hashVector, cosineSimilarity } from '../knowledge/vector.js';

export type IntegrationTier = 'tier1' | 'tier2' | 'tier3';
export type IntegrationSensitivity = 'public' | 'confidential' | 'restricted';
export type IntegrationEntryKind = 'action' | 'trigger' | 'capability';

export interface IntegrationTool {
  toolId: string;
  name: string;
  category: string;
  subcategory?: string;
  description?: string;
  authType?: string;
  sensitivity: IntegrationSensitivity;
  tier: IntegrationTier;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationEntry {
  entryId: string;
  toolId: string;
  capabilityKey: string;
  name: string;
  description?: string;
  kind: IntegrationEntryKind;
  tokenCount: number;
  terms: Record<string, number>;
  vector: number[];
  norm: number;
  createdAt: string;
}

export interface IntegrationSearchResult {
  entry: IntegrationEntry;
  tool: IntegrationTool;
  score: number;
  bm25: number;
  vector: number;
}

export function upsertTool(
  input: Omit<IntegrationTool, 'toolId' | 'createdAt' | 'updatedAt'> & { toolId?: string }
): IntegrationTool {
  const existingByName = queryOne<IntegrationTool>(
    `SELECT tool_id AS toolId, name, category, subcategory, description, auth_type AS authType,
            sensitivity, tier, metadata, created_at AS createdAt, updated_at AS updatedAt
     FROM integration_tools WHERE name = ?`,
    [input.name]
  );

  const now = new Date().toISOString();
  if (existingByName) {
    execute(
      `UPDATE integration_tools
       SET category = ?, subcategory = ?, description = ?, auth_type = ?, sensitivity = ?, tier = ?,
           metadata = ?, updated_at = ?
       WHERE tool_id = ?`,
      [
        input.category,
        input.subcategory ?? null,
        input.description ?? null,
        input.authType ?? null,
        input.sensitivity,
        input.tier,
        JSON.stringify(input.metadata ?? {}),
        now,
        existingByName.toolId,
      ]
    );

    return {
      ...existingByName,
      category: input.category,
      subcategory: input.subcategory,
      description: input.description,
      authType: input.authType,
      sensitivity: input.sensitivity,
      tier: input.tier,
      metadata: input.metadata ?? {},
      updatedAt: now,
    };
  }

  const toolId = input.toolId ?? generateId();
  execute(
    `INSERT INTO integration_tools
     (tool_id, name, category, subcategory, description, auth_type, sensitivity, tier, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      toolId,
      input.name,
      input.category,
      input.subcategory ?? null,
      input.description ?? null,
      input.authType ?? null,
      input.sensitivity,
      input.tier,
      JSON.stringify(input.metadata ?? {}),
      now,
      now,
    ]
  );

  return {
    toolId,
    name: input.name,
    category: input.category,
    subcategory: input.subcategory,
    description: input.description,
    authType: input.authType,
    sensitivity: input.sensitivity,
    tier: input.tier,
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  };
}

export function upsertEntry(
  toolId: string,
  capabilityKey: string,
  name: string,
  description: string | undefined,
  kind: IntegrationEntryKind
): IntegrationEntry {
  const existing = queryOne<{
    entry_id: string;
    tool_id: string;
    capability_key: string;
    name: string;
    description: string | null;
    kind: string;
    token_count: number;
    terms: string;
    vector_json: string;
    norm: number;
    created_at: string;
  }>(
    `SELECT entry_id, tool_id, capability_key, name, description, kind, token_count, terms, vector_json, norm, created_at
     FROM integration_entries WHERE tool_id = ? AND capability_key = ?`,
    [toolId, capabilityKey]
  );

  const textForIndex = [name, description ?? '', capabilityKey].join(' ').trim();
  const terms = countTerms(textForIndex);
  const tokenCount = Object.values(terms).reduce((sum, v) => sum + v, 0);
  const config = getConfig();
  const { vector, norm } = hashVector(textForIndex, config.integrationVectorDims);

  if (existing) {
    execute(
      `UPDATE integration_entries
       SET name = ?, description = ?, kind = ?, token_count = ?, terms = ?, vector_json = ?, norm = ?
       WHERE entry_id = ?`,
      [
        name,
        description ?? null,
        kind,
        tokenCount,
        JSON.stringify(terms),
        JSON.stringify(vector),
        norm,
        existing.entry_id,
      ]
    );

    return {
      entryId: existing.entry_id,
      toolId: existing.tool_id,
      capabilityKey: existing.capability_key,
      name,
      description: description ?? undefined,
      kind,
      tokenCount,
      terms,
      vector,
      norm,
      createdAt: existing.created_at,
    };
  }

  const entryId = generateId();
  const createdAt = new Date().toISOString();
  execute(
    `INSERT INTO integration_entries
     (entry_id, tool_id, capability_key, name, description, kind, token_count, terms, vector_json, norm, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entryId,
      toolId,
      capabilityKey,
      name,
      description ?? null,
      kind,
      tokenCount,
      JSON.stringify(terms),
      JSON.stringify(vector),
      norm,
      createdAt,
    ]
  );

  updateTermStats(terms);
  updateStats(tokenCount);

  return {
    entryId,
    toolId,
    capabilityKey,
    name,
    description: description ?? undefined,
    kind,
    tokenCount,
    terms,
    vector,
    norm,
    createdAt,
  };
}

export function listTools(limit: number = 200): IntegrationTool[] {
  const rows = queryAll<{
    tool_id: string;
    name: string;
    category: string;
    subcategory: string | null;
    description: string | null;
    auth_type: string | null;
    sensitivity: IntegrationSensitivity;
    tier: IntegrationTier;
    metadata: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT tool_id, name, category, subcategory, description, auth_type, sensitivity, tier,
            metadata, created_at, updated_at
     FROM integration_tools
     ORDER BY name ASC
     LIMIT ?`,
    [limit]
  );

  return rows.map((row) => ({
    toolId: row.tool_id,
    name: row.name,
    category: row.category,
    subcategory: row.subcategory ?? undefined,
    description: row.description ?? undefined,
    authType: row.auth_type ?? undefined,
    sensitivity: row.sensitivity,
    tier: row.tier,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getTool(toolId: string): IntegrationTool | null {
  const row = queryOne<{
    tool_id: string;
    name: string;
    category: string;
    subcategory: string | null;
    description: string | null;
    auth_type: string | null;
    sensitivity: IntegrationSensitivity;
    tier: IntegrationTier;
    metadata: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT tool_id, name, category, subcategory, description, auth_type, sensitivity, tier,
            metadata, created_at, updated_at
     FROM integration_tools WHERE tool_id = ?`,
    [toolId]
  );

  if (!row) return null;
  return {
    toolId: row.tool_id,
    name: row.name,
    category: row.category,
    subcategory: row.subcategory ?? undefined,
    description: row.description ?? undefined,
    authType: row.auth_type ?? undefined,
    sensitivity: row.sensitivity,
    tier: row.tier,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function searchEntries(query: string, limit: number = 10): IntegrationSearchResult[] {
  const entries = queryAll<{
    entry_id: string;
    tool_id: string;
    capability_key: string;
    name: string;
    description: string | null;
    kind: IntegrationEntryKind;
    token_count: number;
    terms: string;
    vector_json: string;
    norm: number;
    created_at: string;
  }>(
    `SELECT entry_id, tool_id, capability_key, name, description, kind, token_count, terms,
            vector_json, norm, created_at
     FROM integration_entries`
  );

  if (entries.length === 0) return [];

  const stats = getStats();
  const queryTokens = tokenize(query);
  const config = getConfig();
  const { vector: qVec, norm: qNorm } = hashVector(query, config.integrationVectorDims);

  const toolCache = new Map<string, IntegrationTool>();

  const scores = entries.map((entry) => {
    const terms = JSON.parse(entry.terms) as Record<string, number>;
    const bm25 = bm25Score(queryTokens, terms, entry.token_count, stats);
    const vec = cosineSimilarity(qVec, qNorm, JSON.parse(entry.vector_json) as number[], entry.norm);
    const score = config.integrationHybridWeight * bm25 + (1 - config.integrationHybridWeight) * vec;

    let tool = toolCache.get(entry.tool_id);
    if (!tool) {
      tool = getTool(entry.tool_id);
      if (tool) {
        toolCache.set(entry.tool_id, tool);
      }
    }

    return {
      entry: {
        entryId: entry.entry_id,
        toolId: entry.tool_id,
        capabilityKey: entry.capability_key,
        name: entry.name,
        description: entry.description ?? undefined,
        kind: entry.kind,
        tokenCount: entry.token_count,
        terms,
        vector: JSON.parse(entry.vector_json) as number[],
        norm: entry.norm,
        createdAt: entry.created_at,
      },
      tool,
      bm25,
      vector: vec,
      score,
    };
  });

  return scores
    .filter((result) => result.tool && result.score >= config.integrationMinScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((result) => ({
      entry: result.entry,
      tool: result.tool!,
      bm25: result.bm25,
      vector: result.vector,
      score: result.score,
    }));
}

export function setFallback(primaryAdapter: string, fallbackAdapter: string, matchType: 'exact' | 'prefix'): void {
  const createdAt = new Date().toISOString();
  execute(
    `INSERT OR REPLACE INTO integration_fallbacks
     (primary_adapter, fallback_adapter, match_type, created_at)
     VALUES (?, ?, ?, ?)`,
    [primaryAdapter, fallbackAdapter, matchType, createdAt]
  );
}

export function getFallback(adapterId: string): string | null {
  const exact = queryOne<{ fallback_adapter: string }>(
    `SELECT fallback_adapter FROM integration_fallbacks
     WHERE primary_adapter = ? AND match_type = 'exact'`,
    [adapterId]
  );
  if (exact) return exact.fallback_adapter;

  const prefix = adapterId.split(':')[0];
  if (!prefix) return null;

  const pref = queryOne<{ fallback_adapter: string }>(
    `SELECT fallback_adapter FROM integration_fallbacks
     WHERE primary_adapter = ? AND match_type = 'prefix'`,
    [prefix]
  );
  return pref?.fallback_adapter ?? null;
}

export function listFallbacks(): Array<{ primaryAdapter: string; fallbackAdapter: string; matchType: string; createdAt: string }> {
  return queryAll<{
    primary_adapter: string;
    fallback_adapter: string;
    match_type: string;
    created_at: string;
  }>(
    `SELECT primary_adapter, fallback_adapter, match_type, created_at
     FROM integration_fallbacks
     ORDER BY primary_adapter ASC`
  ).map((row) => ({
    primaryAdapter: row.primary_adapter,
    fallbackAdapter: row.fallback_adapter,
    matchType: row.match_type,
    createdAt: row.created_at,
  }));
}

function countTerms(text: string): Record<string, number> {
  const terms: Record<string, number> = {};
  for (const token of tokenize(text)) {
    terms[token] = (terms[token] || 0) + 1;
  }
  return terms;
}

function updateTermStats(terms: Record<string, number>): void {
  const uniqueTerms = Object.keys(terms);
  for (const term of uniqueTerms) {
    execute(
      `INSERT INTO integration_terms (term, df)
       VALUES (?, 1)
       ON CONFLICT(term) DO UPDATE SET df = df + 1`,
      [term]
    );
  }
}

function updateStats(tokenCount: number): void {
  const totalEntries = getStatNumber('total_entries');
  const totalTokens = getStatNumber('total_tokens');
  setStatNumber('total_entries', totalEntries + 1);
  setStatNumber('total_tokens', totalTokens + tokenCount);
}

function getStats(): { totalEntries: number; avgEntryLen: number } {
  const totalEntries = getStatNumber('total_entries');
  const totalTokens = getStatNumber('total_tokens');
  const avgEntryLen = totalEntries > 0 ? totalTokens / totalEntries : 0;
  return { totalEntries, avgEntryLen };
}

function getStatNumber(key: string): number {
  const row = queryOne<{ value: string }>(
    `SELECT value FROM integration_stats WHERE key = ?`,
    [key]
  );
  if (!row) return 0;
  const num = Number(row.value);
  return Number.isFinite(num) ? num : 0;
}

function setStatNumber(key: string, value: number): void {
  execute(
    `INSERT INTO integration_stats (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value)]
  );
}

function bm25Score(
  queryTokens: string[],
  docTerms: Record<string, number>,
  docLen: number,
  stats: { totalEntries: number; avgEntryLen: number }
): number {
  const k1 = 1.5;
  const b = 0.75;
  let score = 0;

  for (const term of queryTokens) {
    const tf = docTerms[term] || 0;
    if (tf === 0) continue;
    const df = getTermDf(term);
    const idf = Math.log(1 + (stats.totalEntries - df + 0.5) / (df + 0.5));
    const denom = tf + k1 * (1 - b + b * (docLen / Math.max(stats.avgEntryLen, 1)));
    score += idf * ((tf * (k1 + 1)) / denom);
  }

  return score;
}

function getTermDf(term: string): number {
  const row = queryOne<{ df: number }>(
    `SELECT df FROM integration_terms WHERE term = ?`,
    [term]
  );
  return row?.df ?? 0;
}
