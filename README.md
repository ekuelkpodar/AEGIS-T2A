# AEGIS-T2A

**Text-to-Action Anywhere Platform** - A governed multi-agent system for safe, auditable automation.

AEGIS-T2A converts natural language intents into executable, traceable actions across cloud, SaaS, CI/CD, edge, and local systems with enterprise-grade safety controls.

## Features

- **Intent Parsing**: Natural language to typed intent conversion using LLM
- **Multi-LLM Support**: Anthropic Claude, OpenAI, OpenRouter, or local Ollama
- **Policy Engine**: Policy-as-code enforcement with risk classification
- **Plan Generation**: Automatic decomposition into idempotent, compensatable steps
- **Simulation**: Dry-run execution with risk scoring and blast radius analysis
- **Durable Workflow Engine**: Checkpointed execution with retry and compensation
- **Human-in-the-Loop**: Hybrid approval model (auto/async/multi-signer)
- **Audit Ledger**: Immutable, hash-chained event logging
- **Ephemeral Secrets**: Short-lived credentials with zero-trust enforcement
- **Tool Registry**: Versioned adapters with SBOM and capability enforcement
- **Multi-Channel**: Web, Terminal, Telegram, WhatsApp, Slack, API
- **Cloud Providers**: AWS, Azure, GCP, On-premises (SSH/K8s/Docker)

## Architecture

```mermaid
flowchart TB
    subgraph Channels["Input Channels"]
        WEB[Web UI]
        CLI[Terminal CLI]
        TG[Telegram Bot]
        WA[WhatsApp]
        SLACK[Slack Bot]
        API[REST API]
    end

    subgraph LLMProviders["LLM Providers"]
        ANTH[Anthropic Claude]
        OAI[OpenAI GPT]
        OR[OpenRouter]
        OLL[Ollama Local]
    end

    subgraph Gateway["Intent Gateway"]
        IP[Intent Parser]
        PE[Policy Engine]
        RC[Risk Classifier]
    end

    subgraph Planning["Planning Layer"]
        PA[Planner Agent]
        SIM[Simulation Engine]
        RA[Risk Analyzer]
    end

    subgraph Execution["Execution Layer"]
        WE[Workflow Engine]
        EX[Executor]
        CP[Checkpoint Manager]
        CS[Compensation Stack]
    end

    subgraph Adapters["Tool Adapters"]
        AWS[AWS Adapter]
        AZ[Azure Adapter]
        GCP[GCP Adapter]
        K8S[Kubernetes]
        DOCKER[Docker]
        SSH[SSH Remote]
        GH[GitHub]
        TF[Terraform]
    end

    subgraph Infrastructure["Infrastructure"]
        DB[(SQLite DB)]
        AL[Audit Ledger]
        SV[Secrets Vault]
        REG[Tool Registry]
    end

    subgraph Approval["Human Approval"]
        AUTO[Auto-Approve<br/>Low Risk]
        ASYNC[Async Approve<br/>Medium Risk]
        SYNC[Sync Multi-Signer<br/>High Risk]
    end

    %% Channel connections
    WEB --> API
    CLI --> API
    TG --> API
    WA --> API
    SLACK --> API

    API --> Gateway

    %% Gateway flow
    IP --> PE
    PE --> RC
    Gateway --> LLMProviders

    %% Planning flow
    Gateway --> PA
    PA --> SIM
    SIM --> RA

    %% Approval routing
    RA --> AUTO
    RA --> ASYNC
    RA --> SYNC

    AUTO --> WE
    ASYNC --> WE
    SYNC --> WE

    %% Execution flow
    WE --> CP
    WE --> EX
    EX --> CS

    %% Adapter connections
    EX --> Adapters

    %% Infrastructure connections
    WE --> DB
    EX --> AL
    EX --> SV
    EX --> REG

    %% Styling
    classDef channel fill:#e1f5fe,stroke:#01579b
    classDef llm fill:#f3e5f5,stroke:#4a148c
    classDef gateway fill:#fff3e0,stroke:#e65100
    classDef planning fill:#e8f5e9,stroke:#1b5e20
    classDef execution fill:#fce4ec,stroke:#880e4f
    classDef adapter fill:#e0f2f1,stroke:#004d40
    classDef infra fill:#f5f5f5,stroke:#212121
    classDef approval fill:#fff8e1,stroke:#ff6f00

    class WEB,CLI,TG,WA,SLACK,API channel
    class ANTH,OAI,OR,OLL llm
    class IP,PE,RC gateway
    class PA,SIM,RA planning
    class WE,EX,CP,CS execution
    class AWS,AZ,GCP,K8S,DOCKER,SSH,GH,TF adapter
    class DB,AL,SV,REG infra
    class AUTO,ASYNC,SYNC approval
```

