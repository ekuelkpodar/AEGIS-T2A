/**
 * Identity System Initialization
 *
 * Orchestrates the startup of AEGIS-T2A's zero-trust identity infrastructure:
 * - SPIRE Agent integration for workload identity
 * - Workload attestation (Docker, Kubernetes, Unix process)
 * - Workload IAM policies
 * - Scope-based authorization
 * - Identity federation and delegation
 */

import { logger } from '../core/logger.js';
import { getSPIREClient, validateSPIREAgentAvailability } from './spire-agent.js';
import { initializeWorkloadAttestation } from './attestors/workload-attestation.js';
import { getWorkloadIAM, initializeDefaultPolicies } from './workload-iam.js';
import { getScopeManager } from './scopes.js';
import { getFederationManager, createTrustBundle } from './federation.js';
import { getNHILifecycleManager } from './nhi-lifecycle.js';
import { getDelegationManager } from './delegation.js';

export interface IdentitySystemConfig {
  enableSPIRE?: boolean;
  enableWorkloadAttestation?: boolean;
  enableIAMPolicies?: boolean;
  enableFederation?: boolean;
  enableNHILifecycle?: boolean;
}

/**
 * Initialize the complete identity and zero-trust system
 */
export async function initializeIdentitySystem(
  config?: IdentitySystemConfig
): Promise<void> {
  const cfg = {
    enableSPIRE: config?.enableSPIRE ?? true,
    enableWorkloadAttestation: config?.enableWorkloadAttestation ?? true,
    enableIAMPolicies: config?.enableIAMPolicies ?? true,
    enableFederation: config?.enableFederation ?? true,
    enableNHILifecycle: config?.enableNHILifecycle ?? true,
  };

  logger.info('Initializing AEGIS-T2A Identity & Zero-Trust System', { config: cfg });

  try {
    // Step 1: Check SPIRE Agent availability
    if (cfg.enableSPIRE) {
      const spireAvailable = await validateSPIREAgentAvailability();
      if (spireAvailable) {
        logger.info('SPIRE Agent detected - enabling production identity mode');

        // Initialize SPIRE client and fetch initial SVID
        const spireClient = getSPIREClient();
        const svid = await spireClient.fetchX509SVID();

        logger.info('X.509-SVID obtained', {
          spiffeId: svid.spiffeId,
          expiresAt: svid.expiresAt.toISOString(),
        });
      } else {
        logger.warn(
          'SPIRE Agent not available - running in development mode without mTLS identity'
        );
      }
    }

    // Step 2: Initialize workload attestation
    if (cfg.enableWorkloadAttestation) {
      const attestation = await initializeWorkloadAttestation();
      if (attestation) {
        logger.info('Workload attestation completed', {
          attestorType: attestation.attestorType,
          workloadId: attestation.workloadId,
        });
      }
    }

    // Step 3: Initialize Workload IAM with default policies
    if (cfg.enableIAMPolicies) {
      const workloadIAM = getWorkloadIAM();
      initializeDefaultPolicies(workloadIAM);
      logger.info('Workload IAM policies initialized');
    }

    // Step 4: Initialize scope-based authorization
    const scopeManager = getScopeManager();
    logger.info('Scope-based authorization system initialized', {
      defaultScopes: scopeManager.getGrantedScopes('system').length,
    });

    // Step 5: Initialize identity federation (requires trust bundle from SPIRE)
    if (cfg.enableFederation) {
      // Federation requires a local trust bundle - only initialize if SPIRE is available
      try {
        const spireClient = getSPIREClient();
        const trustBundle = await spireClient.getTrustBundle();

        // Create properly structured trust bundle for federation
        const localBundle = createTrustBundle(
          process.env.TRUST_DOMAIN || 'aegis-t2a.local',
          [] // Would be populated from SPIRE trust bundle
        );

        // Note: Federation manager will be initialized on-demand when needed
        logger.info('Identity federation ready (will initialize on first use)');
      } catch (error) {
        logger.debug('Federation not available without SPIRE Agent', { error });
      }
    }

    // Step 6: Initialize non-human identity lifecycle management
    if (cfg.enableNHILifecycle) {
      const nhiManager = getNHILifecycleManager();

      // Start lifecycle monitoring (check for rotations/expirations every minute)
      nhiManager.startMonitoring(60);

      // Set up alert handler
      nhiManager.onAlert(alert => {
        logger.warn('Identity lifecycle alert', {
          alertType: alert.alertType,
          severity: alert.severity,
          message: alert.message,
          identityId: alert.identityId,
          spiffeId: alert.spiffeId,
        });
      });

      logger.info('Non-Human Identity lifecycle manager initialized');
    }

    logger.info('Identity & Zero-Trust System initialization complete');
  } catch (error) {
    logger.error('Failed to initialize identity system', { error });

    // In production, you might want to fail fast if identity is critical
    // For now, we'll allow the app to start in degraded mode
    logger.warn('Continuing startup in degraded security mode');
  }
}

/**
 * Shutdown the identity system gracefully
 */
export async function shutdownIdentitySystem(): Promise<void> {
  logger.info('Shutting down identity system');

  try {
    // Stop SVID rotation timers
    const spireClient = getSPIREClient();
    spireClient.destroy();

    // Cleanup NHI lifecycle manager
    const nhiManager = getNHILifecycleManager();
    nhiManager.stopMonitoring();

    logger.info('Identity system shutdown complete');
  } catch (error) {
    logger.error('Error during identity system shutdown', { error });
  }
}

/**
 * Get system health status for identity components
 */
export async function getIdentitySystemHealth(): Promise<{
  status: 'healthy' | 'degraded' | 'unhealthy';
  components: Record<string, { status: string; message?: string }>;
}> {
  const components: Record<string, { status: string; message?: string }> = {};

  // Check SPIRE Agent
  try {
    const spireAvailable = await validateSPIREAgentAvailability();
    components.spire = {
      status: spireAvailable ? 'healthy' : 'degraded',
      message: spireAvailable ? 'Connected' : 'Not available (development mode)',
    };
  } catch {
    components.spire = { status: 'unhealthy', message: 'Connection failed' };
  }

  // Check Workload IAM
  const workloadIAM = getWorkloadIAM();
  const iamReport = workloadIAM.getComplianceReport();
  components.workloadIAM = {
    status: iamReport.enabledPolicies > 0 ? 'healthy' : 'degraded',
    message: `${iamReport.enabledPolicies} active policies`,
  };

  // Check Scope Manager
  const scopeManager = getScopeManager();
  const scopeReport = scopeManager.getComplianceReport();
  components.scopeManager = {
    status: 'healthy',
    message: `${scopeReport.activeGrants} active grants`,
  };

  // Determine overall status
  const statuses = Object.values(components).map(c => c.status);
  const overallStatus = statuses.includes('unhealthy')
    ? 'unhealthy'
    : statuses.includes('degraded')
    ? 'degraded'
    : 'healthy';

  return {
    status: overallStatus,
    components,
  };
}
