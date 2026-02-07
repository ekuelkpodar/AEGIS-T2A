/**
 * Unix Process Attestor
 * Attests workload based on Unix process metadata: PID, UID, binary path
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { createSPIFFEId } from '../spiffe.js';
import { logger } from '../../core/logger.js';
import type { WorkloadAttestor, AttestationResult } from './workload-attestation.js';

export class UnixAttestor implements WorkloadAttestor {
  name = 'unix';

  async canAttest(): Promise<boolean> {
    return process.platform !== 'win32';
  }

  async attest(): Promise<AttestationResult> {
    try {
      const pid = process.pid;
      const uid = process.getuid ? process.getuid() : 0;
      const gid = process.getgid ? process.getgid() : 0;
      const binaryPath = process.execPath;
      const binaryHash = this.hashBinary(binaryPath);
      
      const selectors = [
        'type:unix',
        `pid:${pid}`,
        `uid:${uid}`,
        `gid:${gid}`,
        `path:${binaryPath}`,
        `sha256:${binaryHash}`
      ];

      const workloadId = `unix-${uid}-${pid}`;
      const spiffeId = createSPIFFEId({ agentType: 'system', agentId: workloadId, namespace: 'unix' });

      return {
        success: true,
        attestorType: 'unix',
        workloadId,
        selectors,
        metadata: { pid, uid, gid, binaryPath, binaryHash },
        spiffeId
      };
    } catch (error) {
      return { success: false, attestorType: 'unix', workloadId: '', selectors: [], metadata: {}, error: String(error) };
    }
  }

  private hashBinary(path: string): string {
    try {
      const content = readFileSync(path);
      return createHash('sha256').update(content).digest('hex').slice(0, 16);
    } catch {
      return 'unknown';
    }
  }
}
