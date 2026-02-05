"""
Approval SQLAlchemy Models

Database models for approval request management.
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
)
from sqlalchemy.dialects.postgresql import UUID, JSONB, ARRAY
from sqlalchemy.orm import relationship

from ...common.db.database import Base


class ApprovalStatus(str, PyEnum):
    """Approval request status."""
    PENDING = "pending"           # Awaiting decision
    APPROVED = "approved"         # Approved
    REJECTED = "rejected"         # Rejected
    EXPIRED = "expired"           # TTL exceeded
    CANCELLED = "cancelled"       # Cancelled by requester
    AUTO_APPROVED = "auto_approved"  # Automatically approved


class ApprovalType(str, PyEnum):
    """Type of approval request."""
    ACTION = "action"             # Single action approval
    BATCH = "batch"               # Batch of actions
    LEASE = "lease"               # Lease approval
    POLICY_CHANGE = "policy_change"  # Policy modification
    ESCALATION = "escalation"     # Escalated decision
    EMERGENCY = "emergency"       # Emergency override


class EscalationLevel(int, PyEnum):
    """Escalation levels."""
    LEVEL_1 = 1  # Team lead / first-line
    LEVEL_2 = 2  # Manager / senior
    LEVEL_3 = 3  # Director / executive
    LEVEL_4 = 4  # C-level / critical


class ApprovalRequest(Base):
    """
    Human approval request.

    Tracks requests for human approval of agent actions.
    """
    __tablename__ = "approval_requests"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)

    # Request info
    title = Column(String(500), nullable=False)
    description = Column(Text)
    approval_type = Column(Enum(ApprovalType), default=ApprovalType.ACTION)
    status = Column(Enum(ApprovalStatus), default=ApprovalStatus.PENDING)

    # Requester
    agent_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    agent_name = Column(String(255))
    requested_by = Column(String(255), nullable=False)

    # Action details
    action = Column(String(255))
    resource = Column(String(500))
    payload = Column(JSONB, default={})
    context = Column(JSONB, default={})

    # Risk assessment
    risk_level = Column(String(50))  # low, medium, high, critical
    risk_factors = Column(ARRAY(String), default=[])
    impact_scope = Column(String(255))

    # Escalation
    escalation_level = Column(Integer, default=EscalationLevel.LEVEL_1.value)
    escalation_chain = Column(ARRAY(String), default=[])  # Ordered list of approvers
    current_approver = Column(String(255))
    escalated_from = Column(UUID(as_uuid=True))  # Previous request if escalated

    # Timing
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    expires_at = Column(DateTime(timezone=True))
    ttl_seconds = Column(Integer, default=3600)

    # Decision
    decided_at = Column(DateTime(timezone=True))
    decided_by = Column(String(255))
    decision_notes = Column(Text)

    # Conditions for approval
    conditions = Column(JSONB, default={})  # Any conditions attached to approval
    modified_payload = Column(JSONB)  # If approver modified the requested action

    # Notifications
    notification_channels = Column(ARRAY(String), default=[])  # slack, email, webhook
    notification_sent = Column(Boolean, default=False)
    reminder_count = Column(Integer, default=0)

    # Metadata
    metadata = Column(JSONB, default={})
    tags = Column(ARRAY(String), default=[])

    __table_args__ = (
        Index("ix_approval_requests_status", "status"),
        Index("ix_approval_requests_agent_id", "agent_id"),
        Index("ix_approval_requests_created_at", "created_at"),
        Index("ix_approval_requests_current_approver", "current_approver"),
    )

    @property
    def is_pending(self) -> bool:
        """Check if request is still pending."""
        return self.status == ApprovalStatus.PENDING

    @property
    def is_expired(self) -> bool:
        """Check if request has expired."""
        if self.expires_at and datetime.now(timezone.utc) > self.expires_at:
            return True
        return False

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "id": str(self.id),
            "title": self.title,
            "description": self.description,
            "approval_type": self.approval_type.value,
            "status": self.status.value,
            "agent_id": str(self.agent_id),
            "agent_name": self.agent_name,
            "requested_by": self.requested_by,
            "action": self.action,
            "resource": self.resource,
            "payload": self.payload,
            "risk_level": self.risk_level,
            "escalation_level": self.escalation_level,
            "current_approver": self.current_approver,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "decided_at": self.decided_at.isoformat() if self.decided_at else None,
            "decided_by": self.decided_by,
            "decision_notes": self.decision_notes,
        }


class ApprovalAudit(Base):
    """
    Approval audit trail.

    Tracks all actions on approval requests.
    """
    __tablename__ = "approval_audits"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    request_id = Column(UUID(as_uuid=True), ForeignKey("approval_requests.id"), nullable=False)

    # Audit info
    action = Column(String(50), nullable=False)  # created, approved, rejected, escalated, etc.
    actor = Column(String(255), nullable=False)
    timestamp = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    # State change
    old_status = Column(Enum(ApprovalStatus))
    new_status = Column(Enum(ApprovalStatus))

    # Details
    details = Column(JSONB, default={})
    notes = Column(Text)

    __table_args__ = (
        Index("ix_approval_audits_request_id", "request_id"),
        Index("ix_approval_audits_timestamp", "timestamp"),
    )


class EscalationRule(Base):
    """
    Escalation rules configuration.

    Defines when and how to escalate approval requests.
    """
    __tablename__ = "escalation_rules"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    name = Column(String(255), unique=True, nullable=False)
    description = Column(Text)
    is_active = Column(Boolean, default=True)

    # Matching criteria
    approval_types = Column(ARRAY(String), default=[])  # Types this rule applies to
    risk_levels = Column(ARRAY(String), default=[])     # Risk levels to match
    action_patterns = Column(ARRAY(String), default=[]) # Action patterns
    resource_patterns = Column(ARRAY(String), default=[])

    # Escalation config
    escalation_chain = Column(ARRAY(String), default=[])  # Ordered list of approvers
    timeout_seconds = Column(Integer, default=3600)        # Time before auto-escalate
    max_escalations = Column(Integer, default=3)           # Max escalation attempts

    # Auto-actions
    auto_approve_after = Column(Integer)  # Auto-approve after N seconds (optional)
    auto_reject_after = Column(Integer)   # Auto-reject after N seconds (optional)

    # Notifications
    notification_template = Column(String(255))
    notification_channels = Column(ARRAY(String), default=["slack"])

    # Metadata
    priority = Column(Integer, default=100)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), onupdate=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        Index("ix_escalation_rules_active", "is_active"),
        Index("ix_escalation_rules_priority", "priority"),
    )
