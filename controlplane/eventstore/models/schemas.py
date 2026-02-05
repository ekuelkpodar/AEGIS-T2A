"""
Pydantic Schemas for Event Store API

Request and response models for event logging and querying.
"""

from datetime import datetime
from enum import Enum
from typing import Optional, List, Dict, Any
from uuid import UUID

from pydantic import BaseModel, Field, ConfigDict


class EventExportFormat(str, Enum):
    """Supported export formats."""
    JSONL = "jsonl"
    CSV = "csv"


class EventCreate(BaseModel):
    """Request to append a new event."""
    event_type: str = Field(..., description="Event type (e.g., agent.registered)")
    actor: str = Field(..., description="Entity that triggered the event")
    actor_type: str = Field(default="agent", description="Actor type")
    target_id: Optional[str] = Field(None, description="Target entity ID")
    target_type: Optional[str] = Field(None, description="Target entity type")
    payload: Dict[str, Any] = Field(default_factory=dict, description="Event payload")
    correlation_id: Optional[str] = Field(None, description="Request correlation ID")
    external_ref: Optional[str] = Field(None, description="External reference ID")
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Additional metadata")

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "event_type": "agent.registered",
                "actor": "admin-user",
                "actor_type": "user",
                "target_id": "agent-123",
                "target_type": "agent",
                "payload": {
                    "agent_name": "my-agent",
                    "issuer": "vault",
                    "permissions": ["read:*"],
                },
                "correlation_id": "req-abc-123",
            }
        }
    )


class EventResponse(BaseModel):
    """Event information response."""
    id: UUID
    sequence: Optional[int] = None
    created_at: datetime
    event_type: str
    actor: str
    actor_type: Optional[str] = "agent"
    target_id: Optional[str] = None
    target_type: Optional[str] = None
    payload: Dict[str, Any] = Field(default_factory=dict)
    prev_hash: str
    event_hash: str
    correlation_id: Optional[str] = None
    external_ref: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    signature: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


class EventListResponse(BaseModel):
    """Response for listing events."""
    events: List[EventResponse]
    total: int
    offset: int = 0
    limit: int = 100
    page: Optional[int] = None
    page_size: Optional[int] = None
    has_more: Optional[bool] = None


class EventSearchRequest(BaseModel):
    """Request to search events."""
    event_types: Optional[List[str]] = Field(None, description="Filter by event types")
    actors: Optional[List[str]] = Field(None, description="Filter by actors")
    target_ids: Optional[List[str]] = Field(None, description="Filter by target IDs")
    from_date: Optional[datetime] = Field(None, description="Start of date range")
    to_date: Optional[datetime] = Field(None, description="End of date range")
    correlation_id: Optional[str] = Field(None, description="Filter by correlation ID")
    external_ref: Optional[str] = Field(None, description="Filter by external reference")
    payload_query: Optional[Dict[str, Any]] = Field(None, description="JSONB query on payload")
    page: int = Field(default=1, ge=1, description="Page number")
    page_size: int = Field(default=50, ge=1, le=1000, description="Items per page")


class EventExportRequest(BaseModel):
    """Request to export events."""
    format: str = Field(default="jsonl", description="Export format (jsonl, csv)")
    from_date: Optional[datetime] = Field(None, description="Start of date range")
    to_date: Optional[datetime] = Field(None, description="End of date range")
    event_types: Optional[List[str]] = Field(None, description="Filter by event types")
    include_signatures: bool = Field(default=True, description="Include signatures")
    destination: Optional[str] = Field(None, description="S3 destination URL")


class EventExportResponse(BaseModel):
    """Response from event export."""
    export_id: str
    status: str
    event_count: int
    from_date: Optional[datetime]
    to_date: Optional[datetime]
    format: str
    file_url: Optional[str] = None
    file_size: Optional[int] = None
    started_at: datetime
    completed_at: Optional[datetime] = None


class ChainVerificationError(BaseModel):
    """Details of a chain verification error."""
    event_id: str
    error_type: str
    details: str


class ChainVerificationResult(BaseModel):
    """Result of hash chain verification."""
    valid: bool
    events_checked: int
    errors: List[ChainVerificationError] = Field(default_factory=list)
    first_event_id: Optional[str] = None
    last_event_id: Optional[str] = None
    first_invalid_event_id: Optional[str] = None
    first_invalid_reason: Optional[str] = None
    verification_time_ms: float
    timestamp: datetime


class AuditProof(BaseModel):
    """Cryptographic proof of chain integrity."""
    proof_type: str
    chain_length: int = 0
    first_event_id: Optional[str] = None
    first_event_hash: Optional[str] = None
    last_event_id: Optional[str] = None
    last_event_hash: Optional[str] = None
    merkle_root: Optional[str] = None
    genesis_hash: Optional[str] = None
    timestamp: str


class ReplayRequest(BaseModel):
    """Request to replay events."""
    from_event_id: Optional[str] = Field(None, description="Start replay from this event")
    from_sequence: Optional[int] = Field(None, description="Start replay from this sequence")
    to_event_id: Optional[str] = Field(None, description="End replay at this event")
    to_sequence: Optional[int] = Field(None, description="End replay at this sequence")
    event_types: Optional[List[str]] = Field(None, description="Filter event types")
    dry_run: bool = Field(default=True, description="Simulate replay without executing")


class ReplayResponse(BaseModel):
    """Response from event replay."""
    replay_id: str
    status: str
    events_replayed: int
    events_skipped: int
    dry_run: bool
    started_at: datetime
    completed_at: Optional[datetime] = None
    errors: Optional[List[Dict[str, Any]]] = None
