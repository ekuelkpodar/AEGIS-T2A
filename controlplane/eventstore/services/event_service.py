"""
Event Service

Core business logic for the immutable event store.
Handles event appending with hash chaining and querying.
"""

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Optional, List, Tuple, Dict, Any
from uuid import UUID, uuid4

from sqlalchemy import select, func, and_, or_, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.event import Event, EventType
from ..models.schemas import EventCreate, EventResponse, EventSearchRequest
from ...common.config.settings import Settings, get_settings

logger = logging.getLogger(__name__)


class EventService:
    """
    Service for managing the immutable event store.

    Provides:
    - Append-only event logging with hash chaining
    - Event querying and search
    - Chain verification
    - Export capabilities
    """

    def __init__(
        self,
        session: AsyncSession,
        settings: Optional[Settings] = None,
        s3_storage=None,
    ):
        self.session = session
        self.settings = settings or get_settings()
        self.s3_storage = s3_storage
        self._genesis_hash = self.settings.eventstore.genesis_hash

    async def append_event(
        self,
        event_type: str,
        actor: str,
        payload: Dict[str, Any],
        actor_type: str = "agent",
        target_id: Optional[str] = None,
        target_type: Optional[str] = None,
        correlation_id: Optional[str] = None,
        external_ref: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Event:
        """
        Append a new event to the event store.

        Events are append-only and hash-chained. The hash of each event
        includes the hash of the previous event, creating a tamper-evident chain.

        Args:
            event_type: Type of event (from EventType enum or custom)
            actor: Entity that triggered the event
            payload: Event payload data
            actor_type: Type of actor (agent, user, system)
            target_id: Optional target entity ID
            target_type: Optional target entity type
            correlation_id: Optional request correlation ID
            external_ref: Optional external reference
            metadata: Optional additional metadata

        Returns:
            The created Event
        """
        logger.debug(f"Appending event: {event_type} by {actor}")

        # Get the previous event's hash
        prev_hash = await self._get_last_hash()

        # Create event
        event = Event(
            id=uuid4(),
            created_at=datetime.now(timezone.utc),
            event_type=event_type,
            actor=actor,
            actor_type=actor_type,
            target_id=target_id,
            target_type=target_type,
            payload=payload,
            prev_hash=prev_hash,
            correlation_id=correlation_id,
            external_ref=external_ref,
            metadata=metadata or {},
        )

        # Compute event hash
        event.event_hash = self._compute_event_hash(event)

        # Handle large payloads by storing in S3
        if self.s3_storage and len(json.dumps(payload)) > 10000:
            s3_key = f"events/{event.created_at.strftime('%Y/%m/%d')}/{event.id}.json"
            await self.s3_storage.put_object(
                key=s3_key,
                data=json.dumps(payload),
            )
            event.payload_location = s3_key
            # Store reference in payload instead
            event.payload = {"_ref": s3_key, "_size": len(json.dumps(payload))}

        # Persist
        self.session.add(event)
        await self.session.flush()

        logger.info(f"Event appended: {event.id} ({event_type})")
        return event

    async def get_event(self, event_id: UUID) -> Optional[Event]:
        """Get event by ID."""
        result = await self.session.execute(
            select(Event).where(Event.id == event_id)
        )
        return result.scalar_one_or_none()

    async def get_event_by_hash(self, event_hash: str) -> Optional[Event]:
        """Get event by its hash."""
        result = await self.session.execute(
            select(Event).where(Event.event_hash == event_hash)
        )
        return result.scalar_one_or_none()

    async def query_events(
        self,
        event_types: Optional[List[str]] = None,
        actor: Optional[str] = None,
        target_id: Optional[str] = None,
        from_date: Optional[datetime] = None,
        to_date: Optional[datetime] = None,
        correlation_id: Optional[str] = None,
        external_ref: Optional[str] = None,
        page: int = 1,
        page_size: int = 50,
    ) -> Tuple[List[Event], int]:
        """
        Query events with filtering.

        Returns:
            Tuple of (events, total_count)
        """
        query = select(Event)
        count_query = select(func.count(Event.id))

        # Apply filters
        conditions = []

        if event_types:
            conditions.append(Event.event_type.in_(event_types))
        if actor:
            conditions.append(Event.actor == actor)
        if target_id:
            conditions.append(Event.target_id == target_id)
        if from_date:
            conditions.append(Event.created_at >= from_date)
        if to_date:
            conditions.append(Event.created_at <= to_date)
        if correlation_id:
            conditions.append(Event.correlation_id == correlation_id)
        if external_ref:
            conditions.append(Event.external_ref == external_ref)

        if conditions:
            query = query.where(and_(*conditions))
            count_query = count_query.where(and_(*conditions))

        # Get total
        total_result = await self.session.execute(count_query)
        total = total_result.scalar() or 0

        # Paginate and order
        offset = (page - 1) * page_size
        query = query.order_by(Event.created_at.desc()).offset(offset).limit(page_size)

        result = await self.session.execute(query)
        events = list(result.scalars().all())

        return events, total

    async def search_events(self, request: EventSearchRequest) -> Tuple[List[Event], int]:
        """
        Advanced event search with JSONB payload queries.
        """
        query = select(Event)
        count_query = select(func.count(Event.id))

        conditions = []

        if request.event_types:
            conditions.append(Event.event_type.in_(request.event_types))
        if request.actors:
            conditions.append(Event.actor.in_(request.actors))
        if request.target_ids:
            conditions.append(Event.target_id.in_(request.target_ids))
        if request.from_date:
            conditions.append(Event.created_at >= request.from_date)
        if request.to_date:
            conditions.append(Event.created_at <= request.to_date)
        if request.correlation_id:
            conditions.append(Event.correlation_id == request.correlation_id)
        if request.external_ref:
            conditions.append(Event.external_ref == request.external_ref)

        # JSONB query on payload
        if request.payload_query:
            for key, value in request.payload_query.items():
                conditions.append(Event.payload[key].astext == str(value))

        if conditions:
            query = query.where(and_(*conditions))
            count_query = count_query.where(and_(*conditions))

        total_result = await self.session.execute(count_query)
        total = total_result.scalar() or 0

        offset = (request.page - 1) * request.page_size
        query = query.order_by(Event.created_at.desc()).offset(offset).limit(request.page_size)

        result = await self.session.execute(query)
        events = list(result.scalars().all())

        return events, total

    async def get_events_by_correlation(self, correlation_id: str) -> List[Event]:
        """Get all events with a correlation ID."""
        result = await self.session.execute(
            select(Event)
            .where(Event.correlation_id == correlation_id)
            .order_by(Event.created_at.asc())
        )
        return list(result.scalars().all())

    async def verify_chain(
        self,
        from_event_id: Optional[UUID] = None,
        limit: int = 10000,
    ) -> Dict[str, Any]:
        """
        Verify the hash chain integrity.

        Returns verification result including any breaks in the chain.
        """
        import time
        start_time = time.time()

        # Build query
        query = select(Event).order_by(Event.created_at.asc())
        if from_event_id:
            from_event = await self.get_event(from_event_id)
            if from_event:
                query = query.where(Event.created_at >= from_event.created_at)

        query = query.limit(limit)
        result = await self.session.execute(query)
        events = list(result.scalars().all())

        if not events:
            return {
                "valid": True,
                "events_checked": 0,
                "verification_time_ms": (time.time() - start_time) * 1000,
                "timestamp": datetime.now(timezone.utc),
            }

        # Verify chain
        expected_prev_hash = events[0].prev_hash
        first_invalid = None
        first_invalid_reason = None

        for i, event in enumerate(events):
            # Verify prev_hash matches
            if event.prev_hash != expected_prev_hash:
                first_invalid = event
                first_invalid_reason = f"prev_hash mismatch: expected {expected_prev_hash}, got {event.prev_hash}"
                break

            # Verify event hash
            computed_hash = self._compute_event_hash(event)
            if event.event_hash != computed_hash:
                first_invalid = event
                first_invalid_reason = f"event_hash mismatch: expected {computed_hash}, got {event.event_hash}"
                break

            expected_prev_hash = event.event_hash

        elapsed_ms = (time.time() - start_time) * 1000

        return {
            "valid": first_invalid is None,
            "events_checked": len(events),
            "first_event_id": str(events[0].id) if events else None,
            "last_event_id": str(events[-1].id) if events else None,
            "first_invalid_event_id": str(first_invalid.id) if first_invalid else None,
            "first_invalid_reason": first_invalid_reason,
            "verification_time_ms": elapsed_ms,
            "timestamp": datetime.now(timezone.utc),
        }

    async def export_events(
        self,
        from_date: Optional[datetime] = None,
        to_date: Optional[datetime] = None,
        event_types: Optional[List[str]] = None,
        format: str = "jsonl",
    ) -> str:
        """
        Export events to JSONL or CSV format.

        Returns the exported data as a string.
        """
        events, _ = await self.query_events(
            event_types=event_types,
            from_date=from_date,
            to_date=to_date,
            page=1,
            page_size=100000,  # Large limit for export
        )

        if format == "jsonl":
            lines = []
            for event in events:
                lines.append(json.dumps(event.to_dict(), default=str))
            return "\n".join(lines)

        elif format == "csv":
            import csv
            import io

            output = io.StringIO()
            if events:
                fieldnames = ["id", "created_at", "event_type", "actor", "target_id", "prev_hash", "event_hash"]
                writer = csv.DictWriter(output, fieldnames=fieldnames)
                writer.writeheader()
                for event in events:
                    writer.writerow({
                        "id": str(event.id),
                        "created_at": event.created_at.isoformat(),
                        "event_type": event.event_type,
                        "actor": event.actor,
                        "target_id": event.target_id or "",
                        "prev_hash": event.prev_hash,
                        "event_hash": event.event_hash,
                    })
            return output.getvalue()

        else:
            raise ValueError(f"Unsupported format: {format}")

    async def _get_last_hash(self) -> str:
        """Get the hash of the last event, or genesis hash if none."""
        result = await self.session.execute(
            select(Event.event_hash)
            .order_by(Event.created_at.desc())
            .limit(1)
        )
        last_hash = result.scalar_one_or_none()
        return last_hash or self._genesis_hash

    def _compute_event_hash(self, event: Event) -> str:
        """
        Compute the SHA-256 hash of an event.

        The hash includes:
        - Previous event hash
        - Timestamp
        - Event type
        - Actor
        - Target
        - Payload
        """
        hashable = event.to_hashable_dict()
        raw = json.dumps(hashable, sort_keys=True, default=str).encode("utf-8")
        return hashlib.sha256(raw).hexdigest()

    def event_to_response(self, event: Event) -> EventResponse:
        """Convert Event model to API response."""
        return EventResponse(
            id=event.id,
            sequence=getattr(event, "seq", None),
            created_at=event.created_at,
            event_type=event.event_type,
            actor=event.actor,
            actor_type=event.actor_type,
            target_id=event.target_id,
            target_type=event.target_type,
            payload=event.payload,
            prev_hash=event.prev_hash,
            event_hash=event.event_hash,
            correlation_id=event.correlation_id,
            external_ref=event.external_ref,
            metadata=event.metadata or {},
            signature=event.signature,
        )

    async def list_events(
        self,
        event_type: Optional[str] = None,
        actor: Optional[str] = None,
        target_id: Optional[str] = None,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        offset: int = 0,
        limit: int = 100,
    ) -> Tuple[List[Event], int]:
        """
        List events with optional filtering.

        Returns:
            Tuple of (events, total_count)
        """
        query = select(Event)
        count_query = select(func.count(Event.id))

        conditions = []
        if event_type:
            conditions.append(Event.event_type == event_type)
        if actor:
            conditions.append(Event.actor == actor)
        if target_id:
            conditions.append(Event.target_id == target_id)
        if start_time:
            conditions.append(Event.created_at >= start_time)
        if end_time:
            conditions.append(Event.created_at <= end_time)

        if conditions:
            query = query.where(and_(*conditions))
            count_query = count_query.where(and_(*conditions))

        total_result = await self.session.execute(count_query)
        total = total_result.scalar() or 0

        query = query.order_by(Event.created_at.asc()).offset(offset).limit(limit)
        result = await self.session.execute(query)
        events = list(result.scalars().all())

        return events, total

    async def stream_events(
        self,
        event_type: Optional[str] = None,
        actor: Optional[str] = None,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        batch_size: int = 100,
    ):
        """
        Stream events for export, yielding in batches.

        Async generator for memory-efficient processing of large exports.
        """
        offset = 0
        while True:
            events, total = await self.list_events(
                event_type=event_type,
                actor=actor,
                start_time=start_time,
                end_time=end_time,
                offset=offset,
                limit=batch_size,
            )

            for event in events:
                yield event

            offset += batch_size
            if offset >= total or len(events) < batch_size:
                break

    async def get_stats(
        self,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """
        Get event store statistics.

        Returns counts by event type, actor, and other metrics.
        """
        # Total events
        total_query = select(func.count(Event.id))
        conditions = []
        if start_time:
            conditions.append(Event.created_at >= start_time)
        if end_time:
            conditions.append(Event.created_at <= end_time)
        if conditions:
            total_query = total_query.where(and_(*conditions))

        total_result = await self.session.execute(total_query)
        total_events = total_result.scalar() or 0

        # Events by type
        type_query = (
            select(Event.event_type, func.count(Event.id))
            .group_by(Event.event_type)
        )
        if conditions:
            type_query = type_query.where(and_(*conditions))

        type_result = await self.session.execute(type_query)
        events_by_type = {row[0]: row[1] for row in type_result.fetchall()}

        # Events by actor (top 10)
        actor_query = (
            select(Event.actor, func.count(Event.id))
            .group_by(Event.actor)
            .order_by(func.count(Event.id).desc())
            .limit(10)
        )
        if conditions:
            actor_query = actor_query.where(and_(*conditions))

        actor_result = await self.session.execute(actor_query)
        events_by_actor = {row[0]: row[1] for row in actor_result.fetchall()}

        # Check chain validity (quick check of last 100 events)
        verify_result = await self.verify_chain(limit=100)

        # Get time range
        time_query = select(func.min(Event.created_at), func.max(Event.created_at))
        time_result = await self.session.execute(time_query)
        time_row = time_result.fetchone()

        return {
            "total_events": total_events,
            "events_by_type": events_by_type,
            "events_by_actor": events_by_actor,
            "chain_valid": verify_result["valid"],
            "first_event_at": time_row[0].isoformat() if time_row and time_row[0] else None,
            "last_event_at": time_row[1].isoformat() if time_row and time_row[1] else None,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

    async def generate_proof(
        self,
        from_event_id: Optional[UUID] = None,
        to_event_id: Optional[UUID] = None,
    ) -> Dict[str, Any]:
        """
        Generate a cryptographic proof of the event chain.

        This proof can be provided to auditors to verify the
        chain was valid at a specific point in time.
        """
        from .chain_verifier import ChainVerifier

        query = select(Event).order_by(Event.created_at.asc())

        if from_event_id:
            from_event = await self.get_event(from_event_id)
            if from_event:
                query = query.where(Event.created_at >= from_event.created_at)

        if to_event_id:
            to_event = await self.get_event(to_event_id)
            if to_event:
                query = query.where(Event.created_at <= to_event.created_at)

        result = await self.session.execute(query)
        events = list(result.scalars().all())

        # Convert to dicts for the verifier
        event_dicts = [
            {
                "id": str(e.id),
                "created_at": e.created_at.isoformat(),
                "event_type": e.event_type,
                "actor": e.actor,
                "target_id": e.target_id,
                "payload": e.payload,
                "prev_hash": e.prev_hash,
                "event_hash": e.event_hash,
            }
            for e in events
        ]

        verifier = ChainVerifier(self._genesis_hash)
        return verifier.generate_proof(event_dicts)


# Singleton service (for dependency injection)
_event_service: Optional[EventService] = None


def get_event_service() -> EventService:
    """Get the event service singleton."""
    global _event_service
    if _event_service is None:
        from ...common.db.database import get_db
        db = get_db()
        _event_service = EventService(db.get_session())
    return _event_service


# Convenience function for logging events from other services
async def log_event(
    session: AsyncSession,
    event_type: str,
    actor: str,
    payload: Dict[str, Any],
    **kwargs,
) -> Event:
    """
    Convenience function to log an event.

    Usage:
        from controlplane.eventstore.services.event_service import log_event

        event = await log_event(
            session,
            event_type="agent.registered",
            actor="admin",
            payload={"agent_id": "123", "name": "my-agent"},
        )
    """
    service = EventService(session)
    return await service.append_event(event_type, actor, payload, **kwargs)
