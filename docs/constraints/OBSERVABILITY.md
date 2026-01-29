# Observability Primitives

All observability primitives listed below are **REQUIRED** for production deployment.

## 1. Structured Audit Logs (JSON)

**Required**: YES

### Minimum Required Fields

```json
{
  "event_id": "UUID",
  "timestamp": "ISO8601 with timezone",
  "event_type": "intent_created|plan_generated|step_started|step_completed|approval_requested|approval_granted|compensation_triggered|...",
  "intent_id": "UUID",
  "plan_id": "UUID",
  "plan_version": "integer",
  "step_id": "UUID (if applicable)",
  "actor_id": "UUID (user or agent)",
  "actor_type": "user|agent|system",
  "action": "string (operation performed)",
  "target_resource": "string (affected resource identifier)",
  "inputs_hash": "SHA256 of inputs",
  "outputs_hash": "SHA256 of outputs",
  "success": "boolean",
  "error_code": "string (if failed)",
  "error_message": "string (if failed)",
  "risk_level": "low|medium|high",
  "cost_incurred": "float (if applicable)",
  "duration_ms": "integer",
  "signature": "base64-encoded cryptographic signature",
  "previous_event_hash": "SHA256 (for hash-chain)"
}
```

### Retention Policy
- **Default**: 1 year minimum
- **High-risk events**: 7 years (compliance)
- **PII-containing events**: Subject to GDPR erasure requests

### Storage Requirements
- Append-only storage
- Encryption at rest with customer-controlled keys
- Multi-zone replication
- Tamper-evident with hash-chaining

---

## 2. Cryptographic Chaining / Signed Events

**Required**: YES

### Implementation
- Every event is signed with service signing key before persistence
- Events are linked via hash-chain (each event includes hash of previous)
- Periodic Merkle root computation for efficient verification

### External Anchoring
**Status**: Optional (customer-configurable)

Options:
- Customer-controlled blockchain anchor
- Third-party notarization service
- Internal periodic checkpoints exported to customer

### Verification Capabilities
- Verify single event signature
- Verify chain integrity (detect gaps or modifications)
- Verify Merkle proof for any event
- Export verification bundle for external audit

### Testable Assertions
- Event signatures verify correctly
- Hash-chain has no gaps
- Merkle root anchors match external anchors

---

## 3. End-to-End Distributed Tracing (OpenTelemetry)

**Required**: YES

### Trace Coverage
Spans must cover the complete flow:
1. Intent ingestion (UI/API entry point)
2. LLM/router calls (with token counts)
3. Planner execution
4. Simulation/dry-run
5. Approval workflow
6. Executor tool calls
7. External API calls
8. Compensation/rollback actions

### Required Span Attributes
```
trace_id: UUID
span_id: UUID
parent_span_id: UUID
intent_id: UUID
plan_id: UUID
step_id: UUID (if applicable)
service.name: string
operation.name: string
status_code: OK|ERROR
error.type: string (if error)
duration_ms: integer
```

### Sampling Policy
- 100% sampling for errors and high-risk operations
- Configurable sampling rate for low-risk (default 10%)
- Always sample if anomaly detected

### Retention Policy
- **Standard traces**: 30 days
- **Critical/error traces**: 1 year archive
- **High-risk operation traces**: 1 year archive

### Testable Assertion
- Trace coverage > 95% of all flows

---

## 4. Action-Level Forensic Artifacts

**Required**: YES

### Captured Artifacts
- Execution snapshots (state before/after)
- Sanitized stdout/stderr from executors
- Request/response bodies (where policy allows)
- Screenshots (for browser-based actions)
- Tool adapter logs

### Tamper Protection
- Artifacts signed on capture
- Stored in immutable object storage
- Hash included in audit log event

### Redaction Policy

**Must Redact**:
- Passwords and secrets
- API keys and tokens
- PII (SSN, credit card numbers, etc.)
- PHI (health information)
- Customer-specified sensitive patterns

**Redaction Implementation**:
- DLP filters applied before storage
- Pattern-based scrubbing (regex for known sensitive formats)
- Customer-configurable redaction rules
- Redaction logged (not the redacted content, but the fact redaction occurred)

### Testable Assertion
- PII scan shows zero persisted sensitive elements

---

## 5. Real-Time Anomaly Detection & Alerts

**Required**: YES

### Detection Categories

| Category | Examples | Alert Priority |
|----------|----------|----------------|
| Cost spikes | Task cost > 3x estimate | High |
| Policy violations | Blocked operation attempted | High |
| Unusual agent behavior | Unexpected tool calls | Medium |
| Authentication anomalies | Failed auth attempts | High |
| Performance degradation | Latency > 3x baseline | Medium |
| Error rate spikes | Error rate > 5% | High |

