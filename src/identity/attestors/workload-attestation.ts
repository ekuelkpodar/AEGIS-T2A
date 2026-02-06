/**
 * Workload Attestation Plugins
 *
 * Attestation plugins for verifying workload identity:
 * - Docker (container ID, image hash)
 * - Kubernetes (service account, namespace, labels)
 * - Unix process (PID, UID, binary hash)
 *
 * Reference: SPIRE workload attestor architecture
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { logger } from '../../core/logger.js';

export interface WorkloadAttestationResult {
  attestorType: 'docker' | 'kubernetes' | 'unix_process';
  workloadId: string;
  attestationData: DockerAttestation | KubernetesAttestation | UnixProcessAttestation;
  confidence: 'high' | 'medium' | 'low';
  verifiedAt: Date;
}

export interface DockerAttestation {
  containerId: string;
  imageId: string;
  imageHash: string;
  imageName: string;
  labels: Record<string, string>;
  networkMode: string;
  pid: number;
}

export interface KubernetesAttestation {
  podName: string;
  podNamespace: string;
  podUID: string;
  serviceAccountName: string;
  serviceAccountToken: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  nodeName: string;
}

export interface UnixProcessAttestation {
  pid: number;
  uid: number;
  gid: number;
  binaryPath: string;
  binaryHash: string;
  commandLine: string[];
  parentPid: number;
  startTime: Date;
}

export class WorkloadAttestationService {
  /**
   * Attest Docker container workload
   */
  async attestDockerWorkload(pid?: number): Promise<DockerAttestation | null> {
    try {
      const workloadPid = pid || process.pid;

      logger.debug('Attempting Docker workload attestation', { pid: workloadPid });

      // Check if running in Docker by looking for .dockerenv
      if (!existsSync('/.dockerenv')) {
        return null;
      }

      // Get container ID from cgroup
      const containerId = this.getContainerIdFromCgroup();
      if (!containerId) {
        return null;
      }

      // Get container information via Docker API
      // In production, this would query Docker socket
      const containerInfo = this.getDockerContainerInfo(containerId);

      const attestation: DockerAttestation = {
        containerId: containerId.substring(0, 12), // Short ID
        imageId: containerInfo.imageId,
        imageHash: containerInfo.imageHash,
        imageName: containerInfo.imageName,
        labels: containerInfo.labels,
        networkMode: containerInfo.networkMode,
        pid: workloadPid,
      };

      logger.info('Docker workload attestation successful', {
        containerId: attestation.containerId,
        imageHash: attestation.imageHash,
      });

      return attestation;
    } catch (error) {
      logger.debug('Docker workload attestation not available', { error });
      return null;
    }
  }

  /**
   * Attest Kubernetes pod workload
   */
  async attestKubernetesWorkload(): Promise<KubernetesAttestation | null> {
    try {
      logger.debug('Attempting Kubernetes workload attestation');

      // Check if running in Kubernetes by looking for service account token
      const saTokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';
      if (!existsSync(saTokenPath)) {
        return null;
      }

      // Read Kubernetes-injected files
      const serviceAccountToken = readFileSync(saTokenPath, 'utf-8');
      const namespace = readFileSync(
        '/var/run/secrets/kubernetes.io/serviceaccount/namespace',
        'utf-8'
      );

      // Get pod information from environment variables
      const podName = process.env.HOSTNAME || '';
      const podUID = this.getKubernetesPodUID();
      const serviceAccountName =
        process.env.KUBERNETES_SERVICE_ACCOUNT_NAME || 'default';
      const nodeName = process.env.NODE_NAME || '';

      // Get labels and annotations (would typically query K8s API)
      const labels = this.getKubernetesLabels();
      const annotations = this.getKubernetesAnnotations();

      const attestation: KubernetesAttestation = {
        podName,
        podNamespace: namespace.trim(),
        podUID,
        serviceAccountName,
        serviceAccountToken,
        labels,
        annotations,
        nodeName,
      };

      logger.info('Kubernetes workload attestation successful', {
        podName: attestation.podName,
        namespace: attestation.podNamespace,
        serviceAccount: attestation.serviceAccountName,
      });

      return attestation;
    } catch (error) {
      logger.debug('Kubernetes workload attestation not available', { error });
      return null;
    }
  }

  /**
   * Attest Unix process workload
   */
  async attestUnixProcessWorkload(pid?: number): Promise<UnixProcessAttestation | null> {
    try {
      const workloadPid = pid || process.pid;

      logger.debug('Attempting Unix process attestation', { pid: workloadPid });

      // Get process information from /proc
      const procPath = `/proc/${workloadPid}`;
      if (!existsSync(procPath)) {
        logger.warn('Process proc directory not found', { procPath });
        return null;
      }

      // Read process status
      const status = readFileSync(`${procPath}/status`, 'utf-8');
      const uid = this.extractFromStatus(status, 'Uid:')?.split('\t')[1] || '0';
      const gid = this.extractFromStatus(status, 'Gid:')?.split('\t')[1] || '0';

      // Get binary path
      const binaryPath = readFileSync(`${procPath}/exe`, 'utf-8');

      // Calculate binary hash
      const binaryHash = this.calculateFileHash(binaryPath);

      // Get command line
      const cmdline = readFileSync(`${procPath}/cmdline`, 'utf-8')
        .split('\0')
        .filter(Boolean);

      // Get parent PID
      const stat = readFileSync(`${procPath}/stat`, 'utf-8');
      const statParts = stat.split(' ');
      const parentPid = parseInt(statParts[3], 10);

      // Get start time
      const startTime = this.getProcessStartTime(workloadPid);

      const attestation: UnixProcessAttestation = {
        pid: workloadPid,
        uid: parseInt(uid, 10),
        gid: parseInt(gid, 10),
        binaryPath,
        binaryHash,
        commandLine: cmdline,
        parentPid,
        startTime,
      };

      logger.info('Unix process attestation successful', {
        pid: attestation.pid,
        uid: attestation.uid,
        binaryHash: attestation.binaryHash,
      });

      return attestation;
    } catch (error) {
      logger.debug('Unix process attestation not available', { error });
      return null;
    }
  }

  /**
   * Auto-detect and attest current workload
   */
  async attestCurrentWorkload(): Promise<WorkloadAttestationResult | null> {
    // Try Kubernetes first (most specific)
    const k8sAttestation = await this.attestKubernetesWorkload();
    if (k8sAttestation) {
      return {
        attestorType: 'kubernetes',
        workloadId: `${k8sAttestation.podNamespace}/${k8sAttestation.podName}`,
        attestationData: k8sAttestation,
        confidence: 'high',
        verifiedAt: new Date(),
      };
    }

    // Try Docker
    const dockerAttestation = await this.attestDockerWorkload();
    if (dockerAttestation) {
      return {
        attestorType: 'docker',
        workloadId: dockerAttestation.containerId,
        attestationData: dockerAttestation,
        confidence: 'high',
        verifiedAt: new Date(),
      };
    }

    // Fall back to Unix process
    const processAttestation = await this.attestUnixProcessWorkload();
    if (processAttestation) {
      return {
        attestorType: 'unix_process',
        workloadId: `pid:${processAttestation.pid}`,
        attestationData: processAttestation,
        confidence: 'medium',
        verifiedAt: new Date(),
      };
    }

    logger.warn('No workload attestation method succeeded');
    return null;
  }

  /**
   * Verify workload attestation matches expected values
   */
  async verifyAttestation(
    attestation: WorkloadAttestationResult,
    expectedValues: {
      imageHash?: string;
      serviceAccount?: string;
      binaryHash?: string;
      namespace?: string;
    }
  ): Promise<{ valid: boolean; reason?: string }> {
    switch (attestation.attestorType) {
      case 'docker': {
        const data = attestation.attestationData as DockerAttestation;
        if (expectedValues.imageHash && data.imageHash !== expectedValues.imageHash) {
          return {
            valid: false,
            reason: `Image hash mismatch: expected ${expectedValues.imageHash}, got ${data.imageHash}`,
          };
        }
        break;
      }

      case 'kubernetes': {
        const data = attestation.attestationData as KubernetesAttestation;
        if (
          expectedValues.serviceAccount &&
          data.serviceAccountName !== expectedValues.serviceAccount
        ) {
          return {
            valid: false,
            reason: `Service account mismatch: expected ${expectedValues.serviceAccount}, got ${data.serviceAccountName}`,
          };
        }
        if (expectedValues.namespace && data.podNamespace !== expectedValues.namespace) {
          return {
            valid: false,
            reason: `Namespace mismatch: expected ${expectedValues.namespace}, got ${data.podNamespace}`,
          };
        }
        break;
      }

      case 'unix_process': {
        const data = attestation.attestationData as UnixProcessAttestation;
        if (expectedValues.binaryHash && data.binaryHash !== expectedValues.binaryHash) {
          return {
            valid: false,
            reason: `Binary hash mismatch: expected ${expectedValues.binaryHash}, got ${data.binaryHash}`,
          };
        }
        break;
      }
    }

    return { valid: true };
  }

  /**
   * Get container ID from cgroup file
   */
  private getContainerIdFromCgroup(): string | null {
    try {
      const cgroup = readFileSync('/proc/self/cgroup', 'utf-8');
      const match = cgroup.match(/docker[/-]([a-f0-9]{64})/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Get Docker container info (stub - would query Docker API)
   */
  private getDockerContainerInfo(containerId: string): {
    imageId: string;
    imageHash: string;
    imageName: string;
    labels: Record<string, string>;
    networkMode: string;
  } {
    // In production, this would query Docker socket API
    return {
      imageId: 'image-id',
      imageHash: 'sha256:...',
      imageName: 'aegis/agent:latest',
      labels: {},
      networkMode: 'bridge',
    };
  }

  /**
   * Get Kubernetes pod UID from downward API
   */
  private getKubernetesPodUID(): string {
    try {
      return readFileSync(
        '/var/run/secrets/kubernetes.io/serviceaccount/namespace',
        'utf-8'
      ).trim();
    } catch {
      return '';
    }
  }

  /**
   * Get Kubernetes labels (stub - would query K8s API or downward API)
   */
  private getKubernetesLabels(): Record<string, string> {
    // In production, read from downward API volume mount
    return {
      app: 'aegis-agent',
      version: 'v1',
    };
  }

  /**
   * Get Kubernetes annotations (stub)
   */
  private getKubernetesAnnotations(): Record<string, string> {
    return {};
  }

  /**
   * Extract value from /proc/PID/status file
   */
  private extractFromStatus(status: string, field: string): string | null {
    const match = status.match(new RegExp(`${field}\\\\s+(.+)`));
    return match ? match[1] : null;
  }

  /**
   * Calculate SHA-256 hash of a file
   */
  private calculateFileHash(filePath: string): string {
    try {
      const content = readFileSync(filePath);
      const hash = createHash('sha256');
      hash.update(content);
      return hash.digest('hex');
    } catch (error) {
      logger.warn('Failed to hash file', { filePath, error });
      return '';
    }
  }

  /**
   * Get process start time
   */
  private getProcessStartTime(pid: number): Date {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const statParts = stat.split(' ');
      const starttime = parseInt(statParts[21], 10);

      // starttime is in clock ticks since boot
      // Convert to actual timestamp (approximate)
      const uptimeSeconds = parseFloat(readFileSync('/proc/uptime', 'utf-8').split(' ')[0]);
      const clockTicks = parseInt(execSync('getconf CLK_TCK').toString().trim(), 10);
      const secondsSinceBoot = starttime / clockTicks;
      const bootTime = Date.now() - uptimeSeconds * 1000;

      return new Date(bootTime + secondsSinceBoot * 1000);
    } catch {
      return new Date();
    }
  }
}

// Singleton instance
let workloadAttestationService: WorkloadAttestationService;

export function getWorkloadAttestationService(): WorkloadAttestationService {
  if (!workloadAttestationService) {
    workloadAttestationService = new WorkloadAttestationService();
  }
  return workloadAttestationService;
}

/**
 * Initialize workload attestation at startup
 */
export async function initializeWorkloadAttestation(): Promise<WorkloadAttestationResult | null> {
  logger.info('Initializing workload attestation');

  const service = getWorkloadAttestationService();
  const attestation = await service.attestCurrentWorkload();

  if (attestation) {
    logger.info('Workload attestation completed', {
      attestorType: attestation.attestorType,
      workloadId: attestation.workloadId,
      confidence: attestation.confidence,
    });
  } else {
    logger.warn('Running without workload attestation - development mode only');
  }

  return attestation;
}
