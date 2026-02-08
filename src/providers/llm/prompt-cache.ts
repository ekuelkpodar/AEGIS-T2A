/**
 * Prompt-response cache using in-memory NodeCache.
 */

import NodeCache from 'node-cache';
import { createHash } from 'crypto';
import { getConfig } from '../../core/config.js';
import { LLMCompletionOptions, LLMCompletionResult } from './index.js';

const cache = new NodeCache({ stdTTL: 0, checkperiod: 120 });

export interface CachedCompletion {
  content: string;
  model: string;
  usage?: LLMCompletionResult['usage'];
  cachedAt: string;
}

export function getPromptCacheKey(model: string, options: LLMCompletionOptions): string {
  const hash = createHash('sha256');
  hash.update(model);
  hash.update(JSON.stringify(options));
  return hash.digest('hex');
}

export function getCachedCompletion(model: string, options: LLMCompletionOptions): CachedCompletion | null {
  const config = getConfig();
  if (!config.promptCacheEnabled) return null;
  const key = getPromptCacheKey(model, options);
  const entry = cache.get<CachedCompletion>(key);
  return entry ?? null;
}

export function setCachedCompletion(model: string, options: LLMCompletionOptions, result: LLMCompletionResult): void {
  const config = getConfig();
  if (!config.promptCacheEnabled) return;
  const key = getPromptCacheKey(model, options);
  cache.set(key, {
    content: result.content,
    model: result.model,
    usage: result.usage,
    cachedAt: new Date().toISOString(),
  }, config.promptCacheTtlSeconds);
}
