/**
 * SPIFFE Identity Registry
 *
 * Central registry linking agent instances to SPIFFE IDs, capabilities, and trust levels.
 * Enables rapid identity lookup and audit trail construction.
 *
 * References:
 * - SPIFFE/SPIRE: https://spiffe.io/docs/
 * - CSA Agentic Trust Framework (Feb 2026): Progressive trust model
 * - Aembit Blended Identity: Composite human:agent:session attribution
 *
 * Architecture:
 * - PostgreSQL backend for durable identity storage
 * - Bi-temporal tracking (valid-time vs recorded-time)
 * - SVID rotation tracking for audit compliance
 * - Capability-based access control (CBAC)
 */

import type { Pool, PoolClient } from 'pg';
import { logger } from '../core/logger.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Agent roles in AEGIS-T2A architecture
 */
export type AgentRole = 'sme' | 'planner' | 'executor' | 'auditor' | 'facilitator';

/**
 * Progressive trust levels per CSA Agentic Trust Framework
 */
export type TrustLevel =
  | 'intern' // Read-only sandbox, learning phase
  | 'junior' // Read + propose, requires approval
  | 'senior' // Scoped execute within budget
  | 'principal'; // Verify + escalate, audit role

/**
 * Identity status lifecycle
 */
export type IdentityStatus =
  | 'active' // Normal operation
  | 'suspended' // Temporarily disabled (e.g., anomaly detected)
  | 'revoked'; // Permanently disabled

/**
 * SPIFFE Identity Record
 */
export interface SPIFFEIdentity {
  /** UUID primary key */
  id: string;

  /** SPIFFE ID in format: spiffe://aegis.io/{plane}/{role}/{instance-id} */
  spiffeId: string;

  /** Agent role */
  agentRole: AgentRole;

  /** Unique agent instance identifier */
  agentInstanceId: string;

  /** Progressive trust level */
  trustLevel: TrustLevel;

  /** Capability set (e.g., ['plan:read', 'plan:write', 'tool:slack']) */
  capabilities: string[];

  /** Current SVID serial number (for rotation tracking) */
  svidSerialNumber: string;

  /** SVID expiration timestamp */
  svidExpiresAt: Date;

  /** Identity creation timestamp */
  createdAt: Date;

  /** Last SVID rotation timestamp */
  lastRotatedAt: Date;

  /** Current status */
  status: IdentityStatus;

  /** Additional metadata (JSON) */
  metadata?: Record<string, unknown>;
}

/**
 * Capability Set Definition
 */
export interface CapabilitySet {
  role: AgentRole;
  trustLevel: TrustLevel;
  capabilities: string[];
}

/**
 * Registration Request
 */
export type RegisterIdentityRequest = Omit<SPIFFEIdentity, 'id' | 'createdAt' | 'lastRotatedAt'>;

/**
 * Rotation Record
 */
export interface RotationRecord {
  spiffeId: string;
  oldSerialNumber: string;
  newSerialNumber: string;
  rotatedAt: Date;
  reason: string;
}

// =============================================================================
// Default Capability Sets
// =============================================================================

/**
 * Default capabilities per role and trust level
 * Following principle of least privilege
 */
export const DEFAULT_CAPABILITIES: Record<AgentRole, Record<TrustLevel, string[]>> = {
  sme: {
    intern: ['intent:read', 'knowledge:read'],
    junior: ['intent:read', 'intent:analyze', 'knowledge:read', 'knowledge:search'],
    senior: ['intent:*', 'knowledge:*'],
    principal: ['intent:*', 'knowledge:*', 'audit:read'],
  },
  planner: {
    intern: ['plan:read', 'tool:discover'],
    junior: ['plan:read', 'plan:write', 'tool:discover', 'simulation:run'],
    senior: ['plan:*', 'tool:*', 'simulation:*'],
    principal: ['plan:*', 'tool:*', 'simulation:*', 'policy:read'],
  },
  executor: {
    intern: ['execution:read', 'sandbox:read'],
    junior: ['execution:read', 'execution:dry-run', 'sandbox:read'],
    senior: ['execution:*', 'sandbox:*', 'tool:execute'],
    principal: ['execution:*', 'sandbox:*', 'tool:*'],
  },
  auditor: {
    intern: ['audit:read'],
    junior: ['audit:read', 'audit:verify'],
    senior: ['audit:*', 'policy:read'],
    principal: ['audit:*', 'policy:*', 'compliance:*'],
  },
  facilitator: {
    intern: ['workflow:read'],
    junior: ['workflow:read', 'workflow:coordinate'],
    senior: ['workflow:*', 'approval:manage'],
    principal: ['workflow:*', 'approval:*', 'governance:*'],
  },
};

