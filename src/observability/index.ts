/**
 * OpenTelemetry setup and helpers.
 */

import { diag, DiagConsoleLogger, DiagLogLevel, trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { getConfig } from '../core/config.js';
import { componentLogger } from '../core/logger.js';

const logger = componentLogger('observability');

let sdk: NodeSDK | null = null;

const REDACTION_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'api_key', pattern: /(?:api[_-]?key|apikey|token)[=:]\s*['\"]?[\w-]{16,}['\"]?/gi },
  { name: 'password', pattern: /(?:password|passwd|pwd)[=:]\s*['\"]?[^\s'\"]{8,}['\"]?/gi },
  { name: 'private_key', pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g },
  { name: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g },
];

export function initializeObservability(): void {
  if (sdk) return;

  const config = getConfig();
  const enabled = config.otelEnabled || Boolean(config.otelEndpoint);

  if (!enabled) {
    logger.info('OpenTelemetry disabled');
    return;
  }

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: config.otelServiceName,
    [SemanticResourceAttributes.SERVICE_VERSION]: '0.1.0',
  });

  const traceExporter = config.otelEndpoint
    ? new OTLPTraceExporter({ url: config.otelEndpoint })
    : undefined;

  sdk = new NodeSDK({
    resource,
    traceExporter,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();
  logger.info({ otelEndpoint: config.otelEndpoint }, 'OpenTelemetry initialized');
}

export async function shutdownObservability(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = null;
  logger.info('OpenTelemetry shutdown complete');
}

export function getTracer(name: string = 'aegis-t2a') {
  return trace.getTracer(name);
}

export async function withSpan<T>(
  name: string,
  attributes: Record<string, unknown>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { attributes: sanitizeAttributes(attributes) }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function setSpanAttributes(span: Span, attributes: Record<string, unknown>): void {
  const sanitized = sanitizeAttributes(attributes);
  for (const [key, value] of Object.entries(sanitized)) {
    if (value === undefined || value === null) continue;
    span.setAttribute(key, value as string | number | boolean);
  }
}

function sanitizeAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string') {
      sanitized[key] = redact(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function redact(value: string): string {
  let redacted = value;
  for (const pattern of REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern.pattern, `[REDACTED:${pattern.name}]`);
  }
  return redacted;
}
