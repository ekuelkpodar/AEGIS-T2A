"""
Pydantic Schemas for Approval System API

Request and response models for approval management.
"""

from datetime import datetime
from enum import Enum
from typing import Optional, List, Dict, Any
from uuid import UUID

from pydantic import BaseModel, Field, ConfigDict


class ApprovalStatus(str, Enum):
    """Approval request status."""
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"
    CANCELLED = "cancelled"
    AUTO_APPROVED = "auto_approved"


class ApprovalType(str, Enum):
    """Type of approval request."""
    ACTION = "action"
    BATCH = "batch"
    LEASE = "lease"
    POLICY_CHANGE = "policy_change"
    ESCALATION = "escalation"
    EMERGENCY = "emergency"


class EscalationLevel(int, Enum):
    """Escalation levels."""
    LEVEL_1 = 1
    LEVEL_2 = 2
    LEVEL_3 = 3
    LEVEL_4 = 4


class ApprovalRequestCreate(BaseModel):
    """Request to create an approval request."""
    title: str = Field(..., min_length=1, max_length=500, description="Request title")
    description: Optional[str] = Field(None, description="Detailed description")
    approval_type: ApprovalType = Field(default=ApprovalType.ACTION, description="Type of approval")

    agent_id: UUID = Field(..., description="Agent requesting approval")
    agent_name: Optional[str] = Field(None, description="Agent display name")

    # Action details
    action: Optional[str] = Field(None, description="Action to be performed")
    resource: Optional[str] = Field(None, description="Resource to be accessed")
    payload: Dict[str, Any] = Field(default_factory=dict, description="Action payload")
    context: Dict[str, Any] = Field(default_factory=dict, description="Request context")

    # Risk
    risk_level: Optional[str] = Field(None, description="Risk level (low, medium, high, critical)")
    risk_factors: List[str] = Field(default_factory=list, description="Risk factors")
    impact_scope: Optional[str] = Field(None, description="Impact scope description")

    # Timing
    ttl_seconds: int = Field(default=3600, ge=60, le=86400, description="Time-to-live")

    # Notifications
    notification_channels: List[str] = Field(default_factory=list, description="Notification channels")

    # Metadata
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional metadata")
    tags: List[str] = Field(default_factory=list, description="Tags for categorization")

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "title": "Delete production database records",
                "description": "Agent needs to delete 1000 records from users table",
                "approval_type": "action",
                "agent_id": "550e8400-e29b-41d4-a716-446655440000",
                "agent_name": "data-cleanup-agent",
                "action": "delete",
                "resource": "database:production/users",
                "payload": {"query": "DELETE FROM users WHERE inactive = true", "limit": 1000},
                "risk_level": "high",
                "risk_factors": ["production_data", "destructive_action"],
                "ttl_seconds": 7200,
                "notification_channels": ["slack", "email"],
            }
        }
    )


class ApprovalRequestResponse(BaseModel):
    """Approval request information response."""
    id: UUID
    title: str
    description: Optional[str] = None
    approval_type: ApprovalType
    status: ApprovalStatus

    # Requester
    agent_id: UUID
    agent_name: Optional[str] = None
    requested_by: str

    # Action
    action: Optional[str] = None
    resource: Optional[str] = None
    payload: Dict[str, Any]
    context: Dict[str, Any]

    # Risk
    risk_level: Optional[str] = None
    risk_factors: List[str]
    impact_scope: Optional[str] = None

    # Escalation
    escalation_level: int
    escalation_chain: List[str]
    current_approver: Optional[str] = None

    # Timing
    created_at: datetime
    expires_at: Optional[datetime] = None
    ttl_seconds: int
    is_expired: bool

    # Decision
    decided_at: Optional[datetime] = None
    decided_by: Optional[str] = None
    decision_notes: Optional[str] = None
    conditions: Dict[str, Any]

    # Notifications
    notification_channels: List[str]
    notification_sent: bool

    # Metadata
    metadata: Dict[str, Any]
    tags: List[str]

    model_config = ConfigDict(from_attributes=True)


class ApprovalListResponse(BaseModel):
    """Response for listing approval requests."""
    requests: List[ApprovalRequestResponse]
    total: int
    offset: int = 0
    limit: int = 100


class ApprovalDecision(BaseModel):
    """Decision on an approval request."""
    approved: bool = Field(..., description="Whether to approve or reject")
    notes: Optional[str] = Field(None, description="Decision notes")
    conditions: Dict[str, Any] = Field(default_factory=dict, description="Conditions for approval")
    modified_payload: Optional[Dict[str, Any]] = Field(None, description="Modified action payload")


class EscalateRequest(BaseModel):
    """Request to escalate an approval."""
    reason: str = Field(..., description="Reason for escalation")
    target_approver: Optional[str] = Field(None, description="Specific approver to escalate to")


class EscalationConfig(BaseModel):
    """Escalation rule configuration."""
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    is_active: bool = True

    # Matching
    approval_types: List[ApprovalType] = Field(default_factory=list)
    risk_levels: List[str] = Field(default_factory=list)
    action_patterns: List[str] = Field(default_factory=list)
    resource_patterns: List[str] = Field(default_factory=list)

    # Escalation
    escalation_chain: List[str] = Field(default_factory=list)
    timeout_seconds: int = Field(default=3600, ge=60)
    max_escalations: int = Field(default=3, ge=1)

    # Auto-actions
    auto_approve_after: Optional[int] = Field(None, ge=60)
    auto_reject_after: Optional[int] = Field(None, ge=60)

    # Notifications
    notification_template: Optional[str] = None
    notification_channels: List[str] = Field(default=["slack"])

    priority: int = Field(default=100, ge=0, le=1000)


class EscalationConfigResponse(BaseModel):
    """Escalation rule response."""
    id: UUID
    name: str
    description: Optional[str] = None
    is_active: bool

    approval_types: List[str]
    risk_levels: List[str]
    action_patterns: List[str]
    resource_patterns: List[str]

    escalation_chain: List[str]
    timeout_seconds: int
    max_escalations: int

    auto_approve_after: Optional[int] = None
    auto_reject_after: Optional[int] = None

    notification_template: Optional[str] = None
    notification_channels: List[str]

    priority: int
    created_at: datetime
    updated_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)


# =============================================================================
# Statistics
# =============================================================================

class ApprovalStats(BaseModel):
    """Approval statistics."""
    total_requests: int
    pending_requests: int
    approved_requests: int
    rejected_requests: int
    expired_requests: int
    auto_approved_requests: int
    average_decision_time_seconds: float
    requests_by_type: Dict[str, int]
    requests_by_risk: Dict[str, int]
    requests_by_agent: Dict[str, int]
    timestamp: datetime
