/**
 * AEGIS-T2A Executor
 *
 * Executes plan steps using tool adapters with sandboxing and DLP.
 */

import {
  PlanStep,
  StepExecutionResult,
} from '../core/types.js';
import { componentLogger, logStep } from '../core/logger.js';
import type { ExecutionContext } from '../workflow/index.js';
import { enforceSandboxGuardrails } from './sandbox-guard.js';
import { getIntegrationCatalog, ZapierMcpClient } from '../integrations/index.js';
import { withSpan, setSpanAttributes } from '../observability/index.js';
import { getFeatureFlags } from '../deployment/feature-flags.js';
import { getMetricsRegistry } from '../observability/metrics.js';

// Re-export DLP Filter
export {
  DLPFilter,
  getDLPFilter,
  initializeDLPFilter,
  defaultDLPConfig,
} from './dlp-filter.js';
export type {
  DLPConfig,
  RedactionMethod,
  DataSchema,
  SensitivePath,
  DataType,
  DataClassification,
  DLPPattern,
  DLPScanResult,
  DLPFinding,
  FilteredOutput,
  FilterContext,
} from './dlp-filter.js';

const logger = componentLogger('executor');

// =============================================================================
// Types
// =============================================================================

export interface ExecutorOptions {
  sandbox?: boolean;
  dlpEnabled?: boolean;
  timeout?: number;
}

export type ToolHandler = (
  params: Record<string, unknown>,
  context: ExecutionContext
) => Promise<Record<string, unknown>>;

// =============================================================================
// DLP Patterns
// =============================================================================

