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
      const error = await response.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(`Anthropic API error: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json() as {
      content: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      model: string;
      stop_reason?: string;
    };

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
      const error = await response.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(`OpenAI API error: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json() as {
      choices: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model: string;
    };

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
      const error = await response.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(`OpenRouter API error: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json() as {
      choices: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model: string;
    };

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
// Ollama Types
// =============================================================================

export interface OllamaModelInfo {
  name: string;
  displayName: string;
  size: number;
  sizeFormatted: string;
  modifiedAt: string;
  digest: string;
  family: string;
  parameterSize: string;
  quantizationLevel: string;
  capabilities: {
    chat: boolean;
    embedding: boolean;
    vision: boolean;
    functionCalling: boolean;
  };
}

export interface OllamaDiscoveryResult {
  available: boolean;
  url: string;
  version?: string;
  models: OllamaModelInfo[];
  error?: string;
  timestamp: string;
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

    const data = await response.json() as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
      model: string;
      done?: boolean;
    };

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
   * List available models (simple name list)
   */
  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) return [];

      const data = await response.json() as { models?: Array<{ name: string }> };
      return (data.models || []).map((m) => m.name);
    } catch {
      return [];
    }
  }

  /**
   * Get detailed model information for all available models
   */
  async listModelsDetailed(): Promise<OllamaModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) return [];

      const data = await response.json() as {
        models?: Array<{
          name: string;
          size?: number;
          modified_at?: string;
          digest?: string;
          details?: {
            family?: string;
            parameter_size?: string;
            quantization_level?: string;
          };
        }>;
      };
      const models: OllamaModelInfo[] = [];

      for (const model of data.models || []) {
        const info = this.parseModelInfo(model);
        models.push(info);
      }

      return models;
    } catch {
      return [];
    }
  }

  /**
   * Full discovery endpoint - includes server version and connectivity status
   */
  async discover(): Promise<OllamaDiscoveryResult> {
    const timestamp = new Date().toISOString();

    try {
      // Check connectivity first
      const versionResponse = await fetch(`${this.baseUrl}/api/version`, {
        signal: AbortSignal.timeout(5000),
      });

      let version: string | undefined;
      if (versionResponse.ok) {
        const versionData = await versionResponse.json() as { version?: string };
        version = versionData.version;
      }

      // Get models
      const models = await this.listModelsDetailed();

      return {
        available: true,
        url: this.baseUrl,
        version,
        models,
        timestamp,
      };
    } catch (error) {
      return {
        available: false,
        url: this.baseUrl,
        models: [],
        error: error instanceof Error ? error.message : 'Connection failed',
        timestamp,
      };
    }
  }

  /**
   * Get detailed information for a specific model
   */
  async getModelInfo(modelName: string): Promise<OllamaModelInfo | null> {
    try {
      const response = await fetch(`${this.baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName }),
      });

      if (!response.ok) return null;

      const data = await response.json() as {
        details?: { family?: string; parameter_size?: string; quantization_level?: string };
        modelfile?: string;
        size?: number;
        modified_at?: string;
        digest?: string;
      };

      // Extract model details from the show response
      const details = data.details || {};
      const modelfile = data.modelfile || '';

      return {
        name: modelName,
        displayName: this.formatDisplayName(modelName),
        size: data.size || 0,
        sizeFormatted: this.formatSize(data.size || 0),
        modifiedAt: data.modified_at || new Date().toISOString(),
        digest: data.digest || '',
        family: details.family || this.extractFamily(modelName),
        parameterSize: details.parameter_size || this.extractParameterSize(modelName),
        quantizationLevel: details.quantization_level || this.extractQuantization(modelName),
        capabilities: this.detectCapabilities(modelName, modelfile, details),
      };
    } catch {
      return null;
    }
  }

  /**
   * Pull a model with progress callback
   */
  async pullModel(model: string, onProgress?: (status: string, completed: number, total: number) => void): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/pull`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: model, stream: true }),
    });

    if (!response.ok) {
      throw new Error(`Failed to pull model: ${await response.text()}`);
    }

    // Process streaming response if callback provided
    if (onProgress && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n').filter(l => l.trim());

        for (const line of lines) {
          try {
            const json = JSON.parse(line);
            onProgress(
              json.status || 'downloading',
              json.completed || 0,
              json.total || 0
            );
          } catch {
            // Ignore parse errors
          }
        }
      }
    }
  }

  /**
   * Delete a model
   */
  async deleteModel(model: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // =========================================================================
  // Helper Methods
  // =========================================================================

  private parseModelInfo(model: {
    name: string;
    size?: number;
    modified_at?: string;
    digest?: string;
    details?: {
      family?: string;
      parameter_size?: string;
      quantization_level?: string;
    };
  }): OllamaModelInfo {
    const details = model.details || {};

    return {
      name: model.name,
      displayName: this.formatDisplayName(model.name),
      size: model.size || 0,
      sizeFormatted: this.formatSize(model.size || 0),
      modifiedAt: model.modified_at || new Date().toISOString(),
      digest: model.digest || '',
      family: details.family || this.extractFamily(model.name),
      parameterSize: details.parameter_size || this.extractParameterSize(model.name),
      quantizationLevel: details.quantization_level || this.extractQuantization(model.name),
      capabilities: this.detectCapabilities(model.name, '', details),
    };
  }

  private formatDisplayName(name: string): string {
    // Convert "llama3.2:latest" to "Llama 3.2"
    const baseName = name.split(':')[0];
    return baseName
      .replace(/([a-z])(\d)/gi, '$1 $2')
      .replace(/[-_]/g, ' ')
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private formatSize(bytes: number): string {
    if (bytes === 0) return 'Unknown';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }

  private extractFamily(name: string): string {
    const families: Record<string, string> = {
      'llama': 'Llama',
      'mistral': 'Mistral',
      'mixtral': 'Mixtral',
      'qwen': 'Qwen',
      'phi': 'Phi',
      'gemma': 'Gemma',
      'codellama': 'Code Llama',
      'deepseek': 'DeepSeek',
      'yi': 'Yi',
      'vicuna': 'Vicuna',
      'openchat': 'OpenChat',
      'neural-chat': 'Neural Chat',
      'starling': 'Starling',
      'orca': 'Orca',
      'dolphin': 'Dolphin',
      'nous-hermes': 'Nous Hermes',
      'solar': 'Solar',
      'command-r': 'Command R',
    };

    const lowerName = name.toLowerCase();
    for (const [key, value] of Object.entries(families)) {
      if (lowerName.includes(key)) return value;
    }
    return 'Unknown';
  }

  private extractParameterSize(name: string): string {
    // Match patterns like "7b", "70b", "8x7b", "3.2"
    const match = name.match(/(\d+(?:\.\d+)?x?\d*)b/i);
    if (match) return match[1].toUpperCase() + 'B';

    // Check for specific patterns
    const sizePatterns: Record<string, string> = {
      'small': '1-3B',
      'medium': '7B',
      'large': '13B',
      'xl': '30-40B',
      'xxl': '65-70B',
    };

    const lowerName = name.toLowerCase();
    for (const [key, value] of Object.entries(sizePatterns)) {
      if (lowerName.includes(key)) return value;
    }

    return 'Unknown';
  }

  private extractQuantization(name: string): string {
    const quantPatterns = ['q2_k', 'q3_k', 'q4_0', 'q4_1', 'q4_k', 'q5_0', 'q5_1', 'q5_k', 'q6_k', 'q8_0', 'fp16', 'fp32'];
    const lowerName = name.toLowerCase();

    for (const pattern of quantPatterns) {
      if (lowerName.includes(pattern)) {
        return pattern.toUpperCase().replace('_', ' ');
      }
    }

    // Default assumption based on common naming
    if (lowerName.includes(':latest')) return 'Q4 K M';
    return 'Unknown';
  }

  private detectCapabilities(
    name: string,
    modelfile: string,
    details: { family?: string; parameter_size?: string }
  ): OllamaModelInfo['capabilities'] {
    const lowerName = name.toLowerCase();
    const lowerModelfile = modelfile.toLowerCase();

    return {
      chat: true, // All Ollama models support chat
      embedding: lowerName.includes('embed') || lowerName.includes('nomic'),
      vision: lowerName.includes('vision') || lowerName.includes('llava') || lowerModelfile.includes('image'),
      functionCalling:
        lowerName.includes('hermes') ||
        lowerName.includes('functionary') ||
        lowerName.includes('openhermes') ||
        details.family === 'llama' && parseInt(details.parameter_size || '0') >= 70,
    };
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
