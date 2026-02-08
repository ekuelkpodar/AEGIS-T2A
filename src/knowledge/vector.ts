/**
 * Simple hashing vectorizer for RAG.
 */

import { tokenize } from './tokenize.js';

export interface VectorResult {
  vector: number[];
  norm: number;
}

export function hashVector(text: string, dims: number): VectorResult {
  const vec = new Array<number>(dims).fill(0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const idx = hashToken(token) % dims;
    vec[idx] += 1;
  }

  let norm = 0;
  for (const v of vec) {
    norm += v * v;
  }
  norm = Math.sqrt(norm);

  return { vector: vec, norm };
}

export function cosineSimilarity(a: number[], aNorm: number, b: number[], bNorm: number): number {
  if (aNorm === 0 || bNorm === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot / (aNorm * bNorm);
}

function hashToken(token: string): number {
  let hash = 5381;
  for (let i = 0; i < token.length; i++) {
    hash = ((hash << 5) + hash) + token.charCodeAt(i);
  }
  return Math.abs(hash);
}