## System Flow

```mermaid
sequenceDiagram
    participant U as User
    participant C as Channel
    participant G as Gateway
    participant L as LLM
    participant P as Planner
    participant S as Simulator
    participant A as Approver
    participant W as Workflow
    participant E as Executor
    participant T as Tool

    U->>C: Natural Language Intent
    C->>G: Parse Request
    G->>L: Extract Intent
    L-->>G: Typed Intent
    G->>G: Policy Check
    G->>P: Generate Plan
    P->>L: Decompose Steps
    L-->>P: Plan Steps
    P->>S: Simulate
    S-->>P: Risk Score

    alt High Risk
        P->>A: Request Approval
        A-->>P: Approve/Reject
    end

    P->>W: Create Workflow

    loop Each Step
        W->>E: Execute Step
        E->>T: Call Tool
        T-->>E: Result
        E->>W: Checkpoint
    end

    W-->>C: Final Result
    C-->>U: Response
```

## Component Architecture

```mermaid
graph LR
    subgraph Core["Core Services"]
        CONFIG[Config Manager]
        CRYPTO[Crypto Utils]
        DB[Database]
        LOG[Logger]
        IDS[ID Generator]
    end

    subgraph Gateway["Intent Gateway"]
        PARSE[Intent Parser]
        POLICY[Policy Engine]
    end

    subgraph Planner["Planner"]
        PLAN[Plan Generator]
        DECOMP[Step Decomposer]
    end

    subgraph Simulation["Simulation"]
        DRY[Dry-Run Engine]
        BLAST[Blast Radius]
        RISK[Risk Scorer]
    end

    subgraph Workflow["Workflow Engine"]
        ORCH[Orchestrator]
        STATE[State Machine]
        RETRY[Retry Handler]
        COMP[Compensation]
    end

    subgraph Executor["Executor"]
        ADAPT[Adapter Manager]
        DLP[DLP Filter]
        SANDBOX[Sandbox]
    end

    subgraph Registry["Registry"]
        TOOLS[Tool Registry]
        VERS[Version Manager]
        SBOM[SBOM Tracker]
    end

    subgraph Audit["Audit"]
        LEDGER[Hash-Chain Ledger]
        SIGN[Signature Verify]
        QUERY[Event Query]
    end

    subgraph Secrets["Secrets"]
        VAULT[Credential Vault]
        TTL[TTL Manager]
        ENCRYPT[Encryption]
    end

    PARSE --> POLICY
    POLICY --> PLAN
    PLAN --> DRY
    DRY --> ORCH
    ORCH --> ADAPT
    ADAPT --> TOOLS

    ORCH --> LEDGER
    ADAPT --> VAULT
```

## Quick Start

### Prerequisites

- Node.js 20+
- One of: Anthropic API key, OpenAI API key, OpenRouter API key, or Ollama

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/aegis-t2a.git
cd aegis-t2a

# Install dependencies
npm install

# Run the setup wizard (interactive)
npm run setup

# Or manually configure
cp .env.example .env
# Edit .env with your settings

# Build the project
npm run build

