/**
 * Control Plane Integration
 *
 * Client libraries for integrating with AEGIS-T2A control plane microservices:
 * - Approval System: Human-in-the-loop approval workflows
 * - Autonomy Manager: Time-limited autonomy leases
 * - Event Store: Immutable audit logging (coming soon)
 * - Policy Engine: OPA-based policy enforcement (coming soon)
 * - Identity Service: Agent registration and PKI (coming soon)
 */

export * from './client.js';
export * from './approval-client.js';
export * from './autonomy-client.js';
