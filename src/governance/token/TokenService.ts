/**
 * AEGIS-T2A Token Service
 *
 * Provides JWT-based token management for agent authentication.
 * Issues short-lived tokens with identity claims, supports rotation,
 * and maintains a revocation list for security.
 */

import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { EventEmitter } from 'events';
import {
  AgentIdentity,
  AgentRole,
  TokenRequest,
  TokenResponse,
  TokenMetadata,
  TokenServiceConfig,
  TokenError,
} from '../types';

/**
 * Token validation result
 */
export interface TokenValidationResult {
  valid: boolean;
  identity?: AgentIdentity;
  error?: string;
  error_code?: string;
}

/**
 * Refresh token payload
 */
interface RefreshTokenPayload {
  jti: string;
  agent_id: string;
  tenant_id: string;
  type: 'refresh';
  iat: number;
  exp: number;
}

/**
 * Token Service for agent identity management
 */
export class TokenService extends EventEmitter {
  private privateKey: string;
  private publicKey: string;
  private config: TokenServiceConfig;
  private revokedTokens: Map<string, { revokedAt: Date; reason: string }> = new Map();
  private tokenMetadata: Map<string, TokenMetadata> = new Map();
  private refreshTokens: Map<string, { agentId: string; expiresAt: Date }> = new Map();

  constructor(config: TokenServiceConfig, privateKey: string, publicKey: string) {
    super();
    this.config = config;
    this.privateKey = privateKey;
    this.publicKey = publicKey;

    // Clean up expired tokens periodically
    setInterval(() => this.cleanupExpiredTokens(), 60000);
  }

  /**
   * Create a new TokenService with generated keys (for development)
   */
  static async createWithGeneratedKeys(
    config: Omit<TokenServiceConfig, 'private_key_path' | 'public_key_path'>
  ): Promise<TokenService> {
    const { privateKey, publicKey } = await this.generateKeyPair(config.algorithm);
    return new TokenService(
      { ...config, private_key_path: '', public_key_path: '' } as TokenServiceConfig,
      privateKey,
      publicKey
    );
  }

  /**
   * Generate RSA or EC key pair
   */
  static async generateKeyPair(
    algorithm: TokenServiceConfig['algorithm']
  ): Promise<{ privateKey: string; publicKey: string }> {
    return new Promise((resolve, reject) => {
      const keyType = algorithm.startsWith('RS') ? 'rsa' : 'ec';
      const options: crypto.RSAKeyPairOptions<'pem', 'pem'> | crypto.ECKeyPairOptions<'pem', 'pem'> =
        keyType === 'rsa'
          ? {
              modulusLength: 2048,
              publicKeyEncoding: { type: 'spki', format: 'pem' },
              privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            }
          : {
              namedCurve: algorithm === 'ES256' ? 'P-256' : algorithm === 'ES384' ? 'P-384' : 'P-521',
              publicKeyEncoding: { type: 'spki', format: 'pem' },
              privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            };

      crypto.generateKeyPair(
        keyType as 'rsa',
        options as crypto.RSAKeyPairOptions<'pem', 'pem'>,
        (err, publicKey, privateKey) => {
          if (err) reject(err);
          else resolve({ privateKey, publicKey });
        }
      );
    });
  }

