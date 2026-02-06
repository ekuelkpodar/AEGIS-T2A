/**
 * Trust Domain Federation
 *
 * Enables AEGIS-T2A instances in different trust domains to verify each other's
 * agent identities. Supports multi-org deployments where Company A's agents need
 * to safely interact with Company B's infrastructure.
 *
 * Reference: SPIFFE federation spec, Istio SPIRE integration
 */

import { createHash } from 'crypto';
import { logger } from '../core/logger.js';
import type { SPIFFEId } from './spiffe.js';

export interface TrustDomain {
  name: string; // e.g., "company-a.aegis.local"
  description?: string;
  trustBundle: TrustBundle;
  federatedWith: Set<string>; // Names of federated trust domains
  createdAt: Date;
  updatedAt?: Date;
}

export interface TrustBundle {
  trustDomain: string;
  refreshHint: number; // Seconds hint for refresh interval
  sequenceNumber: number; // Increments with each update
  rootCAs: RootCA[];
  jwtAuthorities?: JWTAuthority[];
  hash: string; // SHA-256 hash of the bundle for integrity
}

export interface RootCA {
  certificate: string; // PEM-encoded X.509 certificate
  notBefore: Date;
  notAfter: Date;
  serialNumber: string;
  subjectKeyId?: string;
}

export interface JWTAuthority {
  keyId: string;
  publicKey: string; // PEM-encoded public key or JWK
  expiresAt?: Date;
}

export interface FederationRelationship {
  localTrustDomain: string;
  remoteTrustDomain: string;
  trustBundleEndpoint?: string; // HTTPS endpoint for fetching remote bundle
  allowedSPIFFEPatterns?: string[]; // Restrict which remote SPIFFEIDs are accepted
  createdAt: Date;
  lastSync?: Date;
  autoSync: boolean; // Automatically sync trust bundles
  syncInterval: number; // Seconds between syncs
}

export class TrustDomainFederationManager {
  private readonly localTrustDomain: TrustDomain;
  private readonly federatedDomains: Map<string, TrustDomain>;
  private readonly relationships: Map<string, FederationRelationship>;
  private syncIntervals: Map<string, NodeJS.Timeout>;

  constructor(localTrustDomainName: string, localTrustBundle: TrustBundle) {
    this.localTrustDomain = {
      name: localTrustDomainName,
      trustBundle: localTrustBundle,
      federatedWith: new Set(),
      createdAt: new Date(),
    };

    this.federatedDomains = new Map();
    this.relationships = new Map();
    this.syncIntervals = new Map();

    logger.info('Trust domain federation manager initialized', {
      localTrustDomain: localTrustDomainName,
    });
  }

  /**
   * Federate with another trust domain
   */
  async federateWith(
    remoteTrustDomain: string,
    remoteTrustBundle: TrustBundle,
    options: {
      trustBundleEndpoint?: string;
      allowedSPIFFEPatterns?: string[];
      autoSync?: boolean;
      syncInterval?: number;
    } = {}
  ): Promise<void> {
    // Validate trust bundle hash
    const calculatedHash = this.calculateBundleHash(remoteTrustBundle);
    if (calculatedHash !== remoteTrustBundle.hash) {
      throw new Error(
        `Trust bundle hash mismatch for ${remoteTrustDomain}: expected ${remoteTrustBundle.hash}, got ${calculatedHash}`
      );
    }

    // Store remote trust domain
    const domain: TrustDomain = {
      name: remoteTrustDomain,
      trustBundle: remoteTrustBundle,
      federatedWith: new Set([this.localTrustDomain.name]),
      createdAt: new Date(),
    };

    this.federatedDomains.set(remoteTrustDomain, domain);
    this.localTrustDomain.federatedWith.add(remoteTrustDomain);

    // Create federation relationship
    const relationship: FederationRelationship = {
      localTrustDomain: this.localTrustDomain.name,
      remoteTrustDomain,
      trustBundleEndpoint: options.trustBundleEndpoint,
      allowedSPIFFEPatterns: options.allowedSPIFFEPatterns,
      createdAt: new Date(),
      autoSync: options.autoSync ?? true,
      syncInterval: options.syncInterval ?? 3600, // Default 1 hour
    };

    this.relationships.set(remoteTrustDomain, relationship);

    // Start auto-sync if enabled
    if (relationship.autoSync && relationship.trustBundleEndpoint) {
      this.startAutoSync(remoteTrustDomain);
    }

    logger.info('Federation established', {
      localTrustDomain: this.localTrustDomain.name,
      remoteTrustDomain,
      autoSync: relationship.autoSync,
      allowedPatterns: options.allowedSPIFFEPatterns,
    });
  }

