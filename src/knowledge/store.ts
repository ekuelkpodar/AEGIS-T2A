/**
 * Knowledge store backed by SQLite.
 */

import { execute, queryAll, queryOne } from '../core/database.js';
import { generateId } from '../core/ids.js';
import { getConfig } from '../core/config.js';
import { tokenize } from './tokenize.js';
import { hashVector } from './vector.js';

export interface KnowledgeDocument {
  docId: string;
  title?: string;
  source?: string;
  contentHash: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeChunk {
  chunkId: string;
  docId: string;
  chunkIndex: number;
  text: string;
  tokenCount: number;
  terms: Record<string, number>;
  createdAt: string;
}

export interface StoredVector {
  chunkId: string;
  vector: number[];
  norm: number;
}

export interface KnowledgeStats {
  totalChunks: number;
  totalTokens: number;
  avgDocLen: number;
}

export function upsertDocument(
  title: string | undefined,
  source: string | undefined,
  contentHash: string,
  metadata: Record<string, unknown>
): KnowledgeDocument {
  const existing = queryOne<KnowledgeDocument>(
    `SELECT doc_id AS docId, title, source, content_hash AS contentHash,
            metadata, created_at AS createdAt, updated_at AS updatedAt
     FROM knowledge_documents WHERE content_hash = ?`,
    [contentHash]
  );

  const now = new Date().toISOString();
  if (existing) {
    execute(
      `UPDATE knowledge_documents SET updated_at = ?, metadata = ?
       WHERE doc_id = ?`,
      [now, JSON.stringify(metadata ?? {}), existing.docId]
    );
    return { ...existing, updatedAt: now, metadata };
  }

  const docId = generateId();
  execute(
    `INSERT INTO knowledge_documents
     (doc_id, title, source, content_hash, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      docId,
      title ?? null,
      source ?? null,
      contentHash,
      JSON.stringify(metadata ?? {}),
      now,
      now,
    ]
  );
  return { docId, title, source, contentHash, metadata, createdAt: now, updatedAt: now };
}

export function insertChunk(
  docId: string,
  chunkIndex: number,
  text: string
): KnowledgeChunk {
  const chunkId = generateId();
  const terms = countTerms(text);
  const tokenCount = Object.values(terms).reduce((sum, v) => sum + v, 0);
  const createdAt = new Date().toISOString();

  execute(
    `INSERT INTO knowledge_chunks
     (chunk_id, doc_id, chunk_index, text, token_count, terms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      chunkId,
      docId,
      chunkIndex,
      text,
      tokenCount,
      JSON.stringify(terms),
      createdAt,
    ]
  );

  return { chunkId, docId, chunkIndex, text, tokenCount, terms, createdAt };
}

export function insertVector(chunkId: string, text: string): StoredVector {
  const config = getConfig();
  const { vector, norm } = hashVector(text, config.ragVectorDims);
  execute(
    `INSERT INTO knowledge_embeddings (chunk_id, vector_json, norm)
     VALUES (?, ?, ?)`,
    [chunkId, JSON.stringify(vector), norm]
  );
  return { chunkId, vector, norm };
}

export function updateTermStats(terms: Record<string, number>): void {
  const uniqueTerms = Object.keys(terms);
  for (const term of uniqueTerms) {
    execute(
      `INSERT INTO knowledge_terms (term, df)
       VALUES (?, 1)
       ON CONFLICT(term) DO UPDATE SET df = df + 1`,
      [term]
    );
  }
}

export function updateStats(tokenCount: number): void {
  const totalChunks = getStatNumber('total_chunks');
  const totalTokens = getStatNumber('total_tokens');
  setStatNumber('total_chunks', totalChunks + 1);
  setStatNumber('total_tokens', totalTokens + tokenCount);
}

export function getStats(): KnowledgeStats {
  const totalChunks = getStatNumber('total_chunks');
  const totalTokens = getStatNumber('total_tokens');
  const avgDocLen = totalChunks > 0 ? totalTokens / totalChunks : 0;
  return { totalChunks, totalTokens, avgDocLen };
}

export function getAllChunks(): Array<KnowledgeChunk & { vector: number[]; norm: number }> {
  const rows = queryAll<{
    chunk_id: string;
    doc_id: string;
    chunk_index: number;
    text: string;
    token_count: number;
    terms: string;
    created_at: string;
    vector_json: string;
    norm: number;
  }>(
    `SELECT c.chunk_id, c.doc_id, c.chunk_index, c.text, c.token_count,
            c.terms, c.created_at, e.vector_json, e.norm
     FROM knowledge_chunks c
     JOIN knowledge_embeddings e ON e.chunk_id = c.chunk_id`
  );

  return rows.map((row) => ({
    chunkId: row.chunk_id,
    docId: row.doc_id,
    chunkIndex: row.chunk_index,
    text: row.text,
    tokenCount: row.token_count,
    terms: JSON.parse(row.terms) as Record<string, number>,
    createdAt: row.created_at,
    vector: JSON.parse(row.vector_json) as number[],
    norm: row.norm,
  }));
}

export function getTermDf(term: string): number {
  const row = queryOne<{ df: number }>(
    `SELECT df FROM knowledge_terms WHERE term = ?`,
    [term]
  );
  return row?.df ?? 0;
}

function countTerms(text: string): Record<string, number> {
  const terms: Record<string, number> = {};
  for (const token of tokenize(text)) {
    terms[token] = (terms[token] || 0) + 1;
  }
  return terms;
}

function getStatNumber(key: string): number {
  const row = queryOne<{ value: string }>(
    `SELECT value FROM knowledge_stats WHERE key = ?`,
    [key]
  );
  if (!row) return 0;
  const num = Number(row.value);
  return Number.isFinite(num) ? num : 0;
}

function setStatNumber(key: string, value: number): void {
  execute(
    `INSERT INTO knowledge_stats (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value)]
  );
}
