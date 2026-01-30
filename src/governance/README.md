# AEGIS-T2A Governance Module

Enterprise-grade security, policy enforcement, and governance layer for the AEGIS-T2A platform.

## Overview

The Governance module provides a comprehensive control plane that intercepts, evaluates, and enforces every agent action before execution. It implements:

- **Runtime Enforcement Proxy** - Intercepts all agent actions
- **Identity & Token Management** - JWT-based authentication
- **Policy Engine** - OPA integration with YAML policy definitions
- **Approval Workflows** - Human-in-the-loop for high-risk actions
- **Audit & Telemetry** - Comprehensive logging and tracing
- **Budget & Rate Governance** - Cost tracking and rate limiting
- **Multi-Tenant Support** - Tenant-scoped permissions

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Agent Request                                   │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Enforcement Proxy                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ Token        │  │ Rate         │  │ Budget       │              │
│  │ Validation   │  │ Limiter      │  │ Checker      │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│         │                 │                 │                       │
│         └─────────────────┴─────────────────┘                       │
│                           │                                         │
│                           ▼                                         │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │                   Policy Engine                          │       │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐        │       │
│  │  │ Local      │  │ OPA        │  │ Policy     │        │       │
│  │  │ Evaluation │  │ Integration│  │ Cache      │        │       │
│  │  └────────────┘  └────────────┘  └────────────┘        │       │
│  └─────────────────────────────────────────────────────────┘       │
│                           │                                         │
│                           ▼                                         │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │              Decision: ALLOW | DENY | MODIFY |           │       │
│  │                       AWAIT_APPROVAL                     │       │
│  └─────────────────────────────────────────────────────────┘       │
│                           │                                         │
└───────────────────────────┼─────────────────────────────────────────┘
                            │
         ┌──────────────────┼──────────────────┐
         │                  │                  │
         ▼                  ▼                  ▼
    ┌─────────┐      ┌─────────────┐    ┌──────────┐
    │ Execute │      │ Approval    │    │ Audit    │
    │ Action  │      │ Service     │    │ Service  │
    └─────────┘      └─────────────┘    └──────────┘
```

## Quick Start

### Installation

```bash
# Install dependencies
npm install

# Build
npm run build
```

### Running the Governance Server

```bash
# Development
npm run dev:governance

# Production
NODE_ENV=production npm run start:governance
```

### Docker

```bash
# Build images
docker-compose -f deploy/docker/docker-compose.governance.yaml build

# Start services
docker-compose -f deploy/docker/docker-compose.governance.yaml up -d
```

### Kubernetes

```bash
# Deploy to cluster
kubectl apply -f deploy/kubernetes/governance-deployment.yaml
```

## Configuration

Environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `8080` |
| `OPA_URL` | OPA server URL | `http://localhost:8181` |
| `POLICY_BUNDLE_PATH` | Path to policy bundles | `./policies` |
| `SHADOW_MODE` | Enable shadow mode | `false` |
| `FAIL_CLOSED` | Fail-closed behavior | `true` |
| `JWT_ALGORITHM` | JWT signing algorithm | `RS256` |
| `JWT_ISSUER` | JWT issuer claim | `aegis-t2a` |
| `JWT_AUDIENCE` | JWT audience claim | `aegis-agents` |
| `TOKEN_TTL_SECONDS` | Token TTL | `3600` |
| `SLACK_WEBHOOK_URL` | Slack webhook for approvals | - |
| `TEAMS_WEBHOOK_URL` | Teams webhook for approvals | - |

## API Reference

### Token Management

```bash
# Issue a token
curl -X POST http://localhost:8080/api/v1/governance/tokens \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "agent-1",
    "tenant_id": "tenant-1",
    "role": "operator",
    "scopes": ["*"]
  }'

# Validate a token
curl -X POST http://localhost:8080/api/v1/governance/tokens/validate \
  -H "Content-Type: application/json" \
  -d '{"token": "eyJ..."}'
```

### Policy Evaluation

```bash
# Evaluate an action
curl -X POST http://localhost:8080/api/v1/governance/evaluate \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "aws",
    "action": "delete_instance",
    "parameters": {"instance_id": "i-123"}
  }'
```

### Approval Workflows

```bash
# List approval requests
curl http://localhost:8080/api/v1/governance/approvals?status=pending

# Vote on an approval
curl -X POST http://localhost:8080/api/v1/governance/approvals/{id}/vote \
  -H "Content-Type: application/json" \
  -d '{
    "approver_id": "admin-1",
    "approver_role": "tenant_admin",
    "decision": "approve",
    "comment": "Looks good"
  }'
```

