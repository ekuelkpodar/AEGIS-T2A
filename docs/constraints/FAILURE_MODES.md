# Failure Modes the System Must Tolerate

All failure modes listed below are classified as **MUST tolerate** (M) - these are hard requirements for production deployment.

## A. Network Partitions / Intermittent Network

**Tolerance Level**: MUST (M)

### Failure Modes
- Split-brain between control plane and execution plane
- Delayed ACKs causing timeout cascades
- Request timeouts mid-operation
- Partial visibility of execution nodes

### Consequences if Not Tolerated
- Lost audit records
- Partial executions with unknown state
- Inability to roll back completed steps
- Orphaned resources in customer environments

### Required Mitigations
- Durable workflow engine with event sourcing
- Idempotent step execution with idempotency keys
- Offline queuing with exponential backoff
- Circuit-breakers on all external calls
- Checkpoint persistence before any state change

### Testable Assertions
- Intent persisted atomically even when LLM unavailable
- Workflow resumes correctly after partition heals
- No duplicate side effects on retry after network failure

---

## B. Partial State Corruption

**Tolerance Level**: MUST (M)

### Failure Modes
- Corrupted database rows or indexes
- Partial writes to checkpoint store
- Inconsistent checkpoints across replicas
- Missing or corrupted artifacts

### Consequences if Not Tolerated
- Incorrect rollback leading to worse state
- Inconsistent audit logs breaking compliance
- Wrong decisions based on corrupted data
- Unrecoverable workflow state

### Required Mitigations
- Checksums/hash-chains on all persisted data
- Atomic commits with write-ahead logs
- State snapshots with integrity verification
- Repair tools for checkpoint recovery
- Transactional database writes

### Testable Assertions
- Stored intent checksum matches computed checksum
- Corrupted checkpoint triggers automatic detection
- WAL corruption detection and auto-repair verified

---

## C. Malicious or Compromised Tool Calls

**Tolerance Level**: MUST (M)

### Failure Modes
- Tool adapter exploited by attacker
- Arbitrary code execution via tool outputs
- Credential exfiltration through tool responses
- Malicious data injection via tool outputs
- Supply chain compromise of tool dependencies

### Consequences if Not Tolerated
- Data breach and unauthorized access
- Rogue actions on customer infrastructure
- Lateral movement within customer environment
- Compliance violations and legal liability

### Required Mitigations
- Strict allowlists for tool operations
- Sandboxed execution (gVisor/Firecracker)
- DLP filters on all outputs
- Output sanitization before processing
- Least-privilege ephemeral credentials per step
- Preflight simulation for high-risk operations
- SBOM verification and CVE scanning

### Testable Assertions
- Container escape attempts detected by honeypots
- No outbound traffic outside allowlist
- All tool outputs pass sanitization checks
- Only signed, vetted images execute

---

## D. LLM Hallucination / Incorrect Plan Generation

**Tolerance Level**: MUST (M)

### Failure Modes
- Fabricated API calls that don't exist
- Missing idempotency leading to duplicate effects
- Wrong parameters causing destructive actions
- Overconfident plans that skip safety checks
- Plans that bypass policy constraints

### Consequences if Not Tolerated
- Data loss from incorrect operations
- Erroneous changes to production systems
- Regulatory/compliance violations
- Customer trust erosion

### Required Mitigations
- Auditor agent verification of all plans
- Simulation dry-runs before execution
- Conservative default policies (deny by default)
- Human approval gates for high-risk steps
- Schema validation of plan outputs
- Tool/adapter registry verification
- Confidence scoring with threshold gating

### Testable Assertions
- Any plan referencing non-registered tool is rejected
- Intent with confidence below threshold requires confirmation
- Ensemble planning cross-validates outputs

---

## E. Partial External Side-Effects

**Tolerance Level**: MUST (M)

### Failure Modes
- External API succeeds for some calls, fails for others
- Partial business state changes across systems
- Inconsistent state between AEGIS and external systems
- Failed rollback of partially completed operations

### Consequences if Not Tolerated
- Broken invariants across integrated systems
- Hard-to-revert state requiring manual intervention
- Data consistency violations
- Customer operational disruption

### Required Mitigations
- Compensation actions for every side-effecting step
- Transactional outbox patterns
- Two-phase commit where external systems support it
- Idempotent design for all operations
- Saga pattern for distributed transactions

### Testable Assertions
- Step with `side_effect: true` must have `compensation_action`
- Partial failure triggers automatic compensation
- External state reconciliation verified

---

## F. Credential Compromise or Stale/Overprivileged Secrets

**Tolerance Level**: MUST (M)

### Failure Modes
- Long-lived tokens leaked or stolen
- Agents using user-scoped credentials inadvertently
- Overprivileged secrets enabling unauthorized actions
- Stale credentials used after revocation
- Replay attacks with captured tokens

