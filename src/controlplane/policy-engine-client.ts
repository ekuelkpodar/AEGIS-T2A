/**
 * Policy Engine Client
 *
 * Client for the AEGIS-T2A Policy Engine microservice.
 * Provides OPA (Open Policy Agent) based policy enforcement with Rego policies.
 */

import { ControlPlaneClient, ControlPlaneConfig } from './client.js';
import { logger } from '../core/logger.js';

export enum PolicyVerdict {
  ALLOW = 'allow',
  DENY = 'deny',
  REQUIRE_APPROVAL = 'require_approval',
}

export interface Policy {
  policyId: string;
  name: string;
  description?: string;
  version: string;
  rego: string; // Rego policy code
  enabled: boolean;
  priority: number;
  appliesTo: string[]; // Resource patterns
  createdAt: string;
  updatedAt?: string;
  createdBy: string;
}

export interface PolicyEvaluationRequest {
  workflowId: string;
  action: string;
  resource: string;
  actor: {
    id: string;
    type: 'user' | 'agent' | 'system';
    roles?: string[];
  };
  context: {
    time?: string;
    location?: string;
    riskScore?: number;
    blastRadius?: number;
    environment?: string;
    [key: string]: unknown;
  };
}

export interface PolicyEvaluationResult {
  verdict: PolicyVerdict;
  matchedPolicies: string[];
  reason?: string;
  requiredApprovers?: string[];
  restrictions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface PolicyTestCase {
  name: string;
  input: PolicyEvaluationRequest;
  expectedVerdict: PolicyVerdict;
  expectedReason?: string;
}

export class PolicyEngineClient extends ControlPlaneClient {
  constructor(config?: Partial<ControlPlaneConfig>) {
    super({
      baseUrl:
        config?.baseUrl || process.env.POLICY_ENGINE_URL || 'http://localhost:8002',
      ...config,
    });
  }

  /**
   * Create or update a policy
   */
  async createPolicy(policy: {
    name: string;
    description?: string;
    rego: string;
    priority?: number;
    appliesTo?: string[];
    enabled?: boolean;
  }): Promise<Policy> {
    logger.info('Creating policy', {
      name: policy.name,
      priority: policy.priority,
    });

    const response = await this.post<{ policy: Policy }>('/api/v1/policies', {
      name: policy.name,
      description: policy.description,
      rego: policy.rego,
      priority: policy.priority || 100,
      applies_to: policy.appliesTo || ['*'],
      enabled: policy.enabled !== false,
    });

    return response.policy;
  }

  /**
   * Get policy by ID
   */
  async getPolicy(policyId: string): Promise<Policy> {
    const response = await this.get<{ policy: Policy }>(
      `/api/v1/policies/${policyId}`
    );

    return response.policy;
  }

  /**
   * List all policies
   */
  async listPolicies(filters?: {
    enabled?: boolean;
    appliesTo?: string;
  }): Promise<Policy[]> {
    const params: Record<string, string> = {};

    if (filters?.enabled !== undefined) {
      params.enabled = filters.enabled.toString();
    }
    if (filters?.appliesTo) {
      params.applies_to = filters.appliesTo;
    }

    const response = await this.get<{ policies: Policy[] }>(
      '/api/v1/policies',
      params
    );

    return response.policies;
  }

  /**
   * Update a policy
   */
  async updatePolicy(
    policyId: string,
    updates: {
      rego?: string;
      enabled?: boolean;
      priority?: number;
      description?: string;
    }
  ): Promise<Policy> {
    logger.info('Updating policy', { policyId, updates });

    const response = await this.put<{ policy: Policy }>(
      `/api/v1/policies/${policyId}`,
      updates
    );

    return response.policy;
  }

  /**
   * Delete a policy
   */
  async deletePolicy(policyId: string): Promise<void> {
    logger.warn('Deleting policy', { policyId });

    await this.delete(`/api/v1/policies/${policyId}`);
  }

  /**
   * Evaluate a request against all policies
   */
  async evaluate(request: PolicyEvaluationRequest): Promise<PolicyEvaluationResult> {
    logger.debug('Evaluating policies', {
      workflowId: request.workflowId,
      action: request.action,
      resource: request.resource,
      actorId: request.actor.id,
    });

    const response = await this.post<{ result: PolicyEvaluationResult }>(
      '/api/v1/evaluate',
      {
        workflow_id: request.workflowId,
        action: request.action,
        resource: request.resource,
        actor: request.actor,
        context: request.context,
      }
    );

    if (response.result.verdict === PolicyVerdict.DENY) {
      logger.warn('Policy evaluation denied', {
        workflowId: request.workflowId,
        action: request.action,
        resource: request.resource,
        reason: response.result.reason,
        matchedPolicies: response.result.matchedPolicies,
      });
    }

    return response.result;
  }

  /**
   * Batch evaluate multiple requests
   */
  async evaluateBatch(
    requests: PolicyEvaluationRequest[]
  ): Promise<PolicyEvaluationResult[]> {
    logger.debug('Batch evaluating policies', { count: requests.length });

    const response = await this.post<{ results: PolicyEvaluationResult[] }>(
      '/api/v1/evaluate/batch',
      { requests }
    );

    return response.results;
  }