  /**
   * Issue a new token for an agent
   */
  async issueToken(request: TokenRequest): Promise<TokenResponse> {
    const jti = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const ttl = request.ttl_seconds || this.config.token_ttl_seconds;
    const exp = now + ttl;

    // Build identity claims
    const identity: AgentIdentity = {
      agent_id: request.agent_id,
      tenant_id: request.tenant_id,
      role: request.role,
      scopes: request.scopes,
      iat: now,
      exp,
      jti,
      session_id: request.session_id,
    };

    // Sign the token
    const accessToken = jwt.sign(identity, this.privateKey, {
      algorithm: this.config.algorithm,
      issuer: this.config.issuer,
      audience: this.config.audience,
    });

    // Store token metadata
    const metadata: TokenMetadata = {
      jti,
      agent_id: request.agent_id,
      tenant_id: request.tenant_id,
      issued_at: new Date(now * 1000),
      expires_at: new Date(exp * 1000),
      revoked: false,
    };
    this.tokenMetadata.set(jti, metadata);

    // Generate refresh token
    const refreshJti = crypto.randomUUID();
    const refreshExp = now + this.config.refresh_ttl_seconds;
    const refreshPayload: RefreshTokenPayload = {
      jti: refreshJti,
      agent_id: request.agent_id,
      tenant_id: request.tenant_id,
      type: 'refresh',
      iat: now,
      exp: refreshExp,
    };

    const refreshToken = jwt.sign(refreshPayload, this.privateKey, {
      algorithm: this.config.algorithm,
      issuer: this.config.issuer,
      audience: this.config.audience,
    });

    this.refreshTokens.set(refreshJti, {
      agentId: request.agent_id,
      expiresAt: new Date(refreshExp * 1000),
    });

    // Emit event
    this.emit('token_issued', {
      jti,
      agent_id: request.agent_id,
      tenant_id: request.tenant_id,
      expires_at: metadata.expires_at,
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ttl,
      refresh_token: refreshToken,
      scope: request.scopes.join(' '),
    };
  }

  /**
   * Validate a token and extract identity
   */
  async validateToken(token: string): Promise<TokenValidationResult> {
    try {
      // Verify JWT signature and claims
      const decoded = jwt.verify(token, this.publicKey, {
        algorithms: [this.config.algorithm],
        issuer: this.config.issuer,
        audience: this.config.audience,
      }) as AgentIdentity;

      // Check if token is revoked
      if (this.revokedTokens.has(decoded.jti)) {
        const revocation = this.revokedTokens.get(decoded.jti)!;
        return {
          valid: false,
          error: `Token revoked: ${revocation.reason}`,
          error_code: 'TOKEN_REVOKED',
        };
      }

      // Validate identity fields
      if (!decoded.agent_id || !decoded.tenant_id || !decoded.role) {
        return {
          valid: false,
          error: 'Invalid token claims',
          error_code: 'INVALID_CLAIMS',
        };
      }

      // Validate role
      const validRoles: AgentRole[] = [
        'system_admin',
        'tenant_admin',
        'operator',
        'developer',
        'readonly',
        'restricted',
      ];
      if (!validRoles.includes(decoded.role)) {
        return {
          valid: false,
          error: 'Invalid role claim',
          error_code: 'INVALID_ROLE',
        };
      }

      // Emit validation event
      this.emit('token_validated', {
        jti: decoded.jti,
        agent_id: decoded.agent_id,
        tenant_id: decoded.tenant_id,
      });

      return {
        valid: true,
        identity: decoded,
      };
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        return {
          valid: false,
          error: 'Token expired',
          error_code: 'TOKEN_EXPIRED',
        };
      }
      if (error instanceof jwt.JsonWebTokenError) {
        return {
          valid: false,
          error: `Invalid token: ${error.message}`,
          error_code: 'INVALID_TOKEN',
        };
      }
      return {
        valid: false,
        error: 'Token validation failed',
        error_code: 'VALIDATION_FAILED',
      };
    }
  }

