"""
Autonomy Manager API Handlers

HTTP endpoints for lease management and autonomy checks.
"""

import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

from ..models.schemas import (
    LeaseCreate,
    LeaseResponse,
    LeaseListResponse,
    LeaseRenewRequest,
    LeaseRevokeRequest,
    LeaseApproveRequest,
    AutonomyCheckRequest,
    AutonomyCheckResult,
    BulkRevokeRequest,
    BulkRevokeResponse,
    LeaseStats,
    LeaseStatus,
    LeaseType,
)
from ..services.lease_service import LeaseService, get_lease_service
from ...common.auth.middleware import get_current_identity, AgentIdentity

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/leases", tags=["leases"])


def _lease_to_response(lease) -> LeaseResponse:
    """Convert lease model to response."""
    from ..models.lease import LeaseStatus as DBStatus, LeaseType as DBType
    return LeaseResponse(
        id=lease.id,
        agent_id=lease.agent_id,
        agent_name=lease.agent_name,
        lease_type=LeaseType(lease.lease_type.value),
        status=LeaseStatus(lease.status.value),
        autonomy_level=lease.autonomy_level,
        created_at=lease.created_at,
        activated_at=lease.activated_at,
        expires_at=lease.expires_at,
        ttl_seconds=lease.ttl_seconds,
        remaining_seconds=lease.remaining_seconds,
        is_valid=lease.is_valid,
        can_renew=lease.can_renew,
        renewal_count=lease.renewal_count,
        max_renewals=lease.max_renewals,
        allowed_actions=lease.allowed_actions or [],
        allowed_resources=lease.allowed_resources or [],
        denied_actions=lease.denied_actions or [],
        denied_resources=lease.denied_resources or [],
        max_actions_per_minute=lease.max_actions_per_minute,
        max_actions_total=lease.max_actions_total,
        actions_taken=lease.actions_taken or 0,
        constraints=lease.constraints or {},
        context=lease.context or {},
        metadata=lease.metadata or {},
        requires_approval=lease.requires_approval,
        approved_by=lease.approved_by,
        approved_at=lease.approved_at,
        revoked_at=lease.revoked_at,
        revoked_by=lease.revoked_by,
        revocation_reason=lease.revocation_reason,
        granted_by=lease.granted_by,
    )


# =============================================================================
# Lease CRUD
# =============================================================================

@router.post("", response_model=LeaseResponse, status_code=201)
async def create_lease(
    lease: LeaseCreate,
    identity: AgentIdentity = Depends(get_current_identity),
    service: LeaseService = Depends(get_lease_service),
):
    """
    Create a new autonomy lease for an agent.

    If requires_approval is True, the lease starts in PENDING status
    and must be approved before it takes effect.
    """
    if "leases:write" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing leases:write permission")

    try:
        created = await service.create_lease(
            data=lease,
            granted_by=identity.agent_id,
        )
        return _lease_to_response(created)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"Failed to create lease: {e}")
        raise HTTPException(status_code=500, detail="Failed to create lease")


@router.get("/{lease_id}", response_model=LeaseResponse)
async def get_lease(
    lease_id: UUID,
    identity: AgentIdentity = Depends(get_current_identity),
    service: LeaseService = Depends(get_lease_service),
):
    """Get a lease by ID."""
    if "leases:read" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing leases:read permission")

    lease = await service.get_lease(lease_id)
    if not lease:
        raise HTTPException(status_code=404, detail="Lease not found")

    return _lease_to_response(lease)


@router.get("", response_model=LeaseListResponse)
async def list_leases(
    agent_id: Optional[UUID] = Query(None, description="Filter by agent"),
    status: Optional[LeaseStatus] = Query(None, description="Filter by status"),
    lease_type: Optional[LeaseType] = Query(None, description="Filter by type"),
    include_expired: bool = Query(False, description="Include expired leases"),
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    identity: AgentIdentity = Depends(get_current_identity),
    service: LeaseService = Depends(get_lease_service),
):
    """List leases with optional filtering."""
    if "leases:read" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing leases:read permission")

    from ..models.lease import LeaseStatus as DBStatus, LeaseType as DBType

    leases, total = await service.list_leases(
        agent_id=agent_id,
        status=DBStatus(status.value) if status else None,
        lease_type=DBType(lease_type.value) if lease_type else None,
        include_expired=include_expired,
        offset=offset,
        limit=limit,
    )

    return LeaseListResponse(
        leases=[_lease_to_response(l) for l in leases],
        total=total,
        offset=offset,
        limit=limit,
    )


# =============================================================================
# Lease Lifecycle
# =============================================================================

@router.post("/{lease_id}/approve", response_model=LeaseResponse)
async def approve_lease(
    lease_id: UUID,
    request: LeaseApproveRequest,
    identity: AgentIdentity = Depends(get_current_identity),
    service: LeaseService = Depends(get_lease_service),
):
    """
    Approve or reject a pending lease.

    Only pending leases can be approved/rejected.
    """
    if "leases:approve" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing leases:approve permission")

    try:
        lease = await service.approve_lease(
            lease_id=lease_id,
            data=request,
            approved_by=identity.agent_id,
        )
        return _lease_to_response(lease)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{lease_id}/renew", response_model=LeaseResponse)
