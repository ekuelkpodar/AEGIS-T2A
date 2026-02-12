"""
Pydantic schemas for the automation platform service.
"""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .automation import ConnectorAuthType, DefinitionStatus, IntegrationType, RiskLevel, TaskStatus


class TaskPriority(int, Enum):
    LOW = 25
    MEDIUM = 50
    HIGH = 75
    CRITICAL = 100


class ComplianceContext(BaseModel):
    frameworks: List[str] = Field(default_factory=list, description="Applicable frameworks (e.g., GDPR, HIPAA)")
    contains_personal_data: bool = False
    contains_phi: bool = False
    lawful_basis: Optional[str] = None
    retention_days: Optional[int] = Field(default=None, ge=1, le=3650)


class IntegrationConnectorCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    integration_type: IntegrationType
    base_url: Optional[str] = Field(default=None, max_length=2048)

    auth_type: ConnectorAuthType = ConnectorAuthType.NONE
    auth_config: Dict[str, Any] = Field(default_factory=dict)
    secret_ref: Optional[str] = Field(default=None, description="Environment/Vault secret reference")

    verify_tls: bool = True
    timeout_seconds: int = Field(default=30, ge=1, le=120)
    allowed_hosts: List[str] = Field(default_factory=list)
    extra_config: Dict[str, Any] = Field(default_factory=dict)


class IntegrationConnectorResponse(BaseModel):
    id: UUID
    name: str
    integration_type: IntegrationType
    base_url: Optional[str] = None

    auth_type: ConnectorAuthType
    auth_config: Dict[str, Any]
    secret_ref: Optional[str] = None

    verify_tls: bool
    timeout_seconds: int
    allowed_hosts: List[str]
    extra_config: Dict[str, Any]
    is_active: bool

    created_by: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AutomationDefinitionCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    industry_domain: str = Field(..., min_length=1, max_length=120)
    description: Optional[str] = None

    action_type: str = Field(..., min_length=1, max_length=120)
    trigger_mode: str = Field(default="manual", min_length=1, max_length=64)

    integration_id: Optional[UUID] = None
    action_config: Dict[str, Any] = Field(default_factory=dict)
    input_schema: Dict[str, Any] = Field(default_factory=dict)

    compliance_tags: List[str] = Field(default_factory=list)
    default_risk_level: RiskLevel = RiskLevel.MEDIUM

    requires_human_review: bool = False
    max_retries: int = Field(default=3, ge=0, le=10)
    extra_metadata: Dict[str, Any] = Field(default_factory=dict)


class AutomationDefinitionUpdate(BaseModel):
    description: Optional[str] = None
    trigger_mode: Optional[str] = Field(default=None, min_length=1, max_length=64)
    action_config: Optional[Dict[str, Any]] = None
    input_schema: Optional[Dict[str, Any]] = None
    compliance_tags: Optional[List[str]] = None
    default_risk_level: Optional[RiskLevel] = None
    requires_human_review: Optional[bool] = None
    max_retries: Optional[int] = Field(default=None, ge=0, le=10)
    status: Optional[DefinitionStatus] = None
    extra_metadata: Optional[Dict[str, Any]] = None


class AutomationDefinitionResponse(BaseModel):
    id: UUID
    name: str
    industry_domain: str
    description: Optional[str] = None

    action_type: str
    trigger_mode: str
    status: DefinitionStatus
    integration_id: Optional[UUID] = None

    action_config: Dict[str, Any]
    input_schema: Dict[str, Any]

    compliance_tags: List[str]
    default_risk_level: RiskLevel

    requires_human_review: bool
    max_retries: int

    created_by: str
    updated_by: str
    created_at: datetime
    updated_at: datetime
    version: int
    extra_metadata: Dict[str, Any]

    model_config = ConfigDict(from_attributes=True)


class NLPInterpretRequest(BaseModel):
    prompt: str = Field(..., min_length=3, max_length=2000)
    industry_hint: Optional[str] = Field(default=None, max_length=120)


class NLPInterpretResponse(BaseModel):
    action_type: str
    normalized_payload: Dict[str, Any]
    risk_level: RiskLevel
    confidence: float = Field(..., ge=0.0, le=1.0)
    requires_human_review: bool
    review_reasons: List[str] = Field(default_factory=list)
    compliance_frameworks: List[str] = Field(default_factory=list)


class AutomationTaskCreate(BaseModel):
    definition_id: UUID
    payload: Dict[str, Any] = Field(default_factory=dict)
    natural_language_prompt: Optional[str] = Field(default=None, max_length=2000)

    priority: TaskPriority = TaskPriority.MEDIUM
    risk_level: Optional[RiskLevel] = None

    scheduled_at: Optional[datetime] = None
    idempotency_key: Optional[str] = Field(default=None, max_length=255)
    correlation_id: Optional[str] = Field(default=None, max_length=128)

    compliance: ComplianceContext = Field(default_factory=ComplianceContext)

    @model_validator(mode="after")
    def validate_input(self):
        if not self.payload and not self.natural_language_prompt:
            raise ValueError("Either payload or natural_language_prompt must be provided")
        return self


class TaskReviewDecision(BaseModel):
    notes: Optional[str] = None


class TaskTriggerRequest(BaseModel):
    scheduled_at: Optional[datetime] = None


class QueueProcessRequest(BaseModel):
    batch_size: int = Field(default=20, ge=1, le=200)


class AutomationTaskResponse(BaseModel):
    id: UUID
    definition_id: UUID
    status: TaskStatus

    priority: int
    requested_by: str

    payload: Dict[str, Any]
    normalized_payload: Dict[str, Any]
    result_payload: Dict[str, Any]

    risk_level: RiskLevel
    ai_confidence: Optional[float] = None
    ai_summary: Dict[str, Any]

    requires_human_review: bool
    review_reason: Optional[str] = None
    approved_by: Optional[str] = None
    approved_at: Optional[datetime] = None
    rejected_by: Optional[str] = None
    rejected_at: Optional[datetime] = None

    compliance_context: Dict[str, Any]

    scheduled_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

    attempt_count: int
    max_attempts: int

    idempotency_key: Optional[str] = None
    correlation_id: Optional[str] = None

    error_message: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AutomationTaskListResponse(BaseModel):
    tasks: List[AutomationTaskResponse]
    total: int
    offset: int
    limit: int


class AuditRecordResponse(BaseModel):
    id: UUID
    entity_type: str
    entity_id: str
    action: str

    actor: str
    actor_roles: List[str]

    before_state: Dict[str, Any]
    after_state: Dict[str, Any]
    context: Dict[str, Any]

    compliance_tags: List[str]
    correlation_id: Optional[str] = None

    prev_hash: str
    event_hash: str

    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    created_at: datetime


class QueueMetricsResponse(BaseModel):
    queued: int
    waiting_review: int
    running: int
    failed: int
    succeeded: int


class ServiceStatsResponse(BaseModel):
    queue: QueueMetricsResponse
    definitions: int
    connectors: int
    timestamp: datetime
