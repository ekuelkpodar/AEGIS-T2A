"""
OPA Bundle Service

Builds and serves policy bundles for OPA to pull.
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Optional, Tuple, List

from ..models.policy import PolicyStatus
from .opa_client import OPAClient, get_opa_client
from .policy_service import PolicyService

logger = logging.getLogger(__name__)


@dataclass
class BundleArtifact:
    """In-memory bundle artifact."""
    revision: str
    created_at: datetime
    bytes_data: bytes
    policies_count: int


class BundleService:
    """
    Service for generating OPA bundles from active policies.
    """

    def __init__(
        self,
        policy_service: PolicyService,
        opa_client: Optional[OPAClient] = None,
    ):
        self.policy_service = policy_service
        self.opa = opa_client or get_opa_client()
        self._cache: Dict[str, BundleArtifact] = {}

    async def build_bundle(self, name: str = "aegis") -> BundleArtifact:
        """
        Build a bundle from all active policies.
        """
        policies, _ = await self.policy_service.list_policies(status=PolicyStatus.ACTIVE)

        policy_items: List[Dict[str, str]] = []
        for policy in policies:
            code = self._wrap_policy_code(policy.id, policy.rego_code)
            policy_items.append({"id": str(policy.id), "code": code})

        bundle_bytes, revision = self.opa.create_bundle(policy_items)
        artifact = BundleArtifact(
            revision=revision,
            created_at=datetime.now(timezone.utc),
            bytes_data=bundle_bytes,
            policies_count=len(policy_items),
        )
        self._cache[name] = artifact
        logger.info("OPA bundle built", {"name": name, "revision": revision, "policies": len(policy_items)})
        return artifact

    async def get_bundle(self, name: str = "aegis", force_refresh: bool = False) -> BundleArtifact:
        """
        Get a bundle from cache or rebuild if missing/forced.
        """
        if not force_refresh and name in self._cache:
            return self._cache[name]
        return await self.build_bundle(name=name)

    @staticmethod
    def _wrap_policy_code(policy_id: str, code: str) -> str:
        if code.strip().startswith("package"):
            return code
        return f"package aegis.policies.{policy_id}\n\n{code}"
