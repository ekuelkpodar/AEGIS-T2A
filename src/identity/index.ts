/**
 * AEGIS-T2A Identity Module
 *
 * Zero-trust workload identity based on SPIFFE/SPIRE, implementing
 * Aembit-style workload IAM with hierarchical scopes and full NHI lifecycle.
 *
 * Components:
 * - SPIFFE IDs: Cryptographic identity for every agent/service/workflow
 * - Scopes: Hierarchical authorization (read/write/execute/admin)
 * - Workload IAM: Context-aware access control
 * - NHI Lifecycle: Provision→Rotate→Suspend→Revoke→Decommission
 */

export * from './spiffe.js';
export * from './scopes.js';
export * from './workload-iam.js';
export * from './nhi-lifecycle.js';
export * from './spire-agent.js';
export * from './delegation.js';
export * from './federation.js';
export * from './genealogy.js';
export * from './compliance-report.js';
export * from './rate-limiter.js';
export * from './revocation.js';
export * from './svid-rotation.js';
export * from './bilateral-auth.js';
export * from './capabilities.js';
export * from './observability.js';
export * from './attestors/workload-attestation.js';
export * from './initialization.js';
