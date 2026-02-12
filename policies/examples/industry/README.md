# Industry Policy Templates (Rego)

Starter OPA/Rego templates for common enterprise control patterns.

## Files

- `healthcare.rego`: HIPAA-style PHI safeguards and mandatory approval checks.
- `logistics.rego`: dispatch and route-change controls with blast-radius constraints.
- `finance.rego`: payment/reconciliation controls with dual-approval for high-value actions.

## Expected input contract

```json
{
  "actor": {
    "id": "user-or-agent-id",
    "roles": ["industry_operator", "reviewer"]
  },
  "tenant": {
    "id": "tenant-1"
  },
  "action": {
    "id": "logistics.dispatch.driver.notify",
    "risk_level": "medium",
    "safety_score": 76,
    "blast_radius": {"max_records": 2, "level": "medium"},
    "compliance": {
      "frameworks": ["gdpr"],
      "contains_phi": false,
      "contains_personal_data": true
    }
  },
  "context": {
    "lawful_basis": "legitimate_interest",
    "minimum_necessary": true,
    "amount_usd": 0,
    "requires_human_review": false,
    "approvals": ["manager-1"]
  }
}
```

## Decision contract

Each policy returns:

- `decision`: `allow`, `require_approval`, or `deny`
- `reasons`: array of explanatory strings

Example evaluation command:

```bash
opa eval -d policies/examples/industry/healthcare.rego -I -f pretty 'data.aegis.industry.healthcare.output' < input.json
```
