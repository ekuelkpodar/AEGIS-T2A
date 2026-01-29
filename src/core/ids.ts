/**
 * AEGIS-T2A ID Generation
 *
 * Centralized ID generation for consistent identifiers across the system.
 */

import { v4 as uuidv4 } from 'uuid';
import { nanoid } from 'nanoid';
import { sha256 } from './crypto.js';

// =============================================================================
// UUID Generation
// =============================================================================

/**
 * Generate a new UUID v4
 */
export function generateId(): string {
  return uuidv4();
}

/**
 * Generate an intent ID
 */
export function generateIntentId(): string {
  return `int_${uuidv4()}`;
}

/**
 * Generate a plan ID
 */
export function generatePlanId(): string {
  return `pln_${uuidv4()}`;
}

/**
 * Generate a step ID
 */
export function generateStepId(): string {
  return `stp_${uuidv4()}`;
}

/**
 * Generate a workflow ID
 */
export function generateWorkflowId(): string {
  return `wfl_${uuidv4()}`;
}

/**
 * Generate a simulation ID
 */
export function generateSimulationId(): string {
  return `sim_${uuidv4()}`;
}

/**
 * Generate an approval ID
 */
export function generateApprovalId(): string {
  return `apr_${uuidv4()}`;
}

/**
 * Generate an event ID
 */
export function generateEventId(): string {
  return `evt_${uuidv4()}`;
}

/**
 * Generate a credential ID
 */
export function generateCredentialId(): string {
  return `crd_${uuidv4()}`;
}

// =============================================================================
// Idempotency Keys
// =============================================================================

/**
 * Generate an idempotency key from components
 */
export function generateIdempotencyKey(
  namespace: string,
  ...components: string[]
): string {
  const data = [namespace, ...components].join(':');
  return `idk_${sha256(data).substring(0, 32)}`;
}

/**
 * Generate a step idempotency key
 */
export function generateStepIdempotencyKey(
  planId: string,
  stepId: string,
  version: number
): string {
  return generateIdempotencyKey('step', planId, stepId, version.toString());
}

/**
 * Generate a compensation idempotency key
 */
export function generateCompensationIdempotencyKey(
  workflowId: string,
  stepId: string
): string {
  return generateIdempotencyKey('compensation', workflowId, stepId);
}

// =============================================================================
// Short IDs
// =============================================================================

/**
 * Generate a short nanoid for user-facing references
 */
export function generateShortId(length: number = 12): string {
  return nanoid(length);
}

/**
 * Generate a reference code for approvals
 */
export function generateApprovalCode(): string {
  return `APR-${nanoid(8).toUpperCase()}`;
}

// =============================================================================
// Validation
// =============================================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFIXED_UUID_REGEX = /^[a-z]{3}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Check if a string is a valid UUID
 */
export function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id);
}

/**
 * Check if a string is a valid prefixed ID
 */
export function isValidPrefixedId(id: string): boolean {
  return PREFIXED_UUID_REGEX.test(id);
}

/**
 * Extract the UUID from a prefixed ID
 */
export function extractUuid(prefixedId: string): string | null {
  const match = prefixedId.match(/^[a-z]{3}_(.+)$/);
  return match ? match[1] ?? null : null;
}

/**
 * Get the prefix from a prefixed ID
 */
export function getIdPrefix(prefixedId: string): string | null {
  const match = prefixedId.match(/^([a-z]{3})_/);
  return match ? match[1] ?? null : null;
}
