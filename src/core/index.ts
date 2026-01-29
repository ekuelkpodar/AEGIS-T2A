/**
 * AEGIS-T2A Core Module
 *
 * Exports all core types, utilities, and infrastructure components.
 */

// Types
export * from './types.js';

// Utilities
export * from './crypto.js';
export * from './ids.js';
export * from './logger.js';
export * from './config.js';
export * from './database.js';

// Re-export commonly used items at top level
export { logger, createLogger, componentLogger } from './logger.js';
export { getConfig, isDevelopment, isProduction, isTest } from './config.js';
export { getDatabase, runMigrations, transaction } from './database.js';
export { sha256, hashObject, sign, signObject, encrypt, decrypt } from './crypto.js';
export { generateId, generateIntentId, generatePlanId, generateWorkflowId } from './ids.js';
