/**
 * Hybrid RAG (BM25 + Vector) Service
 */

import { createHash } from 'crypto';
import { getConfig } from '../core/config.js';
import {
  upsertDocument,
  insertChunk,
  insertVector,
  updateTermStats,
  updateStats,
  getAllChunks,
  getStats,
  getTermDf,
} from './store.js';
import { tokenize } from './tokenize.js';
import { hashVector, cosineSimilarity } from './vector.js';

export interface IngestOptions {
  title?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface SearchResult {
  chunkId: string;
  docId: string;
  score: number;
  bm25: number;
  vector: number;
  text: string;
}

export class RAGService {
  private config = getConfig();

  ingestDocument(text: string, options: IngestOptions = {}): string {
    const contentHash = createHash('sha256').update(text).digest('hex');
    const doc = upsertDocument(options.title, options.source, contentHash, options.metadata ?? {});

    const chunks = this.chunkText(text);
    chunks.forEach((chunkText, idx) => {
      const chunk = insertChunk(doc.docId, idx, chunkText);
      insertVector(chunk.chunkId, chunkText);
      updateTermStats(chunk.terms);
      updateStats(chunk.tokenCount);
    });

    return doc.docId;
  }

  search(query: string, limit: number = 10): SearchResult[] {
    const stats = getStats();
    const chunks = getAllChunks();
    if (chunks.length === 0) return [];

    const queryTokens = tokenize(query);
    const { vector: qVec, norm: qNorm } = hashVector(query, this.config.ragVectorDims);

    const scores = chunks.map((chunk) => {
      const bm25 = this.bm25Score(queryTokens, chunk.terms, chunk.tokenCount, stats);
      const vec = cosineSimilarity(qVec, qNorm, chunk.vector, chunk.norm);
      const score = this.config.ragHybridWeight * bm25 + (1 - this.config.ragHybridWeight) * vec;
      return { chunk, bm25, vec, score };
    });

    return scores
      .filter((s) => s.score >= this.config.ragMinScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({
        chunkId: s.chunk.chunkId,
        docId: s.chunk.docId,
        score: s.score,
        bm25: s.bm25,
        vector: s.vec,
        text: s.chunk.text,
      }));
  }

  private chunkText(text: string): string[] {
    const words = text.split(/\s+/);
    const size = this.config.ragChunkSizeWords;
    const overlap = this.config.ragChunkOverlapWords;
    const chunks: string[] = [];

    for (let i = 0; i < words.length; i += (size - overlap)) {
      const slice = words.slice(i, i + size);
      if (slice.length === 0) break;
      chunks.push(slice.join(' '));
      if (i + size >= words.length) break;
    }

    return chunks;
  }

  private bm25Score(
    queryTokens: string[],
    docTerms: Record<string, number>,
    docLen: number,
    stats: { totalChunks: number; avgDocLen: number }
  ): number {
    const k1 = 1.5;
    const b = 0.75;
    let score = 0;

    for (const term of queryTokens) {
      const tf = docTerms[term] || 0;
      if (tf === 0) continue;
      const df = getTermDf(term);
      const idf = Math.log(1 + (stats.totalChunks - df + 0.5) / (df + 0.5));
      const denom = tf + k1 * (1 - b + b * (docLen / Math.max(stats.avgDocLen, 1)));
      score += idf * ((tf * (k1 + 1)) / denom);
    }

    return score;
  }
}
