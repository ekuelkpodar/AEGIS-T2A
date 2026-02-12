"""Modular external integration layer for automation execution."""

import os
from abc import ABC, abstractmethod
from typing import Any, Dict
from urllib.parse import urlparse

import httpx

from ..models.automation import ConnectorAuthType, IntegrationConnector, IntegrationType


class IntegrationExecutionError(Exception):
    """Raised when a connector execution fails."""


class BaseIntegrationAdapter(ABC):
    @abstractmethod
    async def execute(
        self,
        connector: IntegrationConnector,
        operation: Dict[str, Any],
        payload: Dict[str, Any],
    ) -> Dict[str, Any]:
        raise NotImplementedError


class HTTPIntegrationAdapter(BaseIntegrationAdapter):
    """Secure HTTP adapter for REST-style integrations."""

    async def execute(
        self,
        connector: IntegrationConnector,
        operation: Dict[str, Any],
        payload: Dict[str, Any],
    ) -> Dict[str, Any]:
        if not connector.base_url:
            raise IntegrationExecutionError("HTTP connector is missing base_url")

        method = str(operation.get("method", "POST")).upper()
        path = str(operation.get("path") or "")
        url = connector.base_url.rstrip("/")
        if path:
            url = f"{url}/{path.lstrip('/')}"

        self._enforce_allowed_host(url, connector)

        timeout_seconds = int(operation.get("timeout_seconds") or connector.timeout_seconds or 30)
        headers = {
            "Content-Type": "application/json",
        }
        headers.update(self._build_auth_headers(connector))

        request_json = payload
        if isinstance(operation.get("body_template"), dict):
            request_json = {**operation["body_template"], **payload}

        async with httpx.AsyncClient(timeout=timeout_seconds, verify=connector.verify_tls) as client:
            response = await client.request(
                method,
                url,
                json=request_json,
                headers=headers,
                params=operation.get("query") or {},
            )

        body: Any
        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            body = response.json()
        else:
            body = response.text

        if response.status_code >= 400:
            raise IntegrationExecutionError(
                f"Connector request failed: status={response.status_code}, body={str(body)[:500]}"
            )

        return {
            "status_code": response.status_code,
            "headers": dict(response.headers),
            "body": body,
        }

    @staticmethod
    def _enforce_allowed_host(url: str, connector: IntegrationConnector) -> None:
        if not connector.allowed_hosts:
            return

        hostname = urlparse(url).hostname
        if hostname not in set(connector.allowed_hosts):
            raise IntegrationExecutionError(f"Host '{hostname}' is not in connector allowed_hosts")

    def _build_auth_headers(self, connector: IntegrationConnector) -> Dict[str, str]:
        if connector.auth_type == ConnectorAuthType.NONE:
            return {}

        secret = self._resolve_secret(connector.secret_ref)
        if not secret:
            raise IntegrationExecutionError("Connector secret_ref not configured or secret is missing")

        if connector.auth_type == ConnectorAuthType.API_KEY:
            header_name = str(connector.auth_config.get("header") or "X-API-Key")
            return {header_name: secret}

        if connector.auth_type == ConnectorAuthType.BEARER:
            return {"Authorization": f"Bearer {secret}"}

        if connector.auth_type == ConnectorAuthType.OAUTH2_CLIENT_CREDENTIALS:
            # Simplified: allows pre-fetched bearer token via secret reference.
            # Production setups can replace this adapter with one that performs token exchange.
            return {"Authorization": f"Bearer {secret}"}

        if connector.auth_type == ConnectorAuthType.MTLS:
            # mTLS cert/key transport should be managed by sidecars/gateway in production.
            return {}

        return {}

    @staticmethod
    def _resolve_secret(secret_ref: str | None) -> str | None:
        if not secret_ref:
            return None
        return os.getenv(secret_ref)


class StubIntegrationAdapter(BaseIntegrationAdapter):
    """Fallback adapter used for connector types requiring custom plugins."""

    async def execute(
        self,
        connector: IntegrationConnector,
        operation: Dict[str, Any],
        payload: Dict[str, Any],
    ) -> Dict[str, Any]:
        return {
            "status": "accepted",
            "integration_type": connector.integration_type.value,
            "connector": connector.name,
            "operation": operation,
            "message": "No native adapter configured. Register a custom adapter for this integration type.",
            "payload_echo": payload,
        }


class IntegrationService:
    """Connector execution orchestrator with pluggable adapters."""

    def __init__(self):
        self.adapters: Dict[IntegrationType, BaseIntegrationAdapter] = {
            IntegrationType.HTTP: HTTPIntegrationAdapter(),
            IntegrationType.WEBHOOK: HTTPIntegrationAdapter(),
            IntegrationType.DATABASE: StubIntegrationAdapter(),
            IntegrationType.CRM: StubIntegrationAdapter(),
            IntegrationType.ERP: StubIntegrationAdapter(),
            IntegrationType.CUSTOM: StubIntegrationAdapter(),
        }

    def register_adapter(self, integration_type: IntegrationType, adapter: BaseIntegrationAdapter) -> None:
        self.adapters[integration_type] = adapter

    async def execute(
        self,
        connector: IntegrationConnector,
        operation: Dict[str, Any],
        payload: Dict[str, Any],
    ) -> Dict[str, Any]:
        if not connector.is_active:
            raise IntegrationExecutionError(f"Connector '{connector.name}' is disabled")

        adapter = self.adapters.get(connector.integration_type)
        if adapter is None:
            raise IntegrationExecutionError(f"No adapter available for {connector.integration_type.value}")

        return await adapter.execute(connector=connector, operation=operation, payload=payload)
