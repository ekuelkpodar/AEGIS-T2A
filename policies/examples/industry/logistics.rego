package aegis.industry.logistics

default decision := "deny"
default reasons := ["No matching policy path"]

is_dispatcher {
  some role
  role := input.actor.roles[_]
  role == "dispatcher"
}

is_operator {
  some role
  role := input.actor.roles[_]
  role == "industry_operator"
}

deny_reasons[reason] {
  input.action.blast_radius.max_records > 200
  reason := "Blast radius exceeds logistics policy threshold (max_records > 200)"
}

deny_reasons[reason] {
  input.action.safety_score < 40
  reason := "Safety score below minimum threshold"
}

require_approval_reasons[reason] {
  input.action.risk_level == "high"
  reason := "High-risk logistics action requires approval"
}

require_approval_reasons[reason] {
  input.action.blast_radius.level == "critical"
  reason := "Critical blast radius requires supervisor sign-off"
}

allow_reasons[reason] {
  is_operator
  is_dispatcher
  not deny_reasons[_]
  not require_approval_reasons[_]
  reason := "Dispatcher/operator roles validated for logistics action"
}

output := {
  "decision": decision,
  "reasons": reasons,
}

# Decision precedence

decision := "deny" {
  count(deny_reasons) > 0
}

reasons := [r | r := deny_reasons[_]] {
  count(deny_reasons) > 0
}

decision := "require_approval" {
  count(deny_reasons) == 0
  count(require_approval_reasons) > 0
}

reasons := [r | r := require_approval_reasons[_]] {
  count(deny_reasons) == 0
  count(require_approval_reasons) > 0
}

decision := "allow" {
  count(deny_reasons) == 0
  count(require_approval_reasons) == 0
  count(allow_reasons) > 0
}

reasons := [r | r := allow_reasons[_]] {
  count(deny_reasons) == 0
  count(require_approval_reasons) == 0
  count(allow_reasons) > 0
}
