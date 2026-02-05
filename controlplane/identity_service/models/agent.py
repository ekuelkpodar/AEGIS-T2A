"""
Agent SQLAlchemy Model

Represents an agent's identity in the control plane database.
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
)
from sqlalchemy.dialects.postgresql import UUID, JSONB

from ...common.db.database import Base


class AgentStatus(str, enum.Enum):
    """Agent lifecycle status."""
    PENDING = "pending"
    ACTIVE = "active"
    SUSPENDED = "suspended"
    REVOKED = "revoked"


class Agent(Base):
    """
    Agent identity record.

    Stores agent registration, identity credentials, and lifecycle state.
    Supports both DID and SPIFFE identity schemes.
    """

    __tablename__ = "agents"

    # Primary identification
    id = Column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid4,
        comment="Unique agent identifier (UUIDv4)",
    )
    name = Column(
        String(255),
        nullable=False,
        index=True,
        comment="Human-readable agent name",
    )

    # DID (Decentralized Identifier) document
    did = Column(
        JSONB,
        nullable=True,
        comment="W3C DID Document containing identity and public keys",
    )

    # SPIFFE ID for workload identity
    spiffe_id = Column(
        Text,
        nullable=True,
        unique=True,
        index=True,
        comment="SPIFFE ID (e.g., spiffe://trust-domain/agent/agent-id)",
    )

    # Public key for asymmetric operations
    public_key = Column(
        Text,
        nullable=True,
        comment="PEM-encoded public key",
    )

    # Key fingerprint for quick lookups
    key_fingerprint = Column(
        String(64),
        nullable=True,
        index=True,
        comment="SHA-256 fingerprint of public key",
    )

    # Certificate information (when using Vault PKI)
    certificate = Column(
        Text,
        nullable=True,
        comment="PEM-encoded X.509 certificate",
    )
    certificate_serial = Column(
        String(64),
        nullable=True,
        index=True,
        comment="Certificate serial number for revocation tracking",
    )
    certificate_expires_at = Column(
        DateTime(timezone=True),
        nullable=True,
        comment="Certificate expiration timestamp",
    )

    # Issuer information
    issuer = Column(
        String(255),
        nullable=True,
        comment="Identity issuer (Vault, SPIRE, or 'local')",
    )

    # Lifecycle status
    status = Column(
        Enum(AgentStatus),
        default=AgentStatus.PENDING,
        nullable=False,
        index=True,
        comment="Current agent status",
    )

    # Metadata for extensibility
    metadata = Column(
        JSONB,
        default=dict,
        nullable=False,
        comment="Additional agent metadata (labels, annotations, etc.)",
    )

    # Permissions (cached from policy engine or assigned directly)
    permissions = Column(
        JSONB,
        default=list,
        nullable=False,
        comment="List of granted permissions",
    )

    # Timestamps
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
        comment="Agent registration timestamp",
    )
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
        comment="Last update timestamp",
    )
    activated_at = Column(
        DateTime(timezone=True),
        nullable=True,
        comment="Timestamp when agent became active",
    )
    revoked_at = Column(
        DateTime(timezone=True),
        nullable=True,
        comment="Timestamp when agent was revoked",
    )

    # Revocation information
    revocation_reason = Column(
        Text,
        nullable=True,
        comment="Reason for revocation",
    )
    revoked_by = Column(
        String(255),
        nullable=True,
        comment="User or system that revoked the agent",
    )

    # Key rotation tracking
    key_rotated_at = Column(
        DateTime(timezone=True),
        nullable=True,
        comment="Last key rotation timestamp",
    )
    key_rotation_count = Column(
        default=0,
        nullable=False,
        comment="Number of key rotations performed",
    )

    # Indexes
    __table_args__ = (
        Index("ix_agents_status_created", "status", "created_at"),
        Index("ix_agents_issuer_status", "issuer", "status"),
        Index("ix_agents_metadata_gin", "metadata", postgresql_using="gin"),
    )

    def __repr__(self) -> str:
        return f"<Agent(id={self.id}, name='{self.name}', status={self.status.value})>"

    def is_active(self) -> bool:
        """Check if agent is currently active."""
        return self.status == AgentStatus.ACTIVE

    def is_revoked(self) -> bool:
        """Check if agent has been revoked."""
        return self.status == AgentStatus.REVOKED

    def has_valid_certificate(self) -> bool:
        """Check if agent has a valid (non-expired) certificate."""
        if not self.certificate_expires_at:
            return False
        return self.certificate_expires_at > datetime.now(timezone.utc)

    def get_did_id(self) -> Optional[str]:
        """Extract DID identifier from DID document."""
        if self.did and isinstance(self.did, dict):
            return self.did.get("id")
        return None

    def to_did_document(self) -> Dict[str, Any]:
        """
        Generate a W3C DID Document for this agent.

        Format follows https://www.w3.org/TR/did-core/
        """
        did_id = f"did:aegis:{self.id}"

        document = {
            "@context": [
                "https://www.w3.org/ns/did/v1",
                "https://w3id.org/security/suites/ed25519-2020/v1",
            ],
            "id": did_id,
            "controller": did_id,
            "created": self.created_at.isoformat() if self.created_at else None,
            "updated": self.updated_at.isoformat() if self.updated_at else None,
        }

        # Add verification methods if public key exists
        if self.public_key:
            document["verificationMethod"] = [
                {
                    "id": f"{did_id}#key-1",
                    "type": "JsonWebKey2020",
                    "controller": did_id,
                    "publicKeyPem": self.public_key,
                }
            ]
            document["authentication"] = [f"{did_id}#key-1"]
            document["assertionMethod"] = [f"{did_id}#key-1"]

        # Add service endpoints
        document["service"] = [
            {
                "id": f"{did_id}#agent-endpoint",
                "type": "AgentService",
                "serviceEndpoint": self.metadata.get("endpoint", ""),
            }
        ]

        return document

    def activate(self) -> None:
        """Activate the agent."""
        self.status = AgentStatus.ACTIVE
        self.activated_at = datetime.now(timezone.utc)

    def suspend(self, reason: str = None) -> None:
        """Suspend the agent temporarily."""
        self.status = AgentStatus.SUSPENDED
        if reason:
            self.metadata["suspension_reason"] = reason

    def revoke(self, reason: str, revoked_by: str) -> None:
        """Revoke the agent permanently."""
        self.status = AgentStatus.REVOKED
        self.revoked_at = datetime.now(timezone.utc)
        self.revocation_reason = reason
        self.revoked_by = revoked_by
