/**
 * AEGIS-T2A Cryptographic Utilities
 *
 * Provides hashing, signing, and verification for audit integrity.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

// =============================================================================
// Hashing
// =============================================================================

/**
 * Compute SHA-256 hash of data
 */
export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute SHA-256 hash of an object (JSON-serialized)
 */
export function hashObject(obj: unknown): string {
  const normalized = JSON.stringify(obj, Object.keys(obj as object).sort());
  return sha256(normalized);
}

/**
 * Compute hash of inputs for audit logging
 */
export function hashInputs(inputs: Record<string, unknown>): string {
  return hashObject(inputs);
}

/**
 * Compute hash of outputs for audit logging
 */
export function hashOutputs(outputs: Record<string, unknown>): string {
  return hashObject(outputs);
}

// =============================================================================
// Signing (HMAC-based for simplicity - use asymmetric in production)
// =============================================================================

let signingKey: Buffer | null = null;

/**
 * Initialize the signing key from environment or generate
 */
export function initializeSigningKey(key?: string): void {
  if (key) {
    signingKey = Buffer.from(key, 'hex');
  } else {
    signingKey = randomBytes(32);
  }
}

/**
 * Get the current signing key (for testing)
 */
export function getSigningKey(): Buffer {
  if (!signingKey) {
    initializeSigningKey();
  }
  return signingKey!;
}

/**
 * Sign data with HMAC-SHA256
 */
export function sign(data: string | Buffer): string {
  if (!signingKey) {
    initializeSigningKey();
  }
  return createHmac('sha256', signingKey!).update(data).digest('hex');
}

/**
 * Sign an object (JSON-serialized)
 */
export function signObject(obj: unknown): string {
  const normalized = JSON.stringify(obj, Object.keys(obj as object).sort());
  return sign(normalized);
}

/**
 * Verify a signature
 */
export function verifySignature(data: string | Buffer, signature: string): boolean {
  const expectedSig = sign(data);
  try {
    return timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSig, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Verify an object signature
 */
export function verifyObjectSignature(obj: unknown, signature: string): boolean {
  const normalized = JSON.stringify(obj, Object.keys(obj as object).sort());
  return verifySignature(normalized, signature);
}

// =============================================================================
// Hash Chain
// =============================================================================

/**
 * Compute the next hash in a chain
 */
export function chainHash(previousHash: string, currentData: string): string {
  return sha256(previousHash + currentData);
}

/**
 * Verify a hash chain link
 */
export function verifyChainLink(
  previousHash: string,
  currentData: string,
  expectedHash: string
): boolean {
  const computed = chainHash(previousHash, currentData);
  return computed === expectedHash;
}

// =============================================================================
// Nonce Generation
// =============================================================================

/**
 * Generate a cryptographically secure nonce
 */
export function generateNonce(length: number = 32): string {
  return randomBytes(length).toString('hex');
}

// =============================================================================
// Checksum
// =============================================================================

/**
 * Compute a checksum for a plan manifest
 */
export function computePlanChecksum(plan: {
  planId?: string;
  intentId?: string;
  version?: number;
  steps?: unknown[];
}): string {
  const data = {
    planId: plan.planId ?? '',
    intentId: plan.intentId ?? '',
    version: plan.version ?? 0,
    stepsHash: hashObject(plan.steps ?? []),
  };
  return hashObject(data);
}

// =============================================================================
// Encryption (simple AES-256-GCM for secrets)
// =============================================================================

import { createCipheriv, createDecipheriv } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

let encryptionKey: Buffer | null = null;

/**
 * Initialize encryption key
 */
export function initializeEncryptionKey(key?: string): void {
  if (key) {
    encryptionKey = Buffer.from(key, 'hex');
    if (encryptionKey.length !== 32) {
      throw new Error('Encryption key must be 32 bytes (64 hex characters)');
    }
  } else {
    encryptionKey = randomBytes(32);
  }
}

/**
 * Encrypt data
 */
export function encrypt(plaintext: string): string {
  if (!encryptionKey) {
    initializeEncryptionKey();
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, encryptionKey!, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:encrypted
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt data
 */
export function decrypt(ciphertext: string): string {
  if (!encryptionKey) {
    throw new Error('Encryption key not initialized');
  }

  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format');
  }

  const [ivHex, authTagHex, encrypted] = parts;
  if (!ivHex || !authTagHex || !encrypted) {
    throw new Error('Invalid ciphertext format');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, encryptionKey, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
