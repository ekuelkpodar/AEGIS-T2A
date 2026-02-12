from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict

from .types import ActionContext, AdapterHealth, ExecutionResult, SimulationResult, ValidationResult


class AdapterPlugin(ABC):
    @property
    @abstractmethod
    def name(self) -> str:
        raise NotImplementedError

    @abstractmethod
    async def connect(self, config: Dict[str, Any]) -> None:
        raise NotImplementedError

    @abstractmethod
    async def validate(self, payload: Dict[str, Any]) -> ValidationResult:
        raise NotImplementedError

    @abstractmethod
    async def simulate(self, payload: Dict[str, Any], context: ActionContext) -> SimulationResult:
        raise NotImplementedError

    @abstractmethod
    async def execute(self, payload: Dict[str, Any], context: ActionContext) -> ExecutionResult:
        raise NotImplementedError

    @abstractmethod
    async def rollback(self, payload: Dict[str, Any], context: ActionContext) -> ExecutionResult:
        raise NotImplementedError

    @abstractmethod
    async def health_check(self) -> AdapterHealth:
        raise NotImplementedError