// =============================================================================
// SPIFFE Registry
// =============================================================================

export class SPIFFERegistry {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Initialize the SPIFFE registry schema
   */
  async initialize(): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query(`
        -- SPIFFE Identities Table
        CREATE TABLE IF NOT EXISTS spiffe_identities (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          spiffe_id TEXT NOT NULL UNIQUE,
          agent_role TEXT NOT NULL,
          agent_instance_id TEXT NOT NULL UNIQUE,
          trust_level TEXT NOT NULL,
          capabilities TEXT[] NOT NULL,
          svid_serial_number TEXT NOT NULL,
          svid_expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          status TEXT NOT NULL DEFAULT 'active',
          metadata JSONB DEFAULT '{}'::jsonb,

          CONSTRAINT valid_role CHECK (agent_role IN ('sme', 'planner', 'executor', 'auditor', 'facilitator')),
          CONSTRAINT valid_trust_level CHECK (trust_level IN ('intern', 'junior', 'senior', 'principal')),
          CONSTRAINT valid_status CHECK (status IN ('active', 'suspended', 'revoked'))
        );

        -- Indexes for fast lookups
        CREATE INDEX IF NOT EXISTS idx_spiffe_id ON spiffe_identities(spiffe_id);
        CREATE INDEX IF NOT EXISTS idx_agent_instance_id ON spiffe_identities(agent_instance_id);
        CREATE INDEX IF NOT EXISTS idx_status ON spiffe_identities(status);
        CREATE INDEX IF NOT EXISTS idx_expires_at ON spiffe_identities(svid_expires_at);
        CREATE INDEX IF NOT EXISTS idx_role_trust ON spiffe_identities(agent_role, trust_level);

        -- SVID Rotation History (for audit compliance)
        CREATE TABLE IF NOT EXISTS spiffe_rotation_history (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          spiffe_id TEXT NOT NULL REFERENCES spiffe_identities(spiffe_id),
          old_serial_number TEXT NOT NULL,
          new_serial_number TEXT NOT NULL,
          rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reason TEXT NOT NULL,
          metadata JSONB DEFAULT '{}'::jsonb
        );

        CREATE INDEX IF NOT EXISTS idx_rotation_spiffe_id ON spiffe_rotation_history(spiffe_id);
        CREATE INDEX IF NOT EXISTS idx_rotation_timestamp ON spiffe_rotation_history(rotated_at);
      `);

