"""
Policy Engine API Handlers

HTTP endpoints for policy management and evaluation.
"""

import logging
from datetime import datetime, timezone
from typing import Optional, List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

from ..models.schemas import (
    PolicyCreate,
    PolicyUpdate,
    PolicyResponse,
    PolicyListResponse,
    PolicyVersionResponse,
    PolicyEvaluationRequest,
    PolicyEvaluationResult,
    PolicyStatus,
    PolicyType,
)
from ..services.policy_service import PolicyService, get_policy_service
from ...common.auth.middleware import get_current_identity, AgentIdentity

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/policies", tags=["policies"])


# =============================================================================
# Policy CRUD
# =============================================================================

@router.post("", response_model=PolicyResponse, status_code=201)
async def create_policy(
    policy: PolicyCreate,
    identity: AgentIdentity = Depends(get_current_identity),
    service: PolicyService = Depends(get_policy_service),
):
    """
    Create a new policy.

    The policy starts in DRAFT status. Use the activate endpoint
    to make it effective.
    """
    if "policies:write" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing policies:write permission")

    try:
        created = await service.create_policy(
            data=policy,
            created_by=identity.agent_id,
        )

        return PolicyResponse(
            id=created.id,
            name=created.name,
            description=created.description,
            policy_type=PolicyType(created.policy_type.value),
            status=PolicyStatus(created.status.value),
            rego_code=created.rego_code,
            applies_to_agents=created.applies_to_agents or [],
            applies_to_actions=created.applies_to_actions or [],
            applies_to_resources=created.applies_to_resources or [],
            priority=created.priority,
            version=created.version,
            labels=created.labels or {},
            annotations=created.annotations or {},
            created_by=created.created_by,
            created_at=created.created_at,
            updated_by=created.updated_by,
            updated_at=created.updated_at,
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"Failed to create policy: {e}")
        raise HTTPException(status_code=500, detail="Failed to create policy")


@router.get("/{policy_id}", response_model=PolicyResponse)
async def get_policy(
    policy_id: UUID,
    identity: AgentIdentity = Depends(get_current_identity),
    service: PolicyService = Depends(get_policy_service),
):
    """Get a policy by ID."""
    if "policies:read" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing policies:read permission")

    policy = await service.get_policy(policy_id)
    if not policy:
        raise HTTPException(status_code=404, detail="Policy not found")

    return PolicyResponse(
        id=policy.id,
        name=policy.name,
        description=policy.description,
        policy_type=PolicyType(policy.policy_type.value),
        status=PolicyStatus(policy.status.value),
        rego_code=policy.rego_code,
        applies_to_agents=policy.applies_to_agents or [],
        applies_to_actions=policy.applies_to_actions or [],
        applies_to_resources=policy.applies_to_resources or [],
        priority=policy.priority,
        version=policy.version,
        labels=policy.labels or {},
        annotations=policy.annotations or {},
        created_by=policy.created_by,
        created_at=policy.created_at,
        updated_by=policy.updated_by,
        updated_at=policy.updated_at,
    )


@router.get("", response_model=PolicyListResponse)
async def list_policies(
    status: Optional[PolicyStatus] = Query(None, description="Filter by status"),
    policy_type: Optional[PolicyType] = Query(None, description="Filter by type"),
    label_key: Optional[str] = Query(None, description="Filter by label key"),
    label_value: Optional[str] = Query(None, description="Filter by label value"),
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    identity: AgentIdentity = Depends(get_current_identity),
    service: PolicyService = Depends(get_policy_service),
):
    """List policies with optional filtering."""
    if "policies:read" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing policies:read permission")

    labels = None
    if label_key and label_value:
        labels = {label_key: label_value}

    from ..models.policy import PolicyStatus as DBStatus, PolicyType as DBType

    policies, total = await service.list_policies(
        status=DBStatus(status.value) if status else None,
        policy_type=DBType(policy_type.value) if policy_type else None,
        labels=labels,
        offset=offset,
        limit=limit,
    )

    return PolicyListResponse(
        policies=[
            PolicyResponse(
                id=p.id,
                name=p.name,
                description=p.description,
                policy_type=PolicyType(p.policy_type.value),
                status=PolicyStatus(p.status.value),
                rego_code=p.rego_code,
                applies_to_agents=p.applies_to_agents or [],
                applies_to_actions=p.applies_to_actions or [],
                applies_to_resources=p.applies_to_resources or [],
                priority=p.priority,
                version=p.version,
                labels=p.labels or {},
                annotations=p.annotations or {},
                created_by=p.created_by,
                created_at=p.created_at,
                updated_by=p.updated_by,
                updated_at=p.updated_at,
            )
            for p in policies
        ],
        total=total,
        offset=offset,
        limit=limit,
    )


