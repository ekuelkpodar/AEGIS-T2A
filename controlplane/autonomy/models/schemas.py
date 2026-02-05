"""
Pydantic Schemas for Autonomy Manager API

Request and response models for lease management.
"""

from datetime import datetime
from enum import Enum
from typing import Optional, List, Dict, Any
from uuid import UUID

from pydantic import BaseModel, Field, ConfigDict


class LeaseStatus(str, Enum):
    """Lease lifecycle status."""
    PENDING = "pending"
    ACTIVE = "active"
    EXPIRED = "expired"
    REVOKED = "revoked"
    SUSPENDED = "suspended"


class LeaseType(str, Enum):
    """Type of autonomy lease."""
    ACTION = "action"
    SESSION = "session"
    CAPABILITY = "capability"
    RESOURCE = "resource"


class AutonomyLevel(int, Enum):
    """Autonomy levels for agent operations."""
    LEVEL_0 = 0  # Fully supervised
    LEVEL_1 = 1  # Read-only autonomy
    LEVEL_2 = 2  # Limited autonomy
    LEVEL_3 = 3  # Standard autonomy
    LEVEL_4 = 4  # Extended autonomy
    LEVEL_5 = 5  # Full autonomy


class LeaseCreate(BaseModel):
    """Request to create a new lease."""
    agent_id: UUID = Field(..., description="Agent UUID")
    agent_name: Optional[str] = Field(None, description="Agent display name")
    lease_type: LeaseType = Field(default=LeaseType.SESSION, description="Type of lease")
    autonomy_level: AutonomyLevel = Field(default=AutonomyLevel.LEVEL_2, description="Autonomy level")

    ttl_seconds: int = Field(
        default=3600,
        ge=60,
        le=86400,
        description="Time-to-live in seconds (1 min to 24 hours)"
    )
    max_renewals: int = Field(default=5, ge=0, le=100, description="Maximum renewal count")

    # Scope
    allowed_actions: List[str] = Field(default_factory=list, description="Allowed action patterns")
    allowed_resources: List[str] = Field(default_factory=list, description="Allowed resource patterns")
    denied_actions: List[str] = Field(default_factory=list, description="Explicitly denied actions")
    denied_resources: List[str] = Field(default_factory=list, description="Explicitly denied resources")

    # Rate limits
    max_actions_per_minute: Optional[int] = Field(None, ge=1, description="Max actions per minute")
    max_actions_total: Optional[int] = Field(None, ge=1, description="Max total actions")

    # Additional constraints
    constraints: Dict[str, Any] = Field(default_factory=dict, description="Additional constraints")
    context: Dict[str, Any] = Field(default_factory=dict, description="Operational context")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional metadata")

    # Approval
    requires_approval: bool = Field(default=False, description="Requires human approval")
    approval_notes: Optional[str] = Field(None, description="Notes for approver")

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "agent_id": "550e8400-e29b-41d4-a716-446655440000",
                "agent_name": "data-processor-1",
                "lease_type": "session",
                "autonomy_level": 2,
                "ttl_seconds": 3600,
                "max_renewals": 3,
                "allowed_actions": ["read:*", "process:data/*"],
                "allowed_resources": ["database:analytics", "storage:temp/*"],
                "denied_actions": ["delete:*", "admin:*"],
                "max_actions_per_minute": 100,
                "max_actions_total": 10000,
                "constraints": {"environment": "production"},
            }
        }
    )


