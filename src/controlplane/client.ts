/**
 * Control Plane Client Base
 *
 * Base HTTP client for communicating with AEGIS-T2A control plane microservices.
 * Provides authentication, retry logic, and error handling.
 */

import { logger } from '../core/logger.js';

export interface ControlPlaneConfig {
  baseUrl: string;
  apiKey?: string;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export class ControlPlaneClientError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public response?: unknown
  ) {
    super(message);
    this.name = 'ControlPlaneClientError';
  }
}

export class ControlPlaneClient {
  protected readonly config: Required<ControlPlaneConfig>;

  constructor(config: ControlPlaneConfig) {
    this.config = {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey || process.env.CONTROLPLANE_API_KEY || '',
      timeout: config.timeout || 30000,
      retries: config.retries || 3,
      retryDelay: config.retryDelay || 1000,
    };
  }

  /**
   * Make HTTP GET request
   */
  protected async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = this.buildUrl(path, params);
    return this.request<T>('GET', url);
  }

  /**
   * Make HTTP POST request
   */
  protected async post<T>(path: string, body?: unknown): Promise<T> {
    const url = this.buildUrl(path);
    return this.request<T>('POST', url, body);
  }

  /**
   * Make HTTP PUT request
   */
  protected async put<T>(path: string, body?: unknown): Promise<T> {
    const url = this.buildUrl(path);
    return this.request<T>('PUT', url, body);
  }

  /**
   * Make HTTP DELETE request
   */
  protected async delete<T>(path: string): Promise<T> {
    const url = this.buildUrl(path);
    return this.request<T>('DELETE', url);
  }

  /**
   * Make HTTP request with retry logic
   */
  private async request<T>(
    method: string,
    url: string,
    body?: unknown,
    attempt = 1
  ): Promise<T> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.config.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          let errorData: unknown;
          try {
            errorData = JSON.parse(errorText);
          } catch {
            errorData = errorText;
          }

          throw new ControlPlaneClientError(
            `HTTP ${response.status}: ${response.statusText}`,
            response.status,
            errorData
          );
        }

        const data = await response.json();
        return data as T;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      // Retry on network errors or 5xx responses
      if (
        attempt < this.config.retries &&
        (error instanceof ControlPlaneClientError
          ? (error.statusCode || 0) >= 500
          : true)
      ) {
        logger.warn('Control plane request failed, retrying', {
          url,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });

        await this.delay(this.config.retryDelay * attempt);
        return this.request<T>(method, url, body, attempt + 1);
      }

      logger.error('Control plane request failed', {
        url,
        method,
        attempt,
        error,
      });

      throw error;
    }
  }

  /**
   * Build full URL with query parameters
   */
  private buildUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(path, this.config.baseUrl);

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }

    return url.toString();
  }

  /**
   * Delay for retry logic
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if control plane service is healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.get('/health');
      return true;
    } catch (error) {
      logger.warn('Control plane health check failed', {
        baseUrl: this.config.baseUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
