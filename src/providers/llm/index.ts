/**
 * AEGIS-T2A LLM Provider Manager
 *
 * Unified interface for multiple LLM providers.
 */

import { getConfig } from '../../core/config.js';
import { logger } from '../../core/logger.js';

// =============================================================================
// Types
// =============================================================================

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMCompletionOptions {
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
}

export interface LLMCompletionResult {
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  model: string;
  finishReason?: string;
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
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'claude-sonnet-4-20250514';
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com';
  }

  async complete(options: LLMCompletionOptions): Promise<LLMCompletionResult> {
    const systemMessage = options.messages.find(m => m.role === 'system');
    const otherMessages = options.messages.filter(m => m.role !== 'system');

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature,
        top_p: options.topP,
        stop_sequences: options.stop,
        system: systemMessage?.content,
        messages: otherMessages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Anthropic API error: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();

    return {
      content: data.content[0]?.text || '',
      usage: {
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
      },
      model: data.model,
      finishReason: data.stop_reason,
    };
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.complete({
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 10,
      });
      return true;
    } catch {
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
  private model: string;
  private baseUrl: string;

  constructor(config: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'gpt-4-turbo';
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  }

  async complete(options: LLMCompletionOptions): Promise<LLMCompletionResult> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature,
        top_p: options.topP,
        stop: options.stop,
        messages: options.messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`OpenAI API error: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();

    return {
      content: data.choices[0]?.message?.content || '',
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
      model: data.model,
      finishReason: data.choices[0]?.finish_reason,
    };
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.complete({
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 10,
      });
      return true;
    } catch {
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
  private baseUrl: string;

  constructor(config: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'anthropic/claude-sonnet-4-20250514';
    this.baseUrl = config.baseUrl || 'https://openrouter.ai/api/v1';
  }

  async complete(options: LLMCompletionOptions): Promise<LLMCompletionResult> {
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
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature,
        top_p: options.topP,
        stop: options.stop,
        messages: options.messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`OpenRouter API error: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();

    return {
      content: data.choices[0]?.message?.content || '',
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
      model: data.model,
      finishReason: data.choices[0]?.finish_reason,
    };
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.complete({
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 10,
      });
      return true;
    } catch {
      return false;
    }
  }
}

// =============================================================================
// Ollama Provider
// =============================================================================

export class OllamaProvider implements LLMProvider {
  name = 'ollama';
  private model: string;
  private baseUrl: string;

  constructor(config: { model?: string; baseUrl?: string }) {
    this.model = config.model || 'llama2';
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
  }

  async complete(options: LLMCompletionOptions): Promise<LLMCompletionResult> {
    // Convert messages to Ollama format
    const systemMessage = options.messages.find(m => m.role === 'system');
    const otherMessages = options.messages.filter(m => m.role !== 'system');

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          ...(systemMessage ? [{ role: 'system', content: systemMessage.content }] : []),
          ...otherMessages.map(m => ({
            role: m.role,
            content: m.content,
          })),
        ],
        stream: false,
        options: {
          temperature: options.temperature,
          top_p: options.topP,
          stop: options.stop,
          num_predict: options.maxTokens,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${error}`);
    }

    const data = await response.json();

    return {
      content: data.message?.content || '',
      usage: {
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
      },
      model: data.model,
      finishReason: data.done ? 'stop' : undefined,
    };
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available models
   */
  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) return [];

      const data = await response.json();
      return (data.models || []).map((m: { name: string }) => m.name);
    } catch {
      return [];
    }
  }

  /**
   * Pull a model
   */
  async pullModel(model: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/pull`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: model, stream: false }),
    });

    if (!response.ok) {
      throw new Error(`Failed to pull model: ${await response.text()}`);
    }
  }
}

// =============================================================================
// Provider Manager
// =============================================================================

let currentProvider: LLMProvider | null = null;

/**
 * Initialize the LLM provider based on configuration
 */
export function initializeLLMProvider(config?: {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): LLMProvider {
  const cfg = config || getProviderConfig();

  switch (cfg.provider) {
    case 'anthropic':
      currentProvider = new AnthropicProvider({
        apiKey: cfg.apiKey!,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
      });
      break;

    case 'openai':
      currentProvider = new OpenAIProvider({
        apiKey: cfg.apiKey!,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
      });
      break;

    case 'openrouter':
      currentProvider = new OpenRouterProvider({
        apiKey: cfg.apiKey!,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
      });
      break;

    case 'ollama':
      currentProvider = new OllamaProvider({
        model: cfg.model,
        baseUrl: cfg.baseUrl,
      });
      break;

    default:
      throw new Error(`Unknown LLM provider: ${cfg.provider}`);
  }

  logger.info({ provider: cfg.provider, model: cfg.model }, 'LLM provider initialized');

  return currentProvider;
}

/**
 * Get provider configuration from environment
 */
function getProviderConfig(): {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
} {
  const provider = process.env['LLM_PROVIDER'] || 'anthropic';

  switch (provider) {
    case 'anthropic':
      return {
        provider,
        apiKey: process.env['ANTHROPIC_API_KEY'],
        model: process.env['ANTHROPIC_MODEL'],
      };

    case 'openai':
      return {
        provider,
        apiKey: process.env['OPENAI_API_KEY'],
        baseUrl: process.env['OPENAI_BASE_URL'],
        model: process.env['OPENAI_MODEL'],
      };

    case 'openrouter':
      return {
        provider,
        apiKey: process.env['OPENROUTER_API_KEY'],
        model: process.env['OPENROUTER_MODEL'],
      };

    case 'ollama':
      return {
        provider,
        baseUrl: process.env['OLLAMA_BASE_URL'],
        model: process.env['OLLAMA_MODEL'],
      };

    default:
      // Default to Anthropic with API key from config
      return {
        provider: 'anthropic',
        apiKey: getConfig().anthropicApiKey,
      };
  }
}

/**
 * Get the current LLM provider
 */
export function getLLMProvider(): LLMProvider {
  if (!currentProvider) {
    initializeLLMProvider();
  }
  return currentProvider!;
}

/**
 * Complete a prompt using the current provider
 */
export async function complete(
  options: LLMCompletionOptions
): Promise<LLMCompletionResult> {
  const provider = getLLMProvider();
  return provider.complete(options);
}

/**
 * Test the current provider connection
 */
export async function testConnection(): Promise<boolean> {
  const provider = getLLMProvider();
  return provider.testConnection();
}
