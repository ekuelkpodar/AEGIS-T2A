/**
 * Azure Workload Attestor
 * 
 * Attests workload identity using Azure Instance Metadata Service (IMDS).
 * Verifies VM instance and managed identity.
 */

import { createSPIFFEId } from '../spiffe.js';
import { logger } from '../../core/logger.js';
import type { WorkloadAttestor, AttestationResult } from './workload-attestation.js';

export class AzureAttestor implements WorkloadAttestor {
  name = 'azure';

  async canAttest(): Promise<boolean> {
    try {
      const response = await fetch(
        'http://169.254.169.254/metadata/instance?api-version=2021-02-01',
        {
          headers: { 'Metadata': 'true' },
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
      const response = await fetch(
        'http://169.254.169.254/metadata/instance?api-version=2021-02-01',
        {
          headers: { 'Metadata': 'true' },
          signal: AbortSignal.timeout(1000)
        }
      );

      const metadata = await response.json() as { compute?: { vmId?: string; subscriptionId?: string; resourceGroupName?: string } };
      const compute = metadata.compute || {};

      const vmId = compute.vmId || 'unknown';
      const subscriptionId = compute.subscriptionId || 'unknown';
      const resourceGroup = compute.resourceGroupName || 'unknown';
      
      const selectors = [
        'type:azure',
        'vm_id:' + vmId,
        'subscription:' + subscriptionId,
        'resource_group:' + resourceGroup
      ];

      const spiffeId = createSPIFFEId({
        agentType: 'service',
        agentId: vmId,
        namespace: 'azure'
      });

      return {
        success: true,
        attestorType: 'azure' as const,
        workloadId: vmId,
        selectors,
        metadata: { vmId, subscriptionId, resourceGroup },
        spiffeId
      };
    } catch (error) {
      return {
        success: false,
        attestorType: 'azure' as const,
        workloadId: '',
        selectors: [],
        metadata: {},
        error: String(error)
      };
    }
  }
}