      logger.info('[SPIFFERegistry] Schema initialized successfully');
    } finally {
      client.release();
    }
  }

  /**
   * Register a new SPIFFE identity
   */
  async registerIdentity(request: RegisterIdentityRequest): Promise<SPIFFEIdentity> {
    const result = await this.pool.query<SPIFFEIdentity>(
      `
      INSERT INTO spiffe_identities (
        spiffe_id, agent_role, agent_instance_id, trust_level,
        capabilities, svid_serial_number, svid_expires_at, status, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *,
        created_at AS "createdAt",
        last_rotated_at AS "lastRotatedAt",
        svid_expires_at AS "svidExpiresAt",
        svid_serial_number AS "svidSerialNumber",
        agent_role AS "agentRole",
        agent_instance_id AS "agentInstanceId",
        trust_level AS "trustLevel",
        spiffe_id AS "spiffeId"
    `,
      [
        request.spiffeId,
        request.agentRole,
        request.agentInstanceId,
        request.trustLevel,
        request.capabilities,
        request.svidSerialNumber,
        request.svidExpiresAt,
        request.status,
        JSON.stringify(request.metadata || {}),
      ]
    );

    const identity = result.rows[0];
    logger.info('[SPIFFERegistry] Identity registered', {
      spiffeId: identity.spiffeId,
      agentRole: identity.agentRole,
      trustLevel: identity.trustLevel,
    });

    return identity;
  }

  /**
   * Get identity by SPIFFE ID
   */
  async getIdentity(spiffeId: string): Promise<SPIFFEIdentity | null> {
    const result = await this.pool.query<SPIFFEIdentity>(
      `
      SELECT *,
        created_at AS "createdAt",
        last_rotated_at AS "lastRotatedAt",
        svid_expires_at AS "svidExpiresAt",
        svid_serial_number AS "svidSerialNumber",
        agent_role AS "agentRole",
        agent_instance_id AS "agentInstanceId",
        trust_level AS "trustLevel",
        spiffe_id AS "spiffeId"
      FROM spiffe_identities
      WHERE spiffe_id = $1
    `,
      [spiffeId]
    );

    return result.rows[0] || null;
  }

  /**
   * Get identity by agent instance ID
   */
  async getIdentityByInstance(agentInstanceId: string): Promise<SPIFFEIdentity | null> {
    const result = await this.pool.query<SPIFFEIdentity>(
      `
      SELECT *,
        created_at AS "createdAt",
        last_rotated_at AS "lastRotatedAt",
        svid_expires_at AS "svidExpiresAt",
        svid_serial_number AS "svidSerialNumber",
        agent_role AS "agentRole",
        agent_instance_id AS "agentInstanceId",
        trust_level AS "trustLevel",
        spiffe_id AS "spiffeId"
      FROM spiffe_identities
      WHERE agent_instance_id = $1
    `,
      [agentInstanceId]
    );

    return result.rows[0] || null;
  }

  /**
   * Record SVID rotation
   */
  async recordRotation(
    spiffeId: string,
    newSerialNumber: string,
    expiresAt: Date,
    reason = 'scheduled'
  ): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Get current serial number
      const current = await client.query<{ svidSerialNumber: string }>(
        'SELECT svid_serial_number AS "svidSerialNumber" FROM spiffe_identities WHERE spiffe_id = $1',
        [spiffeId]
      );

      if (current.rows.length === 0) {
        throw new Error(`Identity not found: ${spiffeId}`);
      }

      const oldSerialNumber = current.rows[0].svidSerialNumber;

      // Update identity
      await client.query(
        `
        UPDATE spiffe_identities
        SET svid_serial_number = $2,
            svid_expires_at = $3,
            last_rotated_at = NOW()
        WHERE spiffe_id = $1
      `,
        [spiffeId, newSerialNumber, expiresAt]
      );

      // Record in rotation history
      await client.query(
        `
        INSERT INTO spiffe_rotation_history (spiffe_id, old_serial_number, new_serial_number, reason)
        VALUES ($1, $2, $3, $4)
      `,
        [spiffeId, oldSerialNumber, newSerialNumber, reason]
      );

      await client.query('COMMIT');

      logger.info('[SPIFFERegistry] SVID rotated', {
        spiffeId,
        oldSerial: oldSerialNumber,
        newSerial: newSerialNumber,
        reason,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Suspend an identity (e.g., on anomaly detection)
   */
  async suspendIdentity(spiffeId: string, reason: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE spiffe_identities
      SET status = 'suspended',
          metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{suspension_reason}',
            to_jsonb($2::text),
            true
          ),
          metadata = jsonb_set(
            metadata,
            '{suspended_at}',
            to_jsonb(NOW()::text),
            true
          )
      WHERE spiffe_id = $1
    `,
      [spiffeId, reason]
    );

    logger.warn('[SPIFFERegistry] Identity suspended', { spiffeId, reason });
  }

  /**
   * Revoke an identity permanently
   */
  async revokeIdentity(spiffeId: string, reason: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE spiffe_identities
      SET status = 'revoked',
          metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{revocation_reason}',
            to_jsonb($2::text),
            true
          ),
          metadata = jsonb_set(
            metadata,
            '{revoked_at}',
            to_jsonb(NOW()::text),
            true
          )
      WHERE spiffe_id = $1
    `,
      [spiffeId, reason]
    );

    logger.warn('[SPIFFERegistry] Identity revoked', { spiffeId, reason });
  }

  /**
   * Reactivate a suspended identity
   */
  async reactivateIdentity(spiffeId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE spiffe_identities
      SET status = 'active',
          metadata = metadata - 'suspension_reason' - 'suspended_at'
      WHERE spiffe_id = $1 AND status = 'suspended'
    `,
      [spiffeId]
    );

    logger.info('[SPIFFERegistry] Identity reactivated', { spiffeId });
  }

  /**
   * Get all identities requiring rotation (expiring within threshold)
   */
  async getExpiringIdentities(thresholdMinutes = 15): Promise<SPIFFEIdentity[]> {
    const result = await this.pool.query<SPIFFEIdentity>(
      `
      SELECT *,
        created_at AS "createdAt",
        last_rotated_at AS "lastRotatedAt",
        svid_expires_at AS "svidExpiresAt",
        svid_serial_number AS "svidSerialNumber",
        agent_role AS "agentRole",
        agent_instance_id AS "agentInstanceId",
        trust_level AS "trustLevel",
        spiffe_id AS "spiffeId"
      FROM spiffe_identities
      WHERE status = 'active'
        AND svid_expires_at < NOW() + ($1 || ' minutes')::INTERVAL
      ORDER BY svid_expires_at ASC
    `,
      [thresholdMinutes]
    );

    return result.rows;
  }

  /**
   * Get capabilities for a SPIFFE ID
   */
  async getCapabilities(spiffeId: string): Promise<string[]> {
    const identity = await this.getIdentity(spiffeId);
    return identity?.capabilities || [];
  }

  /**
   * Update trust level (e.g., promotion after performance evaluation)
   */
  async updateTrustLevel(spiffeId: string, newTrustLevel: TrustLevel): Promise<void> {
    const identity = await this.getIdentity(spiffeId);
    if (!identity) {
      throw new Error(`Identity not found: ${spiffeId}`);
    }

    // Update capabilities to match new trust level
    const newCapabilities = DEFAULT_CAPABILITIES[identity.agentRole][newTrustLevel];

    await this.pool.query(
      `
      UPDATE spiffe_identities
      SET trust_level = $2,
          capabilities = $3,
          metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{trust_level_updated_at}',
            to_jsonb(NOW()::text),
            true
          )
      WHERE spiffe_id = $1
    `,
      [spiffeId, newTrustLevel, newCapabilities]
    );

    logger.info('[SPIFFERegistry] Trust level updated', {
      spiffeId,
      oldLevel: identity.trustLevel,
      newLevel: newTrustLevel,
    });
  }

  /**
   * Get all active identities
   */
  async getAllActiveIdentities(): Promise<SPIFFEIdentity[]> {
    const result = await this.pool.query<SPIFFEIdentity>(`
      SELECT *,
        created_at AS "createdAt",
        last_rotated_at AS "lastRotatedAt",
        svid_expires_at AS "svidExpiresAt",
        svid_serial_number AS "svidSerialNumber",
        agent_role AS "agentRole",
        agent_instance_id AS "agentInstanceId",
        trust_level AS "trustLevel",
        spiffe_id AS "spiffeId"
      FROM spiffe_identities
      WHERE status = 'active'
      ORDER BY created_at DESC
    `);

    return result.rows;
  }

  /**
   * Get rotation history for an identity
   */
  async getRotationHistory(spiffeId: string): Promise<RotationRecord[]> {
    const result = await this.pool.query<RotationRecord>(
      `
      SELECT
        spiffe_id AS "spiffeId",
        old_serial_number AS "oldSerialNumber",
        new_serial_number AS "newSerialNumber",
        rotated_at AS "rotatedAt",
        reason
      FROM spiffe_rotation_history
      WHERE spiffe_id = $1
      ORDER BY rotated_at DESC
    `,
      [spiffeId]
    );

    return result.rows;
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let registryInstance: SPIFFERegistry | null = null;

export function getSPIFFERegistry(pool: Pool): SPIFFERegistry {
  if (!registryInstance) {
    registryInstance = new SPIFFERegistry(pool);
  }
  return registryInstance;
}
