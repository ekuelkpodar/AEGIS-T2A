"""
Pydantic Schemas for Policy Engine API

Request and response models for policy management and evaluation.
"""

from datetime import datetime
from enum import Enum
from typing import Optional, List, Dict, Any
from uuid import UUID

from pydantic import BaseModel, Field, ConfigDict


class PolicyStatus(str, Enum):
    """Policy lifecycle status."""
    DRAFT = "draft"
    ACTIVE = "active"
    DEPRECATED = "deprecated"
    ARCHIVED = "archived"


class PolicyType(str, Enum):
    """Type of policy."""
    ALLOW = "allow"
    DENY = "deny"
    REQUIRE_APPROVAL = "require_approval"
    RATE_LIMIT = "rate_limit"
    SCOPE_LIMIT = "scope_limit"


class PolicyDecision(str, Enum):
    """Result of policy evaluation."""
    ALLOW = "allow"
    DENY = "deny"
    REQUIRE_APPROVAL = "require_approval"
    NOT_APPLICABLE = "not_applicable"


class PolicyCreate(BaseModel):
    """Request to create a new policy."""
    name: str = Field(..., min_length=1, max_length=255, description="Policy name")
    description: Optional[str] = Field(None, description="Policy description")
    policy_type: PolicyType = Field(default=PolicyType.ALLOW, description="Policy type")
    rego_code: str = Field(..., description="Rego policy code")
    applies_to_agents: List[str] = Field(default_factory=list, description="Agent patterns")
    applies_to_actions: List[str] = Field(default_factory=list, description="Action patterns")
    applies_to_resources: List[str] = Field(default_factory=list, description="Resource patterns")
    priority: int = Field(default=100, ge=0, le=1000, description="Priority (higher = first)")
    labels: Dict[str, str] = Field(default_factory=dict, description="Labels for categorization")
    annotations: Dict[str, Any] = Field(default_factory=dict, description="Additional metadata")

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "name": "deny-production-delete",
                "description": "Deny delete operations on production resources",
                "policy_type": "deny",
                "rego_code": """
package aegis.policies

default allow = false

deny[reason] {
    input.action == "delete"
    input.resource.environment == "production"
    reason := "Delete operations not allowed in production"
}
""",
                "applies_to_agents": ["*"],
                "applies_to_actions": ["delete"],
                "applies_to_resources": ["*"],
                "priority": 200,
                "labels": {"environment": "production", "severity": "high"},
            }
        }
    )


class PolicyUpdate(BaseModel):
    """Request to update a policy."""
    description: Optional[str] = None
    rego_code: Optional[str] = None
    applies_to_agents: Optional[List[str]] = None
    applies_to_actions: Optional[List[str]] = None
    applies_to_resources: Optional[List[str]] = None
    priority: Optional[int] = Field(None, ge=0, le=1000)
    labels: Optional[Dict[str, str]] = None
    annotations: Optional[Dict[str, Any]] = None
    change_reason: Optional[str] = Field(None, description="Reason for the change")


class PolicyResponse(BaseModel):
    """Policy information response."""
    id: UUID
    name: str
    description: Optional[str] = None
    policy_type: PolicyType
    status: PolicyStatus
    rego_code: str
    applies_to_agents: List[str]
    applies_to_actions: List[str]
    applies_to_resources: List[str]
    priority: int
    version: int
    labels: Dict[str, str]
    annotations: Dict[str, Any]
    created_by: Optional[str] = None
    created_at: datetime
    updated_by: Optional[str] = None
    updated_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)


class PolicyListResponse(BaseModel):
    """Response for listing policies."""
    policies: List[PolicyResponse]
    total: int
    offset: int = 0
    limit: int = 100


class PolicyVersionResponse(BaseModel):
    """Policy version information."""
    id: UUID
    policy_id: UUID
    version: int
    rego_code: str
    change_reason: Optional[str] = None
    changed_by: Optional[str] = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# =============================================================================
# Policy Evaluation
# =============================================================================

class PolicyEvaluationRequest(BaseModel):
    """Request to evaluate policies for an action."""
    agent_id: str = Field(..., description="Agent requesting the action")
    action: str = Field(..., description="Action being requested")
    resource: Dict[str, Any] = Field(..., description="Resource being accessed")
    context: Dict[str, Any] = Field(default_factory=dict, description="Additional context")

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "agent_id": "agent-123",
                "action": "execute_command",
                "resource": {
                    "type": "server",
                    "id": "srv-456",
                    "environment": "production",
                },
                "context": {
                    "time": "2024-01-15T10:30:00Z",
                    "ip_address": "192.168.1.100",
                },
            }
        }
    )


class PolicyMatch(BaseModel):
    """A policy that matched the evaluation."""
    policy_id: str
    policy_name: str
    decision: PolicyDecision
    reason: Optional[str] = None
    priority: int


class PolicyEvaluationResult(BaseModel):
    """Result of policy evaluation."""
    decision: PolicyDecision
    allowed: bool
    requires_approval: bool = False
    shadow_mode: bool = False
    shadow_decision: Optional[PolicyDecision] = None
    shadow_denial_reasons: List[str] = Field(default_factory=list)
    shadow_approval_reasons: List[str] = Field(default_factory=list)
    denial_reasons: List[str] = Field(default_factory=list)
    approval_reasons: List[str] = Field(default_factory=list)
    matched_policies: List[PolicyMatch] = Field(default_factory=list)
    evaluation_time_ms: float
    evaluated_at: datetime

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "decision": "deny",
                "allowed": False,
                "requires_approval": False,
                "denial_reasons": ["Delete operations not allowed in production"],
                "matched_policies": [
                    {
                        "policy_id": "pol-123",
                        "policy_name": "deny-production-delete",
                        "decision": "deny",
                        "reason": "Delete operations not allowed in production",
                        "priority": 200,
                    }
                ],
                "evaluation_time_ms": 2.5,
                "evaluated_at": "2024-01-15T10:30:00Z",
            }
        }
    )


# =============================================================================
# Bundle Management
# =============================================================================

class BundleCreateRequest(BaseModel):
    """Request to create a policy bundle."""
    name: Optional[str] = Field(None, description="Bundle name")
    policy_ids: Optional[List[UUID]] = Field(None, description="Specific policies to include")
    include_active_only: bool = Field(default=True, description="Only include active policies")


class BundleResponse(BaseModel):
    """Policy bundle information."""
    bundle_id: str
    revision: str
    policies_count: int
    storage_path: Optional[str] = None
    size_bytes: Optional[int] = None
    is_active: bool
    created_at: datetime
    activated_at: Optional[datetime] = None


# =============================================================================
# Data Policies (for OPA data)
# =============================================================================

class DataDocument(BaseModel):
    """OPA data document."""
    path: str = Field(..., description="Data path (e.g., 'agents/permissions')")
    data: Dict[str, Any] = Field(..., description="Data content")


class DataDocumentResponse(BaseModel):
    """Response for data document operations."""
    path: str
    data: Dict[str, Any]
    revision: str
    updated_at: datetime
