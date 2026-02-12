# AEGIS-T2A Control Plane

Enterprise-grade control plane for autonomous AI agent management with comprehensive governance, compliance, and security features.

## 🏗️ Architecture

The AEGIS-T2A Control Plane consists of six core microservices:

### 1. **Identity Service** (Port 8000)
- Agent registration and lifecycle management
- W3C DID (Decentralized Identifier) document generation
- HashiCorp Vault PKI integration for certificate issuance
- SPIFFE/SPIRE workload identity support
- mTLS certificate management

### 2. **Event Store** (Port 8001)
- Immutable, append-only event logging
- Hash-chained events for tamper detection
- Merkle tree proofs for auditing
- S3 storage with Object Lock for large payloads
- Chain verification and integrity checks

### 3. **Policy Engine** (Port 8002)
- OPA (Open Policy Agent) based policy enforcement
- Rego policy language support
- Real-time policy evaluation
- Policy versioning and lifecycle management
- Pattern-based policy matching (deny/allow/require-approval)

### 4. **Autonomy Manager** (Port 8003)
- Time-limited autonomy leases (TTL-based)
- Action and resource scoping with wildcards
- Rate limiting and action counting
- Lease renewal and revocation
- Multi-level autonomy (Level 0-5)

### 5. **Approval System** (Port 8004)
- Human-in-the-loop approval gates
- Multi-level escalation workflows
- Timeout and expiration handling
- Risk-based routing
- Decision tracking and audit trail

### 6. **Universal Automation Platform** (Port 8005)
- Industry-agnostic workflow/action definitions
- Queue-based task orchestration with retries and scheduling
- RBAC-secured execution and human review gates
- Modular integrations for HTTP, CRM, ERP, database, and custom adapters
- Tamper-evident audit trail with GDPR/HIPAA compliance checks

## 🚀 Quick Start

### Prerequisites
- Docker and Docker Compose
- Python 3.11+ (for local development)
- PostgreSQL 15+
- Node.js 18+ (for main AEGIS application)

### Running with Docker Compose

```bash
cd controlplane

# Start all services
docker-compose up -d

# Check service health
docker-compose ps

# View logs
docker-compose logs -f

# Stop all services
docker-compose down
```

### Service Endpoints

Once running, services are available at:

- **Identity Service**: http://localhost:8000/docs
- **Event Store**: http://localhost:8001/docs
- **Policy Engine**: http://localhost:8002/docs
- **Autonomy Manager**: http://localhost:8003/docs
- **Approval System**: http://localhost:8004/docs
- **Universal Automation Platform**: http://localhost:8005/docs

### Infrastructure Components

- **PostgreSQL**: localhost:5432 (database: `aegis_controlplane`)
- **Open Policy Agent**: localhost:8181
- **HashiCorp Vault**: localhost:8200 (UI: dev mode)
- **MinIO**: localhost:9000 (Console: localhost:9001)

## 📋 API Examples

### Register an Agent

```bash
curl -X POST http://localhost:8000/api/v1/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-agent",
    "public_key": "-----BEGIN PUBLIC KEY-----...",
    "permissions": ["read:*", "execute:analysis"],
    "metadata": {"team": "data-science"}
  }'
```

### Create an Autonomy Lease

```bash
curl -X POST http://localhost:8003/api/v1/leases \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "550e8400-e29b-41d4-a716-446655440000",
    "ttl_seconds": 3600,
    "autonomy_level": 2,
    "allowed_actions": ["read:*", "process:data/*"],
    "max_actions_per_minute": 100
  }'
```

### Evaluate a Policy

```bash
curl -X POST http://localhost:8002/api/v1/policies/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "agent-123",
    "action": "delete",
    "resource": {
      "type": "database",
      "environment": "production"
    }
  }'
```

### Request Human Approval

```bash
curl -X POST http://localhost:8004/api/v1/approvals \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Delete production data",
    "agent_id": "550e8400-e29b-41d4-a716-446655440000",
    "action": "delete",
    "resource": "database:production/users",
    "risk_level": "high",
    "ttl_seconds": 3600
  }'
```

### Queue an Automation Task

```bash
curl -X POST http://localhost:8005/api/v1/automation/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "definition_id": "550e8400-e29b-41d4-a716-446655440010",
    "payload": {"operation": "sync_route_plan"},
    "priority": 75,
    "compliance": {
      "frameworks": ["GDPR"],
      "contains_personal_data": true,
      "lawful_basis": "legitimate_interest"
    }
  }'
```

## 🔐 Security Features

- **mTLS**: Mutual TLS authentication between services
- **SPIFFE/SPIRE**: Workload identity and attestation
- **Vault PKI**: Automated certificate lifecycle management
- **Hash-Chained Events**: Tamper-evident audit logs
- **OPA Policies**: Fine-grained authorization
- **Time-Limited Leases**: Automatic revocation on expiry

## 📊 Compliance & Auditability

- **Immutable Event Log**: All actions logged in append-only store
- **Chain Verification**: Cryptographic proof of log integrity
- **Merkle Proofs**: Efficient audit trail verification
- **Policy Versioning**: Complete history of policy changes
- **Lease Audit Trail**: Track all autonomy grants and revocations
- **Approval Decisions**: Full record of human oversight

## 🛠️ Development

### Local Setup

```bash
# Install Python dependencies
cd controlplane
pip install -r requirements.txt

# Copy environment template
cp .env.example .env

# Start infrastructure (PostgreSQL, OPA, Vault, MinIO)
docker-compose up -d postgres opa vault minio

# Run a service locally
python -m uvicorn controlplane.identity_service.app:app --reload --port 8000
```

### Running Tests

```bash
# Unit tests
pytest tests/unit/

# Integration tests
pytest tests/integration/

# E2E tests
pytest tests/e2e/
```

## 📖 Documentation

- [API Documentation](./docs/api.md)
- [Architecture Guide](./docs/architecture.md)
- [Security Model](./docs/security.md)
- [Deployment Guide](./docs/deployment.md)
- [Auditor Runbook](./docs/auditor-runbook.md)
- [Automation Platform Guide](./automation/README.md)

## 🤝 Integration with Main Application

The control plane integrates with the main AEGIS-T2A application (running on port 3000) to provide:

1. **Agent Identity**: Register agents before they can execute intents
2. **Policy Enforcement**: Check policies before executing plans
3. **Autonomy Control**: Verify lease validity before autonomous actions
4. **Event Logging**: Log all significant events for compliance
5. **Approval Gates**: Request human approval for high-risk actions

## 📝 Configuration

Key configuration files:

- `docker-compose.yml`: Service orchestration
- `.env`: Environment variables
- `controlplane/common/config/settings.py`: Pydantic settings

## 🔍 Monitoring & Observability

Each service exposes:

- **Health endpoint**: `/health` - Overall service health
- **Readiness endpoint**: `/ready` - Kubernetes readiness probe
- **Metrics endpoint**: `/metrics` - Prometheus-compatible metrics

## 📜 License

[Add your license here]

## 🙏 Acknowledgments

Built with:
- FastAPI
- SQLAlchemy
- Open Policy Agent
- HashiCorp Vault
- PostgreSQL
- MinIO

---

For questions or support, please open an issue on GitHub.