@router.put("/{policy_id}", response_model=PolicyResponse)
async def update_policy(
    policy_id: UUID,
    update: PolicyUpdate,
    identity: AgentIdentity = Depends(get_current_identity),
    service: PolicyService = Depends(get_policy_service),
):
    """
    Update a policy.

    Creates a new version. If the policy is active, changes are
    automatically pushed to OPA.
    """
    if "policies:write" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing policies:write permission")

    try:
        policy = await service.update_policy(
            policy_id=policy_id,
            data=update,
            updated_by=identity.agent_id,
        )

        return PolicyResponse(
            id=policy.id,
            name=policy.name,
            description=policy.description,
            policy_type=PolicyType(policy.policy_type.value),
            status=PolicyStatus(policy.status.value),
            rego_code=policy.rego_code,
            applies_to_agents=policy.applies_to_agents or [],
            applies_to_actions=policy.applies_to_actions or [],
            applies_to_resources=policy.applies_to_resources or [],
            priority=policy.priority,
            version=policy.version,
            labels=policy.labels or {},
            annotations=policy.annotations or {},
            created_by=policy.created_by,
            created_at=policy.created_at,
            updated_by=policy.updated_by,
            updated_at=policy.updated_at,
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{policy_id}")
async def delete_policy(
    policy_id: UUID,
    identity: AgentIdentity = Depends(get_current_identity),
    service: PolicyService = Depends(get_policy_service),
):
    """Delete a policy (soft delete)."""
    if "policies:delete" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing policies:delete permission")

    deleted = await service.delete_policy(policy_id, identity.agent_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Policy not found")

    return {"status": "deleted", "policy_id": str(policy_id)}


# =============================================================================
# Policy Lifecycle
# =============================================================================

@router.post("/{policy_id}/activate", response_model=PolicyResponse)
async def activate_policy(
    policy_id: UUID,
    identity: AgentIdentity = Depends(get_current_identity),
    service: PolicyService = Depends(get_policy_service),
):
    """
    Activate a policy.

    Pushes the policy to OPA and makes it effective.
    """
    if "policies:activate" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing policies:activate permission")

    try:
        policy = await service.activate_policy(policy_id, identity.agent_id)

        return PolicyResponse(
            id=policy.id,
            name=policy.name,
            description=policy.description,
            policy_type=PolicyType(policy.policy_type.value),
            status=PolicyStatus(policy.status.value),
            rego_code=policy.rego_code,
            applies_to_agents=policy.applies_to_agents or [],
            applies_to_actions=policy.applies_to_actions or [],
            applies_to_resources=policy.applies_to_resources or [],
            priority=policy.priority,
            version=policy.version,
            labels=policy.labels or {},
            annotations=policy.annotations or {},
            created_by=policy.created_by,
            created_at=policy.created_at,
            updated_by=policy.updated_by,
            updated_at=policy.updated_at,
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{policy_id}/deactivate", response_model=PolicyResponse)
async def deactivate_policy(
    policy_id: UUID,
    identity: AgentIdentity = Depends(get_current_identity),
    service: PolicyService = Depends(get_policy_service),
):
    """
    Deactivate a policy.

    Removes the policy from OPA.
    """
    if "policies:activate" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing policies:activate permission")

    try:
        policy = await service.deactivate_policy(policy_id, identity.agent_id)

        return PolicyResponse(
            id=policy.id,
            name=policy.name,
            description=policy.description,
            policy_type=PolicyType(policy.policy_type.value),
            status=PolicyStatus(policy.status.value),
            rego_code=policy.rego_code,
            applies_to_agents=policy.applies_to_agents or [],
            applies_to_actions=policy.applies_to_actions or [],
            applies_to_resources=policy.applies_to_resources or [],
            priority=policy.priority,
            version=policy.version,
            labels=policy.labels or {},
            annotations=policy.annotations or {},
            created_by=policy.created_by,
            created_at=policy.created_at,
            updated_by=policy.updated_by,
            updated_at=policy.updated_at,
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# =============================================================================
# Policy Versions
# =============================================================================

@router.get("/{policy_id}/versions", response_model=List[PolicyVersionResponse])
async def get_policy_versions(
    policy_id: UUID,
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    identity: AgentIdentity = Depends(get_current_identity),
    service: PolicyService = Depends(get_policy_service),
):
    """Get version history for a policy."""
    if "policies:read" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing policies:read permission")

    versions = await service.get_policy_versions(policy_id, offset, limit)

    return [
        PolicyVersionResponse(
            id=v.id,
            policy_id=v.policy_id,
            version=v.version,
            rego_code=v.rego_code,
            change_reason=v.change_reason,
            changed_by=v.changed_by,
            created_at=v.created_at,
        )
        for v in versions
    ]


# =============================================================================
# Policy Evaluation
# =============================================================================

@router.post("/evaluate", response_model=PolicyEvaluationResult)
async def evaluate_policies(
    request: PolicyEvaluationRequest,
    identity: AgentIdentity = Depends(get_current_identity),
    service: PolicyService = Depends(get_policy_service),
):
    """
    Evaluate policies for an action.

    Returns the aggregated decision based on all applicable policies.
    """
    if "policies:evaluate" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing policies:evaluate permission")

    try:
        result = await service.evaluate(request)
        return result

    except Exception as e:
        logger.exception(f"Policy evaluation failed: {e}")
        raise HTTPException(status_code=500, detail="Policy evaluation failed")


# =============================================================================
# Admin Operations
# =============================================================================

@router.post("/sync")
async def sync_policies_to_opa(
    identity: AgentIdentity = Depends(get_current_identity),
    service: PolicyService = Depends(get_policy_service),
):
    """
    Sync all active policies to OPA.

    Admin operation to ensure OPA has the latest policies.
    """
    if "policies:admin" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing policies:admin permission")

    count = await service.sync_all_policies()
    return {"synced": count, "timestamp": datetime.now(timezone.utc).isoformat()}
