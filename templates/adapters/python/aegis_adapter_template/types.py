from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal

AdapterMode = Literal["sandbox", "production"]


@dataclass(slots=True)
class ActionContext:
    tenant_id: str
    correlation_id: str
    actor_id: str
    mode: AdapterMode


@dataclass(slots=True)
class ValidationResult:
    valid: bool
    errors: List[str] = field(default_factory=list)


@dataclass(slots=True)
class SimulationResult:
    accepted: bool
    estimated_duration_seconds: int
    estimated_cost_usd: float
    warnings: List[str] = field(default_factory=list)
    output_preview: Dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ExecutionResult:
    success: bool
    output: Dict[str, Any] = field(default_factory=dict)
    provider_request_id: str | None = None
    error: str | None = None


@dataclass(slots=True)
class AdapterHealth:
    status: Literal["healthy", "degraded", "unhealthy"]
    details: Dict[str, Any] = field(default_factory=dict)