### Consequences if Not Tolerated
- Unauthorized access to customer systems
- Data exfiltration
- Privilege escalation attacks
- Compliance violations (SOC2, ISO27001)

### Required Mitigations
- Ephemeral credentials with short TTL (minutes)
- Per-task least-privilege tokens
- Automated rotation on schedule and on-demand
- HSM-backed master key storage
- Token nonce binding per step
- Reuse detection via audit ledger

### Testable Assertions
- No token older than TTL used
- Token scope verifier rejects excessive scopes
- Reused tokens flagged and blocked

---

## G. Executor Host Failure

**Tolerance Level**: MUST (M)

### Failure Modes
- Executor process crash mid-step
- Container eviction by orchestrator
- Disk loss with uncommitted data
- Network isolation of executor node

### Consequences if Not Tolerated
- Hanging workflows with unknown state
- Lost logs and audit trail gaps
- Partial side effects without cleanup
- SLA violations

### Required Mitigations
- Durable workflow engine with checkpointing
- Persistent logs to remote store in real-time
- Automatic retry on healthy nodes
- Worker heartbeats with lease-based locks
- Idempotency keys prevent duplicate effects

### Testable Assertions
- Executor crash causes task reschedule without double-effect
- Crash recoverability verified in chaos tests
- No log gaps after executor failure

---

## H. Denial-of-Service / Resource Exhaustion

**Tolerance Level**: MUST (M)

### Failure Modes
- Runaway loops consuming unbounded resources
- Token/API cost burn from malicious or buggy plans
- Infrastructure cost spikes from orphaned resources
- CPU/memory exhaustion blocking other tenants
- Queue depth causing cascading latency

### Consequences if Not Tolerated
- Cost overruns exceeding budgets
- Throttled service affecting all customers
- Blocked tenants unable to execute
- Platform instability

### Required Mitigations
- Per-task budget limits with preflight estimation
- Per-agent quotas and rate limiting
- Circuit breakers on all external calls
- Runtime cost estimation and alerts at 80%
- Emergency kill switch for runaway tasks
- Autoscaling with backpressure to Gateway

### Testable Assertions
- Task cost preflight <= budget enforced
- Max requests per minute per principal enforced
- Queue depth < threshold under expected load

---

## I. Policy Engine Failure or Misconfiguration

**Tolerance Level**: MUST (M)

### Failure Modes
- False positives blocking legitimate workflows
- False negatives allowing unsafe operations
- Malicious or errant policy rules pushed
- Policy store outage preventing evaluation

### Consequences if Not Tolerated
- Blocked legitimate business operations
- Allowed unsafe actions causing damage
- Compliance failures from policy bypass
- Operational friction and user frustration

### Required Mitigations
- Policy linting in CI before deployment
- Staged policy rollout with canary
- Comprehensive policy unit tests
- Emergency safe-mode (deny-by-default)
- Fallback manual review channel

### Testable Assertions
- Policy changes must pass test suite before activation
- False positive rate < defined threshold
- Alternate manual review path exists and tested

---

## J. Audit Log Tampering / Loss

**Tolerance Level**: MUST (M)

### Failure Modes
- Logs deleted by attacker or bug
- Logs modified to hide malicious activity
- Logs not flushed before crash
- Replication lag causing log loss

### Consequences if Not Tolerated
- Non-repudiation failure
- Compliance breach (SOC2, HIPAA, GDPR)
- Unable to investigate incidents
- Legal liability from missing evidence

### Required Mitigations
- Append-only ledger architecture
- Cryptographic signing of all events
- External anchoring (optional blockchain/notarization)
- Immutable retention with customer-controlled keys
- Synchronous write to durable store before ACK
- Multi-zone replication

### Testable Assertions
- Event signatures verify correctly
- Merkle root anchors match external anchors
- No events dropped (alert on any loss > 0)

---

## Summary: Requirement to Primitive Mapping

| Failure Mode | Primary Primitives | Testable Assertion |
|--------------|-------------------|-------------------|
| Network partitions | Durable Engine, Gateway, Executor | Intent persisted on LM failure |
| Partial corruption | Durable Engine, Audit Ledger | Checksum verification passes |
| Malicious tools | Executor, Registry, Secrets Vault | Sandbox escape detection |
| LLM hallucination | Planner, Auditor, Simulation Engine | Non-registered tools rejected |
| Partial side-effects | Planner, Durable Engine | Compensation actions exist |
| Credential compromise | Secrets Vault, Executor | Token TTL enforced |
| Host failure | Durable Engine, Executor | Crash recovery without duplicate |
| DoS/exhaustion | Gateway, Quotas, Circuit Breakers | Budget limits enforced |
| Policy failure | Policy Engine, Auditor | Safe-mode fallback exists |
| Audit tampering | Audit Ledger, OTEL | Signed events verify |
