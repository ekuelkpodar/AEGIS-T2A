/**
 * AEGIS-T2A Secrets Vault
 *
 * Ephemeral credentials with short TTL and zero-trust enforcement.
 */

import { EphemeralCredential } from '../core/types.js';
import { generateCredentialId } from '../core/ids.js';
import { componentLogger } from '../core/logger.js';
import { execute, queryOne, queryAll } from '../core/database.js';
import { encrypt, decrypt, signObject, generateNonce as cryptoNonce } from '../core/crypto.js';
import { getConfig } from '../core/config.js';

const logger = componentLogger('secrets');

// =============================================================================
// Types
// =============================================================================

export interface CredentialRequest {
  workflowId: string;
  stepId: string;
  scope: string[];
  ttlSeconds?: number;
}

export interface CredentialResult {
  success: boolean;
  credential?: EphemeralCredential;
  value?: string;
  error?: string;
}

// =============================================================================
// Secrets Vault
// =============================================================================

export class SecretsVault {
  private initialized = false;
  private config = getConfig();
  private secrets = new Map<string, string>();

  /**
   * Initialize the vault
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Clean up expired credentials
    await this.cleanupExpired();

    this.initialized = true;
    logger.info('Secrets vault initialized');
  }

  /**
   * Store a secret (for bootstrapping)
   */
  storeSecret(name: string, value: string): void {
    this.secrets.set(name, value);
    logger.info({ name }, 'Secret stored');
  }

  /**
   * Issue an ephemeral credential
   */
  async issueCredential(request: CredentialRequest): Promise<CredentialResult> {
    try {
      const credentialId = generateCredentialId();
      const nonce = cryptoNonce();
      const now = new Date();
      const ttl = request.ttlSeconds ?? this.config.secretsTtlSeconds;
      const expiresAt = new Date(now.getTime() + ttl * 1000);

      // Generate the credential value (in production, this would fetch from actual secret store)
      const credentialValue = this.generateCredentialValue(request.scope);

      // Encrypt the credential value
      const encryptedValue = encrypt(credentialValue);

      // Build credential metadata
      const credential: EphemeralCredential = {
        credentialId,
        workflowId: request.workflowId,
        stepId: request.stepId,
        scope: request.scope,
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        nonce,
        signature: '',
      };

      // Sign the credential
      credential.signature = signObject(credential);

      // Persist to database
      execute(
        `INSERT INTO ephemeral_credentials
         (credential_id, workflow_id, step_id, scope, encrypted_value, nonce, issued_at, expires_at, revoked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          credential.credentialId,
          credential.workflowId,
          credential.stepId,
          JSON.stringify(credential.scope),
          encryptedValue,
          credential.nonce,
          credential.issuedAt,
          credential.expiresAt,
        ]
      );

      logger.info(
        {
          credentialId,
          workflowId: request.workflowId,
          stepId: request.stepId,
          scope: request.scope,
          ttl,
        },
        'Credential issued'
      );

      return {
        success: true,
        credential,
        value: credentialValue,
      };
    } catch (error) {
      logger.error({ error, request }, 'Failed to issue credential');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Credential issuance failed',
      };
    }
  }

  /**
   * Retrieve a credential value
   */
  async getCredential(credentialId: string, nonce: string): Promise<CredentialResult> {
    const row = queryOne<{
      credential_id: string;
      workflow_id: string;
      step_id: string;
      scope: string;
      encrypted_value: string;
      nonce: string;
      issued_at: string;
      expires_at: string;
      revoked: number;
    }>('SELECT * FROM ephemeral_credentials WHERE credential_id = ?', [credentialId]);

    if (!row) {
      return { success: false, error: 'Credential not found' };
    }

    if (row.revoked === 1) {
      return { success: false, error: 'Credential has been revoked' };
    }

    if (new Date(row.expires_at) < new Date()) {
      return { success: false, error: 'Credential has expired' };
    }

    if (row.nonce !== nonce) {
      logger.warn({ credentialId }, 'Invalid nonce for credential access');
      return { success: false, error: 'Invalid nonce' };
    }

    try {
      const value = decrypt(row.encrypted_value);

      const credential: EphemeralCredential = {
        credentialId: row.credential_id,
        workflowId: row.workflow_id,
        stepId: row.step_id,
        scope: JSON.parse(row.scope),
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
        nonce: row.nonce,
        signature: '',
      };

      return {
        success: true,
        credential,
        value,
      };
    } catch (error) {
      logger.error({ error, credentialId }, 'Failed to decrypt credential');
      return { success: false, error: 'Failed to decrypt credential' };
    }
  }

  /**
   * Revoke a credential
   */
  async revokeCredential(credentialId: string): Promise<void> {
    execute(
      'UPDATE ephemeral_credentials SET revoked = 1 WHERE credential_id = ?',
      [credentialId]
    );

    logger.info({ credentialId }, 'Credential revoked');
  }

  /**
   * Revoke all credentials for a workflow
   */
  async revokeWorkflowCredentials(workflowId: string): Promise<number> {
    const result = execute(
      'UPDATE ephemeral_credentials SET revoked = 1 WHERE workflow_id = ? AND revoked = 0',
      [workflowId]
    );

    logger.info({ workflowId, count: result.changes }, 'Workflow credentials revoked');

    return result.changes;
  }

  /**
   * Clean up expired credentials
   */
  async cleanupExpired(): Promise<number> {
    const result = execute(
      'DELETE FROM ephemeral_credentials WHERE expires_at < ?',
      [new Date().toISOString()]
    );

    if (result.changes > 0) {
      logger.info({ count: result.changes }, 'Expired credentials cleaned up');
    }

    return result.changes;
  }

  /**
   * Validate a credential's scope
   */
  validateScope(credential: EphemeralCredential, requiredScope: string[]): boolean {
    return requiredScope.every((scope) => credential.scope.includes(scope));
  }

  /**
   * Generate a credential value for the requested scope
   */
  private generateCredentialValue(scope: string[]): string {
    // In production, this would:
    // 1. Contact the actual secrets manager (Vault, AWS Secrets Manager, etc.)
    // 2. Request credentials with the specified scope
    // 3. Return actual API keys, tokens, etc.

    // For now, return a mock credential
    const mockCredential = {
      type: 'ephemeral_token',
      scope,
      token: `eph_${cryptoNonce(16)}`,
      generatedAt: new Date().toISOString(),
    };

    return JSON.stringify(mockCredential);
  }

  /**
   * Get statistics about credentials
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    expired: number;
    revoked: number;
  }> {
    const now = new Date().toISOString();

    const total = queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM ephemeral_credentials'
    )?.count ?? 0;

    const active = queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM ephemeral_credentials WHERE revoked = 0 AND expires_at > ?',
      [now]
    )?.count ?? 0;

    const expired = queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM ephemeral_credentials WHERE expires_at <= ?',
      [now]
    )?.count ?? 0;

    const revoked = queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM ephemeral_credentials WHERE revoked = 1'
    )?.count ?? 0;

    return { total, active, expired, revoked };
  }
}

// =============================================================================
// Singleton
// =============================================================================

let vault: SecretsVault | null = null;

export function getSecretsVault(): SecretsVault {
  if (!vault) {
    vault = new SecretsVault();
  }
  return vault;
}

export async function initializeSecretsVault(): Promise<SecretsVault> {
  const v = getSecretsVault();
  await v.initialize();
  return v;
}
