"""
OPA Client

Client for interacting with Open Policy Agent (OPA) server.
"""

import hashlib
import json
import logging
import tarfile
import io
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from dataclasses import dataclass

import httpx

from ...common.config.settings import get_settings

logger = logging.getLogger(__name__)


@dataclass
class OPADecision:
    """Result from OPA evaluation."""
    result: Any
    decision_id: Optional[str]
    metrics: Optional[Dict[str, Any]]


class OPAClient:
    """
    Client for Open Policy Agent.

    Provides:
    - Policy evaluation
    - Policy management (push/delete)
    - Data management
    - Bundle creation and distribution
    """

    def __init__(self, base_url: Optional[str] = None):
        settings = get_settings()
        self.base_url = base_url or settings.opa.url
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=30.0,
            headers={"Content-Type": "application/json"},
        )

    async def close(self):
        """Close the HTTP client."""
        await self._client.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.close()

    # =========================================================================
    # Policy Evaluation
    # =========================================================================

    async def evaluate(
        self,
        policy_path: str,
        input_data: Dict[str, Any],
        pretty: bool = False,
        metrics: bool = False,
        instrument: bool = False,
    ) -> OPADecision:
        """
        Evaluate a policy with input data.

        Args:
            policy_path: Policy path (e.g., "aegis/policies/allow")
            input_data: Input data for evaluation
            pretty: Pretty print the response
            metrics: Include evaluation metrics
            instrument: Include instrumentation data

        Returns:
            OPADecision with the evaluation result
        """
        params = {}
        if pretty:
            params["pretty"] = "true"
        if metrics:
            params["metrics"] = "true"
        if instrument:
            params["instrument"] = "true"

        # Clean path - remove leading slash if present
        clean_path = policy_path.lstrip("/")

        response = await self._client.post(
            f"/v1/data/{clean_path}",
            json={"input": input_data},
            params=params,
        )

        if response.status_code != 200:
            logger.error(f"OPA evaluation failed: {response.text}")
            raise OPAError(f"Evaluation failed: {response.status_code}")

        data = response.json()
        return OPADecision(
            result=data.get("result"),
            decision_id=data.get("decision_id"),
            metrics=data.get("metrics"),
        )

    async def evaluate_batch(
        self,
        policy_path: str,
        inputs: List[Dict[str, Any]],
    ) -> List[OPADecision]:
        """
        Evaluate a policy for multiple inputs.

        More efficient than individual evaluations.
        """
        results = []
        for input_data in inputs:
            result = await self.evaluate(policy_path, input_data)
            results.append(result)
        return results

    # =========================================================================
    # Policy Management
    # =========================================================================

    async def put_policy(
        self,
        policy_id: str,
        rego_code: str,
    ) -> bool:
        """
        Create or update a policy.

        Args:
            policy_id: Policy identifier
            rego_code: Rego policy code

        Returns:
            True if successful
        """
        response = await self._client.put(
            f"/v1/policies/{policy_id}",
            content=rego_code,
            headers={"Content-Type": "text/plain"},
        )

        if response.status_code not in (200, 201):
            error = response.json() if response.text else {}
            logger.error(f"Failed to put policy: {error}")
            raise OPAError(f"Failed to put policy: {error.get('message', response.status_code)}")

        logger.info(f"Policy {policy_id} uploaded to OPA")
        return True

    async def get_policy(self, policy_id: str) -> Optional[str]:
        """Get a policy's Rego code."""
        response = await self._client.get(f"/v1/policies/{policy_id}")

        if response.status_code == 404:
            return None

        if response.status_code != 200:
            raise OPAError(f"Failed to get policy: {response.status_code}")

        data = response.json()
        return data.get("result", {}).get("raw")

    async def delete_policy(self, policy_id: str) -> bool:
        """Delete a policy from OPA."""
        response = await self._client.delete(f"/v1/policies/{policy_id}")

        if response.status_code == 404:
            return False

        if response.status_code != 200:
            raise OPAError(f"Failed to delete policy: {response.status_code}")

        logger.info(f"Policy {policy_id} deleted from OPA")
        return True

    async def list_policies(self) -> List[Dict[str, Any]]:
        """List all policies in OPA."""
        response = await self._client.get("/v1/policies")

        if response.status_code != 200:
            raise OPAError(f"Failed to list policies: {response.status_code}")

        data = response.json()
        return data.get("result", [])

    # =========================================================================
    # Data Management
    # =========================================================================

    async def put_data(
        self,
        path: str,
        data: Dict[str, Any],
    ) -> bool:
        """
        Create or update data at a path.

        Args:
            path: Data path (e.g., "agents/permissions")
            data: Data to store

        Returns:
            True if successful
        """
        clean_path = path.lstrip("/")
        response = await self._client.put(
            f"/v1/data/{clean_path}",
            json=data,
        )

        if response.status_code not in (200, 201, 204):
            raise OPAError(f"Failed to put data: {response.status_code}")

        logger.debug(f"Data updated at {path}")
        return True

    async def get_data(self, path: str) -> Optional[Any]:
        """Get data at a path."""
        clean_path = path.lstrip("/")
        response = await self._client.get(f"/v1/data/{clean_path}")

        if response.status_code == 404:
            return None

        if response.status_code != 200:
            raise OPAError(f"Failed to get data: {response.status_code}")

        data = response.json()
        return data.get("result")

    async def delete_data(self, path: str) -> bool:
        """Delete data at a path."""
        clean_path = path.lstrip("/")
        response = await self._client.delete(f"/v1/data/{clean_path}")

        if response.status_code == 404:
            return False

        if response.status_code not in (200, 204):
            raise OPAError(f"Failed to delete data: {response.status_code}")

        return True

    # =========================================================================
    # Bundle Management
    # =========================================================================

    def create_bundle(
        self,
        policies: List[Dict[str, str]],
        data: Optional[Dict[str, Any]] = None,
    ) -> tuple[bytes, str]:
        """
        Create an OPA bundle (tar.gz).

        Args:
            policies: List of {"id": "...", "code": "..."} dicts
            data: Optional data to include

        Returns:
            Tuple of (bundle_bytes, revision_hash)
        """
        # Create tar.gz in memory
        buffer = io.BytesIO()
        content_hash = hashlib.sha256()

        with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
            # Add policies
            for policy in policies:
                policy_id = policy["id"]
                code = policy["code"].encode("utf-8")

                # Create file info
                info = tarfile.TarInfo(name=f"{policy_id}.rego")
                info.size = len(code)
                info.mtime = int(datetime.now(timezone.utc).timestamp())

                tar.addfile(info, io.BytesIO(code))
                content_hash.update(code)

            # Add data if provided
            if data:
                data_json = json.dumps(data, sort_keys=True).encode("utf-8")
                info = tarfile.TarInfo(name="data.json")
                info.size = len(data_json)
                info.mtime = int(datetime.now(timezone.utc).timestamp())

                tar.addfile(info, io.BytesIO(data_json))
                content_hash.update(data_json)

            # Add manifest
            revision = content_hash.hexdigest()[:16]
            manifest = {
                "revision": revision,
                "roots": ["aegis"],
            }
            manifest_json = json.dumps(manifest).encode("utf-8")
            info = tarfile.TarInfo(name=".manifest")
            info.size = len(manifest_json)
            tar.addfile(info, io.BytesIO(manifest_json))

        return buffer.getvalue(), revision

    # =========================================================================
    # Health & Status
    # =========================================================================

    async def health(self) -> Dict[str, Any]:
        """Check OPA health."""
        try:
            response = await self._client.get("/health")
            return {"status": "healthy", "code": response.status_code}
        except Exception as e:
            return {"status": "unhealthy", "error": str(e)}

    async def status(self) -> Dict[str, Any]:
        """Get OPA status information."""
        response = await self._client.get("/v1/status")

        if response.status_code != 200:
            return {"error": f"Status check failed: {response.status_code}"}

        return response.json()

    # =========================================================================
    # Query Parsing & Compilation
    # =========================================================================

    async def compile_query(
        self,
        query: str,
        input_data: Optional[Dict[str, Any]] = None,
        unknowns: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        Compile a query for partial evaluation.

        Useful for understanding what data is needed for a decision.
        """
        body = {"query": query}
        if input_data:
            body["input"] = input_data
        if unknowns:
            body["unknowns"] = unknowns

        response = await self._client.post(
            "/v1/compile",
            json=body,
        )

        if response.status_code != 200:
            raise OPAError(f"Compilation failed: {response.text}")

        return response.json()


class OPAError(Exception):
    """Exception raised for OPA errors."""
    pass


# Singleton instance
_opa_client: Optional[OPAClient] = None


def get_opa_client() -> OPAClient:
    """Get OPA client singleton."""
    global _opa_client
    if _opa_client is None:
        _opa_client = OPAClient()
    return _opa_client
