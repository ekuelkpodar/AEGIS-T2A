/**
 * SPIFFE Identity System
 *
 * Implements SPIFFE (Secure Production Identity Framework For Everyone) IDs
 * for cryptographic workload identity. Every agent, service, and workflow
 * gets a unique SPIFFE ID before execution.
 *
 * Format: spiffe://aegis-t2a.local/ns/{namespace}/agent/{type}/{id}
 *
 * References:
 * - SPIFFE Specification: https://github.com/spiffe/spiffe/blob/main/standards/SPIFFE.md
 * - arxiv:2504.14760 (Non-Human Identity Management)
 * - Aembit.io (Workload IAM)
 */

import { createHash, randomUUID } from 'crypto';
import { logger } from '../core/logger.js';

export interface SPIFFEId {
  trustDomain: string;
  namespace: string;
  agentType: 'user' | 'agent' | 'system' | 'workflow' | 'service';
  agentId: string;
  path: string;
  toString(): string;
}

export interface SPIFFEIdOptions {
  namespace?: string;
  agentType: 'user' | 'agent' | 'system' | 'workflow' | 'service';
  agentId?: string;
  customPath?: string;
}

export interface SPIFFEConfig {
  trustDomain: string;
  defaultNamespace: string;
  allowWildcards: boolean;
  validateOnCreate: boolean;
}

/**
 * SVID (SPIFFE Verifiable Identity Document)
 * Base type for X.509-SVID and JWT-SVID
 */
export interface SVID {
  spiffeId: string;
  expiresAt: Date;
}

const DEFAULT_CONFIG: SPIFFEConfig = {
  trustDomain: process.env.SPIFFE_TRUST_DOMAIN || 'aegis-t2a.local',
  defaultNamespace: process.env.SPIFFE_DEFAULT_NAMESPACE || 'default',
  allowWildcards: false,
  validateOnCreate: true,
};

class SPIFFEIdImpl implements SPIFFEId {
  constructor(
    public readonly trustDomain: string,
    public readonly namespace: string,
    public readonly agentType: 'user' | 'agent' | 'system' | 'workflow' | 'service',
    public readonly agentId: string,
    public readonly path: string
  ) {}

  toString(): string {
    return `spiffe://${this.trustDomain}${this.path}`;
  }

  hash(): string {
    return createHash('sha256').update(this.toString()).digest('hex');
  }

  matches(pattern: string): boolean {
    const patternRegex = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${patternRegex}$`).test(this.toString());
  }

  isChildOf(parent: SPIFFEId): boolean {
    if (this.trustDomain !== parent.trustDomain) {
      return false;
    }
    return this.path.startsWith(parent.path + '/');
  }

  getParent(): SPIFFEId | null {
    const parts = this.path.split('/').filter(p => p);
    if (parts.length <= 2) {
      return null;
    }
    const parentPath = '/' + parts.slice(0, -1).join('/');
    return parseSPIFFEId(`spiffe://${this.trustDomain}${parentPath}`);
  }
}

export function createSPIFFEId(
  options: SPIFFEIdOptions,
  config: Partial<SPIFFEConfig> = {}
): SPIFFEId {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const namespace = options.namespace || cfg.defaultNamespace;
  const agentId = options.agentId || randomUUID();
  let path: string;
  if (options.customPath) {
    path = options.customPath.startsWith('/') ? options.customPath : `/${options.customPath}`;
  } else {
    path = `/ns/${namespace}/agent/${options.agentType}/${agentId}`;
  }
  if (cfg.validateOnCreate) {
    validateSPIFFEPath(path, cfg);
  }
  const spiffeId = new SPIFFEIdImpl(cfg.trustDomain, namespace, options.agentType, agentId, path);
  logger.debug('Created SPIFFE ID', {
    spiffeId: spiffeId.toString(),
    namespace,
    agentType: options.agentType,
    agentId,
  });
  return spiffeId;
}

export function parseSPIFFEId(spiffeIdString: string): SPIFFEId {
  const match = spiffeIdString.match(/^spiffe:\/\/([^/]+)(\/.*)?$/);
  if (!match) {
    throw new Error(`Invalid SPIFFE ID format: ${spiffeIdString}`);
  }
  const trustDomain = match[1];
  const path = match[2] || '/';
  const pathMatch = path.match(/^\/ns\/([^/]+)\/agent\/([^/]+)\/([^/]+)$/);
  let namespace: string;
  let agentType: 'user' | 'agent' | 'system' | 'workflow' | 'service';
  let agentId: string;
  if (pathMatch) {
    namespace = pathMatch[1];
    agentType = pathMatch[2] as typeof agentType;
    agentId = pathMatch[3];
  } else {
    namespace = 'unknown';
    agentType = 'system';
    agentId = createHash('sha256').update(path).digest('hex').substring(0, 16);
  }
  return new SPIFFEIdImpl(trustDomain, namespace, agentType, agentId, path);
}

function validateSPIFFEPath(path: string, config: SPIFFEConfig): void {
  if (!path.startsWith('/')) {
    throw new Error(`SPIFFE path must start with /: ${path}`);
  }
  if (!/^[a-zA-Z0-9/_-]+$/.test(path)) {
    throw new Error(`SPIFFE path contains invalid characters: ${path}`);
  }
  if (!config.allowWildcards && (path.includes('*') || path.includes('?'))) {
    throw new Error(`Wildcards not allowed in SPIFFE path: ${path}`);
  }
  if (path.length > 1 && path.endsWith('/')) {
    throw new Error(`SPIFFE path must not end with /: ${path}`);
  }
  if (path.includes('//')) {
    throw new Error(`SPIFFE path contains empty segments: ${path}`);
  }
}

export function createWorkflowSPIFFEId(workflowId: string, namespace?: string): SPIFFEId {
  return createSPIFFEId({ namespace, agentType: 'workflow', agentId: workflowId });
}

export function createUserSPIFFEId(userId: string, namespace?: string): SPIFFEId {
  return createSPIFFEId({ namespace, agentType: 'user', agentId: userId });
}

export function createAgentSPIFFEId(agentId: string, namespace?: string): SPIFFEId {
  return createSPIFFEId({ namespace, agentType: 'agent', agentId });
}

export function createSystemSPIFFEId(componentName: string, namespace?: string): SPIFFEId {
  return createSPIFFEId({ namespace, agentType: 'system', agentId: componentName });
}

export function createServiceSPIFFEId(serviceName: string, namespace?: string): SPIFFEId {
  return createSPIFFEId({ namespace, agentType: 'service', agentId: serviceName });
}

export function sameTrustDomain(id1: SPIFFEId, id2: SPIFFEId): boolean {
  return id1.trustDomain === id2.trustDomain;
}

export function isValidSPIFFEId(spiffeIdString: string): boolean {
  try {
    parseSPIFFEId(spiffeIdString);
    return true;
  } catch {
    return false;
  }
}

export function createSPIFFEIdFromContext(context: {
  id: string;
  type?: 'user' | 'agent' | 'system' | 'workflow' | 'service';
  namespace?: string;
  workflowId?: string;
  userId?: string;
  agentId?: string;
}): SPIFFEId {
  let agentType: typeof context.type = context.type || 'system';
  let agentId = context.id;
  if (!context.type) {
    if (context.workflowId) {
      agentType = 'workflow';
      agentId = context.workflowId;
    } else if (context.userId) {
      agentType = 'user';
      agentId = context.userId;
    } else if (context.agentId) {
      agentType = 'agent';
      agentId = context.agentId;
    }
  }
  return createSPIFFEId({ namespace: context.namespace, agentType, agentId });
}
