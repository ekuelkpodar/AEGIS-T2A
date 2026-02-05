"""
Lease SQLAlchemy Models

Database models for autonomy lease management.
"""

from datetime import datetime, timezone
from enum import Enum as PyEnum
from typing import Dict, Any, List, Optional
from uuid import uuid4

from sqlalchemy import (
    Column,
    String,
    DateTime,
    Boolean,
    Text,
    Integer,
    ForeignKey,
    Enum,
    Index,
    CheckConstraint,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB, ARRAY, INTERVAL
from sqlalchemy.orm import relationship

from ...common.db.database import Base


class LeaseStatus(str, PyEnum):
    """Lease lifecycle status."""
    PENDING = "pending"       # Awaiting approval
    ACTIVE = "active"         # Currently valid
    EXPIRED = "expired"       # TTL exceeded
    REVOKED = "revoked"       # Manually revoked
    SUSPENDED = "suspended"   # Temporarily suspended


class LeaseType(str, PyEnum):
    """Type of autonomy lease."""
    ACTION = "action"             # Single action permission
    SESSION = "session"           # Time-bounded session
    CAPABILITY = "capability"     # Specific capability grant
    RESOURCE = "resource"         # Resource access lease


class AutonomyLevel(int, PyEnum):
    """
    Autonomy levels for agent operations.

    Higher levels require more oversight.
    """
    LEVEL_0 = 0  # Fully supervised - all actions require approval
    LEVEL_1 = 1  # Read-only autonomy - can read, must approve writes
    LEVEL_2 = 2  # Limited autonomy - can act within defined scope
    LEVEL_3 = 3  # Standard autonomy - can act, some actions need approval
    LEVEL_4 = 4  # Extended autonomy - high trust, minimal oversight
    LEVEL_5 = 5  # Full autonomy - unrestricted (rarely granted)


class Lease(Base):
    """
    Autonomy Lease.

    Grants an agent permission to operate autonomously within
    defined constraints for a limited time.
    """
    __tablename__ = "leases"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)

    # Agent and ownership
    agent_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    agent_name = Column(String(255))
    granted_by = Column(String(255), nullable=False)

    # Lease type and status
    lease_type = Column(Enum(LeaseType), default=LeaseType.SESSION)
    status = Column(Enum(LeaseStatus), default=LeaseStatus.PENDING)
    autonomy_level = Column(Integer, default=AutonomyLevel.LEVEL_2.value)

    # Time constraints
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    activated_at = Column(DateTime(timezone=True))
    expires_at = Column(DateTime(timezone=True), nullable=False)
    ttl_seconds = Column(Integer, nullable=False)  # Original TTL
    max_renewals = Column(Integer, default=5)      # Max times can be renewed
    renewal_count = Column(Integer, default=0)     # Times renewed

    # Scope constraints
    allowed_actions = Column(ARRAY(String), default=[])    # Action patterns
    allowed_resources = Column(ARRAY(String), default=[])  # Resource patterns
    denied_actions = Column(ARRAY(String), default=[])     # Explicit denials
    denied_resources = Column(ARRAY(String), default=[])   # Explicit denials

    # Rate limits
    max_actions_per_minute = Column(Integer)
    max_actions_total = Column(Integer)
    actions_taken = Column(Integer, default=0)

    # Context and constraints
    constraints = Column(JSONB, default={})  # Additional constraints
    context = Column(JSONB, default={})      # Operational context
    metadata = Column(JSONB, default={})     # Additional metadata

    # Approval chain (for PENDING leases)
    requires_approval = Column(Boolean, default=False)
    approved_by = Column(String(255))
    approved_at = Column(DateTime(timezone=True))
    approval_notes = Column(Text)

    # Revocation
    revoked_at = Column(DateTime(timezone=True))
    revoked_by = Column(String(255))
    revocation_reason = Column(Text)

    # Last activity tracking
    last_activity_at = Column(DateTime(timezone=True))
    last_action = Column(String(255))

    __table_args__ = (
        Index("ix_leases_agent_status", "agent_id", "status"),
        Index("ix_leases_expires_at", "expires_at"),
        Index("ix_leases_status", "status"),
        CheckConstraint("ttl_seconds > 0", name="ck_positive_ttl"),
        CheckConstraint("autonomy_level >= 0 AND autonomy_level <= 5", name="ck_valid_autonomy_level"),
    )

    @property
    def is_valid(self) -> bool:
        """Check if lease is currently valid."""
        if self.status != LeaseStatus.ACTIVE:
            return False
        if datetime.now(timezone.utc) > self.expires_at:
            return False
        if self.max_actions_total and self.actions_taken >= self.max_actions_total:
            return False
        return True

    @property
    def remaining_seconds(self) -> int:
        """Get remaining time in seconds."""
        if not self.is_valid:
            return 0
        delta = self.expires_at - datetime.now(timezone.utc)
        return max(0, int(delta.total_seconds()))

    @property
    def can_renew(self) -> bool:
        """Check if lease can be renewed."""
        return (
            self.status == LeaseStatus.ACTIVE and
            self.renewal_count < self.max_renewals
        )

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "id": str(self.id),
            "agent_id": str(self.agent_id),
            "agent_name": self.agent_name,
            "lease_type": self.lease_type.value,
            "status": self.status.value,
            "autonomy_level": self.autonomy_level,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "activated_at": self.activated_at.isoformat() if self.activated_at else None,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "ttl_seconds": self.ttl_seconds,
            "remaining_seconds": self.remaining_seconds,
            "is_valid": self.is_valid,
            "can_renew": self.can_renew,
            "renewal_count": self.renewal_count,
            "max_renewals": self.max_renewals,
            "allowed_actions": self.allowed_actions,
            "allowed_resources": self.allowed_resources,
            "denied_actions": self.denied_actions,
            "denied_resources": self.denied_resources,
            "max_actions_per_minute": self.max_actions_per_minute,
            "max_actions_total": self.max_actions_total,
            "actions_taken": self.actions_taken,
            "constraints": self.constraints,
            "granted_by": self.granted_by,
        }


class LeaseAudit(Base):
    """
    Lease audit trail.

    Tracks all operations on leases for compliance.
    """
    __tablename__ = "lease_audits"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    lease_id = Column(UUID(as_uuid=True), ForeignKey("leases.id"), nullable=False)

    # Audit info
    action = Column(String(50), nullable=False)  # created, activated, renewed, revoked, etc.
    actor = Column(String(255), nullable=False)
    timestamp = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    # State change
    old_status = Column(Enum(LeaseStatus))
    new_status = Column(Enum(LeaseStatus))

    # Details
    details = Column(JSONB, default={})
    reason = Column(Text)

    __table_args__ = (
        Index("ix_lease_audits_lease_id", "lease_id"),
        Index("ix_lease_audits_timestamp", "timestamp"),
    )
