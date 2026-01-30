# ==============================================================================
# AEGIS-T2A OPA Policy
#
# Open Policy Agent (OPA) policy for runtime authorization decisions.
# This policy implements:
# - Role-based access control (RBAC)
# - Tool and action-based permissions
# - Budget and rate limit enforcement
# - Parameter validation and sanitization
# - Approval workflow triggers
# ==============================================================================

package aegis.authz

import future.keywords.in
import future.keywords.if
import future.keywords.contains

# Default deny
default decision = {
    "allow": false,
    "decision": "DENY",
    "reason": "No matching policy rule found",
    "matched_rule": null
}

# ==============================================================================
# Main Decision Logic
# ==============================================================================

# System admin always allowed
decision = result if {
    input.agent.role == "system_admin"
    result := {
        "allow": true,
        "decision": "ALLOW",
        "reason": sprintf("System admin %s granted full access", [input.agent.id]),
        "matched_rule": "system-admin-full-access"
    }
}

# Check budget exceeded
decision = result if {
    input.context.budget_usage
    input.context.budget_usage.limit_exceeded == true
    result := {
        "allow": false,
        "decision": "DENY",
        "reason": "Budget exceeded - request denied",
        "matched_rule": "budget-exceeded"
    }
}

# Check rate limit exceeded
decision = result if {
    input.context.rate_status
    input.context.rate_status.rate_limited == true
    result := {
        "allow": false,
        "decision": "DENY",
        "reason": "Rate limit exceeded - request denied",
        "matched_rule": "rate-limited"
    }
}

# Restricted role can only read
decision = result if {
    input.agent.role == "restricted"
    not is_read_action
    result := {
        "allow": false,
        "decision": "DENY",
        "reason": sprintf("Restricted role cannot perform '%s'", [input.action.action]),
        "matched_rule": "restricted-deny-writes"
    }
}

# Allow read operations for all authenticated users
decision = result if {
    is_read_action
    result := {
        "allow": true,
        "decision": "ALLOW",
        "reason": sprintf("Read operation '%s' allowed", [input.action.action]),
        "matched_rule": "allow-read-operations"
    }
}

# Destructive operations require approval
decision = result if {
    is_destructive_action
    is_cloud_tool
    result := {
        "allow": false,
        "decision": "AWAIT_APPROVAL",
        "reason": sprintf("Destructive operation '%s' on %s requires approval", [input.action.action, input.action.tool]),
        "matched_rule": "cloud-destructive-require-approval",
        "require_approval": true,
        "approval_config": {
            "required_approvers": ["tenant_admin", "operator"],
            "min_approvals": 1,
            "timeout_seconds": 3600,
            "notify_channels": ["slack", "webhook"]
        }
    }
}

# Cloud create operations for operators
decision = result if {
    is_cloud_tool
    is_create_action
    has_operator_role
    result := {
        "allow": true,
        "decision": "ALLOW",
        "reason": sprintf("Cloud create operation '%s' allowed for %s", [input.action.action, input.agent.role]),
        "matched_rule": "cloud-create-operations"
    }
}

# Cloud read operations
decision = result if {
    is_cloud_tool
    is_cloud_read_action
    has_read_role
    result := {
        "allow": true,
        "decision": "ALLOW",
        "reason": "Cloud read operation allowed",
        "matched_rule": "cloud-read-operations"
    }
}

# LLM operations for authorized roles
decision = result if {
    input.action.tool == "llm"
    input.action.action in ["complete", "chat", "generate"]
    has_operator_role
    result := {
        "allow": true,
        "decision": "ALLOW",
        "reason": sprintf("LLM operation allowed for %s", [input.agent.role]),
        "matched_rule": "llm-allow-inference"
    }
}

# Database read operations
decision = result if {
    input.action.tool == "database"
    input.action.action in ["select", "query", "count"]
    has_operator_role
    result := {
        "allow": true,
        "decision": "ALLOW",
        "reason": "Database read allowed",
        "matched_rule": "database-read-operations"
    }
}

# Database write operations
decision = result if {
    input.action.tool == "database"
    input.action.action in ["insert", "update"]
    has_operator_role
    result := {
        "allow": true,
        "decision": "ALLOW",
        "reason": sprintf("Database write allowed for %s", [input.agent.role]),
        "matched_rule": "database-write-operations"
    }
}

