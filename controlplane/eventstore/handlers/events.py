"""
Event Store API Handlers

HTTP endpoints for the compliance event store.
"""

import logging
from datetime import datetime, timezone
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import StreamingResponse

from ..models.schemas import (
    EventCreate,
    EventResponse,
    EventListResponse,
    ChainVerificationResult,
    AuditProof,
    EventExportFormat,
)
from ..services.event_service import EventService, get_event_service
from ..services.chain_verifier import ChainVerifier
from ...common.auth.middleware import get_current_identity, AgentIdentity

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/events", tags=["events"])


@router.post("", response_model=EventResponse, status_code=201)
async def create_event(
    event: EventCreate,
    identity: AgentIdentity = Depends(get_current_identity),
    service: EventService = Depends(get_event_service),
):
    """
    Append a new event to the immutable event store.

    The event will be hash-chained to the previous event for
    tamper-evident logging.
    """
    if "events:write" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing events:write permission")

    try:
        created = await service.append_event(
            event_type=event.event_type,
            actor=event.actor or identity.agent_id,
            target_id=event.target_id,
            payload=event.payload or {},
            metadata=event.metadata,
        )

        return EventResponse(
            id=created.id,
            created_at=created.created_at,
            event_type=created.event_type,
            actor=created.actor,
            target_id=created.target_id,
            payload=created.payload,
            prev_hash=created.prev_hash,
            event_hash=created.event_hash,
            metadata=created.metadata,
        )

    except Exception as e:
        logger.exception(f"Failed to create event: {e}")
        raise HTTPException(status_code=500, detail="Failed to create event")


@router.get("/{event_id}", response_model=EventResponse)
async def get_event(
    event_id: UUID,
    identity: AgentIdentity = Depends(get_current_identity),
    service: EventService = Depends(get_event_service),
):
    """Retrieve a specific event by ID."""
    if "events:read" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing events:read permission")

    event = await service.get_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    return EventResponse(
        id=event.id,
        created_at=event.created_at,
        event_type=event.event_type,
        actor=event.actor,
        target_id=event.target_id,
        payload=event.payload,
        prev_hash=event.prev_hash,
        event_hash=event.event_hash,
        metadata=event.metadata,
    )


@router.get("", response_model=EventListResponse)
async def list_events(
    event_type: Optional[str] = Query(None, description="Filter by event type"),
    actor: Optional[str] = Query(None, description="Filter by actor"),
    target_id: Optional[str] = Query(None, description="Filter by target ID"),
    start_time: Optional[datetime] = Query(None, description="Filter from timestamp"),
    end_time: Optional[datetime] = Query(None, description="Filter to timestamp"),
    offset: int = Query(0, ge=0, description="Pagination offset"),
    limit: int = Query(100, ge=1, le=1000, description="Maximum results"),
    identity: AgentIdentity = Depends(get_current_identity),
    service: EventService = Depends(get_event_service),
):
    """
    List events with optional filtering.

    Events are returned in chronological order (oldest first).
    """
    if "events:read" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing events:read permission")

    events, total = await service.list_events(
        event_type=event_type,
        actor=actor,
        target_id=target_id,
        start_time=start_time,
        end_time=end_time,
        offset=offset,
        limit=limit,
    )

    return EventListResponse(
        events=[
            EventResponse(
                id=e.id,
                created_at=e.created_at,
                event_type=e.event_type,
                actor=e.actor,
                target_id=e.target_id,
                payload=e.payload,
                prev_hash=e.prev_hash,
                event_hash=e.event_hash,
                metadata=e.metadata,
            )
            for e in events
        ],
        total=total,
        offset=offset,
        limit=limit,
    )


@router.get("/chain/verify", response_model=ChainVerificationResult)
async def verify_chain(
    from_event_id: Optional[UUID] = Query(None, description="Start verification from this event"),
    limit: int = Query(1000, ge=1, le=10000, description="Maximum events to verify"),
    identity: AgentIdentity = Depends(get_current_identity),
    service: EventService = Depends(get_event_service),
):
    """
    Verify the integrity of the event chain.

    Checks hash continuity and event hash integrity.
    Returns detailed verification results.
    """
    if "events:audit" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing events:audit permission")

    result = await service.verify_chain(
        from_event_id=from_event_id,
        limit=limit,
    )

    return ChainVerificationResult(
        valid=result["valid"],
        events_checked=result["events_checked"],
        errors=result.get("errors", []),
        first_event_id=result.get("first_event_id"),
        last_event_id=result.get("last_event_id"),
        verification_time_ms=result.get("verification_time_ms", 0),
        timestamp=datetime.now(timezone.utc),
    )


