"""
Approval System API Handlers

HTTP endpoints for approval request management.
"""

import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from ..models.schemas import (
    ApprovalRequestCreate,
    ApprovalRequestResponse,
    ApprovalListResponse,
    ApprovalDecision,
    EscalateRequest,
    ApprovalStats,
    ApprovalStatus,
    ApprovalType,
)
from ..services.approval_service import ApprovalService, get_approval_service
from ...common.auth.middleware import get_current_identity, AgentIdentity

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/approvals", tags=["approvals"])


def _request_to_response(request) -> ApprovalRequestResponse:
    """Convert request model to response."""
    from ..models.approval import ApprovalStatus as DBStatus, ApprovalType as DBType
    return ApprovalRequestResponse(
        id=request.id,
        title=request.title,
        description=request.description,
        approval_type=ApprovalType(request.approval_type.value),
        status=ApprovalStatus(request.status.value),
        agent_id=request.agent_id,
        agent_name=request.agent_name,
        requested_by=request.requested_by,
        action=request.action,
        resource=request.resource,
        payload=request.payload or {},
        context=request.context or {},
        risk_level=request.risk_level,
        risk_factors=request.risk_factors or [],
        impact_scope=request.impact_scope,
        escalation_level=request.escalation_level,
        escalation_chain=request.escalation_chain or [],
        current_approver=request.current_approver,
        created_at=request.created_at,
        expires_at=request.expires_at,
        ttl_seconds=request.ttl_seconds,
        is_expired=request.is_expired,
        decided_at=request.decided_at,
        decided_by=request.decided_by,
        decision_notes=request.decision_notes,
        conditions=request.conditions or {},
        notification_channels=request.notification_channels or [],
        notification_sent=request.notification_sent,
        metadata=request.metadata or {},
        tags=request.tags or [],
    )


@router.post("", response_model=ApprovalRequestResponse, status_code=201)
async def create_approval_request(
    request: ApprovalRequestCreate,
    identity: AgentIdentity = Depends(get_current_identity),
    service: ApprovalService = Depends(get_approval_service),
):
    """Create a new approval request."""
    if "approvals:write" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing approvals:write permission")

    try:
        created = await service.create_request(
            data=request,
            requested_by=identity.agent_id,
        )
        return _request_to_response(created)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"Failed to create approval request: {e}")
        raise HTTPException(status_code=500, detail="Failed to create approval request")


@router.get("/{request_id}", response_model=ApprovalRequestResponse)
async def get_approval_request(
    request_id: UUID,
    identity: AgentIdentity = Depends(get_current_identity),
    service: ApprovalService = Depends(get_approval_service),
):
    """Get an approval request by ID."""
    if "approvals:read" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing approvals:read permission")

    request = await service.get_request(request_id)
    if not request:
        raise HTTPException(status_code=404, detail="Request not found")

    return _request_to_response(request)


@router.get("", response_model=ApprovalListResponse)
async def list_approval_requests(
    status: Optional[ApprovalStatus] = Query(None),
    agent_id: Optional[UUID] = Query(None),
    approval_type: Optional[ApprovalType] = Query(None),
    approver: Optional[str] = Query(None),
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    identity: AgentIdentity = Depends(get_current_identity),
    service: ApprovalService = Depends(get_approval_service),
):
    """List approval requests with optional filtering."""
    if "approvals:read" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing approvals:read permission")

    from ..models.approval import ApprovalStatus as DBStatus, ApprovalType as DBType

    requests, total = await service.list_requests(
        status=DBStatus(status.value) if status else None,
        agent_id=agent_id,
        approval_type=DBType(approval_type.value) if approval_type else None,
        approver=approver,
        offset=offset,
        limit=limit,
    )

    return ApprovalListResponse(
        requests=[_request_to_response(r) for r in requests],
        total=total,
        offset=offset,
        limit=limit,
    )


@router.post("/{request_id}/decide", response_model=ApprovalRequestResponse)
async def decide_on_request(
    request_id: UUID,
    decision: ApprovalDecision,
    identity: AgentIdentity = Depends(get_current_identity),
    service: ApprovalService = Depends(get_approval_service),
):
    """Make a decision on an approval request."""
    if "approvals:decide" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing approvals:decide permission")

    try:
        request = await service.decide(
            request_id=request_id,
            decision=decision,
            decided_by=identity.agent_id,
        )
        return _request_to_response(request)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{request_id}/escalate", response_model=ApprovalRequestResponse)
async def escalate_request(
    request_id: UUID,
    escalate: EscalateRequest,
    identity: AgentIdentity = Depends(get_current_identity),
    service: ApprovalService = Depends(get_approval_service),
):
    """Escalate an approval request."""
    if "approvals:escalate" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing approvals:escalate permission")

    try:
        request = await service.escalate(
            request_id=request_id,
            escalate_request=escalate,
            escalated_by=identity.agent_id,
        )
        return _request_to_response(request)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{request_id}/cancel", response_model=ApprovalRequestResponse)
async def cancel_request(
    request_id: UUID,
    reason: str = Query(..., description="Cancellation reason"),
    identity: AgentIdentity = Depends(get_current_identity),
    service: ApprovalService = Depends(get_approval_service),
):
    """Cancel an approval request."""
    if "approvals:cancel" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing approvals:cancel permission")

    try:
        request = await service.cancel(
            request_id=request_id,
            reason=reason,
            cancelled_by=identity.agent_id,
        )
        return _request_to_response(request)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/stats", response_model=ApprovalStats)
async def get_approval_stats(
    identity: AgentIdentity = Depends(get_current_identity),
    service: ApprovalService = Depends(get_approval_service),
):
    """Get approval statistics."""
    if "approvals:read" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing approvals:read permission")

    stats = await service.get_stats()
    return ApprovalStats(**stats, timestamp=datetime.now(timezone.utc))


@router.post("/expire")
async def trigger_expiration(
    identity: AgentIdentity = Depends(get_current_identity),
    service: ApprovalService = Depends(get_approval_service),
):
    """Manually trigger approval expiration check."""
    if "approvals:admin" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing approvals:admin permission")

    expired = await service.expire_requests()
    return {"expired_count": expired, "timestamp": datetime.now(timezone.utc).isoformat()}
