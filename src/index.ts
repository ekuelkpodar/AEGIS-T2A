/**
 * AEGIS-T2A - Text-to-Action Anywhere Platform
 *
 * A governed multi-agent system for safe, auditable automation.
 */

import { createServer } from './api/server.js';
import { getConfig } from './core/config.js';
import { runMigrations, closeDatabase } from './core/database.js';
import { initializeSigningKey, initializeEncryptionKey } from './core/crypto.js';
import { logger } from './core/logger.js';

// Component initialization
import { initializeGateway } from './gateway/index.js';
import { initializePlanner } from './planner/index.js';
import { initializeSimulator } from './simulation/index.js';
import { initializeWorkflowEngine } from './workflow/index.js';
import { initializeExecutor } from './executor/index.js';
import { initializeRegistry } from './registry/index.js';
import { initializeAuditLedger } from './audit/index.js';
import { initializeSecretsVault } from './secrets/index.js';
import { initializeIntegrations } from './integrations/index.js';
import { initializeObservability, shutdownObservability } from './observability/index.js';

// Identity & Zero-Trust initialization
import { initializeIdentitySystem, shutdownIdentitySystem } from './identity/initialization.js';

// =============================================================================
// Application Startup
// =============================================================================

async function initialize(): Promise<void> {
  logger.info('Initializing AEGIS-T2A...');

  // Initialize crypto
  const config = getConfig();
  initializeSigningKey(process.env['SIGNING_KEY']);
  if (config.secretsEncryptionKey) {
    initializeEncryptionKey(config.secretsEncryptionKey);
  }

  // Initialize observability early for startup spans/logs
  initializeObservability();

  // Run database migrations
  logger.info('Running database migrations...');
  runMigrations();

  // Initialize components in order
  logger.info('Initializing components...');

  // Initialize identity & zero-trust first (foundational security layer)
  await initializeIdentitySystem();

  await initializeRegistry();
  initializeIntegrations();
  await initializeSecretsVault();
  await initializeAuditLedger();
  await initializeGateway();
  await initializePlanner();
  await initializeSimulator();
  await initializeExecutor();
  await initializeWorkflowEngine();

  logger.info('All components initialized');
}

async function main(): Promise<void> {
  try {
    // Initialize all components
    await initialize();

    // Create and start server
    const config = getConfig();
    const server = createServer();

    const httpServer = server.listen(config.port, () => {
      logger.info({ port: config.port }, `AEGIS-T2A server started on port ${config.port}`);
      logger.info(`  Health check: http://localhost:${config.port}/api/v1/health`);
      logger.info(`  Environment: ${config.nodeEnv}`);
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal');

      httpServer.close(() => {
        logger.info('HTTP server closed');
      });

      // Shutdown identity system
      await shutdownIdentitySystem();
      await shutdownObservability();

      closeDatabase();
      logger.info('Database connection closed');

      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.error({ error }, 'Failed to start AEGIS-T2A');
    process.exit(1);
  }
}

// Run if this is the main module
main();

// =============================================================================
// Exports for library usage
// =============================================================================

// Core exports (primary module)
export * from './core/index.js';

// Individual module exports - import directly from modules to avoid conflicts
export { initializeGateway, getGateway, IntentGateway } from './gateway/index.js';
export { initializePlanner, getPlanner, PlannerAgent } from './planner/index.js';
export { initializeSimulator, getSimulator, SimulationEngine } from './simulation/index.js';
export { initializeWorkflowEngine, getWorkflowEngine, WorkflowEngine } from './workflow/index.js';
export { initializeExecutor, getExecutor, Executor, DLPFilter, getDLPFilter } from './executor/index.js';
export { initializeRegistry, getRegistry, AgentRegistry } from './registry/index.js';
export { initializeAuditLedger, getAuditLedger, AuditLedger } from './audit/index.js';
export { initializeSecretsVault, getSecretsVault, SecretsVault } from './secrets/index.js';
export { initializeIntegrations, getIntegrationCatalog, IntegrationCatalog } from './integrations/index.js';
export { initializeObservability, shutdownObservability } from './observability/index.js';
export { createRouter, createServer, ApiError } from './api/index.js';

// Identity & Zero-Trust exports
export {
  initializeIdentitySystem,
  shutdownIdentitySystem,
  getIdentitySystemHealth,
  getSPIREClient,
  getWorkloadIAM,
  getScopeManager,
  getDelegationManager,
  getNHILifecycleManager,
} from './identity/index.js';

// Control Plane Integration exports
export {
  getApprovalClient,
  getAutonomyClient,
  ApprovalStatus,
  RiskLevel,
  AutonomyLevel,
} from './controlplane/index.js';

// Security exports
export {
  getPromptInjectionDetector,
  getLLMGuardrails,
  ThreatLevel,
  SafetyViolationType,
} from './security/index.js';

// Compliance exports
export {
  getSOC2Reporter,
  SOC2Report,
  CriteriaReport,
} from './compliance/index.js';