### Audit Queries

```bash
# Query audit events
curl "http://localhost:8080/api/v1/governance/audit/events?tenant_id=tenant-1&limit=100"

# Export in CEF format
curl "http://localhost:8080/api/v1/governance/audit/export?format=cef" > audit.cef
```

### Budget Management

```bash
# Create a budget
curl -X POST http://localhost:8080/api/v1/governance/budgets \
  -H "Content-Type: application/json" \
  -d '{
    "id": "budget-1",
    "tenant_id": "tenant-1",
    "agent_id": "agent-1",
    "period": "daily",
    "limit_units": 10000,
    "warning_threshold": 80,
    "hard_limit": true
  }'

# Check budget usage
curl http://localhost:8080/api/v1/governance/budgets/tenant-1/agent-1
```

## Policy Definition

Policies are defined in YAML format:

```yaml
id: my-policy
version: "1.0.0"
name: My Policy
description: Custom policy rules
tenant_id: null  # Global policy

default_decision: DENY

rules:
  - id: allow-read
    name: Allow Read Operations
    priority: 100
    enabled: true
    conditions:
      - field: action
        operator: matches
        value: "^(get|list|read)$"
    effect:
      decision: ALLOW
      reason_template: "Read operation allowed"

  - id: require-approval-delete
    name: Require Approval for Deletes
    priority: 50
    enabled: true
    conditions:
      - field: action
        operator: equals
        value: delete
    effect:
      decision: AWAIT_APPROVAL
      reason_template: "Delete requires approval"
    approval_config:
      required_approvers:
        - tenant_admin
      min_approvals: 1
      timeout_seconds: 3600
      notify_channels:
        - slack
```

### Condition Operators

| Operator | Description |
|----------|-------------|
| `equals` | Exact match |
| `not_equals` | Not equal |
| `contains` | String/array contains |
| `matches` | Regex match |
| `in` | Value in array |
| `not_in` | Value not in array |
| `greater_than` | Numeric comparison |
| `less_than` | Numeric comparison |
| `exists` | Field exists |
| `not_exists` | Field doesn't exist |

### Decision Types

| Decision | Description |
|----------|-------------|
| `ALLOW` | Allow the action to proceed |
| `DENY` | Block the action |
| `MODIFY` | Sanitize parameters and allow |
| `AWAIT_APPROVAL` | Require human approval |

## OPA Integration

The governance module integrates with Open Policy Agent for advanced policy evaluation.

### OPA Policy Example

```rego
package aegis.authz

default decision = {"allow": false, "decision": "DENY", "reason": "No matching rule"}

decision = result {
    input.agent.role == "system_admin"
    result := {"allow": true, "decision": "ALLOW", "reason": "Admin access"}
}

decision = result {
    input.action.action == "delete"
    result := {"allow": false, "decision": "AWAIT_APPROVAL", "require_approval": true}
}
```

### Running OPA

```bash
# Start OPA server
docker run -p 8181:8181 openpolicyagent/opa:latest \
  run --server --addr=0.0.0.0:8181 /policies
```

## Security Features

### Fail-Closed Behavior

When `FAIL_CLOSED=true` (default), any policy evaluation errors result in DENY.

### Shadow Mode

When `SHADOW_MODE=true`, policy decisions are logged but not enforced. Use for testing policies in production.

### Token Security

- Tokens are short-lived (default 1 hour)
- Support for token revocation
- JWKS endpoint for key distribution

### Audit Trail

- Every action is logged with full context
- Hash chain for tamper detection
- Export in CEF format for SIEM integration

## Testing

```bash
# Run tests
npm run test:governance

# Run with coverage
npm run test:coverage
```

## Performance

The policy engine is designed for low-latency evaluation:

- Target: < 20ms per evaluation
- Local evaluation with OPA fallback
- Decision caching
- Efficient condition matching

## Monitoring

### Health Endpoints

- `GET /health` - Basic health check
- `GET /ready` - Readiness check with service status

### Metrics

- `aegis_policy_evaluations_total` - Total evaluations
- `aegis_policy_evaluation_duration_ms` - Evaluation latency
- `aegis_approvals_pending` - Pending approvals
- `aegis_budget_usage_percent` - Budget utilization

## Support

For issues and feature requests, please open a GitHub issue.
