/**
 * Resource Dependency Graph
 *
 * Builds and analyzes dependency relationships between resources to predict
 * cascading failures, identify critical paths, and optimize execution order.
 *
 * Features:
 * - Directed acyclic graph (DAG) construction
 * - Topological sorting for execution order
 * - Critical path analysis
 * - Circular dependency detection
 * - Blast radius calculation via graph traversal
 */

import { componentLogger } from '../core/logger.js';
import type { PlanStep } from '../core/types.js';

const logger = componentLogger('resource-dependency-graph');

// =============================================================================
// Types
// =============================================================================

export interface DependencyNode {
  resourceId: string;
  resourceType: string;
  dependencies: string[]; // resourceIds this depends on
  dependents: string[]; // resourceIds that depend on this
  criticality: 'low' | 'medium' | 'high' | 'critical';
  metadata: Record<string, unknown>;
}

export interface DependencyGraph {
  nodes: Map<string, DependencyNode>;
  edges: Array<{ from: string; to: string; weight: number }>;
  rootNodes: string[];
  leafNodes: string[];
}

export interface CriticalPath {
  path: string[];
  totalWeight: number;
  bottlenecks: string[];
}

export interface CircularDependency {
  cycle: string[];
  severity: 'warning' | 'error';
  description: string;
}

export interface DependencyAnalysis {
  graph: DependencyGraph;
  criticalPaths: CriticalPath[];
  circularDependencies: CircularDependency[];
  executionOrder: string[];
  blastRadiusMap: Map<string, number>;
  metrics: {
    totalNodes: number;
    totalEdges: number;
    avgDependencies: number;
    maxDepth: number;
    parallelizationPotential: number;
  };
}

// =============================================================================
// Resource Dependency Graph Builder
// =============================================================================

export class ResourceDependencyGraphBuilder {
  private nodes = new Map<string, DependencyNode>();

  /**
   * Add resource node
   */
  addNode(
    resourceId: string,
    resourceType: string,
    criticality: DependencyNode['criticality'] = 'medium',
    metadata: Record<string, unknown> = {}
  ): void {
    if (!this.nodes.has(resourceId)) {
      this.nodes.set(resourceId, {
        resourceId,
        resourceType,
        dependencies: [],
        dependents: [],
        criticality,
        metadata,
      });
    }
  }

  /**
   * Add dependency edge
   */
  addDependency(fromResourceId: string, toResourceId: string): void {
    // Ensure both nodes exist
    if (!this.nodes.has(fromResourceId)) {
      this.addNode(fromResourceId, 'unknown');
    }
    if (!this.nodes.has(toResourceId)) {
      this.addNode(toResourceId, 'unknown');
    }

    const fromNode = this.nodes.get(fromResourceId)!;
    const toNode = this.nodes.get(toResourceId)!;

    // Add edge if not already present
    if (!fromNode.dependencies.includes(toResourceId)) {
      fromNode.dependencies.push(toResourceId);
    }

    if (!toNode.dependents.includes(fromResourceId)) {
      toNode.dependents.push(fromResourceId);
    }
  }

  /**
   * Build graph from plan steps
   */
  buildFromPlan(steps: PlanStep[]): void {
    for (const step of steps) {
      // Extract resource from step
      const resourceId = this.extractResourceId(step);
      this.addNode(resourceId, step.toolAdapter, this.inferCriticality(step));

      // Add dependencies from step dependencies
      for (const depStepId of step.dependencies) {
        const depStep = steps.find(s => s.stepId === depStepId);
        if (depStep) {
          const depResourceId = this.extractResourceId(depStep);
          this.addDependency(resourceId, depResourceId);
        }
      }
    }
  }

  /**
   * Build final dependency graph
   */
  build(): DependencyGraph {
    const edges: Array<{ from: string; to: string; weight: number }> = [];

    for (const node of this.nodes.values()) {
      for (const depId of node.dependencies) {
        edges.push({
          from: node.resourceId,
          to: depId,
          weight: this.calculateEdgeWeight(node, this.nodes.get(depId)!),
        });
      }
    }

    const rootNodes = Array.from(this.nodes.values())
      .filter(n => n.dependencies.length === 0)
      .map(n => n.resourceId);

    const leafNodes = Array.from(this.nodes.values())
      .filter(n => n.dependents.length === 0)
      .map(n => n.resourceId);

    return {
      nodes: new Map(this.nodes),
      edges,
      rootNodes,
      leafNodes,
    };
  }

  /**
   * Extract resource ID from step
   */
  private extractResourceId(step: PlanStep): string {
    return (step.parameters['resource_id'] ||
            step.parameters['target'] ||
            step.parameters['identifier'] ||
            step.stepId) as string;
  }

