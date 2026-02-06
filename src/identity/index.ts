/**
 * AEGIS-T2A Identity & Zero-Trust Security Module
 *
 * Implements SPIFFE/SPIRE-based agent identity, workload IAM,
 * and hierarchical scope-based authorization.
 */

// Core identity types and SPIFFE
export * from './spiffe.js';

// SPIRE Agent integration
export * from './spire-agent.js';

// Workload attestation
export * from './attestors/workload-attestation.js';
export * from './attestors/node-attestation.js';

// IAM and authorization
export * from './workload-iam.js';
export * from './scopes.js';

// Delegation and federation
export * from './delegation.js';
export * from './federation.js';

// Lifecycle management
export * from './nhi-lifecycle.js';

// System initialization
export * from './initialization.js';
