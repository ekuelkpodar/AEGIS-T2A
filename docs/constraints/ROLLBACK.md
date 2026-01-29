# Rollback Granularity and Strategies

## Selected Model: Hybrid (Option D)

AEGIS-T2A implements a **Hybrid Rollback Strategy** that combines multiple approaches based on the capabilities of affected systems and the nature of operations.

## Rollback Layers

| Layer | Scope | When Used | Requirements |
|-------|-------|-----------|--------------|
| **Per-Action** | Single step | Default for side-effecting steps | Compensation action defined |
| **Per-Workflow** | Entire workflow | When per-action fails or unavailable | Snapshot or compensation chain |
| **Time-Travel** | Point-in-time state | For supported systems (DBs, infra) | Full event sourcing + snapshots |

---

## Per-Action Rollback (Fine-Grained)

### Description
Each step has a compensating action that can revert that specific step independently.

### When to Use
- Step has clearly defined inverse operation
- External system supports targeted undo
- Step is atomic and isolated

### Implementation Requirements

Every `PlanStep` with `side_effect: true` must include:

```json
{
  "step_id": "UUID",
  "action": "create_user",
  "side_effect": true,
  "compensation_action": {
    "action": "delete_user",
    "parameters": {
      "user_id": "{{outputs.created_user_id}}"
    },
    "idempotency_key": "{{step_id}}-compensation"
  }
}
```

### Compensation Ordering
When rolling back multiple steps, compensation must respect causal dependencies:
1. Identify all steps to compensate
2. Build dependency graph from plan metadata
3. Execute compensations in reverse causal order
4. Handle compensation failures with escalation

### Failure Modes

| Failure | Mitigation |
|---------|------------|
| Compensation action fails | Retry with backoff, then escalate to per-workflow |
| External system doesn't support undo | Pre-define as compensation-unavailable, require snapshot |
| Compound state changed | Track intermediate states, apply partial compensation |

### Testable Assertions
- Every step with `side_effect: true` has `compensation_action`
- Compensation executed respects causal order
- Single step compensation restores pre-step state

---

## Per-Workflow Rollback (Coarse)

### Description
Revert entire workflow as a unit by executing all compensation actions or restoring from snapshot.

### When to Use
- Per-action compensation fails
- Multiple interdependent steps
- Workflow-level snapshot available
- Blast radius acceptable

### Implementation Approaches

#### Approach A: Compensation Chain
Execute all compensation actions in reverse order:

```
[Step 1] -> [Step 2] -> [Step 3] -> FAILURE
                                     |
          [Comp 3] <- [Comp 2] <- [Comp 1]
```

#### Approach B: Snapshot Restore
For systems supporting snapshots:
1. Capture workflow-level snapshot before execution
2. On failure, restore entire snapshot
3. Mark all steps as compensated

### Compensation Stack

The Durable Workflow Engine maintains a compensation stack:

```json
{
  "workflow_id": "UUID",
  "compensation_stack": [
    {
      "step_id": "s3",
      "compensation_action": {...},
      "executed_at": "ISO8601",
      "outputs_to_compensate": {...}
    },
    {
      "step_id": "s2",
      "compensation_action": {...},
      "executed_at": "ISO8601",
      "outputs_to_compensate": {...}
    }
  ]
}
```

### Failure Modes

| Failure | Mitigation |
|---------|------------|
| Compensation chain partially fails | Continue remaining, log failures, escalate |
| Snapshot unavailable or corrupted | Fall back to compensation chain |
| Concurrent modifications by other workflows | Use optimistic locking, detect conflicts |

---

## Time-Travel / Point-in-Time Reconstruction

### Description
Reconstruct system state as-of any timestamp using event sourcing and snapshots.

### When to Use
- Full audit/forensic investigation
- Regulatory compliance demonstration
- Disaster recovery
- Complex multi-system rollback

### Requirements
- Complete event capture (event sourcing)
- Periodic state snapshots
- External system support (DB backups, infra state)
- Significant storage investment

### Supported Systems

| System Type | Time-Travel Support | Implementation |
|-------------|---------------------|----------------|
| Internal databases | Full | Event sourcing + snapshots |
| AWS RDS | Partial | Point-in-time restore (PITR) |
| AWS S3 | Full | Versioning enabled |
| Kubernetes | Partial | Resource manifests + etcd backups |
| SaaS APIs | None | Compensating actions only |
| External databases | Varies | Customer-managed backups |

### Implementation

1. **Event Store**: All mutations logged as events
2. **Snapshot Store**: Periodic full state snapshots
3. **Reconstruction**: Replay events from last snapshot to target time
4. **Restoration**: Apply reconstructed state or use for comparison

### Failure Modes

