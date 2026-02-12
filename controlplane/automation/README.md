# Universal Automation Platform (AI Co-worker)

`controlplane/automation` provides an industry-agnostic automation runtime for healthcare, logistics, energy, and other domains.

## What It Includes

1. Flexible action framework
- `AutomationDefinition`: reusable workflow/action blueprints.
- `AutomationTask`: queued task instances with scheduling, retries, idempotency keys, and lifecycle state.
- Background queue worker + manual trigger endpoint.

2. Secure RBAC
- Role mapping (`platform_admin`, `industry_operator`, `reviewer`, `integration_admin`, `auditor`).
- Permission checks for create/update/execute/review/audit operations.
- Compatible with JWT permissions and role claims from identity metadata.

3. Logging and auditability
- `AutomationAuditLog`: append-only per-action records.
- Hash-linked events (`prev_hash` + `event_hash`) for tamper-evident traceability.
- Sensitive-field redaction before persistence.

4. Modular integration layer
- `IntegrationConnector`: connector registry (HTTP, database, CRM, ERP, webhook, custom).
- Pluggable adapter architecture (`register_adapter`) for system-specific execution plugins.
- Secure HTTP adapter supports TLS verification, host allow-listing, API key/bearer auth with secret references.

5. Compliance controls (GDPR/HIPAA)
- Validates lawful basis requirements for personal data workflows.
- HIPAA minimum-necessary guard for PHI flows.
- Retention checks and payload redaction for logs.
- Violations block task queueing.

6. AI decision support with human oversight
- NLP interpretation endpoint for turning natural language into executable payloads.
- Confidence + risk scoring.
- Automatic human-review gate for high-risk or low-confidence tasks.
- Reviewer endpoints approve/reject critical tasks before execution.

7. Scalability path
- Queue indexing by status/schedule/priority.
- Batch processing + `FOR UPDATE SKIP LOCKED` to support concurrent workers.
- Retry/backoff for transient failures.
- Stateless FastAPI layer for horizontal scaling.

## API Surface

Base path: `/api/v1/automation`

- `POST /integrations`
- `GET /integrations`
- `POST /definitions`
- `GET /definitions`
- `PATCH /definitions/{definition_id}`
- `POST /interpret`
- `POST /tasks`
- `GET /tasks`
- `GET /tasks/{task_id}`
- `POST /tasks/{task_id}/approve`
- `POST /tasks/{task_id}/reject`
- `POST /tasks/{task_id}/trigger`
- `POST /tasks/process`
- `GET /audit`
- `GET /stats`

## Integration Points

- Identity/auth: `controlplane/common/auth/middleware.py`
- DB/session lifecycle: `controlplane/common/db/database.py`
- Existing governance services can enqueue tasks through `/api/v1/automation/tasks`.
- Custom adapters can be registered in `IntegrationService` to support provider-specific APIs.

## Security Measures

- Authenticated endpoints only (JWT/mTLS/SPIFFE through shared middleware).
- RBAC permissions enforced at API boundary.
- Connector host allow-listing to reduce SSRF risks.
- TLS verification enabled by default for outbound integrations.
- Secrets are referenced via `secret_ref` (environment/Vault indirection), not stored in plaintext payloads.
- Audit logs redact sensitive fields (`token`, `password`, `ssn`, `mrn`, etc.).

## Running Locally

```bash
python -m uvicorn controlplane.automation.app:app --reload --port 8005
```

Open docs at [http://localhost:8005/docs](http://localhost:8005/docs)
