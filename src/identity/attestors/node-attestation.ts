/**
 * Node Attestation for Multi-Cloud Deployments
 *
 * Implements cloud-specific node attestation plugins for:
 * - AWS (Instance Identity Document)
 * - Azure (Managed Identity token)
 * - GCP (Instance Metadata)
 * - Bare-metal (TPM-based attestation via Keylime)
 *
 * Reference: SPIRE node attestor plugins, Red Hat Keylime integration
 */

import https from 'https';
import { logger } from '../../core/logger.js';

export interface NodeAttestation {
  cloudProvider: 'aws' | 'azure' | 'gcp' | 'baremetal';
  nodeId: string;
  attestationData: AWSInstanceIdentity | AzureManagedIdentity | GCPInstanceMetadata | BaremetalTPMAttestation;
  verifiedAt: Date;
  expiresAt?: Date;
}

export interface AWSInstanceIdentity {
  instanceId: string;
  region: string;
  accountId: string;
  imageId: string;
  instanceType: string;
  privateIp: string;
  document: string; // Base64-encoded identity document
  signature: string; // PKCS7 signature
}

export interface AzureManagedIdentity {
  vmId: string;
  subscriptionId: string;
  resourceGroup: string;
  location: string;
  token: string;
  principal: {
    id: string;
    tenantId: string;
  };
}

export interface GCPInstanceMetadata {
  instanceId: string;
  projectId: string;
  zone: string;
  instanceName: string;
  serviceAccount: string;
  token: string;
}

export interface BaremetalTPMAttestation {
  nodeId: string;
  tpmQuote: string; // TPM 2.0 quote
  aikCert: string; // AIK certificate
  pcrs: Record<number, string>; // PCR values
  nonce: string;
}

export class NodeAttestationService {
  /**
   * Attest AWS EC2 instance via Instance Identity Document
   */
  async attestAWSNode(): Promise<AWSInstanceIdentity | null> {
    try {
      logger.debug('Attempting AWS node attestation');

      // Fetch instance identity document
      const document = await this.fetchIMDSv2(
        'http://169.254.169.254/latest/dynamic/instance-identity/document'
      );

      // Fetch PKCS7 signature
      const signature = await this.fetchIMDSv2(
        'http://169.254.169.254/latest/dynamic/instance-identity/pkcs7'
      );

      if (!document || !signature) {
        logger.warn('Failed to fetch AWS instance identity');
        return null;
      }

      const identityDoc = JSON.parse(document);

      const attestation: AWSInstanceIdentity = {
        instanceId: identityDoc.instanceId,
        region: identityDoc.region,
        accountId: identityDoc.accountId,
        imageId: identityDoc.imageId,
        instanceType: identityDoc.instanceType,
        privateIp: identityDoc.privateIp,
        document: Buffer.from(document).toString('base64'),
        signature,
      };

      logger.info('AWS node attestation successful', {
        instanceId: attestation.instanceId,
        region: attestation.region,
        accountId: attestation.accountId,
      });

      return attestation;
    } catch (error) {
      logger.debug('AWS node attestation not available', { error });
      return null;
    }
  }

  /**
   * Attest Azure VM via Managed Identity
   */
  async attestAzureNode(): Promise<AzureManagedIdentity | null> {
    try {
      logger.debug('Attempting Azure node attestation');

      // Fetch Azure Instance Metadata Service
      const metadata = await this.fetchAzureIMDS(
        'http://169.254.169.254/metadata/instance?api-version=2021-02-01'
      );

      if (!metadata) {
        logger.warn('Failed to fetch Azure instance metadata');
        return null;
      }

      const compute = metadata.compute;

      // Fetch Managed Identity token
      const tokenResponse = await this.fetchAzureIMDS(
        'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://management.azure.com/'
      );

      const attestation: AzureManagedIdentity = {
        vmId: compute.vmId,
        subscriptionId: compute.subscriptionId,
        resourceGroup: compute.resourceGroupName,
        location: compute.location,
        token: tokenResponse?.access_token || '',
        principal: {
          id: tokenResponse?.client_id || '',
          tenantId: compute.tenantId || '',
        },
      };

      logger.info('Azure node attestation successful', {
        vmId: attestation.vmId,
        subscriptionId: attestation.subscriptionId,
        resourceGroup: attestation.resourceGroup,
      });

      return attestation;
    } catch (error) {
      logger.debug('Azure node attestation not available', { error });
      return null;
    }
  }

  /**
   * Attest GCP instance via Instance Metadata
   */
  async attestGCPNode(): Promise<GCPInstanceMetadata | null> {
    try {
      logger.debug('Attempting GCP node attestation');

      // Fetch GCP metadata
      const fetchMetadata = async (path: string): Promise<string> => {
        return new Promise((resolve, reject) => {
          const req = https.get(
            `https://metadata.google.internal/computeMetadata/v1/${path}`,
            {
              headers: { 'Metadata-Flavor': 'Google' },
              timeout: 2000,
            },
            res => {
              let data = '';
              res.on('data', chunk => (data += chunk));
              res.on('end', () => resolve(data));
            }
          );
          req.on('error', reject);
          req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
          });
        });
      };

      const instanceId = await fetchMetadata('instance/id');
      const projectId = await fetchMetadata('project/project-id');
      const zone = await fetchMetadata('instance/zone');
      const instanceName = await fetchMetadata('instance/name');
      const serviceAccount = await fetchMetadata('instance/service-accounts/default/email');
      const token = await fetchMetadata(
        'instance/service-accounts/default/token'
      );

      const attestation: GCPInstanceMetadata = {
        instanceId,
        projectId,
        zone: zone.split('/').pop() || zone,
        instanceName,
        serviceAccount,
        token,
      };

