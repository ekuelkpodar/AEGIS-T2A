/**
 * AEGIS-T2A LLM Providers
 *
 * Unified interface for multiple LLM providers:
 * - Anthropic Claude
 * - OpenAI GPT
 * - OpenRouter
 * - Ollama (local)
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../core/logger.js';

// =============================================================================
// Types
// =============================================================================

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMCompletionOptions {
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  jsonMode?: boolean;
}

export interface LLMCompletionResult {
  content: string;
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface LLMProvider {
  name: string;
  complete(options: LLMCompletionOptions): Promise<LLMCompletionResult>;
  testConnection(): Promise<boolean>;
}

// =============================================================================
// Anthropic Provider
// =============================================================================

export class AnthropicProvider implements LLMProvider {
  name = 'anthropic';
  private client: Anthropic;
  private model: string;

  constructor(config?: { apiKey?: string; model?: string }) {
    const apiKey = config?.apiKey || process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new Error('Anthropic API key not configured');
    }

    this.client = new Anthropic({ apiKey });
    this.model = config?.model || process.env['ANTHROPIC_MODEL'] || 'claude-sonnet-4-20250514';
  }

  async complete(options: LLMCompletionOptions): Promise<LLMCompletionResult> {
    const messages = options.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const systemPrompt = options.systemPrompt ||
      options.messages.find(m => m.role === 'system')?.content;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: options.maxTokens || 4096,
      temperature: options.temperature ?? 0.7,
      system: systemPrompt,
      messages,
    });

    const content = response.content[0];
    if (!content || content.type !== 'text') {
      throw new Error('Unexpected response type from Anthropic');
    }

    return {
      content: (content as { type: 'text'; text: string }).text,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.complete({
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 10,
      });
      return true;
    } catch (error) {
      logger.error({ error }, 'Anthropic connection test failed');
      return false;
    }
  }
}

// =============================================================================
// OpenAI Provider
// =============================================================================

export class OpenAIProvider implements LLMProvider {
  name = 'openai';
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(config?: { apiKey?: string; baseUrl?: string; model?: string }) {
    this.apiKey = config?.apiKey || process.env['OPENAI_API_KEY'] || '';
    if (!this.apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    this.baseUrl = config?.baseUrl || process.env['OPENAI_BASE_URL'] || 'https://api.openai.com/v1';
    this.model = config?.model || process.env['OPENAI_MODEL'] || 'gpt-4-turbo';
  }

  async complete(options: LLMCompletionOptions): Promise<LLMCompletionResult> {
    const messages: Array<{ role: string; content: string }> = [];

    // Add system prompt
    const systemPrompt = options.systemPrompt ||
      options.messages.find(m => m.role === 'system')?.content;
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // Add other messages
    for (const msg of options.messages) {
      if (msg.role !== 'system') {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    const body: Record<string, any> = {
      model: this.model,
      messages,
      max_tokens: options.maxTokens || 4096,
      temperature: options.temperature ?? 0.7,
    };

    if (options.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`OpenAI API error: ${JSON.stringify(error)}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      model: string;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      content: data.choices[0]?.message.content ?? '',
      model: data.model,
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
    };
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.complete({
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 10,
      });
      return true;
    } catch (error) {
      logger.error({ error }, 'OpenAI connection test failed');
      return false;
    }
  }
}

// =============================================================================
// OpenRouter Provider
// =============================================================================

export class OpenRouterProvider implements LLMProvider {
  name = 'openrouter';
  private apiKey: string;
  private model: string;
  private baseUrl = 'https://openrouter.ai/api/v1';

  constructor(config?: { apiKey?: string; model?: string }) {
    this.apiKey = config?.apiKey || process.env['OPENROUTER_API_KEY'] || '';
    if (!this.apiKey) {
      throw new Error('OpenRouter API key not configured');
    }

    this.model = config?.model || process.env['OPENROUTER_MODEL'] || 'anthropic/claude-sonnet-4-20250514';
  }

  async complete(options: LLMCompletionOptions): Promise<LLMCompletionResult> {
    const messages: Array<{ role: string; content: string }> = [];

    // Add system prompt
    const systemPrompt = options.systemPrompt ||
      options.messages.find(m => m.role === 'system')?.content;
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // Add other messages
    for (const msg of options.messages) {
      if (msg.role !== 'system') {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://aegis-t2a.local',
        'X-Title': 'AEGIS-T2A',
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature ?? 0.7,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`OpenRouter API error: ${JSON.stringify(error)}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      model: string;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      content: data.choices[0]?.message.content ?? '',
      model: data.model,
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
    };
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.complete({
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 10,
      });
      return true;
    } catch (error) {
      logger.error({ error }, 'OpenRouter connection test failed');
      return false;
    }
  }
}

// =============================================================================
// Ollama Provider
// =============================================================================

export class OllamaProvider implements LLMProvider {
  name = 'ollama';
  private baseUrl: string;
  private model: string;

  constructor(config?: { baseUrl?: string; model?: string }) {
    this.baseUrl = config?.baseUrl || process.env['OLLAMA_BASE_URL'] || 'http://localhost:11434';
    this.model = config?.model || process.env['OLLAMA_MODEL'] || 'llama2';
  }

  async complete(options: LLMCompletionOptions): Promise<LLMCompletionResult> {
    // Build prompt
    let prompt = '';

    const systemPrompt = options.systemPrompt ||
      options.messages.find(m => m.role === 'system')?.content;
    if (systemPrompt) {
      prompt += `System: ${systemPrompt}\n\n`;
    }

    for (const msg of options.messages) {
      if (msg.role === 'user') {
        prompt += `User: ${msg.content}\n`;
      } else if (msg.role === 'assistant') {
        prompt += `Assistant: ${msg.content}\n`;
      }
    }
    prompt += 'Assistant: ';

    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        options: {
          num_predict: options.maxTokens || 4096,
          temperature: options.temperature ?? 0.7,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${error}`);
    }

    const data = await response.json() as {
      response: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    return {
      content: data.response,
      model: this.model,
      usage: {
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
      },
    };
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch (error) {
      logger.error({ error }, 'Ollama connection test failed');
      return false;
    }
  }

  /**
   * List available models
   */
  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`);
    if (!response.ok) {
      throw new Error('Failed to list Ollama models');
    }

    const data = await response.json() as { models?: Array<{ name: string }> };
    return data.models?.map((m) => m.name) || [];
  }

  /**
   * Pull a model
   */
  async pullModel(model: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
    });

    if (!response.ok) {
      throw new Error(`Failed to pull model: ${model}`);
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

export type LLMProviderType = 'anthropic' | 'openai' | 'openrouter' | 'ollama';

let currentProvider: LLMProvider | null = null;

export function createLLMProvider(type: LLMProviderType, config?: Record<string, any>): LLMProvider {
  switch (type) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
      return new OpenAIProvider(config);
    case 'openrouter':
      return new OpenRouterProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    default:
      throw new Error(`Unknown LLM provider: ${type}`);
  }
}

export function initializeLLMProvider(type?: LLMProviderType, config?: Record<string, any>): LLMProvider {
  const providerType = type || (process.env['LLM_PROVIDER'] as LLMProviderType) || 'anthropic';
  currentProvider = createLLMProvider(providerType, config);
  logger.info({ provider: providerType }, 'LLM provider initialized');
  return currentProvider;
}

export function getLLMProvider(): LLMProvider {
  if (!currentProvider) {
    currentProvider = initializeLLMProvider();
  }
  return currentProvider;
}

export function setLLMProvider(provider: LLMProvider): void {
  currentProvider = provider;
}