| Failure | Mitigation |
|---------|------------|
| Event gaps | Detect via sequence numbers, alert, use last-known-good |
| Snapshot corruption | Multiple snapshot copies, integrity verification |
| External system not restorable | Document limitation, use compensation |
| Storage cost explosion | Tiered retention, configurable snapshot frequency |

---

## System-Specific Rollback Requirements

Define rollback capability for each integrated system:

### Internal Systems (Full Control)

| System | Per-Action | Per-Workflow | Time-Travel |
|--------|------------|--------------|-------------|
| AEGIS Database | Yes | Yes | Yes (event sourced) |
| Artifact Store | Yes | Yes | Yes (versioned) |
| Config Store | Yes | Yes | Yes (versioned) |

### AWS Services

| Service | Per-Action | Per-Workflow | Time-Travel |
|---------|------------|--------------|-------------|
| EC2 | Yes (terminate) | Yes (snapshot restore) | Partial (AMI) |
| RDS | Yes (delete) | Yes (snapshot) | Yes (PITR) |
| S3 | Yes (delete object) | Yes (versioning) | Yes (versioning) |
| Lambda | Yes (delete) | Yes | No (redeploy) |
| IAM | Yes (delete role/policy) | Yes | No |

### SaaS Integrations

| Service | Per-Action | Per-Workflow | Time-Travel |
|---------|------------|--------------|-------------|
| GitHub | Partial (revert commit) | Partial | No |
| Slack | No (messages not deletable by bots) | No | No |
| Jira | Yes (delete/update issue) | Yes | No |
| Salesforce | Yes (delete/update record) | Yes | Partial (recycle bin) |

---

## Rollback Decision Flow

```
Step Failure Detected
         |
         v
+-------------------+
| Per-Action        |
| Compensation      |
| Available?        |
+--------+----------+
         |
    +----+----+
    |         |
   Yes        No
    |         |
    v         v
+--------+ +------------------+
| Execute| | Per-Workflow     |
| Comp.  | | Snapshot         |
+---+----+ | Available?       |
    |      +--------+---------+
    v               |
Success?       +----+----+
    |          |         |
 +--+--+      Yes        No
 |     |       |         |
Yes    No      v         v
 |     |   +-------+ +------------+
 v     |   |Restore| |Execute     |
Done   |   |Snap.  | |Comp. Chain |
       |   +---+---+ +-----+------+
       |       |           |
       |       v           v
       |    Success?    Success?
       |       |           |
       |    +--+--+     +--+--+
       |    |     |     |     |
       |   Yes    No   Yes    No
       |    |     |     |     |
       v    v     v     v     v
  Escalate Done  Escalate Done  Escalate
```

## Rollback Metadata Schema

```json
{
  "workflow_id": "UUID",
  "rollback_strategy": "per_action|per_workflow|time_travel|hybrid",
  "rollback_state": "not_started|in_progress|completed|failed|partial",
  "triggered_at": "ISO8601",
  "triggered_by": "UUID (user or system)",
  "trigger_reason": "step_failure|user_request|policy_violation|timeout",
  "steps_to_rollback": ["step_id"],
  "steps_rolled_back": ["step_id"],
  "steps_failed_rollback": ["step_id"],
  "snapshot_id": "UUID (if used)",
  "target_timestamp": "ISO8601 (for time-travel)",
  "completion_timestamp": "ISO8601",
  "audit_trail": ["event_id"]
}
```

## Configuration Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `rollback.default_strategy` | Strategy when not specified | `hybrid` |
| `rollback.compensation_timeout` | Max time for single compensation | 5 minutes |
| `rollback.max_retries` | Retry attempts per compensation | 3 |
| `rollback.snapshot_frequency` | How often to capture snapshots | 1 hour |
| `rollback.time_travel_retention` | How far back time-travel works | 30 days |
| `rollback.auto_rollback_on_failure` | Automatically trigger rollback | `true` |

---

## Testing Requirements

### Per-Action Compensation Tests
- Verify each tool adapter's compensation action works
- Test idempotency (compensation can be retried safely)
- Test partial state scenarios

### Per-Workflow Tests
- Test compensation chain execution order
- Test snapshot restore functionality
- Test handling of compensation failures

### Time-Travel Tests
- Test event replay accuracy
- Test snapshot integrity verification
- Test restoration to arbitrary points

### Chaos Testing
- Inject failures during compensation
- Test network partitions during rollback
- Test concurrent modification scenarios

---

## Monitoring and Alerting

| Metric | Alert Threshold | Action |
|--------|-----------------|--------|
| Compensation success rate | < 95% | Review failing compensations |
| Rollback duration (p95) | > 10 minutes | Investigate bottleneck |
| Time-travel gap detection | Any gap | Investigate event loss |
| Snapshot age | > 2x frequency | Alert ops |
| Orphaned resources post-rollback | Any | Manual cleanup required |