# Start the server
npm start
```

### Setup Wizard

AEGIS-T2A includes an interactive setup wizard for easy configuration:

**Terminal Setup:**
```bash
npm run setup
```

**Browser Setup:**
```bash
npm start
# Open http://localhost:3000 in your browser
# Follow the guided setup wizard
```

The wizard helps you configure:
1. **LLM Provider** - Choose Anthropic, OpenAI, OpenRouter, or Ollama
2. **Cloud Services** - Connect AWS, Azure, GCP, or on-premises environments
3. **Channels** - Enable Telegram, WhatsApp, Slack integrations
4. **Security** - Set approval thresholds and policies

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

### Using Channels

**Telegram:**
1. Create a bot via @BotFather
2. Set `TELEGRAM_BOT_TOKEN` in .env
3. Start chatting with your bot

**WhatsApp:**
1. Set up WhatsApp Business API
2. Configure `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_ACCESS_TOKEN`
3. Set up webhook endpoint

**Slack:**
1. Create a Slack app at api.slack.com
2. Set `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`
3. Install app to workspace

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
│   ├── cli/            # Command-line interface
│   ├── channels/       # Telegram, WhatsApp, Slack
│   └── providers/      # LLM and cloud providers
├── frontend/
│   ├── index.html      # Web UI entry point
│   ├── css/            # Stylesheets
│   └── js/             # Frontend JavaScript
├── tests/              # Test files
├── docs/
│   └── constraints/    # System constraint documentation
└── config/             # Configuration files
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `NODE_ENV` | Environment | development |
| `DATABASE_PATH` | SQLite database path | ./data/aegis.db |
| `LLM_PROVIDER` | LLM provider (anthropic/openai/openrouter/ollama) | anthropic |
| `ANTHROPIC_API_KEY` | Anthropic API key | - |
| `OPENAI_API_KEY` | OpenAI API key | - |
| `OPENROUTER_API_KEY` | OpenRouter API key | - |
| `OLLAMA_BASE_URL` | Ollama server URL | http://localhost:11434 |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | - |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp phone number ID | - |
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp access token | - |
| `SLACK_BOT_TOKEN` | Slack bot token | - |
| `AWS_ACCESS_KEY_ID` | AWS access key | - |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | - |
| `AZURE_TENANT_ID` | Azure tenant ID | - |
| `AZURE_CLIENT_ID` | Azure client ID | - |
| `GCP_PROJECT_ID` | GCP project ID | - |
| `JWT_SECRET` | JWT signing secret | - |
| `SECRETS_ENCRYPTION_KEY` | 32-byte hex encryption key | - |
| `REQUIRE_APPROVAL` | Require human approval | true |
| `APPROVAL_THRESHOLD` | Min risk for approval | medium |

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
| POST | `/api/v1/test/llm` | Test LLM connection |
| POST | `/api/v1/test/cloud` | Test cloud provider connection |
| POST | `/api/v1/test/channel` | Test channel connection |

### Webhook Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhooks/telegram` | Telegram bot webhook |
| GET/POST | `/webhooks/whatsapp` | WhatsApp webhook |
| POST | `/webhooks/slack/events` | Slack events webhook |
| POST | `/webhooks/slack/interactions` | Slack interactions webhook |

## Security

- **Authentication**: JWT-based with OIDC support
- **Authorization**: Role-based access control (RBAC)
- **Secrets**: Ephemeral credentials with short TTL, HSM/KMS integration
- **Audit**: Immutable, hash-chained event log with signatures
- **Isolation**: Sandboxed executor with DLP filtering
- **Policy**: Deny-by-default with explicit allowlists
- **Approval**: Risk-based human-in-the-loop enforcement

## Supported Integrations

### Cloud Providers
- **AWS**: EC2, S3, Lambda, and more
- **Azure**: VMs, Storage, Functions
- **GCP**: Compute Engine, Cloud Storage, Cloud Functions
- **On-Premises**: SSH, Kubernetes, Docker

### LLM Providers
- **Anthropic**: Claude 3.5 Sonnet, Opus, Haiku
- **OpenAI**: GPT-4, GPT-4 Turbo, GPT-3.5
- **OpenRouter**: Access to multiple providers
- **Ollama**: Local open-source models (Llama, Mistral, etc.)

### Communication Channels
- **Web UI**: Browser-based dashboard
- **Terminal**: Interactive CLI with setup wizard
- **Telegram**: Bot integration
- **WhatsApp**: Business API integration
- **Slack**: Workspace bot
- **REST API**: Programmatic access

## License

MIT
