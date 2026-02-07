/**
 * Signed Delegation Tokens
 *
 * When the Temporal Orchestrator delegates a subtask to an MCP Action Worker,
 * it issues a signed delegation token (JWT-SVID) containing: parent workflow ID,
 * delegated scopes, max TTL, and target resource constraints.
 *
 * Reference: arxiv:2504.14760, SPIFFE JWT-SVID spec
 */

import { createHmac, randomBytes } from 'crypto';
import { logger } from '../core/logger.js';
import type { SPIFFEId } from './spiffe.js';

export interface DelegationToken {
  // Token metadata
  tokenId: string;
  issuedAt: Date;
  expiresAt: Date;

  // Delegation chain
  issuerSpiffeId: string; // Parent agent
  subjectSpiffeId: string; // Child agent receiving delegation
  parentWorkflowId?: string;

  // Delegated permissions
  delegatedScopes: string[];
  maxTTL: number; // Maximum time-to-live in seconds

  // Resource constraints
  allowedResources?: string[]; // Resource patterns this token can access
  deniedResources?: string[];
  allowedActions?: string[]; // Action patterns

  // Additional constraints
  maxDelegationDepth?: number; // How many times can this be re-delegated
  currentDepth: number; // Current depth in delegation chain

  // Signed JWT
  jwt: string;
  signature: string;
}

export interface DelegationClaims {
  // Standard JWT claims
  iss: string; // Issuer SPIFFE ID
  sub: string; // Subject SPIFFE ID
  aud: string[]; // Audience (services that should accept this token)
  exp: number; // Expiration timestamp
  iat: number; // Issued at timestamp
  jti: string; // JWT ID (unique token identifier)

  // Custom AEGIS claims
  workflow_id?: string;
  parent_token_id?: string;
  delegated_scopes: string[];
  max_ttl: number;
  allowed_resources?: string[];
  denied_resources?: string[];
  allowed_actions?: string[];
  delegation_depth: number;
  max_delegation_depth?: number;
}

export class DelegationManager {
  private readonly signingSecret: string;
  private readonly activeTokens: Map<string, DelegationToken>;
  private readonly revokedTokens: Set<string>;

  constructor(signingSecret?: string) {
    this.signingSecret = signingSecret || process.env.DELEGATION_SECRET || this.generateSecret();
    this.activeTokens = new Map();
    this.revokedTokens = new Set();
  }

  /**
   * Issue a delegation token from parent to child agent
   */
  async issueDelegationToken(
    issuerSpiffeId: SPIFFEId,
    subjectSpiffeId: SPIFFEId,
    delegatedScopes: string[],
    ttl: number, // seconds
    options: {
      parentWorkflowId?: string;
      parentTokenId?: string;
      allowedResources?: string[];
      deniedResources?: string[];
      allowedActions?: string[];
      maxDelegationDepth?: number;
      audience?: string[];
    } = {}
  ): Promise<DelegationToken> {
    const now = new Date();
    const tokenId = this.generateTokenId();

    // Calculate current delegation depth
    let currentDepth = 0;
    if (options.parentTokenId) {
      const parentToken = this.activeTokens.get(options.parentTokenId);
      if (parentToken) {
        currentDepth = parentToken.currentDepth + 1;

        // Check if max delegation depth would be exceeded
        if (parentToken.maxDelegationDepth && currentDepth > parentToken.maxDelegationDepth) {
          throw new Error(
            `Delegation depth ${currentDepth} exceeds maximum ${parentToken.maxDelegationDepth}`
          );
        }
      }
    }

    // Create delegation claims
    const claims: DelegationClaims = {
      iss: issuerSpiffeId.toString(),
      sub: subjectSpiffeId.toString(),
      aud: options.audience || ['aegis-t2a'],
      exp: Math.floor((now.getTime() + ttl * 1000) / 1000),
      iat: Math.floor(now.getTime() / 1000),
      jti: tokenId,
      workflow_id: options.parentWorkflowId,
      parent_token_id: options.parentTokenId,
      delegated_scopes: delegatedScopes,
      max_ttl: ttl,
      allowed_resources: options.allowedResources,
      denied_resources: options.deniedResources,
      allowed_actions: options.allowedActions,
      delegation_depth: currentDepth,
      max_delegation_depth: options.maxDelegationDepth,
    };

    // Sign the token
    const jwt = this.createJWT(claims);
    const signature = this.signToken(jwt);

    const token: DelegationToken = {
      tokenId,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + ttl * 1000),
      issuerSpiffeId: issuerSpiffeId.toString(),
      subjectSpiffeId: subjectSpiffeId.toString(),
      parentWorkflowId: options.parentWorkflowId,
      delegatedScopes,
      maxTTL: ttl,
      allowedResources: options.allowedResources,
      deniedResources: options.deniedResources,
      allowedActions: options.allowedActions,
      maxDelegationDepth: options.maxDelegationDepth,
      currentDepth,
      jwt,
      signature,
    };

