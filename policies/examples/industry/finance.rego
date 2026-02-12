package aegis.industry.finance

default decision := "deny"
default reasons := ["No matching policy path"]

is_finops {
  some role
  role := input.actor.roles[_]
  role == "finance_operator"
}

is_reviewer {
  some role
  role := input.actor.roles[_]
  role == "reviewer"
}

deny_reasons[reason] {
  input.action.id == "finance.payment.execute"
  input.context.amount_usd > 100000
  count(input.context.approvals) < 2
  reason := "Payments above 100000 USD require dual approval"
}

deny_reasons[reason] {
  input.action.safety_score < 50
  reason := "Finance action rejected due to low safety score"
}

require_approval_reasons[reason] {
  input.action.risk_level == "high"
  count(input.context.approvals) < 1
  reason := "High-risk finance action requires at least one approval"
}

require_approval_reasons[reason] {
  input.context.amount_usd >= 10000
  input.context.amount_usd <= 100000
  count(input.context.approvals) < 1
  reason := "Mid-value payment requires manager approval"
}

allow_reasons[reason] {
  is_finops
  is_reviewer
  not deny_reasons[_]
  not require_approval_reasons[_]
  reason := "Finance operator and reviewer constraints satisfied"
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