async def renew_lease(
    lease_id: UUID,
    request: LeaseRenewRequest,
    identity: AgentIdentity = Depends(get_current_identity),
    service: LeaseService = Depends(get_lease_service),
):
    """
    Renew a lease, extending its expiration time.

    Can only be done if the lease is active and has renewals remaining.
    """
    if "leases:renew" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing leases:renew permission")

    try:
        lease = await service.renew_lease(
            lease_id=lease_id,
            data=request,
            renewed_by=identity.agent_id,
        )
        return _lease_to_response(lease)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{lease_id}/revoke", response_model=LeaseResponse)
async def revoke_lease(
    lease_id: UUID,
    request: LeaseRevokeRequest,
    identity: AgentIdentity = Depends(get_current_identity),
    service: LeaseService = Depends(get_lease_service),
):
    """
    Revoke a lease, immediately terminating agent autonomy.

    This is a critical operation used for emergency shutdowns.
    """
    if "leases:revoke" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing leases:revoke permission")

    try:
        lease = await service.revoke_lease(
            lease_id=lease_id,
            data=request,
            revoked_by=identity.agent_id,
        )
        return _lease_to_response(lease)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{lease_id}/suspend", response_model=LeaseResponse)
async def suspend_lease(
    lease_id: UUID,
    reason: str = Query(..., description="Reason for suspension"),
    identity: AgentIdentity = Depends(get_current_identity),
    service: LeaseService = Depends(get_lease_service),
):
    """Temporarily suspend a lease."""
    if "leases:suspend" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing leases:suspend permission")

    try:
        lease = await service.suspend_lease(
            lease_id=lease_id,
            reason=reason,
            suspended_by=identity.agent_id,
        )
        return _lease_to_response(lease)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{lease_id}/resume", response_model=LeaseResponse)
async def resume_lease(
    lease_id: UUID,
    identity: AgentIdentity = Depends(get_current_identity),
    service: LeaseService = Depends(get_lease_service),
):
    """Resume a suspended lease."""
    if "leases:resume" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing leases:resume permission")

    try:
        lease = await service.resume_lease(
            lease_id=lease_id,
            resumed_by=identity.agent_id,
        )
        return _lease_to_response(lease)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# =============================================================================
# Autonomy Checks
# =============================================================================

@router.post("/check", response_model=AutonomyCheckResult)
async def check_autonomy(
    request: AutonomyCheckRequest,
    identity: AgentIdentity = Depends(get_current_identity),
    service: LeaseService = Depends(get_lease_service),
):
    """
    Check if an agent has autonomy to perform an action.

    This is the primary endpoint used by agents to verify they
    have permission before taking action.
    """
    if "leases:check" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing leases:check permission")

    result = await service.check_autonomy(request)
    return result


@router.get("/agent/{agent_id}/active", response_model=Optional[LeaseResponse])
async def get_active_lease_for_agent(
    agent_id: UUID,
    identity: AgentIdentity = Depends(get_current_identity),
    service: LeaseService = Depends(get_lease_service),
):
    """Get the currently active lease for an agent."""
    if "leases:read" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing leases:read permission")

    lease = await service.get_active_lease(agent_id)
    if not lease:
        return JSONResponse(status_code=204, content=None)

    return _lease_to_response(lease)


# =============================================================================
# Bulk Operations
# =============================================================================

@router.post("/bulk/revoke", response_model=BulkRevokeResponse)
async def bulk_revoke_leases(
    request: BulkRevokeRequest,
    identity: AgentIdentity = Depends(get_current_identity),
    service: LeaseService = Depends(get_lease_service),
):
    """
    Revoke multiple leases at once.

    Can specify lease IDs or revoke all for an agent.
    """
    if "leases:admin" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing leases:admin permission")

    errors = []
    revoked_count = 0

    if request.agent_id:
        revoked_count = await service.revoke_all_for_agent(
            agent_id=request.agent_id,
            reason=request.reason,
            revoked_by=identity.agent_id,
        )
    elif request.lease_ids:
        for lease_id in request.lease_ids:
            try:
                await service.revoke_lease(
                    lease_id=lease_id,
                    data=LeaseRevokeRequest(reason=request.reason),
                    revoked_by=identity.agent_id,
                )
                revoked_count += 1
            except Exception as e:
                errors.append({"lease_id": str(lease_id), "error": str(e)})

    return BulkRevokeResponse(
        revoked_count=revoked_count,
        failed_count=len(errors),
        errors=errors,
    )


# =============================================================================
# Statistics & Admin
# =============================================================================

@router.get("/stats", response_model=LeaseStats)
async def get_lease_stats(
    identity: AgentIdentity = Depends(get_current_identity),
    service: LeaseService = Depends(get_lease_service),
):
    """Get lease statistics."""
    if "leases:read" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing leases:read permission")

    stats = await service.get_stats()
    return LeaseStats(
        total_leases=stats["total_leases"],
        active_leases=stats["active_leases"],
        pending_leases=stats["pending_leases"],
        expired_leases=stats["expired_leases"],
        revoked_leases=stats["revoked_leases"],
        leases_by_agent=stats["leases_by_agent"],
        leases_by_type=stats["leases_by_type"],
        average_ttl_seconds=stats["average_ttl_seconds"],
        average_renewal_count=stats["average_renewal_count"],
        timestamp=datetime.now(timezone.utc),
    )


@router.post("/expire")
async def trigger_expiration(
    identity: AgentIdentity = Depends(get_current_identity),
    service: LeaseService = Depends(get_lease_service),
):
    """
    Manually trigger lease expiration check.

    Admin operation to expire stale leases.
    """
    if "leases:admin" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing leases:admin permission")

    expired = await service.expire_leases()
    return {"expired_count": expired, "timestamp": datetime.now(timezone.utc).isoformat()}
