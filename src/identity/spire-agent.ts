/**
 * SPIRE Agent Integration
 *
 * Wraps the SPIRE Workload API for workload attestation and SVID issuance.
 * The SPIRE Agent performs workload attestation before issuing short-lived SVIDs.
 *
 * Reference: spiffe.io/docs, Red Hat SPIFFE/SPIRE documentation
 */

import { readFileSync, existsSync } from 'fs';
import { Socket } from 'net';
import { logger } from '../core/logger.js';
import type { SVID, SPIFFEId } from './spiffe.js';

export interface SPIREConfig {
  socketPath: string;
  trustDomain: string;
  svidTTL: number; // seconds
  rotationThreshold: number; // rotate at this fraction of TTL (e.g., 0.66)
}

export interface X509SVID {
  spiffeId: string;
  x509Svid: string; // PEM-encoded certificate chain
  x509SvidKey: string; // PEM-encoded private key
  bundle: string; // PEM-encoded trust bundle
  expiresAt: Date;
}

export interface JWTSVID {
  spiffeId: string;
  token: string;
  expiresAt: Date;
}

export class SPIREAgentClient {
  private readonly config: SPIREConfig;
  private currentSVID?: X509SVID;
  private rotationTimer?: NodeJS.Timeout;

  constructor(config?: Partial<SPIREConfig>) {
    this.config = {
      socketPath: config?.socketPath || process.env.SPIRE_SOCKET_PATH || '/run/spire/sockets/agent.sock',
      trustDomain: config?.trustDomain || 'aegis-t2a.local',
      svidTTL: config?.svidTTL || 3600, // 1 hour default
      rotationThreshold: config?.rotationThreshold || 0.66, // rotate at 2/3 of TTL
    };
  }

  /**
   * Fetch X.509-SVID from SPIRE Agent via Workload API
   *
   * In production, this would make a gRPC call to the SPIRE Workload API.
   * For now, this is a stub that demonstrates the flow.
   */
  async fetchX509SVID(): Promise<X509SVID> {
    logger.debug('Fetching X.509-SVID from SPIRE Agent', {
      socketPath: this.config.socketPath,
    });

    // Check if socket exists
    if (!existsSync(this.config.socketPath)) {
      throw new Error(`SPIRE Agent socket not found: ${this.config.socketPath}`);
    }

    // In production, this would:
    // 1. Connect to Unix domain socket
    // 2. Make gRPC WorkloadAPI.FetchX509SVID call
    // 3. SPIRE Agent performs attestation (verifies workload identity)
    // 4. Returns X.509-SVID if attestation succeeds

    // Stub implementation - would be replaced with actual gRPC call
    const svid = await this.mockFetchX509SVID();

    // Cache the SVID
    this.currentSVID = svid;

    // Schedule automatic rotation
    this.scheduleRotation();

    logger.info('X.509-SVID fetched successfully', {
      spiffeId: svid.spiffeId,
      expiresAt: svid.expiresAt.toISOString(),
    });

    return svid;
  }

  /**
   * Fetch JWT-SVID from SPIRE Agent
   *
   * JWT-SVIDs are used for HTTP-based authentication and delegation.
   */
  async fetchJWTSVID(audience: string[], extraClaims?: Record<string, unknown>): Promise<JWTSVID> {
    logger.debug('Fetching JWT-SVID from SPIRE Agent', {
      audience,
      extraClaims,
    });

    if (!existsSync(this.config.socketPath)) {
      throw new Error(`SPIRE Agent socket not found: ${this.config.socketPath}`);
    }

    // In production, this would:
    // 1. Connect to Unix domain socket
    // 2. Make gRPC WorkloadAPI.FetchJWTSVID call
    // 3. Pass audience and any extra claims
    // 4. Returns signed JWT-SVID

    // Stub implementation
    const jwtSvid = await this.mockFetchJWTSVID(audience, extraClaims);

    logger.info('JWT-SVID fetched successfully', {
      spiffeId: jwtSvid.spiffeId,
      audience,
      expiresAt: jwtSvid.expiresAt.toISOString(),
    });

    return jwtSvid;
  }

  /**
   * Validate a JWT-SVID
   */
  async validateJWTSVID(token: string, expectedAudience?: string): Promise<boolean> {
    // In production, this would:
    // 1. Make gRPC WorkloadAPI.ValidateJWTSVID call
    // 2. SPIRE Agent validates signature using trust bundle
    // 3. Checks expiration and audience claims
    // 4. Returns validation result

    logger.debug('Validating JWT-SVID', {
      tokenLength: token.length,
      expectedAudience,
    });

    // Stub - would call SPIRE Agent
    return true;
  }