class LeaseResponse(BaseModel):
    """Lease information response."""
    id: UUID
    agent_id: UUID
    agent_name: Optional[str] = None
    lease_type: LeaseType
    status: LeaseStatus
    autonomy_level: int

    # Timing
    created_at: datetime
    activated_at: Optional[datetime] = None
    expires_at: datetime
    ttl_seconds: int
    remaining_seconds: int
    is_valid: bool

    # Renewals
    can_renew: bool
    renewal_count: int
    max_renewals: int

    # Scope
    allowed_actions: List[str]
    allowed_resources: List[str]
    denied_actions: List[str]
    denied_resources: List[str]

    # Rate limits
    max_actions_per_minute: Optional[int] = None
    max_actions_total: Optional[int] = None
    actions_taken: int = 0

    # Constraints and context
    constraints: Dict[str, Any]
    context: Dict[str, Any]
    metadata: Dict[str, Any]

    # Approval
    requires_approval: bool = False
    approved_by: Optional[str] = None
    approved_at: Optional[datetime] = None

    # Revocation
    revoked_at: Optional[datetime] = None
    revoked_by: Optional[str] = None
    revocation_reason: Optional[str] = None

    # Ownership
    granted_by: str

    model_config = ConfigDict(from_attributes=True)


class LeaseListResponse(BaseModel):
    """Response for listing leases."""
    leases: List[LeaseResponse]
    total: int
    offset: int = 0
    limit: int = 100


class LeaseRenewRequest(BaseModel):
    """Request to renew a lease."""
    extend_seconds: Optional[int] = Field(
        None,
        ge=60,
        le=86400,
        description="Additional time to add (defaults to original TTL)"
    )
    reason: Optional[str] = Field(None, description="Reason for renewal")


class LeaseRevokeRequest(BaseModel):
    """Request to revoke a lease."""
    reason: str = Field(..., min_length=1, description="Reason for revocation")
    immediate: bool = Field(default=True, description="Revoke immediately vs graceful")


class LeaseApproveRequest(BaseModel):
    """Request to approve a pending lease."""
    approved: bool = Field(..., description="Whether to approve or reject")
    notes: Optional[str] = Field(None, description="Approval/rejection notes")
    modified_ttl: Optional[int] = Field(None, ge=60, le=86400, description="Modified TTL if approved")
    modified_autonomy_level: Optional[AutonomyLevel] = Field(None, description="Modified autonomy level")


# =============================================================================
# Autonomy Checks
# =============================================================================

class AutonomyCheckRequest(BaseModel):
    """Request to check if an action is allowed."""
    agent_id: UUID = Field(..., description="Agent requesting action")
    action: str = Field(..., description="Action to perform")
    resource: Optional[str] = Field(None, description="Resource to access")
    context: Dict[str, Any] = Field(default_factory=dict, description="Action context")

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "agent_id": "550e8400-e29b-41d4-a716-446655440000",
                "action": "read:database",
                "resource": "database:analytics/users",
                "context": {"query": "SELECT * FROM users LIMIT 10"},
            }
        }
    )


class AutonomyCheckResult(BaseModel):
    """Result of autonomy check."""
    allowed: bool
    lease_id: Optional[UUID] = None
    lease_status: Optional[LeaseStatus] = None
    autonomy_level: Optional[int] = None
    remaining_actions: Optional[int] = None
    remaining_seconds: Optional[int] = None
    denial_reason: Optional[str] = None
    requires_approval: bool = False
    checked_at: datetime


# =============================================================================
# Bulk Operations
# =============================================================================

class BulkRevokeRequest(BaseModel):
    """Request to revoke multiple leases."""
    lease_ids: Optional[List[UUID]] = Field(None, description="Specific lease IDs")
    agent_id: Optional[UUID] = Field(None, description="Revoke all for agent")
    reason: str = Field(..., description="Revocation reason")


class BulkRevokeResponse(BaseModel):
    """Response from bulk revocation."""
    revoked_count: int
    failed_count: int
    errors: List[Dict[str, str]] = Field(default_factory=list)


# =============================================================================
# Statistics
# =============================================================================

class LeaseStats(BaseModel):
    """Lease statistics."""
    total_leases: int
    active_leases: int
    pending_leases: int
    expired_leases: int
    revoked_leases: int
    leases_by_agent: Dict[str, int]
    leases_by_type: Dict[str, int]
    average_ttl_seconds: float
    average_renewal_count: float
    timestamp: datetime
