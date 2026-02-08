"""
Pydantic Schemas for Identity Service API

Request and response models for agent registration, management, and DID operations.
"""

from datetime import datetime
from typing import Optional, List, Dict, Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, ConfigDict


class DIDVerificationMethod(BaseModel):
    """W3C DID Verification Method."""
    id: str
    type: str
    controller: str
    publicKeyPem: Optional[str] = None
    publicKeyJwk: Optional[Dict[str, Any]] = None


class DIDService(BaseModel):
    """W3C DID Service Endpoint."""
    id: str
    type: str
    serviceEndpoint: str


class DIDDocument(BaseModel):
    """W3C DID Document (subset of spec)."""
    context: List[str] = Field(alias="@context", default=[
        "https://www.w3.org/ns/did/v1",
        "https://w3id.org/security/suites/ed25519-2020/v1",
    ])
    id: str
    controller: Optional[str] = None
    verificationMethod: Optional[List[DIDVerificationMethod]] = None
    authentication: Optional[List[str]] = None
    assertionMethod: Optional[List[str]] = None
    service: Optional[List[DIDService]] = None
    created: Optional[datetime] = None
    updated: Optional[datetime] = None

    model_config = ConfigDict(populate_by_name=True)


class AgentCreate(BaseModel):
    """Request to register a new agent."""
    name: str = Field(..., min_length=1, max_length=255, description="Agent name")
    public_key: Optional[str] = Field(None, description="PEM-encoded public key")
    agent_role: Optional[Literal["sme", "planner", "executor", "auditor", "facilitator"]] = Field(
        None,
        description="Primary agent role (sme, planner, executor, auditor, facilitator)",
    )
    trust_level: Optional[Literal["intern", "junior", "senior", "principal"]] = Field(
        None,
        description="Progressive trust level (intern, junior, senior, principal)",
    )
    capabilities: Optional[List[str]] = Field(
        default_factory=list,
        description="Capability set for authorization decisions",
    )
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Agent metadata")
    permissions: Optional[List[str]] = Field(default_factory=list, description="Initial permissions")

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "name": "my-agent",
                "public_key": "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...\n-----END PUBLIC KEY-----",
                "agent_role": "executor",
                "trust_level": "junior",
                "capabilities": ["execution:read", "sandbox:read"],
                "metadata": {"team": "platform", "environment": "production"},
                "permissions": ["read:*", "jira:write"],
            }
        }
    )


class AgentResponse(BaseModel):
    """Agent information response."""
    id: UUID
    name: str
    did: Optional[DIDDocument] = None
    spiffe_id: Optional[str] = None
    agent_role: Optional[str] = None
    trust_level: Optional[str] = None
    capabilities: List[str] = Field(default_factory=list)
    public_key: Optional[str] = None
    key_fingerprint: Optional[str] = None
    issuer: Optional[str] = None
    status: str
    permissions: List[str]
    metadata: Dict[str, Any]
    created_at: datetime
    updated_at: datetime
    activated_at: Optional[datetime] = None
    revoked_at: Optional[datetime] = None
    certificate_expires_at: Optional[datetime] = None

    # Token for authentication (only included on registration)
    token: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


class AgentListResponse(BaseModel):
    """Response for listing agents."""
    agents: List[AgentResponse]
    total: int
    page: int
    page_size: int


class KeyRotationRequest(BaseModel):
    """Request to rotate agent's keys."""
    new_public_key: str = Field(..., description="New PEM-encoded public key")
    reason: Optional[str] = Field(None, description="Reason for rotation")


class KeyRotationResponse(BaseModel):
    """Response after key rotation."""
    agent_id: UUID
    old_key_fingerprint: Optional[str]
    new_key_fingerprint: str
    rotated_at: datetime
    new_certificate: Optional[str] = None
    new_certificate_expires_at: Optional[datetime] = None
    token: Optional[str] = None  # New token if applicable


class AgentRevokeRequest(BaseModel):
    """Request to revoke an agent."""
    reason: str = Field(..., min_length=1, description="Reason for revocation")


class AgentRevokeResponse(BaseModel):
    """Response after agent revocation."""
    agent_id: UUID
    status: str
    revoked_at: datetime
    revoked_by: str
    reason: str


class HealthResponse(BaseModel):
    """Health check response."""
    status: str
    service: str
    version: str
    timestamp: datetime
    components: Dict[str, Dict[str, Any]]


class ErrorResponse(BaseModel):
    """Standard error response."""
    error: str
    detail: Optional[str] = None
    code: Optional[str] = None
    timestamp: datetime = Field(default_factory=lambda: datetime.now())