@router.get("/chain/proof", response_model=AuditProof)
async def generate_proof(
    from_event_id: Optional[UUID] = Query(None, description="Start from this event"),
    to_event_id: Optional[UUID] = Query(None, description="End at this event"),
    identity: AgentIdentity = Depends(get_current_identity),
    service: EventService = Depends(get_event_service),
):
    """
    Generate a cryptographic proof of the chain.

    This proof can be provided to auditors to verify the
    chain was valid at a specific point in time.
    """
    if "events:audit" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing events:audit permission")

    proof = await service.generate_proof(
        from_event_id=from_event_id,
        to_event_id=to_event_id,
    )

    return AuditProof(
        proof_type=proof["proof_type"],
        chain_length=proof.get("chain_length", 0),
        first_event_id=proof.get("first_event_id"),
        first_event_hash=proof.get("first_event_hash"),
        last_event_id=proof.get("last_event_id"),
        last_event_hash=proof.get("last_event_hash"),
        merkle_root=proof.get("merkle_root"),
        genesis_hash=proof.get("genesis_hash"),
        timestamp=proof["timestamp"],
    )


@router.get("/export")
async def export_events(
    format: EventExportFormat = Query(EventExportFormat.JSONL, description="Export format"),
    event_type: Optional[str] = Query(None, description="Filter by event type"),
    actor: Optional[str] = Query(None, description="Filter by actor"),
    start_time: Optional[datetime] = Query(None, description="Filter from timestamp"),
    end_time: Optional[datetime] = Query(None, description="Filter to timestamp"),
    identity: AgentIdentity = Depends(get_current_identity),
    service: EventService = Depends(get_event_service),
):
    """
    Export events for external verification or archival.

    Supports JSONL format for line-by-line processing.
    """
    if "events:export" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing events:export permission")

    async def generate_jsonl():
        """Stream events as JSONL."""
        import json

        async for event in service.stream_events(
            event_type=event_type,
            actor=actor,
            start_time=start_time,
            end_time=end_time,
        ):
            line = json.dumps({
                "id": str(event.id),
                "created_at": event.created_at.isoformat(),
                "event_type": event.event_type,
                "actor": event.actor,
                "target_id": event.target_id,
                "payload": event.payload,
                "prev_hash": event.prev_hash,
                "event_hash": event.event_hash,
                "metadata": event.metadata,
            }, default=str)
            yield line + "\n"

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    filename = f"events_export_{timestamp}.jsonl"

    return StreamingResponse(
        generate_jsonl(),
        media_type="application/x-ndjson",
        headers={
            "Content-Disposition": f"attachment; filename={filename}",
        },
    )


@router.get("/by-target/{target_id}", response_model=EventListResponse)
async def get_events_by_target(
    target_id: str,
    event_type: Optional[str] = Query(None, description="Filter by event type"),
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    identity: AgentIdentity = Depends(get_current_identity),
    service: EventService = Depends(get_event_service),
):
    """
    Get all events for a specific target (agent, policy, etc.).

    Useful for retrieving the complete audit trail of an entity.
    """
    if "events:read" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing events:read permission")

    events, total = await service.list_events(
        target_id=target_id,
        event_type=event_type,
        offset=offset,
        limit=limit,
    )

    return EventListResponse(
        events=[
            EventResponse(
                id=e.id,
                created_at=e.created_at,
                event_type=e.event_type,
                actor=e.actor,
                target_id=e.target_id,
                payload=e.payload,
                prev_hash=e.prev_hash,
                event_hash=e.event_hash,
                metadata=e.metadata,
            )
            for e in events
        ],
        total=total,
        offset=offset,
        limit=limit,
    )


@router.get("/by-actor/{actor}", response_model=EventListResponse)
async def get_events_by_actor(
    actor: str,
    event_type: Optional[str] = Query(None, description="Filter by event type"),
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    identity: AgentIdentity = Depends(get_current_identity),
    service: EventService = Depends(get_event_service),
):
    """
    Get all events created by a specific actor.

    Useful for auditing agent activity.
    """
    if "events:read" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing events:read permission")

    events, total = await service.list_events(
        actor=actor,
        event_type=event_type,
        offset=offset,
        limit=limit,
    )

    return EventListResponse(
        events=[
            EventResponse(
                id=e.id,
                created_at=e.created_at,
                event_type=e.event_type,
                actor=e.actor,
                target_id=e.target_id,
                payload=e.payload,
                prev_hash=e.prev_hash,
                event_hash=e.event_hash,
                metadata=e.metadata,
            )
            for e in events
        ],
        total=total,
        offset=offset,
        limit=limit,
    )


@router.get("/stats")
async def get_event_stats(
    start_time: Optional[datetime] = Query(None),
    end_time: Optional[datetime] = Query(None),
    identity: AgentIdentity = Depends(get_current_identity),
    service: EventService = Depends(get_event_service),
):
    """
    Get event store statistics.

    Returns counts by event type, actor, and time periods.
    """
    if "events:read" not in identity.permissions:
        raise HTTPException(status_code=403, detail="Missing events:read permission")

    stats = await service.get_stats(start_time=start_time, end_time=end_time)
    return stats