    // Store active token
    this.activeTokens.set(tokenId, token);

    logger.info('Delegation token issued', {
      tokenId,
      issuer: issuerSpiffeId.toString(),
      subject: subjectSpiffeId.toString(),
      scopes: delegatedScopes,
      ttl,
      depth: currentDepth,
      workflowId: options.parentWorkflowId,
    });

    return token;
  }

  /**
   * Verify and decode a delegation token
   */
  async verifyDelegationToken(
    jwt: string,
    signature: string,
    expectedAudience?: string
  ): Promise<{ valid: boolean; claims?: DelegationClaims; reason?: string }> {
    // Verify signature
    const expectedSignature = this.signToken(jwt);
    if (signature !== expectedSignature) {
      logger.warn('Delegation token signature verification failed');
      return { valid: false, reason: 'Invalid signature' };
    }

    // Decode claims
    const claims = this.decodeJWT(jwt);
    if (!claims) {
      return { valid: false, reason: 'Invalid JWT format' };
    }

    // Check if token is revoked
    if (this.revokedTokens.has(claims.jti)) {
      logger.warn('Delegation token revoked', { tokenId: claims.jti });
      return { valid: false, reason: 'Token revoked' };
    }

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp < now) {
      logger.warn('Delegation token expired', {
        tokenId: claims.jti,
        expiredAt: new Date(claims.exp * 1000).toISOString(),
      });
      return { valid: false, reason: 'Token expired' };
    }

    // Check audience
    if (expectedAudience && !claims.aud.includes(expectedAudience)) {
      logger.warn('Delegation token audience mismatch', {
        tokenId: claims.jti,
        expected: expectedAudience,
        actual: claims.aud,
      });
      return { valid: false, reason: 'Audience mismatch' };
    }

    logger.debug('Delegation token verified', {
      tokenId: claims.jti,
      subject: claims.sub,
      scopes: claims.delegated_scopes,
    });

    return { valid: true, claims };
  }

  /**
   * Revoke a delegation token
   */
  revokeToken(tokenId: string, reason: string): boolean {
    const token = this.activeTokens.get(tokenId);
    if (!token) {
      return false;
    }

    this.revokedTokens.add(tokenId);
    this.activeTokens.delete(tokenId);

    logger.warn('Delegation token revoked', {
      tokenId,
      reason,
      subject: token.subjectSpiffeId,
      issuer: token.issuerSpiffeId,
    });

    return true;
  }

  /**
   * Revoke all tokens for a specific agent
   */
  revokeAllTokensForAgent(spiffeId: string, reason: string): number {
    let count = 0;

    for (const [tokenId, token] of this.activeTokens.entries()) {
      if (token.subjectSpiffeId === spiffeId || token.issuerSpiffeId === spiffeId) {
        this.revokeToken(tokenId, reason);
        count++;
      }
    }

    logger.info('All tokens revoked for agent', {
      spiffeId,
      count,
      reason,
    });

    return count;
  }

  /**
   * Revoke all tokens in a workflow chain
   */
  revokeWorkflowTokens(workflowId: string, reason: string): number {
    let count = 0;

    for (const [tokenId, token] of this.activeTokens.entries()) {
      if (token.parentWorkflowId === workflowId) {
        this.revokeToken(tokenId, reason);
        count++;
      }
    }

    logger.info('All workflow tokens revoked', {
      workflowId,
      count,
      reason,
    });

    return count;
  }

  /**
   * Get token information
   */
  getToken(tokenId: string): DelegationToken | undefined {
    return this.activeTokens.get(tokenId);
  }

  /**
   * Cleanup expired tokens
   */
  cleanupExpiredTokens(): number {
    const now = new Date();
    let count = 0;

    for (const [tokenId, token] of this.activeTokens.entries()) {
      if (token.expiresAt < now) {
        this.activeTokens.delete(tokenId);
        count++;
      }
    }

    if (count > 0) {
      logger.info('Expired tokens cleaned up', { count });
    }

    return count;
  }

  /**
   * Create JWT from claims
   */
  private createJWT(claims: DelegationClaims): string {
    const header = {
      alg: 'HS256',
      typ: 'JWT',
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');

    return `${encodedHeader}.${encodedPayload}`;
  }

  /**
   * Decode JWT to claims
   */
  private decodeJWT(jwt: string): DelegationClaims | null {
    try {
      const parts = jwt.split('.');
      if (parts.length !== 2) return null;

      const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
      return JSON.parse(payload) as DelegationClaims;
    } catch (error) {
      logger.error('Failed to decode JWT', { error });
      return null;
    }
  }

  /**
   * Sign token with HMAC-SHA256
   */
  private signToken(jwt: string): string {
    const hmac = createHmac('sha256', this.signingSecret);
    hmac.update(jwt);
    return hmac.digest('base64url');
  }

  /**
   * Generate unique token ID
   */
  private generateTokenId(): string {
    return randomBytes(16).toString('hex');
  }

  /**
   * Generate signing secret
   */
  private generateSecret(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Get delegation statistics
   */
  getStats(): {
    activeTokens: number;
    revokedTokens: number;
    tokensByDepth: Record<number, number>;
    tokensByIssuer: Record<string, number>;
    timestamp: string;
  } {
    const tokens = Array.from(this.activeTokens.values());

    const byDepth: Record<number, number> = {};
    const byIssuer: Record<string, number> = {};

    tokens.forEach(token => {
      byDepth[token.currentDepth] = (byDepth[token.currentDepth] || 0) + 1;
      byIssuer[token.issuerSpiffeId] = (byIssuer[token.issuerSpiffeId] || 0) + 1;
    });

    return {
      activeTokens: tokens.length,
      revokedTokens: this.revokedTokens.size,
      tokensByDepth: byDepth,
      tokensByIssuer: byIssuer,
      timestamp: new Date().toISOString(),
    };
  }
}

// Singleton instance
let delegationManager: DelegationManager;

export function getDelegationManager(signingSecret?: string): DelegationManager {
  if (!delegationManager) {
    delegationManager = new DelegationManager(signingSecret);
  }
  return delegationManager;
}

/**
 * Middleware to validate delegation token in requests
 */
export async function validateDelegationMiddleware(
  authHeader: string | undefined
): Promise<{ authorized: boolean; claims?: DelegationClaims; error?: string }> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { authorized: false, error: 'Missing or invalid authorization header' };
  }

  const token = authHeader.substring(7);
  const parts = token.split('.');

  if (parts.length !== 3) {
    return { authorized: false, error: 'Invalid token format' };
  }

  const jwt = `${parts[0]}.${parts[1]}`;
  const signature = parts[2];

  const manager = getDelegationManager();
  const result = await manager.verifyDelegationToken(jwt, signature);

  if (!result.valid) {
    return { authorized: false, error: result.reason };
  }

  return { authorized: true, claims: result.claims };
}