  /**
   * Verify a SPIFFE ID from a federated trust domain
   */
  async verifyFederatedIdentity(
    spiffeId: SPIFFEId,
    certificate: string
  ): Promise<{ valid: boolean; reason?: string }> {
    const trustDomain = spiffeId.trustDomain;

    // Check if trust domain is federated
    if (trustDomain === this.localTrustDomain.name) {
      // Local identity - verify with local trust bundle
      return this.verifyAgainstBundle(certificate, this.localTrustDomain.trustBundle);
    }

    const federatedDomain = this.federatedDomains.get(trustDomain);
    if (!federatedDomain) {
      logger.warn('Identity from non-federated trust domain', {
        spiffeId: spiffeId.fullId,
        trustDomain,
      });
      return {
        valid: false,
        reason: `Trust domain ${trustDomain} is not federated`,
      };
    }

    // Check if SPIFFE ID matches allowed patterns
    const relationship = this.relationships.get(trustDomain);
    if (relationship?.allowedSPIFFEPatterns) {
      const allowed = relationship.allowedSPIFFEPatterns.some(pattern =>
        this.matchesPattern(spiffeId.fullId, pattern)
      );

      if (!allowed) {
        logger.warn('SPIFFE ID not in allowed patterns', {
          spiffeId: spiffeId.fullId,
          allowedPatterns: relationship.allowedSPIFFEPatterns,
        });
        return {
          valid: false,
          reason: 'SPIFFE ID not in allowed patterns',
        };
      }
    }

    // Verify certificate against federated trust bundle
    const result = await this.verifyAgainstBundle(certificate, federatedDomain.trustBundle);

    if (result.valid) {
      logger.info('Federated identity verified', {
        spiffeId: spiffeId.fullId,
        trustDomain,
      });
    }

    return result;
  }

  /**
   * Sync trust bundle from remote endpoint
   */
  async syncTrustBundle(trustDomain: string): Promise<boolean> {
    const relationship = this.relationships.get(trustDomain);
    if (!relationship?.trustBundleEndpoint) {
      logger.warn('No trust bundle endpoint configured', { trustDomain });
      return false;
    }

    try {
      // Fetch remote trust bundle
      logger.debug('Fetching remote trust bundle', {
        trustDomain,
        endpoint: relationship.trustBundleEndpoint,
      });

      // In production, this would make an HTTPS request to the endpoint
      // For now, this is a stub
      logger.warn('Trust bundle sync not yet fully implemented');

      relationship.lastSync = new Date();
      return true;
    } catch (error) {
      logger.error('Failed to sync trust bundle', {
        trustDomain,
        error,
      });
      return false;
    }
  }

  /**
   * Unfederate from a trust domain
   */
  unfederate(trustDomain: string): boolean {
    const domain = this.federatedDomains.get(trustDomain);
    if (!domain) {
      return false;
    }

    // Stop auto-sync
    this.stopAutoSync(trustDomain);

    // Remove federation
    this.federatedDomains.delete(trustDomain);
    this.relationships.delete(trustDomain);
    this.localTrustDomain.federatedWith.delete(trustDomain);

    logger.info('Federation removed', {
      localTrustDomain: this.localTrustDomain.name,
      remoteTrustDomain: trustDomain,
    });

    return true;
  }

  /**
   * Get local trust bundle for sharing with others
   */
  getLocalTrustBundle(): TrustBundle {
    return { ...this.localTrustDomain.trustBundle };
  }

  /**
   * Update local trust bundle
   */
  updateLocalTrustBundle(trustBundle: TrustBundle): void {
    // Validate hash
    const calculatedHash = this.calculateBundleHash(trustBundle);
    if (calculatedHash !== trustBundle.hash) {
      throw new Error('Trust bundle hash mismatch');
    }

    this.localTrustDomain.trustBundle = trustBundle;
    this.localTrustDomain.updatedAt = new Date();

    logger.info('Local trust bundle updated', {
      trustDomain: this.localTrustDomain.name,
      sequenceNumber: trustBundle.sequenceNumber,
    });
  }

  /**
   * List all federated trust domains
   */
  listFederatedDomains(): string[] {
    return Array.from(this.federatedDomains.keys());
  }

