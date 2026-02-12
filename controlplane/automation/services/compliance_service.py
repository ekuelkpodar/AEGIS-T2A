"""Privacy and regulatory compliance checks for automation tasks."""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Set

from ..models.automation import RiskLevel


@dataclass
class ComplianceResult:
    valid: bool
    violations: List[str] = field(default_factory=list)
    requires_human_review: bool = False
    review_reasons: List[str] = field(default_factory=list)
    sanitized_payload: Dict[str, Any] = field(default_factory=dict)


class ComplianceService:
    """Evaluates GDPR/HIPAA style controls and redacts sensitive fields."""

    SENSITIVE_KEYS: Set[str] = {
        "password",
        "secret",
        "token",
        "access_token",
        "refresh_token",
        "ssn",
        "social_security_number",
        "mrn",
        "medical_record_number",
        "credit_card",
        "api_key",
    }

    def redact(self, value: Any) -> Any:
        if isinstance(value, dict):
            output: Dict[str, Any] = {}
            for key, nested in value.items():
                lower_key = key.lower()
                if lower_key in self.SENSITIVE_KEYS or "secret" in lower_key or "token" in lower_key:
                    output[key] = "***REDACTED***"
                else:
                    output[key] = self.redact(nested)
            return output

        if isinstance(value, list):
            return [self.redact(item) for item in value]

        return value

    def evaluate(
        self,
        payload: Dict[str, Any],
        frameworks: List[str],
        contains_personal_data: bool,
        contains_phi: bool,
        lawful_basis: str | None,
        retention_days: int | None,
        risk_level: RiskLevel,
        ai_confidence: float | None,
        definition_requires_review: bool,
    ) -> ComplianceResult:
        frameworks_normalized = {item.lower() for item in frameworks}

        violations: List[str] = []
        review_reasons: List[str] = []

        if "gdpr" in frameworks_normalized and contains_personal_data and not lawful_basis:
            violations.append("GDPR requires lawful_basis when personal data is processed")

        if "gdpr" in frameworks_normalized and retention_days and retention_days > 2555:
            violations.append("GDPR retention_days exceeds configured maximum (2555 days)")

        if "hipaa" in frameworks_normalized and contains_phi:
            minimum_necessary = payload.get("minimum_necessary")
            if minimum_necessary is not True:
                violations.append("HIPAA PHI operations require minimum_necessary=true")

        if risk_level in {RiskLevel.HIGH, RiskLevel.CRITICAL}:
            review_reasons.append(f"Risk level is {risk_level.value}")

        if ai_confidence is not None and ai_confidence < 0.70:
            review_reasons.append(f"AI confidence {ai_confidence:.2f} below threshold 0.70")

        if definition_requires_review:
            review_reasons.append("Definition requires human review")

        return ComplianceResult(
            valid=len(violations) == 0,
            violations=violations,
            requires_human_review=len(review_reasons) > 0,
            review_reasons=review_reasons,
            sanitized_payload=self.redact(payload),
        )
