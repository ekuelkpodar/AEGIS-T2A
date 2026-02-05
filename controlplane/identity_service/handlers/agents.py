"""
Agent Identity API Handlers

REST endpoints for agent registration, management, and identity operations.
"""

import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.agent import AgentStatus
from ..models.schemas import (
    AgentCreate,
    AgentResponse,
    AgentListResponse,
    KeyRotationRequest,
    KeyRotationResponse,
    AgentRevokeRequest,
    AgentRevokeResponse,
    ErrorResponse,
)
from ..services.agent_service import AgentService
from ...common.db.database import get_session
from ...common.auth.middleware import verify_agent_identity, AgentIdentity
from ...common.config.settings import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agents", tags=["agents"])


async def get_agent_service(
    session: AsyncSession = Depends(get_session),
) -> AgentService:
    """Dependency to get AgentService instance."""
    settings = get_settings()

    # Initialize PKI/SPIRE services based on config
    vault_pki = None
    spire_client = None

    if settings.vault.enabled:
        from ..services.vault_pki import VaultPKIService, VaultPKIServiceMock
        if settings.environment == "development":
            vault_pki = VaultPKIServiceMock(settings)
        else:
            vault_pki = VaultPKIService(settings)

    if settings.spire.enabled:
        from ..services.spire_client import SPIREClient, SPIREClientMock
        if settings.environment == "development":
            spire_client = SPIREClientMock(settings)
        else:
            spire_client = SPIREClient(settings)

    return AgentService(
        session=session,
        settings=settings,
        vault_pki=vault_pki,
        spire_client=spire_client,
    )


@router.post(
    "",
    response_model=AgentResponse,
    status_code=201,
    responses={
        201: {"description": "Agent registered successfully"},
        400: {"model": ErrorResponse, "description": "Invalid request"},
        409: {"model": ErrorResponse, "description": "Agent already exists"},
    },
    summary="Register a new agent",
    description="""
    Register a new agent in the control plane.

    This creates an agent identity record, generates a DID document,
    and optionally issues a certificate through Vault PKI or
    creates a SPIFFE workload entry.

    The response includes a JWT token for the agent to authenticate
    to other control plane services.
    """,
)
async def register_agent(
    request: Request,
    data: AgentCreate,
    service: AgentService = Depends(get_agent_service),
):
    """Register a new agent."""
    try:
        # Get registrar identity if authenticated
        registrar = "anonymous"
        if hasattr(request.state, "agent_identity") and request.state.agent_identity:
            registrar = request.state.agent_identity.agent_id

        agent, token = await service.register_agent(data, registered_by=registrar)
        return service.agent_to_response(agent, token=token)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"Failed to register agent: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get(
    "/{agent_id}",
    response_model=AgentResponse,
    responses={
        200: {"description": "Agent found"},
        404: {"model": ErrorResponse, "description": "Agent not found"},
    },
    summary="Get agent by ID",
    description="Retrieve agent information including DID document and status.",
)
async def get_agent(
    agent_id: UUID,
    service: AgentService = Depends(get_agent_service),
):
    """Get agent by ID."""
    agent = await service.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return service.agent_to_response(agent)


