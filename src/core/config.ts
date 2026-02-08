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
  llmProvider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama']).default('anthropic'),
  anthropicApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  openrouterApiKey: z.string().optional(),
  ollamaBaseUrl: z.string().url().optional(),
  llmModel: z.string().optional(),
  llmTemperature: z.coerce.number().min(0).max(2).default(0.7),
  llmFastModel: z.string().optional(),
  llmStandardModel: z.string().optional(),
  llmComplexModel: z.string().optional(),
  promptCacheEnabled: z.coerce.boolean().default(false),
  promptCacheTtlSeconds: z.coerce.number().int().positive().default(86400),
  featureFlagsJson: z.string().optional(),

  // Observability
  otelEnabled: z.coerce.boolean().default(false),
  otelEndpoint: z.string().url().optional(),
  otelServiceName: z.string().default('aegis-t2a'),

  // Rate Limiting
  rateLimitWindowMs: z.coerce.number().int().positive().default(60000),
  rateLimitMaxRequests: z.coerce.number().int().positive().default(100),

  // Workflow
  workflowCheckpointIntervalMs: z.coerce.number().int().positive().default(5000),
  workflowMaxRetries: z.coerce.number().int().min(0).default(3),
  workflowRetryBackoffMs: z.coerce.number().int().positive().default(1000),
  temporalEnabled: z.coerce.boolean().default(false),
  temporalAddress: z.string().default('localhost:7233'),
  temporalNamespace: z.string().default('default'),
  temporalTaskQueue: z.string().default('aegis-t2a'),
  temporalPayloadThresholdBytes: z.coerce.number().int().positive().default(65536),
  temporalApprovalTimeoutHours: z.coerce.number().int().positive().default(12),

  // Secrets
  secretsEncryptionKey: z.string().length(64).optional(),
  secretsTtlSeconds: z.coerce.number().int().positive().default(300),

  // Simulation
  simulationTimeoutMs: z.coerce.number().int().positive().default(30000),
  simulationMaxIterations: z.coerce.number().int().positive().default(100),

  // Approval
  approvalMediumRiskTtlHours: z.coerce.number().positive().default(24),
  approvalHighRiskTtlHours: z.coerce.number().positive().default(1),

  // RAG
  ragChunkSizeWords: z.coerce.number().int().positive().default(200),
  ragChunkOverlapWords: z.coerce.number().int().min(0).default(40),
  ragVectorDims: z.coerce.number().int().positive().default(256),
  ragHybridWeight: z.coerce.number().min(0).max(1).default(0.6),
  ragMinScore: z.coerce.number().min(0).default(0.0),

  // Integrations
  integrationVectorDims: z.coerce.number().int().positive().default(192),
  integrationHybridWeight: z.coerce.number().min(0).max(1).default(0.5),
  integrationMinScore: z.coerce.number().min(0).default(0.0),
  zapierMcpEndpoint: z.string().url().optional(),
  zapierMcpApiKey: z.string().optional(),
  zapierMcpTimeoutMs: z.coerce.number().int().positive().default(15000),

  // Sandbox
  sandboxEnforceEgressAllowlist: z.coerce.boolean().default(false),
  sandboxAllowLocalhost: z.coerce.boolean().default(false),
  sandboxAllowedDomains: z.array(z.string()).default([]),
  sandboxBlockedPaths: z.array(z.string()).default([]),
  sandboxReadOnlyPaths: z.array(z.string()).default([]),
  sandboxMaxPayloadBytes: z.coerce.number().int().positive().default(64 * 1024),
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
    openrouterApiKey: process.env['OPENROUTER_API_KEY'],
    ollamaBaseUrl: process.env['OLLAMA_BASE_URL'],
    llmModel: process.env['LLM_MODEL'],
    llmTemperature: process.env['LLM_TEMPERATURE'],
    llmFastModel: process.env['LLM_FAST_MODEL'],
    llmStandardModel: process.env['LLM_STANDARD_MODEL'],
    llmComplexModel: process.env['LLM_COMPLEX_MODEL'],
    promptCacheEnabled: process.env['PROMPT_CACHE_ENABLED'],
    promptCacheTtlSeconds: process.env['PROMPT_CACHE_TTL_SECONDS'],
    featureFlagsJson: process.env['FEATURE_FLAGS_JSON'],
    otelEndpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
    otelServiceName: process.env['OTEL_SERVICE_NAME'],
    otelEnabled: process.env['OTEL_ENABLED'],
    rateLimitWindowMs: process.env['RATE_LIMIT_WINDOW_MS'],
    rateLimitMaxRequests: process.env['RATE_LIMIT_MAX_REQUESTS'],
    workflowCheckpointIntervalMs: process.env['WORKFLOW_CHECKPOINT_INTERVAL_MS'],
    workflowMaxRetries: process.env['WORKFLOW_MAX_RETRIES'],
    workflowRetryBackoffMs: process.env['WORKFLOW_RETRY_BACKOFF_MS'],
    temporalEnabled: process.env['TEMPORAL_ENABLED'],
    temporalAddress: process.env['TEMPORAL_ADDRESS'],
    temporalNamespace: process.env['TEMPORAL_NAMESPACE'],
    temporalTaskQueue: process.env['TEMPORAL_TASK_QUEUE'],
    temporalPayloadThresholdBytes: process.env['TEMPORAL_PAYLOAD_THRESHOLD_BYTES'],
    temporalApprovalTimeoutHours: process.env['TEMPORAL_APPROVAL_TIMEOUT_HOURS'],
    secretsEncryptionKey: process.env['SECRETS_ENCRYPTION_KEY'],
    secretsTtlSeconds: process.env['SECRETS_TTL_SECONDS'],
    simulationTimeoutMs: process.env['SIMULATION_TIMEOUT_MS'],
    simulationMaxIterations: process.env['SIMULATION_MAX_ITERATIONS'],
    approvalMediumRiskTtlHours: process.env['APPROVAL_MEDIUM_RISK_TTL_HOURS'],
    approvalHighRiskTtlHours: process.env['APPROVAL_HIGH_RISK_TTL_HOURS'],
    ragChunkSizeWords: process.env['RAG_CHUNK_SIZE_WORDS'],
    ragChunkOverlapWords: process.env['RAG_CHUNK_OVERLAP_WORDS'],
    ragVectorDims: process.env['RAG_VECTOR_DIMS'],
    ragHybridWeight: process.env['RAG_HYBRID_WEIGHT'],
    ragMinScore: process.env['RAG_MIN_SCORE'],
    integrationVectorDims: process.env['INTEGRATION_VECTOR_DIMS'],
    integrationHybridWeight: process.env['INTEGRATION_HYBRID_WEIGHT'],
    integrationMinScore: process.env['INTEGRATION_MIN_SCORE'],
    zapierMcpEndpoint: process.env['ZAPIER_MCP_ENDPOINT'],
    zapierMcpApiKey: process.env['ZAPIER_MCP_API_KEY'],
    zapierMcpTimeoutMs: process.env['ZAPIER_MCP_TIMEOUT_MS'],
    sandboxEnforceEgressAllowlist: process.env['SANDBOX_ENFORCE_EGRESS_ALLOWLIST'],
    sandboxAllowLocalhost: process.env['SANDBOX_ALLOW_LOCALHOST'],
    sandboxAllowedDomains: parseCsv(process.env['SANDBOX_ALLOWED_DOMAINS']),
    sandboxBlockedPaths: parseCsv(process.env['SANDBOX_BLOCKED_PATHS']),
    sandboxReadOnlyPaths: parseCsv(process.env['SANDBOX_READONLY_PATHS']),
    sandboxMaxPayloadBytes: process.env['SANDBOX_MAX_PAYLOAD_BYTES'],
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

function parseCsv(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
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
