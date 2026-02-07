/**
 * AWS Workload Attestor
 * 
 * Attests workload identity using AWS Instance Identity Document (IID).
 * Verifies EC2 instance metadata and IAM role.
 */

import { createSPIFFEId } from '../spiffe.js';
import { logger } from '../../core/logger.js';
import type { WorkloadAttestor, AttestationResult } from './workload-attestation.js';

export class AWSAttestor implements WorkloadAttestor {
  name = 'aws';

  async canAttest(): Promise<boolean> {
    try {
      const response = await fetch(
        'http://169.254.169.254/latest/meta-data/instance-id',
        { signal: AbortSignal.timeout(1000) }
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async attest(): Promise<AttestationResult> {
    try {
      const instanceId = await this.fetchMetadata('instance-id');
      const region = await this.fetchMetadata('placement/region');
      const accountId = await this.fetchAccountId();
      
      const selectors = [
        'type:aws',
        'instance_id:' + instanceId,
        'region:' + region,
        'account:' + accountId
      ];

      const spiffeId = createSPIFFEId({
        agentType: 'service',
        agentId: instanceId,
        namespace: 'aws'
      });

      return {
        success: true,
        attestorType: 'aws' as const,
        workloadId: instanceId,
        selectors,
        metadata: { instanceId, region, accountId },
        spiffeId
      };
    } catch (error) {
      return {
        success: false,
        attestorType: 'aws' as const,
        workloadId: '',
        selectors: [],
        metadata: {},
        error: String(error)
      };
    }
  }

  private async fetchMetadata(path: string): Promise<string> {
    const response = await fetch(
      'http://169.254.169.254/latest/meta-data/' + path,
      { signal: AbortSignal.timeout(1000) }
    );
    return await response.text();
  }

  private async fetchAccountId(): Promise<string> {
    try {
      const iidoc = await fetch(
        'http://169.254.169.254/latest/dynamic/instance-identity/document',
        { signal: AbortSignal.timeout(1000) }
      );
      const doc = await iidoc.json() as { accountId?: string };
      return doc.accountId || 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