  /**
   * Test a policy with test cases
   */
  async testPolicy(
    policyId: string,
    testCases: PolicyTestCase[]
  ): Promise<{
    passed: number;
    failed: number;
    results: Array<{
      testCase: string;
      passed: boolean;
      actualVerdict: PolicyVerdict;
      expectedVerdict: PolicyVerdict;
      error?: string;
    }>;
  }> {
    logger.info('Testing policy', { policyId, testCases: testCases.length });

    const response = await this.post<{
      summary: {
        passed: number;
        failed: number;
      };
      results: Array<{
        test_case: string;
        passed: boolean;
        actual_verdict: PolicyVerdict;
        expected_verdict: PolicyVerdict;
        error?: string;
      }>;
    }>(`/api/v1/policies/${policyId}/test`, {
      test_cases: testCases.map(tc => ({
        name: tc.name,
        input: tc.input,
        expected_verdict: tc.expectedVerdict,
        expected_reason: tc.expectedReason,
      })),
    });

    return {
      passed: response.summary.passed,
      failed: response.summary.failed,
      results: response.results.map(r => ({
        testCase: r.test_case,
        passed: r.passed,
        actualVerdict: r.actual_verdict,
        expectedVerdict: r.expected_verdict,
        error: r.error,
      })),
    };
  }

  /**
   * Validate Rego policy syntax
   */
  async validateRego(rego: string): Promise<{
    valid: boolean;
    errors?: string[];
  }> {
    const response = await this.post<{
      valid: boolean;
      errors?: string[];
    }>('/api/v1/policies/validate', { rego });

    return response;
  }

  /**
   * Get policy evaluation statistics
   */
  async getPolicyStats(timeRange?: {
    start: Date;
    end: Date;
  }): Promise<{
    totalEvaluations: number;
    byVerdict: Record<PolicyVerdict, number>;
    byPolicy: Record<string, number>;
    avgEvaluationTime: number;
    denialRate: number;
  }> {
    const params: Record<string, string> = {};

    if (timeRange) {
      params.start = timeRange.start.toISOString();
      params.end = timeRange.end.toISOString();
    }

    const response = await this.get<{
      stats: {
        total_evaluations: number;
        by_verdict: Record<PolicyVerdict, number>;
        by_policy: Record<string, number>;
        avg_evaluation_time: number;
        denial_rate: number;
      };
    }>('/api/v1/policies/stats', params);

    return {
      totalEvaluations: response.stats.total_evaluations,
      byVerdict: response.stats.by_verdict,
      byPolicy: response.stats.by_policy,
      avgEvaluationTime: response.stats.avg_evaluation_time,
      denialRate: response.stats.denial_rate,
    };
  }

  /**
   * Export all policies for backup
   */
  async exportPolicies(): Promise<{
    policies: Policy[];
    exportedAt: string;
    version: string;
  }> {
    logger.info('Exporting all policies');

    const response = await this.get<{
      policies: Policy[];
      exported_at: string;
      version: string;
    }>('/api/v1/policies/export');

    return {
      policies: response.policies,
      exportedAt: response.exported_at,
      version: response.version,
    };
  }

  /**
   * Import policies from backup
   */
  async importPolicies(
    policies: Policy[],
    options?: {
      overwrite?: boolean;
      validate?: boolean;
    }
  ): Promise<{
    imported: number;
    skipped: number;
    errors: string[];
  }> {
    logger.info('Importing policies', {
      count: policies.length,
      overwrite: options?.overwrite,
    });

    const response = await this.post<{
      imported: number;
      skipped: number;
      errors: string[];
    }>('/api/v1/policies/import', {
      policies,
      overwrite: options?.overwrite || false,
      validate: options?.validate !== false,
    });

    return response;
  }

  /**
   * Create a default set of policies for common scenarios
   */
  async createDefaultPolicies(): Promise<Policy[]> {
    logger.info('Creating default policies');

    const defaultPolicies = [
      {
        name: 'Production Write Protection',
        description: 'Require approval for write operations in production',
        rego: `
package aegis

default verdict = "allow"

verdict = "require_approval" {
  input.context.environment == "production"
  input.action == "write"
}

verdict = "require_approval" {
  input.context.environment == "production"
  input.action == "delete"
}
`,
        priority: 200,
        appliesTo: ['*'],
      },
      {
        name: 'High Risk Blast Radius',
        description: 'Require approval for actions with high blast radius',
        rego: `
package aegis

default verdict = "allow"

verdict = "require_approval" {
  input.context.blastRadius >= 70
}

verdict = "deny" {
  input.context.blastRadius >= 90
  input.actor.type != "user"
}
`,
        priority: 300,
        appliesTo: ['*'],
      },
      {
        name: 'Business Hours Only',
        description: 'Restrict sensitive operations to business hours',
        rego: `
package aegis

import future.keywords.in

default verdict = "allow"

verdict = "deny" {
  hour := time.clock([time.now_ns(), "America/Los_Angeles"])[0]
  not hour in [9, 10, 11, 12, 13, 14, 15, 16, 17]
  input.context.riskScore >= 60
}
`,
        priority: 150,
        appliesTo: ['*'],
      },
    ];

    const created: Policy[] = [];
    for (const policyDef of defaultPolicies) {
      const policy = await this.createPolicy(policyDef);
      created.push(policy);
    }

    return created;
  }
}

// Singleton instance
let policyEngineClient: PolicyEngineClient;

export function getPolicyEngineClient(
  config?: Partial<ControlPlaneConfig>
): PolicyEngineClient {
  if (!policyEngineClient) {
    policyEngineClient = new PolicyEngineClient(config);
  }
  return policyEngineClient;
}
