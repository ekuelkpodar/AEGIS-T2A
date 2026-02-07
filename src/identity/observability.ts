/**
 * Identity Observability Integration
 * 
 * Adds SPIFFE IDs to all metrics and traces for complete attribution.
 * Critical for incident response and security auditing.
 * 
 * References:
 * - SPIRE Telemetry
 * - OpenTelemetry Context Propagation
 */

import { SPIFFEId } from './spiffe.js';
import { logger } from '../core/logger.js';

export interface IdentityContext {
  spiffeId: SPIFFEId;
  namespace: string;
  agentType: string;
  sessionId?: string;
}

/**
 * Add SPIFFE ID to log context
 */
export function enrichLogContext(
  spiffeId: SPIFFEId,
  additionalContext?: Record<string, unknown>
): Record<string, unknown> {
  return {
    spiffe_id: spiffeId.toString(),
    spiffe_namespace: spiffeId.namespace,
    spiffe_agent_type: spiffeId.agentType,
    spiffe_trust_domain: spiffeId.trustDomain,
    ...additionalContext
  };
}

/**
 * Add SPIFFE ID to metrics labels
 */
export function getMetricsLabels(spiffeId: SPIFFEId): Record<string, string> {
  return {
    spiffe_id: spiffeId.toString(),
    spiffe_namespace: spiffeId.namespace,
    spiffe_agent_type: spiffeId.agentType,
    spiffe_trust_domain: spiffeId.trustDomain
  };
}

/**
 * Add SPIFFE ID to trace span attributes
 */
export function getTraceAttributes(spiffeId: SPIFFEId): Record<string, string> {
  return {
    'spiffe.id': spiffeId.toString(),
    'spiffe.namespace': spiffeId.namespace,
    'spiffe.agent_type': spiffeId.agentType,
    'spiffe.trust_domain': spiffeId.trustDomain
  };
}

/**
 * Identity-aware logger wrapper
 */
export class IdentityLogger {
  constructor(private spiffeId: SPIFFEId) {}

  info(message: string, context?: Record<string, unknown>): void {
    logger.info(message, enrichLogContext(this.spiffeId, context));
  }

  warn(message: string, context?: Record<string, unknown>): void {
    logger.warn(message, enrichLogContext(this.spiffeId, context));
  }

  error(message: string, context?: Record<string, unknown>): void {
    logger.error(message, enrichLogContext(this.spiffeId, context));
  }

  debug(message: string, context?: Record<string, unknown>): void {
    logger.debug(message, enrichLogContext(this.spiffeId, context));
  }
}

/**
 * Create identity-aware logger
 */
export function createIdentityLogger(spiffeId: SPIFFEId): IdentityLogger {
  return new IdentityLogger(spiffeId);
}
