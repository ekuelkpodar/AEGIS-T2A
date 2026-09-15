import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PolicyEngine } from '../../src/governance/policy/PolicyEngine.js';
import type { PolicyBundle, PolicyRequest } from '../../src/governance/types/index.js';

function makeRequest(): PolicyRequest {
  return {
    agent: {
      agent_id: 'agent-1',
      tenant_id: 'tenant-a',
      role: 'operator',
      scopes: [],
    },
    tool: 'aws',
    action: 'delete-instance',
    parameters: {},
    context: {
      timestamp: new Date(),
      environment: 'test',
      correlation_id: 'test-1',
    },
  };
}

function makeBundle(): PolicyBundle {
  return {
    id: 'approval-test-bundle',
    version: '1.0.0',
    name: 'Approval Test Bundle',
    description: 'Bundle with approval_config on an AWAIT_APPROVAL rule',
    tenant_id: null,
    rules: [
      {
        id: 'destructive-needs-approval',
        name: 'Destructive Needs Approval',
        description: 'Destructive actions require approval',
        priority: 10,
        enabled: true,
        conditions: [{ field: 'action', operator: 'equals', value: 'delete-instance' }],
        effect: { decision: 'AWAIT_APPROVAL', reason_template: 'Approval required' },
        approval_config: {
          required_approvers: ['tenant_admin'],
          min_approvals: 2,
          timeout_seconds: 600,
          notify_channels: ['slack'],
          auto_deny_on_timeout: true,
        },
      },
    ],
    default_decision: 'DENY',
    metadata: {
      created_at: new Date(),
      updated_at: new Date(),
      created_by: 'test',
      checksum: '',
      tags: [],
    },
  };
}

describe('PolicyEngine approval_config plumbing', () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine({
      opa_url: 'http://localhost:1', // unreachable -> local evaluation
      bundle_path: './policies/examples',
      hot_reload: false,
      reload_interval_seconds: 60,
      cache_ttl_seconds: 0,
    });
    engine.addBundle(makeBundle());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves approval_config from local rules in the result metadata', async () => {
    const result = await engine.evaluate(makeRequest());

    expect(result.decision).toBe('AWAIT_APPROVAL');
    const approvalConfig = result.metadata?.['approval_config'] as
      | Record<string, unknown>
      | undefined;
    expect(approvalConfig).toBeDefined();
    expect(approvalConfig?.['min_approvals']).toBe(2);
    expect(approvalConfig?.['timeout_seconds']).toBe(600);
    expect(approvalConfig?.['auto_deny_on_timeout']).toBe(true);
  });

  it('preserves approval_config from OPA responses in the result metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          result: {
            allow: false,
            decision: 'AWAIT_APPROVAL',
            reason: 'OPA says approval required',
            matched_rule: 'opa-approval-rule',
            require_approval: true,
            approval_config: {
              required_approvers: ['tenant_admin'],
              min_approvals: 3,
              timeout_seconds: 1200,
              notify_channels: ['webhook'],
              auto_deny_on_timeout: false,
            },
          },
        }),
      }))
    );

    await engine.initialize();

    const result = await engine.evaluate(makeRequest());

    expect(result.decision).toBe('AWAIT_APPROVAL');
    const approvalConfig = result.metadata?.['approval_config'] as
      | Record<string, unknown>
      | undefined;
    expect(approvalConfig).toBeDefined();
    expect(approvalConfig?.['min_approvals']).toBe(3);
    expect(approvalConfig?.['timeout_seconds']).toBe(1200);
  });
});
