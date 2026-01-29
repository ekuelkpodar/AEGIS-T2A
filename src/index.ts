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

  // Run database migrations
  logger.info('Running database migrations...');
  runMigrations();

  // Initialize components in order
  logger.info('Initializing components...');

  await initializeRegistry();
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

export * from './core/index.js';
export * from './gateway/index.js';
export * from './planner/index.js';
export * from './simulation/index.js';
export * from './workflow/index.js';
export * from './executor/index.js';
export * from './registry/index.js';
export * from './audit/index.js';
export * from './secrets/index.js';
export * from './api/index.js';