const DLP_PATTERNS = [
  { name: 'api_key', pattern: /(?:api[_-]?key|apikey)[=:]\s*['"]?[\w-]{20,}['"]?/gi },
  { name: 'password', pattern: /(?:password|passwd|pwd)[=:]\s*['"]?[^\s'"]{8,}['"]?/gi },
  { name: 'secret', pattern: /(?:secret|token)[=:]\s*['"]?[\w-]{20,}['"]?/gi },
  { name: 'aws_key', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'private_key', pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
  { name: 'credit_card', pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g },
  { name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g },
];

// =============================================================================
// Executor
// =============================================================================

export class Executor {
  private initialized = false;
  private toolHandlers = new Map<string, ToolHandler>();
  private options: ExecutorOptions;

  constructor(options: ExecutorOptions = {}) {
    this.options = {
      sandbox: true,
      dlpEnabled: true,
      timeout: 60000,
      ...options,
    };
  }

  /**
   * Initialize the executor
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Register built-in tool handlers
    this.registerBuiltInHandlers();

    this.initialized = true;
    logger.info('Executor initialized');
  }

  /**
   * Register a tool handler
   */
  registerHandler(adapterType: string, handler: ToolHandler): void {
    this.toolHandlers.set(adapterType, handler);
    logger.info({ adapterType }, 'Tool handler registered');
  }

  /**
   * Execute a plan step
   */
  async executeStep(
    step: PlanStep,
    context: ExecutionContext
  ): Promise<StepExecutionResult> {
    const startTime = Date.now();

    logStep(step.stepId, context.workflowId, 'executing', {
      action: step.action,
      adapter: step.toolAdapter,
    });

    try {
      const flags = getFeatureFlags();
      if (!flags.isEnabled('execution_enabled', true)) {
        throw new Error('Execution disabled by feature flag');
      }
      // Get the handler for this adapter (with fallback support)
      let adapterToUse = step.toolAdapter;
      let handler = this.getHandler(adapterToUse);
      if (!handler) {
        const fallback = getIntegrationCatalog().getFallbackAdapter(adapterToUse);
        if (fallback) {
          adapterToUse = fallback;
          handler = this.getHandler(adapterToUse);
          logger.warn({ adapter: step.toolAdapter, fallback: adapterToUse }, 'Using fallback adapter');
        }
      }
      if (!handler) {
        throw new Error(`No handler for adapter: ${step.toolAdapter}`);
      }

      // Apply DLP to inputs
      const sanitizedParams = this.options.dlpEnabled
        ? this.sanitizeInputs(step.parameters)
        : step.parameters;

      if (this.options.sandbox) {
        enforceSandboxGuardrails(sanitizedParams);
      }

      // Execute with timeout (traced)
      const outputs = await withSpan('aegis.tool.execute', {
        'aegis.workflow.id': context.workflowId,
        'aegis.plan.id': context.planId,
        'aegis.intent.id': context.intentId,
        'aegis.step.id': step.stepId,
        'aegis.tool.adapter': adapterToUse,
        'aegis.tool.fallback_applied': adapterToUse !== step.toolAdapter,
        'aegis.step.risk_level': step.riskLevel,
      }, async (span) => {
        setSpanAttributes(span, {
          'aegis.step.action': step.action,
          'aegis.step.has_side_effects': step.hasSideEffects,
          'aegis.step.estimated_cost': step.estimatedCost,
        });

        return Promise.race([
          handler(sanitizedParams, context),
          this.timeout(step.timeout),
        ]);
      });
      const metrics = getMetricsRegistry();
      metrics.inc('aegis_tool_executions_total', 1);

      // Apply DLP to outputs
      const sanitizedOutputs = this.options.dlpEnabled
        ? this.sanitizeOutputs(outputs)
        : outputs;

      const durationMs = Date.now() - startTime;

      return {
        stepId: step.stepId,
        status: 'completed',
        outputs: {
          ...sanitizedOutputs,
          usedAdapter: adapterToUse,
          fallbackApplied: adapterToUse !== step.toolAdapter,
        },
        durationMs,
        costIncurred: step.estimatedCost,
      };
    } catch (error) {
      getMetricsRegistry().inc('aegis_tool_failures_total', 1);
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logger.error({ error, stepId: step.stepId }, 'Step execution failed');

      return {
        stepId: step.stepId,
        status: 'failed',
        outputs: {},
        error: errorMessage,
        durationMs,
        costIncurred: 0,
      };
    }
  }

  /**
   * Get handler for adapter type
   */
  private getHandler(adapterType: string): ToolHandler | undefined {
    // Try exact match first
    let handler = this.toolHandlers.get(adapterType);
    if (handler) return handler;

    // Try prefix match (e.g., "aws:ec2" -> "aws")
    const prefix = adapterType.split(':')[0];
    if (prefix) {
      handler = this.toolHandlers.get(prefix);
    }

    return handler;
  }

  /**
   * Register built-in handlers
   */
  private registerBuiltInHandlers(): void {
    // HTTP handler
    this.registerHandler('http', async (params) => {
      const url = params['url'] as string;
      const method = (params['method'] as string) ?? 'GET';
      const body = params['body'];
      const headers = (params['headers'] as Record<string, string>) ?? {};

      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      const responseBody = await response.text();
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(responseBody);
      } catch {
        parsedBody = responseBody;
      }

      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: parsedBody,
      };
    });

    // Shell handler (mock for security)
    this.registerHandler('shell', async (params) => {
      // In production, this would execute in a sandboxed container
      logger.warn('Shell execution is mocked for security');
      return {
        exitCode: 0,
        stdout: `[MOCK] Would execute: ${params['command']}`,
        stderr: '',
      };
    });

    // File handler (mock)
    this.registerHandler('file', async (params) => {
      const operation = params['operation'] as string;
      logger.warn({ operation }, 'File operation is mocked');
      return {
        success: true,
        mock: true,
        operation,
      };
    });

    // Database handler (mock)
    this.registerHandler('database', async (_params) => {
      logger.warn('Database operation is mocked');
      return {
        rowCount: 0,
        rows: [],
        mock: true,
      };
    });

    // AWS handler (mock)
    this.registerHandler('aws', async (params) => {
      const service = params['service'] as string;
      const operation = params['operation'] as string;
      logger.warn({ service, operation }, 'AWS operation is mocked');
      return {
        success: true,
        mock: true,
        service,
        operation,
      };
    });

    // GitHub handler (mock)
    this.registerHandler('github', async (params) => {
      const endpoint = params['endpoint'] as string;
      logger.warn({ endpoint }, 'GitHub operation is mocked');
      return {
        success: true,
        mock: true,
        endpoint,
      };
    });

    // Notification handler (mock)
    this.registerHandler('notification', async (params) => {
      const channel = params['channel'] as string;
      logger.warn({ channel }, 'Notification is mocked');
      return {
        sent: true,
        mock: true,
        channel,
      };
    });

    // Webhook handler (HTTP passthrough)
    this.registerHandler('webhook', async (params) => {
      const url = params['url'] as string;
      const method = (params['method'] as string) ?? 'POST';
      const body = params['body'];
      const headers = (params['headers'] as Record<string, string>) ?? {};

      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      const responseBody = await response.text();
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(responseBody);
      } catch {
        parsedBody = responseBody;
      }

      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: parsedBody,
      };
    });

    // Zapier MCP handler
    const zapierClient = new ZapierMcpClient();
    this.registerHandler('zapier', async (params) => {
      const actionId = (params['actionId'] ?? params['action'] ?? params['capability']) as string | undefined;
      if (!actionId) {
        throw new Error('Zapier MCP actionId is required');
      }
      const input = (params['input'] as Record<string, unknown>) ?? params;
      return zapierClient.execute(actionId, input);
    });
  }

  /**
   * Sanitize inputs using DLP
   */
  private sanitizeInputs(params: Record<string, unknown>): Record<string, unknown> {
    const sanitized = { ...params };
    const stringified = JSON.stringify(params);

    for (const { name, pattern } of DLP_PATTERNS) {
      if (pattern.test(stringified)) {
        logger.warn({ pattern: name }, 'Potential sensitive data detected in inputs');
      }
    }

    return sanitized;
  }

  /**
   * Sanitize outputs using DLP
   */
  private sanitizeOutputs(outputs: Record<string, unknown>): Record<string, unknown> {
    const stringified = JSON.stringify(outputs);
    let sanitized = stringified;

    for (const { name, pattern } of DLP_PATTERNS) {
      sanitized = sanitized.replace(pattern, `[REDACTED:${name}]`);
    }

    try {
      return JSON.parse(sanitized);
    } catch {
      return { redacted: true, original: '[Parse error after sanitization]' };
    }
  }

  /**
   * Create timeout promise
   */
  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Execution timed out after ${ms}ms`)), ms);
    });
  }
}

// =============================================================================
// Singleton
// =============================================================================

let executor: Executor | null = null;

export function getExecutor(): Executor {
  if (!executor) {
    executor = new Executor();
  }
  return executor;
}

export async function initializeExecutor(): Promise<Executor> {
  const e = getExecutor();
  await e.initialize();
  return e;
}