@router.get(
    "",
    response_model=AgentListResponse,
    summary="List agents",
    description="List agents with optional filtering by status and issuer.",
)
async def list_agents(
    status: Optional[str] = Query(None, description="Filter by status (active, pending, revoked)"),
    issuer: Optional[str] = Query(None, description="Filter by issuer (vault, spire, local)"),
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(50, ge=1, le=100, description="Items per page"),
    service: AgentService = Depends(get_agent_service),
):
    """List agents with pagination."""
    # Convert status string to enum
    status_enum = None
    if status:
        try:
            status_enum = AgentStatus(status.lower())
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid status. Must be one of: {[s.value for s in AgentStatus]}",
            )

    agents, total = await service.list_agents(
        status=status_enum,
        issuer=issuer,
        page=page,
        page_size=page_size,
    )

    return AgentListResponse(
        agents=[service.agent_to_response(a) for a in agents],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post(
    "/{agent_id}/rotate",
    response_model=KeyRotationResponse,
    responses={
        200: {"description": "Keys rotated successfully"},
        400: {"model": ErrorResponse, "description": "Invalid request"},
        404: {"model": ErrorResponse, "description": "Agent not found"},
    },
    summary="Rotate agent keys",
    description="""
    Request cryptographic key rotation for an agent.

    This updates the agent's public key, regenerates the DID document,
    and issues a new certificate if using Vault PKI. The old certificate
    is revoked immediately.
    """,
)
async def rotate_keys(
    agent_id: UUID,
    data: KeyRotationRequest,
    request: Request,
    service: AgentService = Depends(get_agent_service),
):
    """Rotate agent's cryptographic keys."""
    try:
        # Get requester identity
        rotated_by = "anonymous"
        if hasattr(request.state, "agent_identity") and request.state.agent_identity:
            rotated_by = request.state.agent_identity.agent_id

        agent = await service.rotate_keys(
            agent_id=agent_id,
            new_public_key=data.new_public_key,
            reason=data.reason,
            rotated_by=rotated_by,
        )

        return KeyRotationResponse(
            agent_id=agent.id,
            old_key_fingerprint=agent.metadata.get("key_rotations", [{}])[-1].get("old_fingerprint"),
            new_key_fingerprint=agent.key_fingerprint,
            rotated_at=agent.key_rotated_at,
            new_certificate=agent.certificate,
            new_certificate_expires_at=agent.certificate_expires_at,
        )

    except ValueError as e:
        raise HTTPException(status_code=404 if "not found" in str(e).lower() else 400, detail=str(e))
    except Exception as e:
        logger.exception(f"Failed to rotate keys: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post(
    "/{agent_id}/revoke",
    response_model=AgentRevokeResponse,
    responses={
        200: {"description": "Agent revoked successfully"},
        400: {"model": ErrorResponse, "description": "Invalid request"},
        404: {"model": ErrorResponse, "description": "Agent not found"},
    },
    summary="Revoke agent identity",
    description="""
    Revoke an agent's identity immediately.

    This is a destructive operation that:
    - Marks the agent as revoked
    - Revokes any issued certificates
    - Removes SPIFFE workload entries
    - Prevents the agent from authenticating

    **This action cannot be undone.**
    """,
)
async def revoke_agent(
    agent_id: UUID,
    data: AgentRevokeRequest,
    request: Request,
    service: AgentService = Depends(get_agent_service),
):
    """Revoke an agent's identity."""
    try:
        # Get revoker identity
        revoked_by = "anonymous"
        if hasattr(request.state, "agent_identity") and request.state.agent_identity:
            revoked_by = request.state.agent_identity.agent_id

        agent = await service.revoke_agent(
            agent_id=agent_id,
            reason=data.reason,
            revoked_by=revoked_by,
        )

        return AgentRevokeResponse(
            agent_id=agent.id,
            status=agent.status.value,
            revoked_at=agent.revoked_at,
            revoked_by=agent.revoked_by,
            reason=agent.revocation_reason,
        )

    except ValueError as e:
        raise HTTPException(status_code=404 if "not found" in str(e).lower() else 400, detail=str(e))
    except Exception as e:
        logger.exception(f"Failed to revoke agent: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get(
    "/{agent_id}/did",
    response_model=dict,
    summary="Get agent DID document",
    description="Retrieve the W3C DID document for an agent.",
)
async def get_agent_did(
    agent_id: UUID,
    service: AgentService = Depends(get_agent_service),
):
    """Get agent's DID document."""
    agent = await service.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    return agent.to_did_document()


@router.get(
    "/{agent_id}/verify",
    response_model=dict,
    summary="Verify agent identity",
    description="Verify that an agent's identity is valid and active.",
)
async def verify_agent(
    agent_id: UUID,
    service: AgentService = Depends(get_agent_service),
):
    """Verify agent identity."""
    is_valid = await service.verify_agent(agent_id)
    agent = await service.get_agent(agent_id)

    return {
        "agent_id": str(agent_id),
        "valid": is_valid,
        "status": agent.status.value if agent else "not_found",
        "verified_at": datetime.now(timezone.utc).isoformat(),
    }


@router.get(
    "/search",
    response_model=AgentListResponse,
    summary="Search agents",
    description="Search agents by name or metadata.",
)
async def search_agents(
    q: str = Query(..., min_length=1, description="Search query"),
    status: Optional[str] = Query(None, description="Filter by status"),
    limit: int = Query(20, ge=1, le=100, description="Maximum results"),
    service: AgentService = Depends(get_agent_service),
):
    """Search agents."""
    status_enum = None
    if status:
        try:
            status_enum = AgentStatus(status.lower())
        except ValueError:
            pass

    agents = await service.search_agents(query=q, status=status_enum, limit=limit)

    return AgentListResponse(
        agents=[service.agent_to_response(a) for a in agents],
        total=len(agents),
        page=1,
        page_size=limit,
    )