  /**
   * Get federation statistics
   */
  getStats(): {
    localTrustDomain: string;
    federatedDomains: number;
    relationships: Array<{
      domain: string;
      autoSync: boolean;
      lastSync?: string;
      allowedPatterns?: string[];
    }>;
    timestamp: string;
  } {
    const relationships = Array.from(this.relationships.entries()).map(
      ([domain, rel]) => ({
        domain,
        autoSync: rel.autoSync,
        lastSync: rel.lastSync?.toISOString(),
        allowedPatterns: rel.allowedSPIFFEPatterns,
      })
    );

    return {
      localTrustDomain: this.localTrustDomain.name,
      federatedDomains: this.federatedDomains.size,
      relationships,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Verify certificate against a trust bundle (stub)
   */
  private async verifyAgainstBundle(
    certificate: string,
    bundle: TrustBundle
  ): Promise<{ valid: boolean; reason?: string }> {
    // In production, this would:
    // 1. Parse the X.509 certificate
    // 2. Verify the certificate chain against trust bundle root CAs
    // 3. Check certificate validity period
    // 4. Verify certificate hasn't been revoked

    logger.debug('Certificate verification (stub)', {
      trustDomain: bundle.trustDomain,
      rootCACount: bundle.rootCAs.length,
    });

    // For now, assume valid if bundle has root CAs
    return {
      valid: bundle.rootCAs.length > 0,
    };
  }

  /**
   * Calculate SHA-256 hash of trust bundle
   */
  private calculateBundleHash(bundle: TrustBundle): string {
    // Create canonical representation for hashing
    const canonical = {
      trustDomain: bundle.trustDomain,
      sequenceNumber: bundle.sequenceNumber,
      rootCAs: bundle.rootCAs.map(ca => ({
        certificate: ca.certificate,
        serialNumber: ca.serialNumber,
      })),
      jwtAuthorities: bundle.jwtAuthorities?.map(auth => ({
        keyId: auth.keyId,
        publicKey: auth.publicKey,
      })),
    };

    const hash = createHash('sha256');
    hash.update(JSON.stringify(canonical));
    return hash.digest('hex');
  }

  /**
   * Check if SPIFFE ID matches pattern
   */
  private matchesPattern(spiffeId: string, pattern: string): boolean {
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(spiffeId);
  }

  /**
   * Start automatic trust bundle sync
   */
  private startAutoSync(trustDomain: string): void {
    const relationship = this.relationships.get(trustDomain);
    if (!relationship) return;

    // Clear existing interval if any
    this.stopAutoSync(trustDomain);

    // Set up periodic sync
    const interval = setInterval(async () => {
      await this.syncTrustBundle(trustDomain);
    }, relationship.syncInterval * 1000);

    this.syncIntervals.set(trustDomain, interval);

    logger.debug('Auto-sync started', {
      trustDomain,
      intervalSeconds: relationship.syncInterval,
    });
  }

  /**
   * Stop automatic trust bundle sync
   */
  private stopAutoSync(trustDomain: string): void {
    const interval = this.syncIntervals.get(trustDomain);
    if (interval) {
      clearInterval(interval);
      this.syncIntervals.delete(trustDomain);

      logger.debug('Auto-sync stopped', { trustDomain });
    }
  }

  /**
   * Cleanup on shutdown
   */
  destroy(): void {
    // Stop all auto-sync intervals
    for (const [trustDomain] of this.syncIntervals) {
      this.stopAutoSync(trustDomain);
    }
  }
}

// Singleton instance
let federationManager: TrustDomainFederationManager;

export function getFederationManager(
  localTrustDomain?: string,
  localTrustBundle?: TrustBundle
): TrustDomainFederationManager {
  if (!federationManager && localTrustDomain && localTrustBundle) {
    federationManager = new TrustDomainFederationManager(
      localTrustDomain,
      localTrustBundle
    );
  }

  if (!federationManager) {
    throw new Error('Federation manager not initialized');
  }

  return federationManager;
}

/**
 * Create a trust bundle from root CAs
 */
export function createTrustBundle(
  trustDomain: string,
  rootCAs: RootCA[],
  jwtAuthorities?: JWTAuthority[]
): TrustBundle {
  const bundle: Omit<TrustBundle, 'hash'> = {
    trustDomain,
    refreshHint: 3600,
    sequenceNumber: Date.now(),
    rootCAs,
    jwtAuthorities,
  };

  const hash = createHash('sha256');
  hash.update(JSON.stringify(bundle));

  return {
    ...bundle,
    hash: hash.digest('hex'),
  };
}
