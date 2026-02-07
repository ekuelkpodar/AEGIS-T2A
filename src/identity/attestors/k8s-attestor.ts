/**
 * Kubernetes Workload Attestor
 * Attests workload based on K8s pod metadata: namespace, service account, labels
 */

import { readFileSync, existsSync } from 'fs';
import { createSPIFFEId } from '../spiffe.js';
import { logger } from '../../core/logger.js';
import type { WorkloadAttestor, AttestationResult } from './workload-attestation.js';

export class KubernetesAttestor implements WorkloadAttestor {
  name = 'kubernetes';

  async canAttest(): Promise<boolean> {
    return existsSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace');
  }

  async attest(): Promise<AttestationResult> {
    try {
      const namespace = this.readK8sFile('namespace');
      const serviceAccount = this.readK8sFile('serviceaccount');
      const podName = process.env.HOSTNAME || 'unknown';
      
      const selectors = [
        'type:kubernetes',
        `ns:${namespace}`,
        `sa:${serviceAccount}`,
        `pod:${podName}`
      ];

      if (process.env.K8S_POD_LABELS) {
        const labels = JSON.parse(process.env.K8S_POD_LABELS);
        for (const [key, value] of Object.entries(labels)) {
          selectors.push(`label:${key}=${value}`);
        }
      }

      const workloadId = `${namespace}/${podName}`;
      const spiffeId = createSPIFFEId({ agentType: 'service', agentId: podName, namespace });

      return {
        success: true,
        attestorType: 'kubernetes',
        workloadId,
        selectors,
        metadata: { namespace, serviceAccount, podName },
        spiffeId
      };
    } catch (error) {
      return { success: false, attestorType: 'kubernetes', workloadId: '', selectors: [], metadata: {}, error: String(error) };
    }
  }

  private readK8sFile(name: string): string {
    try {
      return readFileSync(`/var/run/secrets/kubernetes.io/serviceaccount/${name}`, 'utf8').trim();
    } catch {
      return 'unknown';
    }
  }
}
