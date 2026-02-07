/**
 * Automatic SVID Rotation
 * Zero-disruption certificate rotation following Envoy SDS pattern
 */

import { SPIREAgentClient, X509SVID } from './spire-agent.js';
import { logger } from '../core/logger.js';

export interface RotationConfig {
  rotationThreshold: number;
  retryInterval: number;
  maxRetries: number;
  enabled: boolean;
}

export interface RotationStats {
  totalRotations: number;
  successfulRotations: number;
  failedRotations: number;
  lastRotation?: Date;
  nextRotation?: Date;
}

export class SVIDRotationManager {
  private config: RotationConfig;
  private currentSVID?: X509SVID;
  private rotationTimer?: NodeJS.Timeout;
  private stats: RotationStats;
  private spireClient: SPIREAgentClient;

  constructor(spireClient: SPIREAgentClient, config?: Partial<RotationConfig>) {
    this.spireClient = spireClient;
    this.config = {
      rotationThreshold: config?.rotationThreshold || 0.66,
      retryInterval: config?.retryInterval || 60000,
      maxRetries: config?.maxRetries || 5,
      enabled: config?.enabled !== false
    };
    this.stats = { totalRotations: 0, successfulRotations: 0, failedRotations: 0 };
  }

  async start(): Promise<void> {
    if (!this.config.enabled) return;
    
    try {
      this.currentSVID = await this.spireClient.fetchX509SVID();
      this.scheduleRotation();
      logger.info('SVID rotation started', { spiffeId: this.currentSVID.spiffeId });
    } catch (error) {
      logger.error('Failed to start rotation', { error });
    }
  }

  stop(): void {
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
    }
  }

  private scheduleRotation(): void {
    if (!this.currentSVID) return;
    const ttl = this.currentSVID.expiresAt.getTime() - Date.now();
    const delay = ttl * (1 - this.config.rotationThreshold);
    this.rotationTimer = setTimeout(() => this.performRotation(), delay);
  }

  private async performRotation(): Promise<void> {
    this.stats.totalRotations++;
    try {
      this.currentSVID = await this.spireClient.fetchX509SVID();
      this.stats.successfulRotations++;
      this.stats.lastRotation = new Date();
      logger.info('SVID rotated', { spiffeId: this.currentSVID.spiffeId });
      this.scheduleRotation();
    } catch (error) {
      this.stats.failedRotations++;
      logger.error('Rotation failed', { error });
    }
  }

  getStats(): RotationStats {
    return this.stats;
  }
}

let rotationManager: SVIDRotationManager;

export function getSVIDRotationManager(spireClient: SPIREAgentClient, config?: Partial<RotationConfig>): SVIDRotationManager {
  if (!rotationManager) {
    rotationManager = new SVIDRotationManager(spireClient, config);
  }
  return rotationManager;
}
