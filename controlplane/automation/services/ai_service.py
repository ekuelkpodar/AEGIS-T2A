"""AI interpretation and risk scoring with optional external model endpoint."""

import os
from dataclasses import dataclass, field
from typing import Any, Dict, List

import httpx

from ..models.automation import RiskLevel


@dataclass
class AIInterpretation:
    action_type: str
    normalized_payload: Dict[str, Any]
    risk_level: RiskLevel
    confidence: float
    requires_human_review: bool
    review_reasons: List[str] = field(default_factory=list)
    compliance_frameworks: List[str] = field(default_factory=list)


class AIService:
    """NLP-driven task interpretation with deterministic fallback."""

    def __init__(self):
        self.endpoint = os.getenv("AEGIS_AI_INTERPRETER_URL")
        self.timeout_seconds = float(os.getenv("AEGIS_AI_INTERPRETER_TIMEOUT", "8"))

    async def interpret_task(self, prompt: str, industry_hint: str | None = None) -> AIInterpretation:
        if self.endpoint:
            remote = await self._interpret_remote(prompt, industry_hint)
            if remote:
                return remote

        return self._interpret_heuristic(prompt, industry_hint)

    async def _interpret_remote(self, prompt: str, industry_hint: str | None) -> AIInterpretation | None:
        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.post(
                    self.endpoint,
                    json={
                        "prompt": prompt,
                        "industry_hint": industry_hint,
                    },
                )

            if response.status_code >= 400:
                return None

            payload = response.json()
            action_type = str(payload.get("action_type") or "workflow.execute")
            normalized_payload = payload.get("normalized_payload") or {"instruction": prompt}

            risk_value = str(payload.get("risk_level") or "medium").lower()
            risk = RiskLevel(risk_value) if risk_value in RiskLevel._value2member_map_ else RiskLevel.MEDIUM

            confidence = float(payload.get("confidence") or 0.6)
            review_reasons = list(payload.get("review_reasons") or [])
            frameworks = list(payload.get("compliance_frameworks") or [])

            requires_review = bool(payload.get("requires_human_review")) or confidence < 0.70

            return AIInterpretation(
                action_type=action_type,
                normalized_payload=normalized_payload,
                risk_level=risk,
                confidence=max(0.0, min(1.0, confidence)),
                requires_human_review=requires_review,
                review_reasons=review_reasons,
                compliance_frameworks=frameworks,
            )

        except Exception:
            return None

    def _interpret_heuristic(self, prompt: str, industry_hint: str | None) -> AIInterpretation:
        text = prompt.lower()

        action_type = "workflow.execute"
        frameworks: List[str] = []
        review_reasons: List[str] = []
        risk = RiskLevel.MEDIUM
        confidence = 0.62

        if any(keyword in text for keyword in ["patient", "clinical", "hospital", "medical"]):
            action_type = "healthcare.workflow"
            frameworks.append("HIPAA")
            confidence += 0.08

        elif any(keyword in text for keyword in ["route", "shipment", "freight", "warehouse", "delivery"]):
            action_type = "logistics.workflow"
            confidence += 0.08

        elif any(keyword in text for keyword in ["grid", "power", "energy", "substation", "load"]):
            action_type = "energy.workflow"
            confidence += 0.08

        if any(keyword in text for keyword in ["customer", "email", "phone", "address", "employee", "pii"]):
            frameworks.append("GDPR")

        if any(keyword in text for keyword in ["delete", "shutdown", "terminate", "override", "emergency"]):
            risk = RiskLevel.HIGH
            review_reasons.append("Contains high-impact intent keywords")
            confidence -= 0.1

        if any(keyword in text for keyword in ["critical", "production", "live system"]):
            risk = RiskLevel.CRITICAL
            review_reasons.append("Targets critical production systems")
            confidence -= 0.1

        if industry_hint:
            confidence += 0.05

        confidence = max(0.3, min(0.95, confidence))
        requires_review = risk in {RiskLevel.HIGH, RiskLevel.CRITICAL} or confidence < 0.70
        if confidence < 0.70:
            review_reasons.append("Low NLP confidence")

        normalized_payload = {
            "instruction": prompt,
            "industry_hint": industry_hint,
        }

        return AIInterpretation(
            action_type=action_type,
            normalized_payload=normalized_payload,
            risk_level=risk,
            confidence=confidence,
            requires_human_review=requires_review,
            review_reasons=review_reasons,
            compliance_frameworks=frameworks,
        )