      logger.info('GCP node attestation successful', {
        instanceId: attestation.instanceId,
        projectId: attestation.projectId,
        zone: attestation.zone,
      });

      return attestation;
    } catch (error) {
      logger.debug('GCP node attestation not available', { error });
      return null;
    }
  }

  /**
   * Attest bare-metal node via TPM (Keylime integration)
   */
  async attestBaremetalNode(
    keylimeAgentUrl: string = 'http://localhost:9002'
  ): Promise<BaremetalTPMAttestation | null> {
    try {
      logger.debug('Attempting bare-metal TPM attestation via Keylime');

      // In production, this would make actual Keylime API calls
      // For now, this is a stub showing the expected structure

      // Keylime agent provides TPM quotes and AIK certificates
      // The verifier checks: PCR values, TPM quote signature, AIK cert chain

      logger.warn('Bare-metal TPM attestation not yet implemented');
      return null;
    } catch (error) {
      logger.debug('Bare-metal attestation not available', { error });
      return null;
    }
  }

  /**
   * Auto-detect and attest current node
   */
  async attestCurrentNode(): Promise<NodeAttestation | null> {
    // Try AWS first
    const awsAttestation = await this.attestAWSNode();
    if (awsAttestation) {
      return {
        cloudProvider: 'aws',
        nodeId: awsAttestation.instanceId,
        attestationData: awsAttestation,
        verifiedAt: new Date(),
      };
    }

    // Try Azure
    const azureAttestation = await this.attestAzureNode();
    if (azureAttestation) {
      return {
        cloudProvider: 'azure',
        nodeId: azureAttestation.vmId,
        attestationData: azureAttestation,
        verifiedAt: new Date(),
      };
    }

    // Try GCP
    const gcpAttestation = await this.attestGCPNode();
    if (gcpAttestation) {
      return {
        cloudProvider: 'gcp',
        nodeId: gcpAttestation.instanceId,
        attestationData: gcpAttestation,
        verifiedAt: new Date(),
      };
    }

    // Try bare-metal (if Keylime is configured)
    if (process.env.KEYLIME_AGENT_URL) {
      const baremetalAttestation = await this.attestBaremetalNode(
        process.env.KEYLIME_AGENT_URL
      );
      if (baremetalAttestation) {
        return {
          cloudProvider: 'baremetal',
          nodeId: baremetalAttestation.nodeId,
          attestationData: baremetalAttestation,
          verifiedAt: new Date(),
        };
      }
    }

    logger.warn('No node attestation method succeeded - running in unattested mode');
    return null;
  }

  /**
   * Verify AWS PKCS7 signature (stub - would use actual crypto verification)
   */
  async verifyAWSSignature(
    document: string,
    signature: string,
    region: string
  ): Promise<boolean> {
    // In production, this would:
    // 1. Fetch AWS public key for the region
    // 2. Verify PKCS7 signature
    // 3. Check document hasn't been tampered with

    logger.debug('AWS signature verification (stub)', { region });
    return true;
  }

  /**
   * Verify Azure token (stub - would validate JWT with Azure AD)
   */
  async verifyAzureToken(token: string, tenantId: string): Promise<boolean> {
    // In production, this would:
    // 1. Fetch Azure AD public keys
    // 2. Verify JWT signature
    // 3. Validate claims (tenant, audience, expiry)

    logger.debug('Azure token verification (stub)', { tenantId });
    return true;
  }

  /**
   * Verify GCP token (stub - would validate with Google OAuth)
   */
  async verifyGCPToken(token: string, projectId: string): Promise<boolean> {
    // In production, this would:
    // 1. Validate token with Google OAuth API
    // 2. Check project ID matches
    // 3. Verify service account permissions

    logger.debug('GCP token verification (stub)', { projectId });
    return true;
  }

  /**
   * Fetch from AWS IMDSv2 (requires session token)
   */
  private async fetchIMDSv2(url: string): Promise<string | null> {
    try {
      // Get session token
      const tokenResponse = await new Promise<string>((resolve, reject) => {
        const req = https.request(
          'http://169.254.169.254/latest/api/token',
          {
            method: 'PUT',
            headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
            timeout: 2000,
          },
          res => {
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => resolve(data));
          }
        );
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });
        req.end();
      });

      // Fetch metadata with token
      return new Promise((resolve, reject) => {
        const req = https.get(
          url,
          {
            headers: { 'X-aws-ec2-metadata-token': tokenResponse },
            timeout: 2000,
          },
          res => {
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => resolve(data));
          }
        );
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });
      });
    } catch (error) {
      return null;
    }
  }

  /**
   * Fetch from Azure IMDS
   */
  private async fetchAzureIMDS(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = https.get(
        url,
        {
          headers: { Metadata: 'true' },
          timeout: 2000,
        },
        res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(data);
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }
}

// Singleton instance
let nodeAttestationService: NodeAttestationService;

export function getNodeAttestationService(): NodeAttestationService {
  if (!nodeAttestationService) {
    nodeAttestationService = new NodeAttestationService();
  }
  return nodeAttestationService;
}

/**
 * Initialize node attestation at startup
 */
export async function initializeNodeAttestation(): Promise<NodeAttestation | null> {
  logger.info('Initializing node attestation');

  const service = getNodeAttestationService();
  const attestation = await service.attestCurrentNode();

  if (attestation) {
    logger.info('Node attestation completed', {
      provider: attestation.cloudProvider,
      nodeId: attestation.nodeId,
    });
  } else {
    logger.warn('Running without node attestation - development mode only');
  }

  return attestation;
}