### Alerting Channels
- SIEM integration (Splunk, Sentinel, etc.)
- Slack/Teams notifications
- PagerDuty for critical alerts
- Email for non-urgent notifications

### Alert Schema
```json
{
  "alert_id": "UUID",
  "timestamp": "ISO8601",
  "severity": "critical|high|medium|low",
  "category": "string",
  "description": "string",
  "affected_resources": ["string"],
  "intent_id": "UUID (if applicable)",
  "recommended_action": "string",
  "auto_mitigated": "boolean",
  "mitigation_taken": "string (if auto-mitigated)"
}
```

---

## 6. Replayability (Checkpoint Replay)

**Required**: YES

### Capabilities
- Re-run simulation from any checkpoint in sandbox (dry-run)
- Reconstruct exact state at any point in workflow history
- Compare actual vs. replayed execution for debugging

### Implementation Requirements
- Event sourcing architecture
- Complete input capture at each checkpoint
- Deterministic replay of non-external steps
- External calls mocked with captured responses during replay

### Use Cases
- Post-incident investigation
- Compliance audit demonstration
- Debugging unexpected behavior
- Training and testing

---

## 7. Immutable Human Approval Records

**Required**: YES

### Captured Information
- Approver identity (verified)
- MFA evidence (method used, verification timestamp)
- Approval decision and rationale
- Timestamp (cryptographically signed)
- Information presented to approver at decision time
- Any modifications requested

### Storage Requirements
- Same immutability guarantees as audit ledger
- Separately queryable for compliance reporting
- Exportable for external auditors

### Schema
See [HUMAN_OVERRIDE.md](./HUMAN_OVERRIDE.md) for approval record schema.

---

## 8. Operational Metrics (SLOs)

**Required**: YES

### Core Metrics

| Metric | Description | Target SLO |
|--------|-------------|------------|
| `plan_success_rate` | % of plans that complete successfully | > 95% |
| `mean_time_to_approval` | Average approval latency | < 1 hour (medium-risk) |
| `provisioning_time_p95` | 95th percentile sandbox provisioning | < 5 minutes |
| `cost_per_task_accuracy` | Actual vs. estimated cost variance | < 20% |
| `audit_event_loss_rate` | % of events lost | 0% |
| `step_retry_rate` | % of steps requiring retry | < 5% |
| `compensation_trigger_rate` | % of workflows requiring compensation | < 2% |
| `human_override_rate` | % of tasks requiring manual intervention | Tracked (no target) |

### Dashboard Requirements
- Real-time view of active workflows
- Historical trend analysis
- Per-tenant/per-team breakdowns
- Drill-down from metric to specific workflows

---

## 9. Tamper-Evidence & Audit Export APIs

**Required**: YES

### Export Capabilities
- Full audit trail export for date range
- Filtered export by intent/workflow/user
- Verification bundle export (hashes, signatures, anchors)
- Chain-of-custody documentation

### API Endpoints
```
GET /audit/events?start=<ISO8601>&end=<ISO8601>
GET /audit/events/{intent_id}
GET /audit/verification-bundle/{event_id}
GET /audit/merkle-proof/{event_id}
POST /audit/verify-chain
GET /audit/export?format=json|csv&filters=...
```

### Access Control
- Audit export requires elevated permissions
- All export requests logged
- Rate limiting to prevent abuse

---

## Failure Modes and Mitigations

### H1. Ledger Corruption or Tamper
**Mitigation**:
- Sign events with service keys
- Replicate across zones
- Anchor periodic Merkle roots externally

**Testable Assertion**: Merkle root anchors match

### H2. Event Loss (Buffer Overflow / Downstream Outage)
**Mitigation**:
- Synchronous write to durable store before ACK
- Local buffering with safe TTL
- Backpressure to producers

**Testable Assertion**: Alert on any event loss > 0%

### H3. Privacy Leakage in Logs
**Mitigation**:
- Redact sensitive fields per policy
- Encrypt PII at rest with KMS
- Regular PII scanning

**Testable Assertion**: PII scan shows zero persisted elements

### H4. Observability Blind Spots
**Mitigation**:
- Enforce OTEL instrumentation in all services
- Trace context propagation tests
- Coverage reporting

**Testable Assertion**: Trace coverage > 95%

### H5. Storage Cost Growth
**Mitigation**:
- Tiered retention (hot/cold/archive)
- Customer-configurable retention
- Compression and aggregation for older data

---

## Monitoring the Observability Stack

| Component | Health Check | Alert Threshold |
|-----------|--------------|-----------------|
| Audit Ledger | Write latency, replication lag | Latency > 1s, lag > 10s |
| OTEL Collector | Span ingestion rate | Drop rate > 0.1% |
| Artifact Store | Write success rate | Failure rate > 0.1% |
| Alert Pipeline | Alert delivery latency | Delivery > 5 minutes |
| Anchor Service | Anchor success rate | Any failure |
