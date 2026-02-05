"""
Event SQLAlchemy Model

Represents an immutable audit event in the compliance event store.
Events are hash-chained for tamper-evident logging.
"""

import enum
from datetime import datetime, timezone
from typing import Optional, Dict, Any
from uuid import uuid4

from sqlalchemy import (
    Column,
    String,
    Text,
    DateTime,
    Enum,
    Index,
    Boolean,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB

from ...common.db.database import Base


class EventType(str, enum.Enum):
    """Event type categories for audit classification."""

    # Identity events
    AGENT_REGISTERED = "agent.registered"
    AGENT_ACTIVATED = "agent.activated"
    AGENT_SUSPENDED = "agent.suspended"
    AGENT_REVOKED = "agent.revoked"
    AGENT_KEY_ROTATED = "agent.key_rotated"

    # Authentication events
    AUTH_SUCCESS = "auth.success"
    AUTH_FAILURE = "auth.failure"
    AUTH_TOKEN_ISSUED = "auth.token_issued"
    AUTH_TOKEN_REVOKED = "auth.token_revoked"

    # Policy events
    POLICY_EVALUATED = "policy.evaluated"
    POLICY_UPLOADED = "policy.uploaded"
    POLICY_ACTIVATED = "policy.activated"
    POLICY_DEACTIVATED = "policy.deactivated"

    # Autonomy events
    LEASE_ISSUED = "lease.issued"
    LEASE_RENEWED = "lease.renewed"
    LEASE_REVOKED = "lease.revoked"
    LEASE_EXPIRED = "lease.expired"

    # Approval events
    APPROVAL_REQUESTED = "approval.requested"
    APPROVAL_GRANTED = "approval.granted"
    APPROVAL_DENIED = "approval.denied"
    APPROVAL_EXPIRED = "approval.expired"

    # Action events
    ACTION_REQUESTED = "action.requested"
    ACTION_ALLOWED = "action.allowed"
    ACTION_DENIED = "action.denied"
    ACTION_EXECUTED = "action.executed"
    ACTION_FAILED = "action.failed"
    ACTION_COMPENSATED = "action.compensated"

    # System events
    SYSTEM_STARTUP = "system.startup"
    SYSTEM_SHUTDOWN = "system.shutdown"
    SYSTEM_ERROR = "system.error"
    SYSTEM_CONFIG_CHANGED = "system.config_changed"

    # Data events
    DATA_ACCESSED = "data.accessed"
    DATA_MODIFIED = "data.modified"
    DATA_EXPORTED = "data.exported"


class Event(Base):
    """
    Immutable audit event record.

    Events are append-only and hash-chained. Once written,
    events cannot be modified or deleted (enforced at application level).

    The hash chain provides cryptographic proof of event ordering
    and tamper detection.
    """

    __tablename__ = "events"

    # Primary identification
    id = Column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid4,
        comment="Unique event identifier (UUIDv4)",
    )

    # Sequence number for ordering
    sequence = Column(
        "seq",
        type_=None,  # SERIAL type handled by PostgreSQL
        nullable=False,
        comment="Monotonic sequence number for ordering",
    )

    # Timestamp with high precision
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
        index=True,
        comment="Event timestamp (UTC)",
    )

    # Event classification
    event_type = Column(
        String(64),
        nullable=False,
        index=True,
        comment="Event type (e.g., agent.registered, policy.evaluated)",
    )

    # Actor information (who triggered the event)
    actor = Column(
        String(255),
        nullable=False,
        index=True,
        comment="Entity that triggered the event (agent ID, user ID, or 'system')",
    )
    actor_type = Column(
        String(32),
        default="agent",
        nullable=False,
        comment="Actor type (agent, user, system, service)",
    )

    # Target information (what was acted upon)
    target_id = Column(
        String(255),
        nullable=True,
        index=True,
        comment="ID of the target entity",
    )
    target_type = Column(
        String(64),
        nullable=True,
        comment="Type of target entity",
    )

    # Event payload (structured data)
    payload = Column(
        JSONB,
        nullable=False,
        default=dict,
        comment="Event payload with structured details",
    )

    # Hash chain fields
    prev_hash = Column(
        String(64),
        nullable=False,
        comment="SHA-256 hash of previous event (or genesis hash)",
    )
    event_hash = Column(
        String(64),
        nullable=False,
        unique=True,
        index=True,
        comment="SHA-256 hash of this event (computed from payload + prev_hash)",
    )

    # Correlation for request tracing
    correlation_id = Column(
        String(64),
        nullable=True,
        index=True,
        comment="Request correlation ID for distributed tracing",
    )

    # Optional external reference
    external_ref = Column(
        String(255),
        nullable=True,
        comment="External reference (e.g., workflow ID, intent ID)",
    )

    # Storage location for large payloads
    payload_location = Column(
        Text,
        nullable=True,
        comment="S3 URL if payload stored externally",
    )

    # Metadata
    metadata = Column(
        JSONB,
        default=dict,
        nullable=False,
        comment="Additional metadata (tags, labels)",
    )

    # Signature for non-repudiation (optional)
    signature = Column(
        Text,
        nullable=True,
        comment="Digital signature of the event",
    )
    signer = Column(
        String(255),
        nullable=True,
        comment="Identity of the signer",
    )

    # Indexes for efficient querying
    __table_args__ = (
        Index("ix_events_type_created", "event_type", "created_at"),
        Index("ix_events_actor_created", "actor", "created_at"),
        Index("ix_events_target_created", "target_id", "created_at"),
        Index("ix_events_correlation", "correlation_id"),
        Index("ix_events_payload_gin", "payload", postgresql_using="gin"),
    )

    def __repr__(self) -> str:
        return f"<Event(id={self.id}, type={self.event_type}, actor={self.actor})>"

    def to_dict(self) -> Dict[str, Any]:
        """Convert event to dictionary for hashing and export."""
        return {
            "id": str(self.id),
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "event_type": self.event_type,
            "actor": self.actor,
            "actor_type": self.actor_type,
            "target_id": self.target_id,
            "target_type": self.target_type,
            "payload": self.payload,
            "prev_hash": self.prev_hash,
            "event_hash": self.event_hash,
            "correlation_id": self.correlation_id,
            "external_ref": self.external_ref,
            "metadata": self.metadata,
        }

    def to_hashable_dict(self) -> Dict[str, Any]:
        """
        Convert to dictionary for hash computation.

        Only includes fields that are part of the hash chain.
        """
        return {
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "event_type": self.event_type,
            "actor": self.actor,
            "target_id": self.target_id,
            "payload": self.payload,
            "prev_hash": self.prev_hash,
        }