  /**
   * Infer criticality from step
   */
  private inferCriticality(step: PlanStep): DependencyNode['criticality'] {
    if (step.riskLevel === 'destructive') return 'critical';
    if (step.riskLevel === 'high') return 'high';
    if (step.riskLevel === 'medium') return 'medium';
    return 'low';
  }

  /**
   * Calculate edge weight based on criticality
   */
  private calculateEdgeWeight(from: DependencyNode, to: DependencyNode): number {
    const criticalityWeights = {
      low: 1,
      medium: 2,
      high: 3,
      critical: 4,
    };

    return criticalityWeights[from.criticality] + criticalityWeights[to.criticality];
  }
}

// =============================================================================
// Dependency Analyzer
// =============================================================================

export class DependencyAnalyzer {
  /**
   * Analyze dependency graph
   */
  analyze(graph: DependencyGraph): DependencyAnalysis {
    const criticalPaths = this.findCriticalPaths(graph);
    const circularDependencies = this.detectCircularDependencies(graph);
    const executionOrder = this.topologicalSort(graph);
    const blastRadiusMap = this.calculateBlastRadius(graph);

    const metrics = {
      totalNodes: graph.nodes.size,
      totalEdges: graph.edges.length,
      avgDependencies: this.calculateAvgDependencies(graph),
      maxDepth: this.calculateMaxDepth(graph),
      parallelizationPotential: this.calculateParallelizationPotential(graph),
    };

    return {
      graph,
      criticalPaths,
      circularDependencies,
      executionOrder,
      blastRadiusMap,
      metrics,
    };
  }

  /**
   * Find critical paths (longest weighted paths)
   */
  private findCriticalPaths(graph: DependencyGraph): CriticalPath[] {
    const paths: CriticalPath[] = [];

    for (const rootId of graph.rootNodes) {
      const path = this.findLongestPath(graph, rootId);
      if (path) {
        paths.push(path);
      }
    }

    return paths.sort((a, b) => b.totalWeight - a.totalWeight).slice(0, 3);
  }

  /**
   * Find longest weighted path from a node
   */
  private findLongestPath(graph: DependencyGraph, startId: string): CriticalPath | null {
    const visited = new Set<string>();
    let maxPath: string[] = [];
    let maxWeight = 0;

    const dfs = (nodeId: string, currentPath: string[], currentWeight: number): void => {
      if (visited.has(nodeId)) return;

      visited.add(nodeId);
      currentPath.push(nodeId);

      const node = graph.nodes.get(nodeId);
      if (!node || node.dependents.length === 0) {
        // Leaf node
        if (currentWeight > maxWeight) {
          maxWeight = currentWeight;
          maxPath = [...currentPath];
        }
      } else {
        for (const depId of node.dependents) {
          const edge = graph.edges.find(e => e.from === depId && e.to === nodeId);
          const weight = edge?.weight || 1;
          dfs(depId, currentPath, currentWeight + weight);
        }
      }

      currentPath.pop();
      visited.delete(nodeId);
    };

    dfs(startId, [], 0);

    if (maxPath.length === 0) return null;

    // Identify bottlenecks (nodes with high in-degree)
    const bottlenecks = maxPath.filter(id => {
      const node = graph.nodes.get(id);
      return node && node.dependents.length > 2;
    });

    return {
      path: maxPath,
      totalWeight: maxWeight,
      bottlenecks,
    };
  }

  /**
   * Detect circular dependencies
   */
  private detectCircularDependencies(graph: DependencyGraph): CircularDependency[] {
    const cycles: CircularDependency[] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (nodeId: string, path: string[]): boolean => {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      path.push(nodeId);

      const node = graph.nodes.get(nodeId);
      if (node) {
        for (const depId of node.dependencies) {
          if (!visited.has(depId)) {
            if (dfs(depId, path)) {
              return true;
            }
          } else if (recursionStack.has(depId)) {
            // Found cycle
            const cycleStart = path.indexOf(depId);
            const cycle = path.slice(cycleStart);

            cycles.push({
              cycle,
              severity: cycle.some(id => graph.nodes.get(id)?.criticality === 'critical') ? 'error' : 'warning',
              description: `Circular dependency detected: ${cycle.join(' → ')} → ${cycle[0]}`,
            });

            return true;
          }
        }
      }

      path.pop();
      recursionStack.delete(nodeId);
      return false;
    };

    for (const nodeId of graph.nodes.keys()) {
      if (!visited.has(nodeId)) {
        dfs(nodeId, []);
      }
    }

    return cycles;
  }

