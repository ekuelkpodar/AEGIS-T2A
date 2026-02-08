"""
Bundle API Handlers

Endpoints for serving OPA bundles.
"""

from typing import Optional

from fastapi import APIRouter, Depends, Header, Response

from ..services.bundle_service import BundleService
from ..services.policy_service import get_policy_service, PolicyService

router = APIRouter(prefix="/bundles", tags=["bundles"])


@router.get("/{bundle_name}")
async def get_bundle(
    bundle_name: str,
    if_none_match: Optional[str] = Header(None),
    service: PolicyService = Depends(get_policy_service),
):
    """
    Serve a policy bundle for OPA.

    OPA will use If-None-Match for cache validation.
    """
    bundle_service = BundleService(service)
    artifact = await bundle_service.get_bundle(name=bundle_name)

    if if_none_match and if_none_match.strip('"') == artifact.revision:
        return Response(status_code=304)

    headers = {
        "ETag": f"\"{artifact.revision}\"",
        "Content-Type": "application/gzip",
    }
    return Response(content=artifact.bytes_data, media_type="application/gzip", headers=headers)
