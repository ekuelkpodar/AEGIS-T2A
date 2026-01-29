/**
 * AEGIS-T2A Configuration
 *
 * Centralized configuration management with validation.
 */

import { z } from 'zod';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// =============================================================================
// Configuration Schema
// =============================================================================

const ConfigSchema = z.object({
  // Server
  port: z.coerce.number().int().positive().default(3000),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Database
  databasePath: z.string().default('./data/aegis.db'),

  // Authentication
  jwtSecret: z.string().min(32),
  jwtExpiresIn: z.string().default('1h'),

  // LLM
  llmProvider: z.enum(['anthropic', 'openai', 'openrouter']).default('anthropic'),
  anthropicApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),

  // Observability
  otelEndpoint: z.string().url().optional(),
  otelServiceName: z.string().default('aegis-t2a'),

  // Rate Limiting
  rateLimitWindowMs: z.coerce.number().int().positive().default(60000),
  rateLimitMaxRequests: z.coerce.number().int().positive().default(100),

  // Workflow
  workflowCheckpointIntervalMs: z.coerce.number().int().positive().default(5000),
  workflowMaxRetries: z.coerce.number().int().min(0).default(3),
  workflowRetryBackoffMs: z.coerce.number().int().positive().default(1000),

  // Secrets
  secretsEncryptionKey: z.string().length(64).optional(),
  secretsTtlSeconds: z.coerce.number().int().positive().default(300),

  // Simulation
  simulationTimeoutMs: z.coerce.number().int().positive().default(30000),
  simulationMaxIterations: z.coerce.number().int().positive().default(100),

  // Approval
  approvalMediumRiskTtlHours: z.coerce.number().positive().default(24),
  approvalHighRiskTtlHours: z.coerce.number().positive().default(1),
});

export type Config = z.infer<typeof ConfigSchema>;

// =============================================================================
// Load Configuration
// =============================================================================

function loadConfig(): Config {
  const rawConfig = {
    port: process.env['PORT'],
    nodeEnv: process.env['NODE_ENV'],
    logLevel: process.env['LOG_LEVEL'],
    databasePath: process.env['DATABASE_PATH'],
    jwtSecret: process.env['JWT_SECRET'] ?? 'development-secret-change-in-production-minimum-32-chars',
    jwtExpiresIn: process.env['JWT_EXPIRES_IN'],
    llmProvider: process.env['LLM_PROVIDER'],
    anthropicApiKey: process.env['ANTHROPIC_API_KEY'],
    openaiApiKey: process.env['OPENAI_API_KEY'],
    otelEndpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
    otelServiceName: process.env['OTEL_SERVICE_NAME'],
    rateLimitWindowMs: process.env['RATE_LIMIT_WINDOW_MS'],
    rateLimitMaxRequests: process.env['RATE_LIMIT_MAX_REQUESTS'],
    workflowCheckpointIntervalMs: process.env['WORKFLOW_CHECKPOINT_INTERVAL_MS'],
    workflowMaxRetries: process.env['WORKFLOW_MAX_RETRIES'],
    workflowRetryBackoffMs: process.env['WORKFLOW_RETRY_BACKOFF_MS'],
    secretsEncryptionKey: process.env['SECRETS_ENCRYPTION_KEY'],
    secretsTtlSeconds: process.env['SECRETS_TTL_SECONDS'],
    simulationTimeoutMs: process.env['SIMULATION_TIMEOUT_MS'],
    simulationMaxIterations: process.env['SIMULATION_MAX_ITERATIONS'],
    approvalMediumRiskTtlHours: process.env['APPROVAL_MEDIUM_RISK_TTL_HOURS'],
    approvalHighRiskTtlHours: process.env['APPROVAL_HIGH_RISK_TTL_HOURS'],
  };

  const result = ConfigSchema.safeParse(rawConfig);

  if (!result.success) {
    console.error('Configuration validation failed:');
    for (const error of result.error.errors) {
      console.error(`  ${error.path.join('.')}: ${error.message}`);
    }
    throw new Error('Invalid configuration');
  }

  return result.data;
}

// =============================================================================
// Singleton Configuration
// =============================================================================

let config: Config | null = null;

export function getConfig(): Config {
  if (!config) {
    config = loadConfig();
  }
  return config;
}

export function resetConfig(): void {
  config = null;
}

// =============================================================================
// Environment Helpers
// =============================================================================

export function isDevelopment(): boolean {
  return getConfig().nodeEnv === 'development';
}

export function isProduction(): boolean {
  return getConfig().nodeEnv === 'production';
}

export function isTest(): boolean {
  return getConfig().nodeEnv === 'test';
}

export default getConfig;
