/**
 * Memory Types
 */

export type MemoryType = 'working' | 'semantic' | 'episodic' | 'verified';

export interface MemoryEntry {
  entryId: string;
  namespaceId: string;
  memoryType: MemoryType;
  key: string;
  value: Record<string, unknown>;
  createdAt: string;
  validFrom?: string;
  validTo?: string;
  recordedAt: string;
  confidence?: number;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryQuery {
  namespaceId: string;
  memoryType?: MemoryType;
  keyPrefix?: string;
  validAt?: string;
  limit?: number;
  offset?: number;
}