  /**
   * Refresh an access token using a refresh token
   */
  async refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
    try {
      const decoded = jwt.verify(refreshToken, this.publicKey, {
        algorithms: [this.config.algorithm],
        issuer: this.config.issuer,
        audience: this.config.audience,
      }) as RefreshTokenPayload;

      if (decoded.type !== 'refresh') {
        throw new TokenError('Invalid refresh token type', 'INVALID_TOKEN_TYPE');
      }

      // Check if refresh token is still valid
      const stored = this.refreshTokens.get(decoded.jti);
      if (!stored || stored.expiresAt < new Date()) {
        throw new TokenError('Refresh token expired or invalid', 'REFRESH_EXPIRED');
      }

      // Find the original token metadata to get role and scopes
      let originalMetadata: TokenMetadata | undefined;
      for (const [_, metadata] of this.tokenMetadata) {
        if (metadata.agent_id === decoded.agent_id && !metadata.revoked) {
          originalMetadata = metadata;
          break;
        }
      }

      // Issue new token with same claims
      // In production, you'd look up the agent's current role/scopes from a database
      return this.issueToken({
        agent_id: decoded.agent_id,
        tenant_id: decoded.tenant_id,
        role: 'operator', // Would be looked up in production
        scopes: ['*'], // Would be looked up in production
      });
    } catch (error) {
      if (error instanceof TokenError) throw error;
      throw new TokenError('Refresh token validation failed', 'REFRESH_FAILED');
    }
  }

  /**
   * Revoke a token
   */
  async revokeToken(jti: string, reason: string): Promise<void> {
    this.revokedTokens.set(jti, {
      revokedAt: new Date(),
      reason,
    });

    const metadata = this.tokenMetadata.get(jti);
    if (metadata) {
      metadata.revoked = true;
      metadata.revoked_at = new Date();
      metadata.revoked_reason = reason;
    }

    this.emit('token_revoked', { jti, reason });
  }

  /**
   * Revoke all tokens for an agent
   */
  async revokeAllAgentTokens(agentId: string, reason: string): Promise<number> {
    let count = 0;
    for (const [jti, metadata] of this.tokenMetadata) {
      if (metadata.agent_id === agentId && !metadata.revoked) {
        await this.revokeToken(jti, reason);
        count++;
      }
    }
    return count;
  }

  /**
   * Revoke all tokens for a tenant
   */
  async revokeAllTenantTokens(tenantId: string, reason: string): Promise<number> {
    let count = 0;
    for (const [jti, metadata] of this.tokenMetadata) {
      if (metadata.tenant_id === tenantId && !metadata.revoked) {
        await this.revokeToken(jti, reason);
        count++;
      }
    }
    return count;
  }

  /**
   * Check if a token is revoked
   */
  isRevoked(jti: string): boolean {
    return this.revokedTokens.has(jti);
  }

  /**
   * Get token metadata
   */
  getTokenMetadata(jti: string): TokenMetadata | undefined {
    return this.tokenMetadata.get(jti);
  }

  /**
   * List active tokens for an agent
   */
  listAgentTokens(agentId: string): TokenMetadata[] {
    const tokens: TokenMetadata[] = [];
    const now = new Date();
    for (const metadata of this.tokenMetadata.values()) {
      if (
        metadata.agent_id === agentId &&
        !metadata.revoked &&
        metadata.expires_at > now
      ) {
        tokens.push(metadata);
      }
    }
    return tokens;
  }

  /**
   * Get the public key for token verification
   */
  getPublicKey(): string {
    return this.publicKey;
  }

  /**
   * Get JWKS (JSON Web Key Set) for key distribution
   */
  async getJWKS(): Promise<{ keys: object[] }> {
    const keyObject = crypto.createPublicKey(this.publicKey);
    const jwk = keyObject.export({ format: 'jwk' });
    return {
      keys: [
        {
          ...jwk,
          kid: crypto.createHash('sha256').update(this.publicKey).digest('hex').substring(0, 8),
          use: 'sig',
          alg: this.config.algorithm,
        },
      ],
    };
  }

  /**
   * Clean up expired tokens from memory
   */
  private cleanupExpiredTokens(): void {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000); // Keep revoked for 24h

    // Clean up token metadata
    for (const [jti, metadata] of this.tokenMetadata) {
      if (metadata.expires_at < cutoff) {
        this.tokenMetadata.delete(jti);
        this.revokedTokens.delete(jti);
      }
    }

    // Clean up refresh tokens
    for (const [jti, data] of this.refreshTokens) {
      if (data.expiresAt < now) {
        this.refreshTokens.delete(jti);
      }
    }
  }

  /**
   * Get service statistics
   */
  getStats(): {
    activeTokens: number;
    revokedTokens: number;
    refreshTokens: number;
  } {
    const now = new Date();
    let activeTokens = 0;
    for (const metadata of this.tokenMetadata.values()) {
      if (!metadata.revoked && metadata.expires_at > now) {
        activeTokens++;
      }
    }
    return {
      activeTokens,
      revokedTokens: this.revokedTokens.size,
      refreshTokens: this.refreshTokens.size,
    };
  }
}

/**
 * Create token service from configuration
 */
export async function createTokenService(
  config: TokenServiceConfig
): Promise<TokenService> {
  const fs = await import('fs/promises');

  let privateKey: string;
  let publicKey: string;

  if (config.private_key_path && config.public_key_path) {
    privateKey = await fs.readFile(config.private_key_path, 'utf-8');
    publicKey = await fs.readFile(config.public_key_path, 'utf-8');
  } else {
    // Generate keys if not provided
    const keys = await TokenService.generateKeyPair(config.algorithm);
    privateKey = keys.privateKey;
    publicKey = keys.publicKey;
  }

  return new TokenService(config, privateKey, publicKey);
}

export default TokenService;
