/**
 * Docker Workload Attestor
 * Attests workload identity based on Docker container metadata
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { createSPIFFEId } from '../spiffe.js';
import { logger } from '../../core/logger.js';
import type { WorkloadAttestor, AttestationResult } from './workload-attestation.js';

export class DockerAttestor implements WorkloadAttestor {
  name = 'docker';

  async canAttest(): Promise<boolean> {
    try {
      const cgroup = readFileSync('/proc/self/cgroup', 'utf8');
      return cgroup.includes('docker') || cgroup.includes('containerd');
    } catch {
      return false;
    }
  }

  async attest(): Promise<AttestationResult> {
    try {
      const containerId = this.getContainerId();
      if (!containerId) {
        return { success: false, attestorType: 'docker', workloadId: '', selectors: [], metadata: {}, error: 'No container ID' };
      }

      const metadata = await this.getContainerMetadata(containerId);
      const selectors = this.buildSelectors(containerId, metadata);
      const spiffeId = createSPIFFEId({ agentType: 'service', agentId: containerId.slice(0, 12), namespace: 'docker' });

      return { success: true, attestorType: 'docker', workloadId: containerId, selectors, metadata, spiffeId };
    } catch (error) {
      return { success: false, attestorType: 'docker', workloadId: '', selectors: [], metadata: {}, error: String(error) };
    }
  }

  private getContainerId(): string | null {
    try {
      const cgroup = readFileSync('/proc/self/cgroup', 'utf8');
      const match = cgroup.match(/docker[/-]([a-f0-9]{64})/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  private async getContainerMetadata(containerId: string): Promise<Record<string, unknown>> {
    try {
      const output = execSync(`docker inspect ${containerId}`, { encoding: 'utf8', timeout: 5000 });
      const info = JSON.parse(output)[0];
      return { imageId: info.Image, imageName: info.Config?.Image, labels: info.Config?.Labels || {}, env: info.Config?.Env || [], created: info.Created };
    } catch {
      return {};
    }
  }

  private buildSelectors(containerId: string, metadata: Record<string, unknown>): string[] {
    const selectors = ['type:docker', `container_id:${containerId.slice(0, 12)}`];
    if (metadata.imageId) selectors.push(`image_id:${metadata.imageId}`);
    if (metadata.imageName) selectors.push(`image_name:${metadata.imageName}`);
    if (metadata.labels && typeof metadata.labels === 'object') {
      for (const [key, value] of Object.entries(metadata.labels)) {
        selectors.push(`label:${key}=${value}`);
      }
    }
    return selectors;
  }
}
