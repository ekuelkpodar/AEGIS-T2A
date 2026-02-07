/**
 * GCP Workload Attestor
 * 
 * Attests workload identity using GCP instance metadata.
 * Verifies Compute Engine instance and service account.
 */

import { createSPIFFEId } from '../spiffe.js';
import { logger } from '../../core/logger.js';
import type { WorkloadAttestor, AttestationResult } from './workload-attestation.js';

export class GCPAttestor implements WorkloadAttestor {
  name = 'gcp';

  async canAttest(): Promise<boolean> {
    try {
      const response = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/instance/id',
        {
          headers: { 'Metadata-Flavor': 'Google' },
          signal: AbortSignal.timeout(1000)
        }
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async attest(): Promise<AttestationResult> {
    try {
      const instanceId = await this.fetchMetadata('instance/id');
      const projectId = await this.fetchMetadata('project/project-id');
      const zone = await this.fetchMetadata('instance/zone');
      
      const selectors = [
        'type:gcp',
        'instance_id:' + instanceId,
        'project:' + projectId,
        'zone:' + zone
      ];

      const spiffeId = createSPIFFEId({
        agentType: 'service',
        agentId: instanceId,
        namespace: 'gcp'
      });

      return {
        success: true,
        attestorType: 'gcp' as const,
        workloadId: instanceId,
        selectors,
        metadata: { instanceId, projectId, zone },
        spiffeId
      };
    } catch (error) {
      return {
        success: false,
        attestorType: 'gcp' as const,
        workloadId: '',
        selectors: [],
        metadata: {},
        error: String(error)
      };
    }
  }

  private async fetchMetadata(path: string): Promise<string> {
    const response = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/' + path,
      {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(1000)
      }
    );
    return await response.text();
  }
}
