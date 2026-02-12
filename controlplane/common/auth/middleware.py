"""
AEGIS-T2A Authentication Middleware

Provides JWT and mTLS authentication for control plane services.
Supports SPIFFE SVID validation and Vault-issued certificates.
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any, Callable
from functools import wraps

import jwt
from fastapi import Request, HTTPException, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from starlette.middleware.base import BaseHTTPMiddleware
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend

from ..config.settings import get_settings, Settings

logger = logging.getLogger(__name__)

# Security scheme for API documentation
bearer_scheme = HTTPBearer(auto_error=False)


class AgentIdentity:
    """Represents a verified agent identity."""

    def __init__(
        self,
        agent_id: str,
        spiffe_id: Optional[str] = None,
        issuer: Optional[str] = None,
        subject: Optional[str] = None,
        permissions: Optional[list] = None,
        metadata: Optional[dict] = None,
        expires_at: Optional[datetime] = None,
    ):
        self.agent_id = agent_id
        self.spiffe_id = spiffe_id
        self.issuer = issuer
        self.subject = subject
        self.permissions = permissions or []
        self.metadata = metadata or {}
        self.expires_at = expires_at
        self.verified_at = datetime.now(timezone.utc)

    def has_permission(self, permission: str) -> bool:
        """Check if agent has a specific permission."""
        return permission in self.permissions or "*" in self.permissions

    def is_expired(self) -> bool:
        """Check if identity credentials are expired."""
        if self.expires_at is None:
            return False
        return datetime.now(timezone.utc) > self.expires_at

    def to_dict(self) -> dict:
        """Convert to dictionary for logging/serialization."""
        return {
            "agent_id": self.agent_id,
            "spiffe_id": self.spiffe_id,
            "issuer": self.issuer,
            "subject": self.subject,
            "permissions": self.permissions,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "verified_at": self.verified_at.isoformat(),
        }


class AuthMiddleware(BaseHTTPMiddleware):
    """
    FastAPI middleware for authentication.

    Supports multiple authentication methods:
    - JWT Bearer tokens
    - mTLS client certificates
    - SPIFFE SVIDs
    """

    # Paths that don't require authentication
    PUBLIC_PATHS = [
        "/health",
        "/ready",
        "/metrics",
        "/docs",
        "/openapi.json",
        "/redoc",
    ]

    def __init__(self, app, settings: Optional[Settings] = None):
        super().__init__(app)
        self.settings = settings or get_settings()

    async def dispatch(self, request: Request, call_next: Callable):
        """Process request and validate authentication."""
        # Skip auth for public paths
        if any(request.url.path.startswith(path) for path in self.PUBLIC_PATHS):
            return await call_next(request)

        try:
            # Try to authenticate
            identity = await self._authenticate(request)
            if identity:
                # Store identity in request state for handlers
                request.state.agent_identity = identity
                logger.debug(f"Authenticated agent: {identity.agent_id}")
            else:
                # No authentication provided - allow but log
                request.state.agent_identity = None
                logger.debug(f"Unauthenticated request to {request.url.path}")

        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Authentication error: {e}")
            raise HTTPException(status_code=401, detail="Authentication failed")

        return await call_next(request)

    async def _authenticate(self, request: Request) -> Optional[AgentIdentity]:
        """Attempt to authenticate the request."""
        # Try JWT first
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            token = auth_header[7:]
            return await self._verify_jwt(token)

        # Try mTLS client certificate
        if self.settings.auth.mtls_enabled:
            client_cert = request.headers.get("X-Client-Cert")
            if client_cert:
                return await self._verify_certificate(client_cert)

        # Try SPIFFE SVID from header (set by Envoy sidecar)
        spiffe_id = request.headers.get("X-SPIFFE-ID")
        if spiffe_id:
            return await self._verify_spiffe(spiffe_id, request)

        return None

    async def _verify_jwt(self, token: str) -> AgentIdentity:
        """Verify JWT token and extract identity."""
        try:
            # Decode without verification first to get header
            header = jwt.get_unverified_header(token)

            # Get the appropriate key based on algorithm
            if header.get("alg") == "RS256":
                # For RS256, we need the public key
                # In production, fetch from JWKS endpoint or file
                secret = self.settings.auth.jwt_secret
            else:
                secret = self.settings.auth.jwt_secret

            payload = jwt.decode(
                token,
                secret,
                algorithms=[self.settings.auth.jwt_algorithm, "HS256"],
                options={"verify_exp": True},
            )

            # Validate issuer if configured
            if self.settings.auth.allowed_issuers:
                if payload.get("iss") not in self.settings.auth.allowed_issuers:
                    raise HTTPException(status_code=401, detail="Invalid token issuer")

            return AgentIdentity(
                agent_id=payload.get("sub") or payload.get("agent_id"),
                issuer=payload.get("iss"),
                subject=payload.get("sub"),
                permissions=payload.get("permissions", []),
                metadata=payload.get("metadata", {}),
                expires_at=datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
                if "exp" in payload
                else None,
            )

        except jwt.ExpiredSignatureError:
            raise HTTPException(status_code=401, detail="Token has expired")
        except jwt.InvalidTokenError as e:
            raise HTTPException(status_code=401, detail=f"Invalid token: {str(e)}")

    async def _verify_certificate(self, cert_pem: str) -> AgentIdentity:
        """Verify client certificate and extract identity."""
        try:
            # Parse the certificate
            cert = x509.load_pem_x509_certificate(
                cert_pem.encode(), default_backend()
            )

            # Check expiration
            if cert.not_valid_after_utc < datetime.now(timezone.utc):
                raise HTTPException(status_code=401, detail="Certificate has expired")

            # Extract subject CN as agent ID
            subject = cert.subject
            cn = subject.get_attributes_for_oid(x509.oid.NameOID.COMMON_NAME)
            agent_id = cn[0].value if cn else None

            if not agent_id:
                raise HTTPException(
                    status_code=401, detail="Certificate missing Common Name"
                )

            # Extract SPIFFE ID from SAN if present
            spiffe_id = None
            try:
                san = cert.extensions.get_extension_for_oid(
                    x509.oid.ExtensionOID.SUBJECT_ALTERNATIVE_NAME
                )
                for name in san.value:
                    if isinstance(name, x509.UniformResourceIdentifier):
                        if name.value.startswith("spiffe://"):
                            spiffe_id = name.value
                            break
            except x509.ExtensionNotFound:
                pass

            # Extract issuer
            issuer_cn = cert.issuer.get_attributes_for_oid(x509.oid.NameOID.COMMON_NAME)
            issuer = issuer_cn[0].value if issuer_cn else "unknown"

            return AgentIdentity(
                agent_id=agent_id,
                spiffe_id=spiffe_id,
                issuer=issuer,
                subject=agent_id,
                expires_at=cert.not_valid_after_utc,
            )

        except Exception as e:
            logger.error(f"Certificate verification failed: {e}")
            raise HTTPException(status_code=401, detail="Invalid certificate")

    async def _verify_spiffe(
        self, spiffe_id: str, request: Request
    ) -> AgentIdentity:
        """Verify SPIFFE ID (typically set by Envoy after mTLS)."""
        # The SPIFFE ID is already verified by the sidecar
        # Extract agent ID from the SPIFFE ID path
        # Format: spiffe://trust-domain/agent/<agent-id>
        parts = spiffe_id.split("/")
        agent_id = parts[-1] if len(parts) > 0 else spiffe_id

        return AgentIdentity(
            agent_id=agent_id,
            spiffe_id=spiffe_id,
            issuer=f"spiffe://{parts[2]}" if len(parts) > 2 else "spiffe",
        )


def verify_agent_identity(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Security(bearer_scheme),
) -> AgentIdentity:
    """
    FastAPI dependency for requiring authenticated agent.

    Usage:
        @app.get("/secure")
        async def secure_endpoint(identity: AgentIdentity = Depends(verify_agent_identity)):
            return {"agent_id": identity.agent_id}
    """
    identity = getattr(request.state, "agent_identity", None)
    if identity is None:
        raise HTTPException(
            status_code=401, detail="Authentication required", headers={"WWW-Authenticate": "Bearer"}
        )
    if identity.is_expired():
        raise HTTPException(status_code=401, detail="Credentials have expired")
    return identity


def get_current_identity(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Security(bearer_scheme),
) -> AgentIdentity:
    """
    Backward-compatible alias used by control plane handlers.

    Kept separate from verify_agent_identity so existing imports continue to work.
    """
    return verify_agent_identity(request=request, credentials=credentials)


def require_permission(permission: str):
    """
    Decorator to require specific permission.

    Usage:
        @app.get("/admin")
        @require_permission("admin:read")
        async def admin_endpoint(identity: AgentIdentity = Depends(verify_agent_identity)):
            ...
    """
    def decorator(func: Callable):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            # Find the identity in kwargs (from dependency injection)
            identity = None
            for key, value in kwargs.items():
                if isinstance(value, AgentIdentity):
                    identity = value
                    break

            if identity is None:
                raise HTTPException(status_code=401, detail="Authentication required")

            if not identity.has_permission(permission):
                raise HTTPException(
                    status_code=403,
                    detail=f"Permission denied: requires '{permission}'",
                )

            return await func(*args, **kwargs)
        return wrapper
    return decorator


def create_agent_token(
    agent_id: str,
    permissions: list = None,
    metadata: dict = None,
    ttl_seconds: int = None,
    settings: Settings = None,
) -> str:
    """
    Create a JWT token for an agent.

    Used by the identity service when registering agents or
    when agents need to authenticate to other services.
    """
    settings = settings or get_settings()
    ttl = ttl_seconds or settings.auth.jwt_expiry_seconds

    now = datetime.now(timezone.utc)
    payload = {
        "sub": agent_id,
        "agent_id": agent_id,
        "iss": settings.service_name,
        "iat": now,
        "exp": now + timedelta(seconds=ttl),
        "permissions": permissions or [],
        "metadata": metadata or {},
    }

    token = jwt.encode(
        payload,
        settings.auth.jwt_secret,
        algorithm="HS256"  # Use HS256 for simplicity; RS256 for production
    )

    return token
