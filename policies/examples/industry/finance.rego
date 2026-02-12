package aegis.industry.finance

import rego.v1

default decision := "deny"

default reasons := ["No matching policy path"]

is_finops if {
	some role in input.actor.roles
	role == "finance_operator"
}

is_reviewer if {
	some role in input.actor.roles
	role == "reviewer"
}

deny_reasons contains reason if {
	input.action.id == "finance.payment.execute"
	input.context.amount_usd > 100000
	count(input.context.approvals) < 2
	reason := "Payments above 100000 USD require dual approval"
}

deny_reasons contains reason if {
	input.action.safety_score < 50
	reason := "Finance action rejected due to low safety score"
}

require_approval_reasons contains reason if {
	input.action.risk_level == "high"
	count(input.context.approvals) < 1
	reason := "High-risk finance action requires at least one approval"
}

require_approval_reasons contains reason if {
	input.context.amount_usd >= 10000
	input.context.amount_usd <= 100000
	count(input.context.approvals) < 1
	reason := "Mid-value payment requires manager approval"
}

allow_reasons contains reason if {
	is_finops
	is_reviewer
	count(deny_reasons) == 0
	count(require_approval_reasons) == 0
	reason := "Finance operator and reviewer constraints satisfied"
}

output := {
	"decision": decision,
	"reasons": reasons,
}

# Decision precedence

decision := "deny" if {
	count(deny_reasons) > 0
}

reasons := [r | r := deny_reasons[_]] if {
	count(deny_reasons) > 0
}

decision := "require_approval" if {
	count(deny_reasons) == 0
	count(require_approval_reasons) > 0
}

reasons := [r | r := require_approval_reasons[_]] if {
	count(deny_reasons) == 0
	count(require_approval_reasons) > 0
}

decision := "allow" if {
	count(deny_reasons) == 0
	count(require_approval_reasons) == 0
	count(allow_reasons) > 0
}

reasons := [r | r := allow_reasons[_]] if {
	count(deny_reasons) == 0
	count(require_approval_reasons) == 0
	count(allow_reasons) > 0
}