# Database delete requires approval
decision = result if {
    input.action.tool == "database"
    input.action.action in ["delete", "drop", "truncate"]
    result := {
        "allow": false,
        "decision": "AWAIT_APPROVAL",
        "reason": "Database delete operation requires approval",
        "matched_rule": "database-delete-require-approval",
        "require_approval": true,
        "approval_config": {
            "required_approvers": ["tenant_admin"],
            "min_approvals": 1,
            "timeout_seconds": 1800,
            "notify_channels": ["slack"]
        }
    }
}

# Development environment - more permissive
decision = result if {
    input.context.environment == "development"
    input.agent.role in ["developer", "operator", "tenant_admin", "system_admin"]
    result := {
        "allow": true,
        "decision": "ALLOW",
        "reason": "Development environment - action allowed",
        "matched_rule": "dev-environment-allow"
    }
}

# ==============================================================================
# Parameter Sanitization
# ==============================================================================

# Check if parameters need modification
needs_modification if {
    has_sensitive_parameters
}

# Get modified parameters
modifications = mods if {
    needs_modification
    mods := sanitize_parameters(input.action.parameters)
}

# Sanitize sensitive parameters
sanitize_parameters(params) = result if {
    result := {k: sanitize_value(k, v) | some k; v := params[k]}
}

sanitize_value(key, value) = "[REDACTED]" if {
    is_sensitive_key(key)
} else = value

is_sensitive_key(key) if {
    lower(key) in ["password", "secret", "api_key", "apikey", "token", "credentials", "private_key"]
}

is_sensitive_key(key) if {
    contains(lower(key), "password")
}

is_sensitive_key(key) if {
    contains(lower(key), "secret")
}

has_sensitive_parameters if {
    some key
    input.action.parameters[key]
    is_sensitive_key(key)
}

# ==============================================================================
# Helper Rules
# ==============================================================================

# Read actions
is_read_action if {
    input.action.action in ["get", "list", "read", "describe", "status", "health", "ping"]
}

# Create actions
is_create_action if {
    startswith(input.action.action, "create")
}

is_create_action if {
    startswith(input.action.action, "launch")
}

is_create_action if {
    startswith(input.action.action, "start")
}

is_create_action if {
    startswith(input.action.action, "deploy")
}

# Destructive actions
is_destructive_action if {
    startswith(input.action.action, "delete")
}

is_destructive_action if {
    startswith(input.action.action, "terminate")
}

is_destructive_action if {
    startswith(input.action.action, "destroy")
}

is_destructive_action if {
    startswith(input.action.action, "remove")
}

# Cloud read actions
is_cloud_read_action if {
    startswith(input.action.action, "describe")
}

is_cloud_read_action if {
    startswith(input.action.action, "list")
}

is_cloud_read_action if {
    startswith(input.action.action, "get")
}

# Cloud tools
is_cloud_tool if {
    input.action.tool in ["aws", "azure", "gcp", "kubernetes"]
}

# Role checks
has_operator_role if {
    input.agent.role in ["system_admin", "tenant_admin", "operator", "developer"]
}

has_read_role if {
    input.agent.role in ["system_admin", "tenant_admin", "operator", "developer", "readonly"]
}

# ==============================================================================
# Scope Validation
# ==============================================================================

# Check if agent has required scope
has_scope(required_scope) if {
    input.agent.scopes[_] == "*"
}

has_scope(required_scope) if {
    input.agent.scopes[_] == required_scope
}

has_scope(required_scope) if {
    # Check wildcard scopes like "aws:*"
    some scope in input.agent.scopes
    prefix := concat("", [split(required_scope, ":")[0], ":*"])
    scope == prefix
}

# Tool-specific scope check
tool_scope_allowed if {
    required := sprintf("%s:*", [input.action.tool])
    has_scope(required)
}

tool_scope_allowed if {
    required := sprintf("%s:%s", [input.action.tool, input.action.action])
    has_scope(required)
}

# ==============================================================================
# Budget and Rate Limit Checks
# ==============================================================================

budget_available if {
    not input.context.budget_usage
}

budget_available if {
    input.context.budget_usage
    input.context.budget_usage.remaining > 0
}

rate_limit_ok if {
    not input.context.rate_status
}

rate_limit_ok if {
    input.context.rate_status
    not input.context.rate_status.rate_limited
}

# ==============================================================================
# Audit Information
# ==============================================================================

# Generate audit context for logging
audit_context = {
    "agent_id": input.agent.id,
    "tenant_id": input.agent.tenant_id,
    "role": input.agent.role,
    "tool": input.action.tool,
    "action": input.action.action,
    "environment": input.context.environment,
    "timestamp": input.context.timestamp,
    "correlation_id": input.context.correlation_id
}