  /**
   * Topological sort for execution order
   */
  private topologicalSort(graph: DependencyGraph): string[] {
    const order: string[] = [];
    const inDegree = new Map<string, number>();

    // Calculate in-degrees
    for (const nodeId of graph.nodes.keys()) {
      const node = graph.nodes.get(nodeId)!;
      inDegree.set(nodeId, node.dependencies.length);
    }

    // Find nodes with in-degree 0
    const queue: string[] = [];
    for (const [nodeId, degree] of inDegree.entries()) {
      if (degree === 0) {
        queue.push(nodeId);
      }
    }

    // Process queue
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      order.push(nodeId);

      const node = graph.nodes.get(nodeId)!;
      for (const depId of node.dependents) {
        const currentDegree = inDegree.get(depId)! - 1;
        inDegree.set(depId, currentDegree);

        if (currentDegree === 0) {
          queue.push(depId);
        }
      }
    }

    return order;
  }

  /**
   * Calculate blast radius for each node
   */
  private calculateBlastRadius(graph: DependencyGraph): Map<string, number> {
    const blastRadiusMap = new Map<string, number>();

    for (const nodeId of graph.nodes.keys()) {
      const affected = this.getAffectedNodes(graph, nodeId);
      blastRadiusMap.set(nodeId, affected.size);
    }

    return blastRadiusMap;
  }

  /**
   * Get all nodes affected if this node fails
   */
  private getAffectedNodes(graph: DependencyGraph, nodeId: string): Set<string> {
    const affected = new Set<string>();
    const queue = [nodeId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      affected.add(currentId);

      const node = graph.nodes.get(currentId);
      if (node) {
        for (const depId of node.dependents) {
          if (!affected.has(depId)) {
            queue.push(depId);
          }
        }
      }
    }

    return affected;
  }

  /**
   * Calculate average dependencies per node
   */
  private calculateAvgDependencies(graph: DependencyGraph): number {
    if (graph.nodes.size === 0) return 0;

    const totalDeps = Array.from(graph.nodes.values())
      .reduce((sum, node) => sum + node.dependencies.length, 0);

    return totalDeps / graph.nodes.size;
  }

  /**
   * Calculate maximum depth of dependency graph
   */
  private calculateMaxDepth(graph: DependencyGraph): number {
    let maxDepth = 0;

    const getDepth = (nodeId: string, visited: Set<string>): number => {
      if (visited.has(nodeId)) return 0;

      visited.add(nodeId);
      const node = graph.nodes.get(nodeId);

      if (!node || node.dependencies.length === 0) {
        return 0;
      }

      const depths = node.dependencies.map(depId => getDepth(depId, new Set(visited)));
      return 1 + Math.max(...depths, 0);
    };

    for (const nodeId of graph.nodes.keys()) {
      const depth = getDepth(nodeId, new Set());
      maxDepth = Math.max(maxDepth, depth);
    }

    return maxDepth;
  }

  /**
   * Calculate parallelization potential (0-1 scale)
   */
  private calculateParallelizationPotential(graph: DependencyGraph): number {
    if (graph.nodes.size === 0) return 0;

    // Count nodes that can execute in parallel (nodes with same depth)
    const depthMap = new Map<number, number>();

    const getDepth = (nodeId: string, visited: Set<string>): number => {
      if (visited.has(nodeId)) return 0;

      visited.add(nodeId);
      const node = graph.nodes.get(nodeId);

      if (!node || node.dependencies.length === 0) {
        return 0;
      }

      const depths = node.dependencies.map(depId => getDepth(depId, new Set(visited)));
      return 1 + Math.max(...depths, 0);
    };

    for (const nodeId of graph.nodes.keys()) {
      const depth = getDepth(nodeId, new Set());
      depthMap.set(depth, (depthMap.get(depth) || 0) + 1);
    }

    // Calculate average parallelization per level
    const avgParallelism = Array.from(depthMap.values()).reduce((sum, count) => sum + count, 0) / depthMap.size;

    // Normalize to 0-1 scale
    return Math.min(1, avgParallelism / Math.max(3, Math.sqrt(graph.nodes.size)));
  }
}

// =============================================================================
// Singleton
// =============================================================================

export function buildDependencyGraph(steps: PlanStep[]): DependencyGraph {
  const builder = new ResourceDependencyGraphBuilder();
  builder.buildFromPlan(steps);
  return builder.build();
}

export function analyzeDependencyGraph(graph: DependencyGraph): DependencyAnalysis {
  const analyzer = new DependencyAnalyzer();
  return analyzer.analyze(graph);
}
