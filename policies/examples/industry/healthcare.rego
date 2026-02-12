package aegis.industry.healthcare

import rego.v1

default decision := "deny"

default reasons := ["No matching policy path"]

is_operator if {
	some role in input.actor.roles
	role == "industry_operator"
}

is_reviewer if {
	some role in input.actor.roles
	role == "reviewer"
}

hipaa_action if {
	some fw in input.action.compliance.frameworks
	lower(fw) == "hipaa"
}

deny_reasons contains reason if {
	hipaa_action
	input.action.compliance.contains_phi
	not input.context.minimum_necessary
	reason := "HIPAA requires minimum_necessary=true for PHI actions"
}

deny_reasons contains reason if {
	input.action.risk_level == "critical"
	not is_reviewer
	reason := "Critical healthcare actions require reviewer role"
}

require_approval_reasons contains reason if {
	input.action.compliance.contains_phi
	count(input.context.approvals) < 1
	reason := "PHI action requires at least one human approval"
}

require_approval_reasons contains reason if {
	input.action.risk_level == "high"
	input.context.requires_human_review
	reason := "High-risk healthcare action flagged for human review"
}

allow_reasons contains reason if {
	is_operator
	count(deny_reasons) == 0
	count(require_approval_reasons) == 0
	reason := "Healthcare action satisfies operator and compliance checks"
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
