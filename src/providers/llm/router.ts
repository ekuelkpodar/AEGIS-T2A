/**
 * Simple model router for cost-aware LLM selection.
 */

import { getConfig } from '../../core/config.js';

export type LLMTask = 'intent' | 'plan' | 'general';
export type LLMComplexity = 'fast' | 'standard' | 'complex';

const COMPLEX_KEYWORDS = [
  'analyze', 'investigate', 'root cause', 'multi-step', 'strategy', 'optimize',
  'tradeoff', 'compliance', 'risk', 'temporal', 'orchestrate', 'design', 'architecture',
  'saga', 'workflow', 'policy', 'simulation', 'migration', 'incident'
];

const FAST_KEYWORDS = ['summarize', 'extract', 'classify', 'list', 'quick', 'brief'];

export function classifyComplexity(text: string, task: LLMTask): LLMComplexity {
  const lower = text.toLowerCase();
  const tokenEstimate = Math.ceil(text.length / 4);

  let score = 0;
  for (const keyword of COMPLEX_KEYWORDS) {
    if (lower.includes(keyword)) score += 2;
  }
  for (const keyword of FAST_KEYWORDS) {
    if (lower.includes(keyword)) score -= 1;
  }

  if (task === 'plan') score += 1;
  if (tokenEstimate > 800) score += 2;
  if (tokenEstimate < 200) score -= 1;

  if (score >= 3) return 'complex';
  if (score <= -1) return 'fast';
  return 'standard';
}

export function selectModelForTask(task: LLMTask, text: string): string | undefined {
  const config = getConfig();
  const complexity = classifyComplexity(text, task);

  if (complexity === 'fast') {
    return config.llmFastModel || config.llmModel;
  }
  if (complexity === 'complex') {
    return config.llmComplexModel || config.llmModel;
  }
  return config.llmStandardModel || config.llmModel;
}
