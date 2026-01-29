/**
 * AEGIS-T2A Logger
 *
 * Structured logging with context propagation for observability.
 */

import pino from 'pino';

// =============================================================================
// Logger Configuration
// =============================================================================

const isDevelopment = process.env['NODE_ENV'] !== 'production';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? (isDevelopment ? 'debug' : 'info'),
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  base: {
    service: 'aegis-t2a',
    version: process.env['npm_package_version'] ?? '0.1.0',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
});

// =============================================================================
// Child Loggers
// =============================================================================

export type LogContext = {
  intentId?: string;
  planId?: string;
  workflowId?: string;
  stepId?: string;
  userId?: string;
  component?: string;
  traceId?: string;
  spanId?: string;
};

/**
 * Create a child logger with context
 */
export function createLogger(context: LogContext): pino.Logger {
  return logger.child(context);
}

/**
 * Create a component-specific logger
 */
export function componentLogger(component: string): pino.Logger {
  return createLogger({ component });
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Log an intent processing event
 */
export function logIntent(
  intentId: string,
  action: string,
  data?: Record<string, unknown>
): void {
  logger.info({ intentId, action, ...data }, `Intent: ${action}`);
}

/**
 * Log a plan event
 */
export function logPlan(
  planId: string,
  action: string,
  data?: Record<string, unknown>
): void {
  logger.info({ planId, action, ...data }, `Plan: ${action}`);
}

/**
 * Log a workflow event
 */
export function logWorkflow(
  workflowId: string,
  action: string,
  data?: Record<string, unknown>
): void {
  logger.info({ workflowId, action, ...data }, `Workflow: ${action}`);
}

/**
 * Log a step execution event
 */
export function logStep(
  stepId: string,
  workflowId: string,
  action: string,
  data?: Record<string, unknown>
): void {
  logger.info({ stepId, workflowId, action, ...data }, `Step: ${action}`);
}

/**
 * Log a security event
 */
export function logSecurity(
  event: string,
  data: Record<string, unknown>
): void {
  logger.warn({ event, security: true, ...data }, `Security: ${event}`);
}

/**
 * Log an error with context
 */
export function logError(
  error: Error,
  context: Record<string, unknown>
): void {
  logger.error(
    {
      err: {
        message: error.message,
        name: error.name,
        stack: error.stack,
      },
      ...context,
    },
    `Error: ${error.message}`
  );
}

/**
 * Log a policy violation
 */
export function logPolicyViolation(
  ruleId: string,
  context: Record<string, unknown>
): void {
  logger.warn(
    { ruleId, policyViolation: true, ...context },
    `Policy violation: ${ruleId}`
  );
}

/**
 * Log an anomaly detection
 */
export function logAnomaly(
  anomalyType: string,
  severity: 'low' | 'medium' | 'high',
  data: Record<string, unknown>
): void {
  const logFn = severity === 'high' ? logger.error : severity === 'medium' ? logger.warn : logger.info;
  logFn.call(logger, { anomalyType, severity, anomaly: true, ...data }, `Anomaly: ${anomalyType}`);
}

// =============================================================================
// Request Logging
// =============================================================================

/**
 * Create a request logger middleware context
 */
export function requestLogger(requestId: string, method: string, path: string): pino.Logger {
  return logger.child({ requestId, method, path });
}

export default logger;
