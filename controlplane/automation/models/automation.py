"""
Automation Service SQLAlchemy Models

Defines action framework entities, queue records, integrations, and audit logs.
"""

from datetime import datetime, timezone
from enum import Enum as PyEnum
from uuid import uuid4

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID

from ...common.db.database import Base


class RiskLevel(str, PyEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class TaskStatus(str, PyEnum):
    QUEUED = "queued"
    WAITING_REVIEW = "waiting_review"
    APPROVED = "approved"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    REJECTED = "rejected"
    CANCELLED = "cancelled"


class DefinitionStatus(str, PyEnum):
    ACTIVE = "active"
    DISABLED = "disabled"


class IntegrationType(str, PyEnum):
    HTTP = "http"
    DATABASE = "database"
    CRM = "crm"
    ERP = "erp"
    WEBHOOK = "webhook"
    CUSTOM = "custom"


class ConnectorAuthType(str, PyEnum):
    NONE = "none"
    API_KEY = "api_key"
    BEARER = "bearer"
    OAUTH2_CLIENT_CREDENTIALS = "oauth2_client_credentials"
    MTLS = "mtls"


class AutomationDefinition(Base):
    """Reusable automation workflow/action definition."""

    __tablename__ = "automation_definitions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)

    name = Column(String(255), nullable=False, unique=True, index=True)
    industry_domain = Column(String(120), nullable=False, index=True)
    description = Column(Text)

    action_type = Column(String(120), nullable=False, index=True)
    trigger_mode = Column(String(64), nullable=False, default="manual")
    status = Column(Enum(DefinitionStatus), nullable=False, default=DefinitionStatus.ACTIVE)

    integration_id = Column(UUID(as_uuid=True), ForeignKey("integration_connectors.id"), nullable=True)

    action_config = Column(JSONB, nullable=False, default=dict)
    input_schema = Column(JSONB, nullable=False, default=dict)
    compliance_tags = Column(ARRAY(String), nullable=False, default=list)
    default_risk_level = Column(Enum(RiskLevel), nullable=False, default=RiskLevel.MEDIUM)

    requires_human_review = Column(Boolean, nullable=False, default=False)
    max_retries = Column(Integer, nullable=False, default=3)

    created_by = Column(String(255), nullable=False)
    updated_by = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    version = Column(Integer, nullable=False, default=1)
    extra_metadata = Column("metadata", JSONB, nullable=False, default=dict)

    __table_args__ = (
        Index("ix_automation_definitions_domain_status", "industry_domain", "status"),
    )


class IntegrationConnector(Base):
    """External system connector configuration."""

    __tablename__ = "integration_connectors"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)

    name = Column(String(255), nullable=False, unique=True, index=True)
    integration_type = Column(Enum(IntegrationType), nullable=False, index=True)

    base_url = Column(String(2048), nullable=True)
    auth_type = Column(Enum(ConnectorAuthType), nullable=False, default=ConnectorAuthType.NONE)
    auth_config = Column(JSONB, nullable=False, default=dict)
    secret_ref = Column(String(255), nullable=True)

    verify_tls = Column(Boolean, nullable=False, default=True)
    timeout_seconds = Column(Integer, nullable=False, default=30)
    allowed_hosts = Column(ARRAY(String), nullable=False, default=list)

    extra_config = Column(JSONB, nullable=False, default=dict)
    is_active = Column(Boolean, nullable=False, default=True)

    created_by = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


class AutomationTask(Base):
    """Queued automation task instance."""

    __tablename__ = "automation_tasks"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)

    definition_id = Column(UUID(as_uuid=True), ForeignKey("automation_definitions.id"), nullable=False, index=True)
    status = Column(Enum(TaskStatus), nullable=False, default=TaskStatus.QUEUED, index=True)

    priority = Column(Integer, nullable=False, default=50)
    requested_by = Column(String(255), nullable=False, index=True)

    payload = Column(JSONB, nullable=False, default=dict)
    normalized_payload = Column(JSONB, nullable=False, default=dict)
    result_payload = Column(JSONB, nullable=False, default=dict)

    risk_level = Column(Enum(RiskLevel), nullable=False, default=RiskLevel.MEDIUM)
    ai_confidence = Column(Float, nullable=True)
    ai_summary = Column(JSONB, nullable=False, default=dict)

    requires_human_review = Column(Boolean, nullable=False, default=False)
    review_reason = Column(Text, nullable=True)
    approved_by = Column(String(255), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    rejected_by = Column(String(255), nullable=True)
    rejected_at = Column(DateTime(timezone=True), nullable=True)

    compliance_context = Column(JSONB, nullable=False, default=dict)

    scheduled_at = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc), index=True)
    started_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)

    attempt_count = Column(Integer, nullable=False, default=0)
    max_attempts = Column(Integer, nullable=False, default=3)

    idempotency_key = Column(String(255), nullable=True, unique=True)
    correlation_id = Column(String(128), nullable=True, index=True)

    error_message = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    __table_args__ = (
        Index("ix_automation_tasks_status_schedule", "status", "scheduled_at"),
        Index("ix_automation_tasks_definition_status", "definition_id", "status"),
    )

    @property
    def is_terminal(self) -> bool:
        return self.status in {
            TaskStatus.SUCCEEDED,
            TaskStatus.FAILED,
            TaskStatus.REJECTED,
            TaskStatus.CANCELLED,
        }


class AutomationAuditLog(Base):
    """Append-only audit trail for every automation action."""

    __tablename__ = "automation_audit_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)

    entity_type = Column(String(64), nullable=False, index=True)
    entity_id = Column(String(64), nullable=False, index=True)
    action = Column(String(96), nullable=False, index=True)

    actor = Column(String(255), nullable=False, index=True)
    actor_roles = Column(ARRAY(String), nullable=False, default=list)

    before_state = Column(JSONB, nullable=False, default=dict)
    after_state = Column(JSONB, nullable=False, default=dict)
    context = Column(JSONB, nullable=False, default=dict)

    compliance_tags = Column(ARRAY(String), nullable=False, default=list)
    correlation_id = Column(String(128), nullable=True, index=True)

    prev_hash = Column(String(64), nullable=False)
    event_hash = Column(String(64), nullable=False, unique=True, index=True)

    ip_address = Column(String(64), nullable=True)
    user_agent = Column(String(512), nullable=True)

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False, index=True)

    __table_args__ = (
        Index("ix_automation_audit_entity_time", "entity_type", "entity_id", "created_at"),
    )
