"""
Policy SQLAlchemy Models

Database models for policy management.
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
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB, ARRAY
from sqlalchemy.orm import relationship

from ...common.db.database import Base


class PolicyStatus(str, PyEnum):
    """Policy lifecycle status."""
    DRAFT = "draft"
    ACTIVE = "active"
    DEPRECATED = "deprecated"
    ARCHIVED = "archived"


class PolicyType(str, PyEnum):
    """Type of policy."""
    ALLOW = "allow"
    DENY = "deny"
    REQUIRE_APPROVAL = "require_approval"
    RATE_LIMIT = "rate_limit"
    SCOPE_LIMIT = "scope_limit"


class Policy(Base):
    """
    Policy definition.

    Policies define rules for agent behavior using Rego (OPA's policy language).
    """
    __tablename__ = "policies"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    name = Column(String(255), nullable=False, unique=True)
    description = Column(Text)

    # Policy type and status
    policy_type = Column(Enum(PolicyType), default=PolicyType.ALLOW)
    status = Column(Enum(PolicyStatus), default=PolicyStatus.DRAFT)

    # Policy content (Rego)
    rego_code = Column(Text, nullable=False)

    # Policy targeting
    applies_to_agents = Column(ARRAY(String), default=[])  # Agent IDs or wildcards
    applies_to_actions = Column(ARRAY(String), default=[])  # Action types or wildcards
    applies_to_resources = Column(ARRAY(String), default=[])  # Resource patterns

    # Priority (higher = evaluated first)
    priority = Column(Integer, default=100)

    # Version tracking
    version = Column(Integer, default=1)

    # Metadata
    labels = Column(JSONB, default={})
    annotations = Column(JSONB, default={})

    # Audit fields
    created_by = Column(String(255))
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_by = Column(String(255))
    updated_at = Column(DateTime(timezone=True), onupdate=lambda: datetime.now(timezone.utc))

    # Soft delete
    deleted_at = Column(DateTime(timezone=True), nullable=True)

    # Relationships
    versions = relationship("PolicyVersion", back_populates="policy", lazy="dynamic")

    __table_args__ = (
        Index("ix_policies_status", "status"),
        Index("ix_policies_priority", "priority"),
        Index("ix_policies_name", "name"),
    )

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "id": str(self.id),
            "name": self.name,
            "description": self.description,
            "policy_type": self.policy_type.value,
            "status": self.status.value,
            "rego_code": self.rego_code,
            "applies_to_agents": self.applies_to_agents,
            "applies_to_actions": self.applies_to_actions,
            "applies_to_resources": self.applies_to_resources,
            "priority": self.priority,
            "version": self.version,
            "labels": self.labels,
            "annotations": self.annotations,
            "created_by": self.created_by,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_by": self.updated_by,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class PolicyVersion(Base):
    """
    Policy version history.

    Tracks changes to policies for audit purposes.
    """
    __tablename__ = "policy_versions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    policy_id = Column(UUID(as_uuid=True), ForeignKey("policies.id"), nullable=False)
    version = Column(Integer, nullable=False)

    # Snapshot of policy at this version
    rego_code = Column(Text, nullable=False)
    applies_to_agents = Column(ARRAY(String), default=[])
    applies_to_actions = Column(ARRAY(String), default=[])
    applies_to_resources = Column(ARRAY(String), default=[])
    priority = Column(Integer)

    # Change metadata
    change_reason = Column(Text)
    changed_by = Column(String(255))
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    # Relationship
    policy = relationship("Policy", back_populates="versions")

    __table_args__ = (
        UniqueConstraint("policy_id", "version", name="uq_policy_version"),
        Index("ix_policy_versions_policy_id", "policy_id"),
    )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": str(self.id),
            "policy_id": str(self.policy_id),
            "version": self.version,
            "rego_code": self.rego_code,
            "change_reason": self.change_reason,
            "changed_by": self.changed_by,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class PolicyBundle(Base):
    """
    OPA Policy Bundle metadata.

    Tracks bundles pushed to OPA for distribution.
    """
    __tablename__ = "policy_bundles"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    bundle_id = Column(String(255), unique=True, nullable=False)

    # Bundle contents
    policies_included = Column(ARRAY(UUID(as_uuid=True)), default=[])
    revision = Column(String(64), nullable=False)  # Content hash

    # Storage
    storage_path = Column(String(1024))  # S3 path or local path
    size_bytes = Column(Integer)

    # Status
    is_active = Column(Boolean, default=False)
    activated_at = Column(DateTime(timezone=True))

    # Audit
    created_by = Column(String(255))
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        Index("ix_policy_bundles_active", "is_active"),
        Index("ix_policy_bundles_bundle_id", "bundle_id"),
    )
