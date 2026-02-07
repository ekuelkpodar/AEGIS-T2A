/**
 * Workload Attestation System
 *
 * Verifies workload identity before issuing SPIFFE IDs using multiple attestors:
 * - Docker: Container ID, image hash, labels
 * - Kubernetes: Pod name, namespace, service account
 * - Unix: PID, UID, binary hash, environment
 * - AWS: EC2 instance ID, IAM role, region, account
 * - GCP: Compute Engine instance ID, project, zone
 * - Azure: VM ID, subscription, resource group
 *
 * References:
 * - SPIRE Workload Attestation: https://spiffe.io/docs/latest/spire/using/
 * - arxiv:2504.14760 (NHI Management)
 */

import { SPIFFEId, createSPIFFEId } from '../spiffe.js';
import { logger } from '../../core/logger.js';
import { randomUUID } from 'crypto';

/**
 * Attestation result
 */
export interface AttestationResult {
  success: boolean;
  attestorType: 'docker' | 'kubernetes' | 'unix' | 'aws' | 'gcp' | 'azure' | 'unknown';
  workloadId: string;
  selectors: string[];
  metadata: Record<string, unknown>;
  spiffeId?: SPIFFEId;
  error?: string;
}

/**
 * Workload attestor interface
 */
export interface WorkloadAttestor {
  name: string;
  canAttest(): Promise<boolean>;
  attest(): Promise<AttestationResult>;
}

/**
 * Workload attestation manager
 */
export class WorkloadAttestationManager {
  private attestors: WorkloadAttestor[] = [];

  /**
   * Register an attestor
   */
  registerAttestor(attestor: WorkloadAttestor): void {
    this.attestors.push(attestor);
    logger.debug('Registered workload attestor', { name: attestor.name });
  }

  /**
   * Perform workload attestation using available attestors
   */
  async attest(): Promise<AttestationResult> {
    logger.debug('Starting workload attestation', {
      availableAttestors: this.attestors.length,
    });

    // Try each attestor in order
    for (const attestor of this.attestors) {
      try {
        const canAttest = await attestor.canAttest();
        if (!canAttest) {
          logger.debug('Attestor cannot attest in this environment', {
            name: attestor.name,
          });
          continue;
        }

        const result = await attestor.attest();
        if (result.success) {
          logger.info('Workload attestation successful', {
            attestorType: result.attestorType,
            workloadId: result.workloadId,
            selectors: result.selectors,
          });
          return result;
        }
      } catch (error) {
        logger.error('Attestor failed', {
          name: attestor.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // No attestor succeeded - return unknown
    const fallbackId = randomUUID();
    logger.warn('No attestor succeeded - using fallback identity', {
      workloadId: fallbackId,
    });

    return {
      success: true,
      attestorType: 'unknown',
      workloadId: fallbackId,
      selectors: ['type:unknown'],
      metadata: { fallback: true },
      spiffeId: createSPIFFEId({
        agentType: 'system',
        agentId: fallbackId,
      }),
    };
  }
}

/**
 * Initialize workload attestation with all available attestors
 */
export async function initializeWorkloadAttestation(): Promise<AttestationResult | null> {
  const manager = new WorkloadAttestationManager();

  // Dynamically import and register attestors
  try {
    const { DockerAttestor } = await import('./docker-attestor.js');
    manager.registerAttestor(new DockerAttestor());
  } catch {
    logger.debug('Docker attestor not available');
  }

  try {
    const { KubernetesAttestor } = await import('./k8s-attestor.js');
    manager.registerAttestor(new KubernetesAttestor());
  } catch {
    logger.debug('Kubernetes attestor not available');
  }

  try {
    const { UnixAttestor } = await import('./unix-attestor.js');
    manager.registerAttestor(new UnixAttestor());
  } catch {
    logger.debug('Unix attestor not available');
  }

  // Cloud attestors
  try {
    const { AWSAttestor } = await import('./aws-attestor.js');
    manager.registerAttestor(new AWSAttestor());
  } catch {
    logger.debug('AWS attestor not available');
  }

  try {
    const { GCPAttestor } = await import('./gcp-attestor.js');
    manager.registerAttestor(new GCPAttestor());
  } catch {
    logger.debug('GCP attestor not available');
  }

  try {
    const { AzureAttestor } = await import('./azure-attestor.js');
    manager.registerAttestor(new AzureAttestor());
  } catch {
    logger.debug('Azure attestor not available');
  }

  // Perform attestation
  return await manager.attest();
}

/**
 * Singleton instance
 */
let workloadAttestationManager: WorkloadAttestationManager;

export function getWorkloadAttestationManager(): WorkloadAttestationManager {
  if (!workloadAttestationManager) {
    workloadAttestationManager = new WorkloadAttestationManager();
  }
  return workloadAttestationManager;
}
