package aegis.industry.healthcare

default decision := "deny"
default reasons := ["No matching policy path"]

is_operator {
  some role
  role := input.actor.roles[_]
  role == "industry_operator"
}

is_reviewer {
  some role
  role := input.actor.roles[_]
  role == "reviewer"
}

hipaa_action {
  some fw
  fw := input.action.compliance.frameworks[_]
  lower(fw) == "hipaa"
}

deny_reasons[reason] {
  hipaa_action
  input.action.compliance.contains_phi
  not input.context.minimum_necessary
  reason := "HIPAA requires minimum_necessary=true for PHI actions"
}

deny_reasons[reason] {
  input.action.risk_level == "critical"
  not is_reviewer
  reason := "Critical healthcare actions require reviewer role"
}

require_approval_reasons[reason] {
  input.action.compliance.contains_phi
  count(input.context.approvals) < 1
  reason := "PHI action requires at least one human approval"
}

require_approval_reasons[reason] {
  input.action.risk_level == "high"
  input.context.requires_human_review
  reason := "High-risk healthcare action flagged for human review"
}

allow_reasons[reason] {
  is_operator
  not deny_reasons[_]
  not require_approval_reasons[_]
  reason := "Healthcare action satisfies operator and compliance checks"
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
