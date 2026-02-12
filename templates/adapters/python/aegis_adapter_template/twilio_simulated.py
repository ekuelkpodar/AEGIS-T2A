from __future__ import annotations

from uuid import uuid4
from typing import Any, Dict

from .base import AdapterPlugin
from .types import ActionContext, AdapterHealth, ExecutionResult, SimulationResult, ValidationResult


class SimulatedTwilioAdapter(AdapterPlugin):
    @property
    def name(self) -> str:
        return "twilio-simulated"

    def __init__(self) -> None:
        self._connected = False
        self._config: Dict[str, Any] = {}

    async def connect(self, config: Dict[str, Any]) -> None:
        required = ["account_sid", "auth_token_ref", "from_phone"]
        missing = [field for field in required if not config.get(field)]
        if missing:
            raise ValueError(f"Missing config fields: {', '.join(missing)}")

        self._config = config
        self._connected = True

    async def validate(self, payload: Dict[str, Any]) -> ValidationResult:
        errors = []
        if not payload.get("to_phone"):
            errors.append("to_phone is required")
        if not payload.get("message"):
            errors.append("message is required")
        return ValidationResult(valid=len(errors) == 0, errors=errors)

    async def simulate(self, payload: Dict[str, Any], context: ActionContext) -> SimulationResult:
        validation = await self.validate(payload)
        if not validation.valid:
            return SimulationResult(
                accepted=False,
                estimated_duration_seconds=0,
                estimated_cost_usd=0.0,
                warnings=validation.errors,
                output_preview={},
            )

        msg = str(payload["message"])
        cost = min(0.01 + len(msg) * 0.0001, 0.08)

        warnings = []
        if context.mode == "sandbox":
            warnings.append("Sandbox mode enabled; provider call skipped")

        return SimulationResult(
            accepted=True,
            estimated_duration_seconds=2,
            estimated_cost_usd=round(cost, 4),
            warnings=warnings,
            output_preview={
                "to": payload.get("to_phone"),
                "from": self._config.get("from_phone"),
                "message_length": len(msg),
            },
        )

    async def execute(self, payload: Dict[str, Any], context: ActionContext) -> ExecutionResult:
        if not self._connected:
            return ExecutionResult(success=False, error="Adapter not connected")

        validation = await self.validate(payload)
        if not validation.valid:
            return ExecutionResult(success=False, error="; ".join(validation.errors))

        if context.mode == "sandbox":
            return ExecutionResult(
                success=True,
                provider_request_id=f"sandbox-{uuid4()}",
                output={
                    "simulated": True,
                    "to": payload["to_phone"],
                    "message": payload["message"],
                },
            )

        return ExecutionResult(
            success=True,
            provider_request_id=f"twilio-{uuid4()}",
            output={
                "delivered": True,
                "to": payload["to_phone"],
            },
        )

    async def rollback(self, payload: Dict[str, Any], context: ActionContext) -> ExecutionResult:
        return ExecutionResult(
            success=True,
            provider_request_id=f"rollback-{uuid4()}",
            output={
                "action": "send_compensation_message",
                "to": payload.get("to_phone"),
                "correlation_id": context.correlation_id,
            },
        )

    async def health_check(self) -> AdapterHealth:
        return AdapterHealth(
            status="healthy" if self._connected else "degraded",
            details={"provider": "twilio", "mode": "simulated", "connected": self._connected},
        )
