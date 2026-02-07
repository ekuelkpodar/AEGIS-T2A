/**
 * Agent Genealogy Tracking
 *
 * Tracks the parent-child relationships of agent spawning to create
 * a complete audit trail of who spawned whom. Critical for:
 * - Incident response (trace back to root cause)
 * - Authorization (child inherits constraints from parent)
 * - Blast radius analysis (understand full impact)
 *
 * References:
 * - arxiv:2601.13671 (Multi-Agent Orchestration)
 * - SOC 2 CC7.3 (Incident Response)
 */

import { SPIFFEId } from './spiffe.js';
import { logger } from '../core/logger.js';

/**
 * Agent genealogy record
 */
export interface GenealogyRecord {
  spiffeId: string;
  parentSpiffeId?: string;
  children: string[];
  spawnedAt: Date;
  spawnedBy: string;
  purpose: string;
  depth: number; // Distance from root
  metadata?: Record<string, unknown>;
}

/**
 * Agent genealogy manager - tracks agent spawn relationships
 */
export class AgentGenealogy {
  private records: Map<string, GenealogyRecord> = new Map();

  /**
   * Register a new agent in the genealogy tree
   */
  register(
    spiffeId: SPIFFEId,
    options: {
      parentSpiffeId?: SPIFFEId;
      spawnedBy: string;
      purpose: string;
      metadata?: Record<string, unknown>;
    }
  ): GenealogyRecord {
    const spiffeIdStr = spiffeId.toString();
    const parentIdStr = options.parentSpiffeId?.toString();

    // Calculate depth
    let depth = 0;
    if (parentIdStr) {
      const parent = this.records.get(parentIdStr);
      if (parent) {
        depth = parent.depth + 1;
        // Add this agent to parent's children
        parent.children.push(spiffeIdStr);
      }
    }

    const record: GenealogyRecord = {
      spiffeId: spiffeIdStr,
      parentSpiffeId: parentIdStr,
      children: [],
      spawnedAt: new Date(),
      spawnedBy: options.spawnedBy,
      purpose: options.purpose,
      depth,
      metadata: options.metadata,
    };

    this.records.set(spiffeIdStr, record);

    logger.debug('Registered agent in genealogy', {
      spiffeId: spiffeIdStr,
      parentSpiffeId: parentIdStr,
      depth,
    });

    return record;
  }

  /**
   * Get genealogy record for an agent
   */
  get(spiffeId: SPIFFEId | string): GenealogyRecord | undefined {
    const id = typeof spiffeId === 'string' ? spiffeId : spiffeId.toString();
    return this.records.get(id);
  }

  /**
   * Get all ancestors (parent, grandparent, etc.) up to root
   */
  getAncestors(spiffeId: SPIFFEId | string): GenealogyRecord[] {
    const id = typeof spiffeId === 'string' ? spiffeId : spiffeId.toString();
    const ancestors: GenealogyRecord[] = [];
    let current = this.records.get(id);

    while (current?.parentSpiffeId) {
      const parent = this.records.get(current.parentSpiffeId);
      if (!parent) break;
      ancestors.push(parent);
      current = parent;
    }

    return ancestors;
  }

  /**
   * Get all descendants (children, grandchildren, etc.)
   */
  getDescendants(spiffeId: SPIFFEId | string): GenealogyRecord[] {
    const id = typeof spiffeId === 'string' ? spiffeId : spiffeId.toString();
    const descendants: GenealogyRecord[] = [];
    const record = this.records.get(id);

    if (!record) return descendants;

    // BFS to get all descendants
    const queue = [...record.children];
    while (queue.length > 0) {
      const childId = queue.shift()!;
      const child = this.records.get(childId);
      if (child) {
        descendants.push(child);
        queue.push(...child.children);
      }
    }

    return descendants;
  }

  /**
   * Get root ancestor (agent with no parent)
   */
  getRoot(spiffeId: SPIFFEId | string): GenealogyRecord | undefined {
    const ancestors = this.getAncestors(spiffeId);
    return ancestors.length > 0 ? ancestors[ancestors.length - 1] : this.get(spiffeId);
  }

  /**
   * Get full lineage (root -> ... -> current)
   */
  getLineage(spiffeId: SPIFFEId | string): GenealogyRecord[] {
    const ancestors = this.getAncestors(spiffeId);
    const current = this.get(spiffeId);
    
    // Reverse ancestors to get root-first order, then add current
    const lineage = ancestors.reverse();
    if (current) {
      lineage.push(current);
    }

    return lineage;
  }

  /**
   * Check if one agent is an ancestor of another
   */
  isAncestor(
    potentialAncestor: SPIFFEId | string,
    descendant: SPIFFEId | string
  ): boolean {
    const ancestorId = typeof potentialAncestor === 'string' 
      ? potentialAncestor 
      : potentialAncestor.toString();
    
    const ancestors = this.getAncestors(descendant);
    return ancestors.some(a => a.spiffeId === ancestorId);
  }

  /**
   * Get genealogy tree visualization (for debugging/auditing)
   */
  visualizeTree(rootSpiffeId?: SPIFFEId | string): string {
    const roots = rootSpiffeId 
      ? [this.get(rootSpiffeId)]
      : Array.from(this.records.values()).filter(r => !r.parentSpiffeId);

    let tree = 'Agent Genealogy Tree:\n';
    for (const root of roots) {
      if (root) {
        tree += this.visualizeNode(root, 0);
      }
    }
    return tree;
  }

  private visualizeNode(record: GenealogyRecord, indent: number): string {
    const prefix = '  '.repeat(indent);
    let result = `${prefix}├─ ${record.spiffeId} (${record.purpose})\n`;

    for (const childId of record.children) {
      const child = this.records.get(childId);
      if (child) {
        result += this.visualizeNode(child, indent + 1);
      }
    }

    return result;
  }

  /**
   * Calculate total blast radius (count all descendants)
   */
  calculateBlastRadius(spiffeId: SPIFFEId | string): number {
    return this.getDescendants(spiffeId).length;
  }

  /**
   * Get agents spawned by a specific actor
   */
  getBySpawnedBy(actor: string): GenealogyRecord[] {
    return Array.from(this.records.values()).filter(r => r.spawnedBy === actor);
  }

  /**
   * Get all root agents (no parent)
   */
  getRoots(): GenealogyRecord[] {
    return Array.from(this.records.values()).filter(r => !r.parentSpiffeId);
  }

  /**
   * Export genealogy for audit/compliance
   */
  exportGenealogy(): {
    totalAgents: number;
    roots: number;
    maxDepth: number;
    avgChildrenPerAgent: number;
    records: GenealogyRecord[];
  } {
    const records = Array.from(this.records.values());
    const roots = records.filter(r => !r.parentSpiffeId).length;
    const maxDepth = Math.max(...records.map(r => r.depth), 0);
    const totalChildren = records.reduce((sum, r) => sum + r.children.length, 0);
    const avgChildrenPerAgent = records.length > 0 ? totalChildren / records.length : 0;

    return {
      totalAgents: records.length,
      roots,
      maxDepth,
      avgChildrenPerAgent,
      records,
    };
  }
}

/**
 * Singleton instance
 */
let agentGenealogy: AgentGenealogy;

export function getAgentGenealogy(): AgentGenealogy {
  if (!agentGenealogy) {
    agentGenealogy = new AgentGenealogy();
  }
  return agentGenealogy;
}
