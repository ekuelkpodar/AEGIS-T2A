# AEGIS-T2A

**Text-to-Action Anywhere Platform** - A governed multi-agent system for safe, auditable automation.

AEGIS-T2A converts natural language intents into executable, traceable actions across cloud, SaaS, CI/CD, edge, and local systems with enterprise-grade safety controls.

## Features

- **Intent Parsing**: Natural language to typed intent conversion using LLM
- **Policy Engine**: Policy-as-code enforcement with risk classification
- **Plan Generation**: Automatic decomposition into idempotent, compensatable steps
- **Simulation**: Dry-run execution with risk scoring and blast radius analysis
- **Durable Workflow Engine**: Checkpointed execution with retry and compensation
- **Human-in-the-Loop**: Hybrid approval model (auto/async/multi-signer)
- **Audit Ledger**: Immutable, hash-chained event logging
- **Ephemeral Secrets**: Short-lived credentials with zero-trust enforcement
- **Tool Registry**: Versioned adapters with SBOM and capability enforcement

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   User Input    │────▶│ Intent Gateway  │────▶│  Planner Agent  │
│  (NL / API)     │     │ (Parse+Policy)  │     │  (Decompose)    │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                        ┌─────────────────┐              │
                        │   Simulation    │◀─────────────┘
                        │    Engine       │
                        └────────┬────────┘
                                 │
                        ┌────────▼────────┐     ┌─────────────────┐
                        │ Workflow Engine │────▶│    Executor     │
                        │  (Orchestrate)  │     │ (Tool Adapters) │
                        └────────┬────────┘     └─────────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
┌────────▼────────┐     ┌────────▼────────┐     ┌────────▼────────┐
│  Audit Ledger   │     │ Secrets Vault   │     │ Agent Registry  │
│ (Hash-chained)  │     │ (Ephemeral)     │     │  (Versioned)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 20+
- Anthropic API key (for LLM-powered intent parsing)

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/aegis-t2a.git
cd aegis-t2a

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env and add your API keys
# ANTHROPIC_API_KEY=your-key-here

# Build the project
npm run build

# Run database migrations
npm run db:migrate

# Start the server
npm start
```

### Using the CLI

```bash
# Process an intent
npm run cli -- intent "Create a new S3 bucket called my-data-bucket"

# With execution
npm run cli -- intent "List all EC2 instances in us-east-1" --execute

# View audit logs
npm run cli -- audit --limit 10

# View registered adapters
npm run cli -- registry
```

### Using the API

```bash
# Create an intent
curl -X POST http://localhost:3000/api/v1/intents \
  -H "Content-Type: application/json" \
  -H "X-User-Id: user-123" \
  -d '{"text": "Deploy the latest version of my-app to staging"}'

# Generate a plan
curl -X POST http://localhost:3000/api/v1/intents/{intentId}/plan

# Simulate the plan
curl -X POST http://localhost:3000/api/v1/plans/{planId}/simulate

# Execute the plan
curl -X POST http://localhost:3000/api/v1/plans/{planId}/execute

# Approve a workflow
curl -X POST http://localhost:3000/api/v1/workflows/{workflowId}/approve \
  -H "Content-Type: application/json" \
  -d '{"decision": "approved", "approverId": "approver-123"}'
```

## Project Structure

```
aegis-t2a/
├── src/
│   ├── core/           # Types, crypto, logging, database
│   ├── gateway/        # Intent parsing and policy engine
│   ├── planner/        # Plan generation
│   ├── simulation/     # Dry-run and risk analysis
│   ├── workflow/       # Durable workflow engine
│   ├── executor/       # Tool adapters and execution
│   ├── registry/       # Agent/adapter registry
│   ├── audit/          # Audit ledger
│   ├── secrets/        # Ephemeral credentials
│   ├── api/            # REST API server
│   └── cli/            # Command-line interface
├── tests/              # Test files
├── docs/
│   └── constraints/    # System constraint documentation
└── config/             # Configuration files
```

## Configuration

Environment variables (see `.env.example`):

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `NODE_ENV` | Environment | development |
| `DATABASE_PATH` | SQLite database path | ./data/aegis.db |
| `ANTHROPIC_API_KEY` | Anthropic API key | - |
| `JWT_SECRET` | JWT signing secret | - |
| `SECRETS_ENCRYPTION_KEY` | 32-byte hex encryption key | - |
| `WORKFLOW_MAX_RETRIES` | Max step retries | 3 |
| `SECRETS_TTL_SECONDS` | Credential TTL | 300 |

## Constraint Documentation

See [`docs/constraints/`](./docs/constraints/) for detailed constraint documentation:

- [Failure Modes](./docs/constraints/FAILURE_MODES.md) - System fault tolerance requirements
- [Human Override](./docs/constraints/HUMAN_OVERRIDE.md) - Approval workflow semantics
- [Observability](./docs/constraints/OBSERVABILITY.md) - Audit and tracing requirements
- [Rollback](./docs/constraints/ROLLBACK.md) - Compensation and recovery strategies

## Development

```bash
# Run in development mode
npm run dev

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Type check
npm run typecheck

# Lint
npm run lint
```

## API Reference

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/health` | Health check |
| POST | `/api/v1/intents` | Create intent from natural language |
| GET | `/api/v1/intents/:id` | Get intent by ID |
| POST | `/api/v1/intents/:id/plan` | Generate plan for intent |
| GET | `/api/v1/plans/:id` | Get plan by ID |
| POST | `/api/v1/plans/:id/simulate` | Simulate plan execution |
| POST | `/api/v1/plans/:id/execute` | Create and start workflow |
| GET | `/api/v1/workflows/:id` | Get workflow status |
| POST | `/api/v1/workflows/:id/approve` | Approve/reject workflow |
| POST | `/api/v1/workflows/:id/cancel` | Cancel workflow |
| GET | `/api/v1/audit/events` | Query audit events |
| GET | `/api/v1/audit/verify` | Verify audit chain |
| GET | `/api/v1/registry/adapters` | List tool adapters |
| GET | `/api/v1/policy/rules` | List policy rules |

## Security

- **Authentication**: JWT-based with OIDC support
- **Authorization**: Role-based access control (RBAC)
- **Secrets**: Ephemeral credentials with short TTL, HSM/KMS integration
- **Audit**: Immutable, hash-chained event log with signatures
- **Isolation**: Sandboxed executor with DLP filtering
- **Policy**: Deny-by-default with explicit allowlists

## License

MIT