  /**
   * Get current X.509-SVID (fetches new one if not cached)
   */
  async getX509SVID(): Promise<X509SVID> {
    if (!this.currentSVID || this.shouldRotate(this.currentSVID)) {
      return await this.fetchX509SVID();
    }
    return this.currentSVID;
  }

  /**
   * Get trust bundle for validating peer SVIDs
   */
  async getTrustBundle(): Promise<string> {
    const svid = await this.getX509SVID();
    return svid.bundle;
  }

  /**
   * Schedule automatic SVID rotation
   */
  private scheduleRotation(): void {
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
    }

    if (!this.currentSVID) return;

    const now = Date.now();
    const expiresAt = this.currentSVID.expiresAt.getTime();
    const ttl = expiresAt - now;
    const rotateAt = now + (ttl * this.config.rotationThreshold);
    const delay = rotateAt - now;

    this.rotationTimer = setTimeout(async () => {
      logger.info('Automatic SVID rotation triggered', {
        currentSvidExpiry: this.currentSVID?.expiresAt.toISOString(),
      });

      try {
        await this.fetchX509SVID();
      } catch (error) {
        logger.error('SVID rotation failed', { error });
        // Retry after 1 minute
        setTimeout(() => this.scheduleRotation(), 60000);
      }
    }, delay);

    logger.debug('SVID rotation scheduled', {
      rotateAt: new Date(rotateAt).toISOString(),
      delayMs: delay,
    });
  }

  /**
   * Check if SVID should be rotated
   */
  private shouldRotate(svid: X509SVID): boolean {
    const now = Date.now();
    const expiresAt = svid.expiresAt.getTime();
    const ttl = expiresAt - now;
    const rotationPoint = now + (ttl * (1 - this.config.rotationThreshold));

    return Date.now() >= rotationPoint;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
    }
  }

  /**
   * Mock implementation - would be replaced with actual gRPC call
   */
  private async mockFetchX509SVID(): Promise<X509SVID> {
    // Generate a mock SVID for development/testing
    const spiffeId = `spiffe://${this.config.trustDomain}/workload/aegis-agent`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (this.config.svidTTL * 1000));

    return {
      spiffeId,
      x509Svid: this.generateMockCertificate(spiffeId),
      x509SvidKey: this.generateMockPrivateKey(),
      bundle: this.generateMockTrustBundle(),
      expiresAt,
    };
  }

  /**
   * Mock implementation for JWT-SVID
   */
  private async mockFetchJWTSVID(
    audience: string[],
    extraClaims?: Record<string, unknown>
  ): Promise<JWTSVID> {
    const spiffeId = `spiffe://${this.config.trustDomain}/workload/aegis-agent`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (this.config.svidTTL * 1000));

    // In production, this would be a properly signed JWT
    const payload = {
      sub: spiffeId,
      aud: audience,
      exp: Math.floor(expiresAt.getTime() / 1000),
      iat: Math.floor(now.getTime() / 1000),
      ...extraClaims,
    };

    const token = Buffer.from(JSON.stringify(payload)).toString('base64');

    return {
      spiffeId,
      token: `mock.${token}.signature`,
      expiresAt,
    };
  }

  /**
   * Generate mock certificate for development
   */
  private generateMockCertificate(spiffeId: string): string {
    return `-----BEGIN CERTIFICATE-----
MIICertificate for ${spiffeId}
(Mock certificate - replace with actual SPIRE Agent in production)
-----END CERTIFICATE-----`;
  }

  /**
   * Generate mock private key for development
   */
  private generateMockPrivateKey(): string {
    return `-----BEGIN PRIVATE KEY-----
MockPrivateKey
(Replace with actual SPIRE Agent in production)
-----END PRIVATE KEY-----`;
  }

  /**
   * Generate mock trust bundle for development
   */
  private generateMockTrustBundle(): string {
    return `-----BEGIN CERTIFICATE-----
MockTrustBundleRootCA
(Replace with actual SPIRE Agent in production)
-----END CERTIFICATE-----`;
  }
}

// Singleton instance
let spireClient: SPIREAgentClient;

export function getSPIREClient(config?: Partial<SPIREConfig>): SPIREAgentClient {
  if (!spireClient) {
    spireClient = new SPIREAgentClient(config);
  }
  return spireClient;
}

/**
 * Helper to validate that SPIRE Agent is available
 */
export async function validateSPIREAgentAvailability(socketPath?: string): Promise<boolean> {
  const path = socketPath || process.env.SPIRE_SOCKET_PATH || '/run/spire/sockets/agent.sock';

  if (!existsSync(path)) {
    logger.warn('SPIRE Agent socket not found - running in development mode', {
      expectedPath: path,
    });
    return false;
  }

  logger.info('SPIRE Agent socket found', { path });
  return true;
}
