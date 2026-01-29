# Human Override Semantics

## Selected Model: Hybrid / Escalation (Option D)

AEGIS-T2A implements a **Hybrid Human Override Model** that balances automation efficiency with safety controls based on risk classification.

## Override Model Behavior

| Risk Level | Behavior | Approval Type | Timeout |
|------------|----------|--------------|---------|
| **Low** | Auto-execute if policy allows | None required | N/A |
| **Medium** | Async approval with TTL | Single approver | Configurable (default 24h) |
| **High** | Real-time multi-signer approval | 2+ approvers with MFA | Configurable (default 1h) |
| **Emergency** | Special override path | On-call + MFA + mandatory post-hoc review | N/A |

## Risk Classification Definitions

### Low Risk Actions
- Read-only queries and data retrieval
- Status checks and health monitoring
- Log viewing and report generation
- Non-mutating API calls
- Sandbox/preview environment operations

### Medium Risk Actions
- Configuration updates (non-production)
- Updates to existing resources
- Non-destructive data modifications
- CI/CD pipeline triggers
- Permission changes (non-admin)
- Service restarts in non-production

### High Risk Actions
- Production data modifications
- Database schema changes
- Infrastructure creation or destruction
- Admin privilege escalations
- External payment/financial operations
- PII/sensitive data access
- Cross-account operations

### Destructive Actions (Subset of High Risk)
- Production database deletion or truncation
- Infrastructure teardown in production
- Credential revocation for active services
- Bulk data deletion operations
- Irreversible external API calls

## Override Flow Diagrams

### Low Risk Flow
```
Intent -> Policy Check -> Auto-Execute -> Audit Log
```

### Medium Risk Flow
```
Intent -> Policy Check -> Queue for Approval ->
  Approver Reviews (async) ->
    [Approved] -> Execute -> Audit Log
    [Rejected] -> Notify User -> Audit Log
    [Timeout] -> Reject with notification -> Audit Log
```

### High Risk Flow
```
Intent -> Policy Check -> Multi-Signer Queue ->
  Approver 1 Reviews (real-time) ->
    [Approved] -> Approver 2 Reviews ->
      [Both Approved] -> Execute -> Audit Log
      [Any Rejected] -> Reject -> Audit Log
    [Rejected] -> Reject -> Audit Log
```

### Emergency Override Flow
```
Emergency Request -> On-Call Alert ->
  On-Call Responds with MFA ->
    Execute -> Audit Log (flagged for review) ->
    Mandatory Post-Hoc Review (24h)
```

## Approval UI Requirements

### Information Displayed to Approvers
1. **Intent Summary**: Plain-English description of requested action
2. **Risk Assessment**: Risk level, blast radius, affected resources
3. **Simulation Results**: Dry-run outcomes, predicted cost
4. **Compensation Plan**: Rollback strategy if something goes wrong
5. **Requestor Identity**: Who initiated the request
6. **Historical Context**: Similar past requests and outcomes

### Approval Actions Available
- **Approve**: Proceed with execution
- **Approve with Modifications**: Approve with parameter changes
- **Reject**: Block execution with reason
- **Request Clarification**: Ask for more information
- **Delegate**: Assign to different approver

## Failure Modes and Mitigations

### G1. Auditor False-Negative (Missed Policy Violation)
**Mitigation**:
- Ensemble of checks (policy-as-code + ML detectors + deterministic rules)
- Periodic red-team testing
- Detection rate benchmarks with seeded violations

**Testable Assertion**: Detection rate > 99% for seeded violations

### G2. Auditor False-Positive (Blocks Legitimate Action)
**Mitigation**:
- Clear human-override path with recorded rationale
- Staged release to reduce friction
- Feedback loop to improve policy rules

**Testable Assertion**: False positive rate < 5%

### G3. Audit Engine Outage Delaying Approvals
**Mitigation**:
- Fallback to emergency policy (deny-by-default)
- Alternative manual review channel (out-of-band contact)
- High-availability deployment

**Testable Assertion**: Alternate manual approval path exists and is tested

### G4. Tampering of Approval Records
**Mitigation**:
- Approval records signed with approver cryptographic keys
- Stored in immutable ledger
- MFA evidence captured
- Multi-signature for high-risk

**Testable Assertion**: All approval signatures verify correctly

### G5. Approver Collusion / Compromised Credentials
**Mitigation**:
- Approver role separation (different teams for different risk levels)
- Just-in-time approval assignments
- Anomaly detection on approver behavior
- Multi-signer requirement for high-risk

**Testable Assertion**: Approver anomalies detected and flagged

## Approval Record Schema

```json
{
  "approval_id": "UUID",
  "workflow_id": "UUID",
  "step_id": "UUID",
  "risk_level": "low|medium|high|destructive",
  "approver_id": "UUID",
  "approver_identity": {
    "email": "string",
    "mfa_method": "totp|webauthn|sms",
    "mfa_verified": true
  },
  "decision": "approved|rejected|delegated",
  "rationale": "string (optional)",
  "modifications": {},
  "timestamp": "ISO8601",
  "signature": "base64-encoded-signature",
  "previous_approval_hash": "sha256 (for multi-signer chain)"
}
```

## Configuration Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `approval.medium_risk_ttl` | Timeout for medium-risk approvals | 24 hours |
| `approval.high_risk_ttl` | Timeout for high-risk approvals | 1 hour |
| `approval.high_risk_signers` | Required signers for high-risk | 2 |
| `approval.emergency_review_window` | Post-hoc review deadline | 24 hours |
| `approval.mfa_required_levels` | Risk levels requiring MFA | ["high", "destructive"] |
| `approval.delegation_allowed` | Whether delegation is permitted | true |
| `approval.notification_channels` | Alert channels for approvals | ["slack", "email"] |

## Integration Points

### With Durable Workflow Engine
- Workflow pauses at approval gates
- Workflow state preserved during approval window
- Timeout triggers workflow cancellation or fallback

### With Audit Ledger
- All approval decisions logged with full context
- Approval signatures anchored in ledger
- Queryable for compliance reporting

### With Policy Engine
- Policy determines risk classification
- Policy may require additional approvers for specific resources
- Policy changes require their own approval workflow

## Monitoring and Alerting

| Metric | Alert Threshold | Action |
|--------|-----------------|--------|
| Approval latency (median) | > 1 hour for medium-risk | Notify ops team |
| Approval timeout rate | > 5% | Review approval workflow |
| Emergency override rate | > 1/week | Security review |
| False positive rate | > 5% | Policy tuning required |
| Approver anomaly score | > threshold | Block approver + investigate |
