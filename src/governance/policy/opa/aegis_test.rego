# =============================================================================
# Tests for the AEGIS-T2A runtime authorization policy (aegis.rego)
#
# Run with: opa test policies src/governance/policy/opa
# =============================================================================

package aegis.authz

base_input := {
	"agent": {
		"id": "agent-1",
		"tenant_id": "tenant-a",
		"role": "operator",
		"scopes": ["aws:*"],
	},
	"action": {
		"tool": "aws",
		"action": "describe-instances",
		"parameters": {},
	},
	"context": {
		"timestamp": "2026-09-15T00:00:00Z",
		"environment": "test",
		"correlation_id": "test-1",
	},
}

# System admin bypasses all rules
test_system_admin_full_access if {
	decision := data.aegis.authz.decision with input as object.union(base_input, {
		"agent": {"id": "root", "tenant_id": "t", "role": "system_admin", "scopes": ["*"]},
	})
	decision.decision == "ALLOW"
	decision.matched_rule == "system-admin-full-access"
}

# Budget exhaustion denies
test_budget_exceeded_deny if {
	ctx := object.union(base_input.context, {"budget_usage": {"limit_exceeded": true}})
	decision := data.aegis.authz.decision with input as object.union(base_input, {"context": ctx})
	decision.decision == "DENY"
	decision.matched_rule == "budget-exceeded"
}

# Rate limiting denies
test_rate_limited_deny if {
	ctx := object.union(base_input.context, {"rate_status": {"rate_limited": true}})
	decision := data.aegis.authz.decision with input as object.union(base_input, {"context": ctx})
	decision.decision == "DENY"
	decision.matched_rule == "rate-limited"
}

# Restricted role cannot perform writes
test_restricted_deny_writes if {
	action := {"tool": "aws", "action": "create-instance", "parameters": {}}
	decision := data.aegis.authz.decision with input as object.union(base_input, {
		"agent": {"id": "r1", "tenant_id": "t", "role": "restricted", "scopes": []},
		"action": action,
	})
	decision.decision == "DENY"
	decision.matched_rule == "restricted-deny-writes"
}

# Read operations allowed for authenticated roles (cloud prefixed read actions)
test_read_operation_allowed if {
	decision := data.aegis.authz.decision with input as base_input
	decision.decision == "ALLOW"
	decision.matched_rule == "cloud-read-operations"
}

# Plain read actions hit the generic read rule
test_generic_read_operation_allowed if {
	action := {"tool": "filesystem", "action": "read", "parameters": {}}
	decision := data.aegis.authz.decision with input as object.union(base_input, {"action": action})
	decision.decision == "ALLOW"
	decision.matched_rule == "allow-read-operations"
}

# Destructive cloud operations require approval and carry approval_config
test_destructive_requires_approval_with_config if {
	action := {"tool": "aws", "action": "delete-instance", "parameters": {}}
	decision := data.aegis.authz.decision with input as object.union(base_input, {"action": action})
	decision.decision == "AWAIT_APPROVAL"
	decision.require_approval == true
	decision.approval_config.min_approvals == 1
	decision.approval_config.timeout_seconds == 3600
	count(decision.approval_config.required_approvers) > 0
}

# Default: no matching rule -> deny
test_default_deny if {
	action := {"tool": "unknown-tool", "action": "frobnicate", "parameters": {}}
	decision := data.aegis.authz.decision with input as object.union(base_input, {"action": action})
	decision.decision == "DENY"
}
