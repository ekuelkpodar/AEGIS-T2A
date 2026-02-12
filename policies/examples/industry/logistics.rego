package aegis.industry.logistics

import rego.v1

default decision := "deny"

default reasons := ["No matching policy path"]

is_dispatcher if {
	some role in input.actor.roles
	role == "dispatcher"
}

is_operator if {
	some role in input.actor.roles
	role == "industry_operator"
}

deny_reasons contains reason if {
	input.action.blast_radius.max_records > 200
	reason := "Blast radius exceeds logistics policy threshold (max_records > 200)"
}

deny_reasons contains reason if {
	input.action.safety_score < 40
	reason := "Safety score below minimum threshold"
}

require_approval_reasons contains reason if {
	input.action.risk_level == "high"
	reason := "High-risk logistics action requires approval"
}

require_approval_reasons contains reason if {
	input.action.blast_radius.level == "critical"
	reason := "Critical blast radius requires supervisor sign-off"
}

allow_reasons contains reason if {
	is_operator
	is_dispatcher
	count(deny_reasons) == 0
	count(require_approval_reasons) == 0
	reason := "Dispatcher/operator roles validated for logistics action"
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
