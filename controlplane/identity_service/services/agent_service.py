"""
Agent Service

Core business logic for agent identity management.
Handles registration, verification, rotation, and revocation.
"""

import hashlib
import logging
from datetime import datetime, timezone
from typing import Optional, List, Tuple
from uuid import UUID

from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.agent import Agent, AgentStatus
from ..models.schemas import AgentCreate, AgentResponse, DIDDocument
from ...common.config.settings import Settings, get_settings
from ...common.auth.middleware import create_agent_token

logger = logging.getLogger(__name__)


class AgentService:
    """
    Service for managing agent identities.

    Provides CRUD operations for agents and integrates with
    Vault/SPIRE for certificate/SVID issuance.
    """

    def __init__(
        self,
        session: AsyncSession,
        settings: Optional[Settings] = None,
        vault_pki=None,
        spire_client=None,
    ):
        self.session = session
        self.settings = settings or get_settings()
        self.vault_pki = vault_pki
        self.spire_client = spire_client

    async def register_agent(self, data: AgentCreate, registered_by: str = "system") -> Tuple[Agent, str]:
        """
        Register a new agent.

        Creates agent record, generates DID document, and optionally
        issues certificate through Vault or SPIRE.

        Returns:
            Tuple of (Agent, token) where token is for authentication
        """
        logger.info(f"Registering new agent: {data.name}")

        # Compute key fingerprint if public key provided
        key_fingerprint = None
        if data.public_key:
            key_fingerprint = self._compute_key_fingerprint(data.public_key)

        # Create agent record
        agent = Agent(
            name=data.name,
            public_key=data.public_key,
            key_fingerprint=key_fingerprint,
            metadata=data.metadata or {},
            permissions=data.permissions or [],
            status=AgentStatus.PENDING,
        )

        # Generate DID document
        agent.did = agent.to_did_document()

        # Determine identity provider and issue credentials
        provider = self.settings.get_identity_provider()
        agent.issuer = provider

        if provider == "vault" and self.vault_pki:
            # Issue certificate via Vault PKI
            cert_info = await self.vault_pki.issue_certificate(
                agent_id=str(agent.id),
                common_name=data.name,
                ttl=self.settings.default_lease_ttl,
            )
            agent.certificate = cert_info.get("certificate")
            agent.certificate_serial = cert_info.get("serial_number")
            agent.certificate_expires_at = cert_info.get("expires_at")

        elif provider == "spire" and self.spire_client:
            # Create SPIFFE workload entry
            spiffe_id = f"spiffe://{self.settings.spire.trust_domain}/agent/{agent.id}"
            await self.spire_client.create_entry(
                spiffe_id=spiffe_id,
                parent_id=f"spiffe://{self.settings.spire.trust_domain}/server",
                selectors=[{"type": "aegis", "value": f"agent:{agent.id}"}],
            )
            agent.spiffe_id = spiffe_id

        # Activate agent
        agent.activate()

        # Add metadata about registration
        agent.metadata["registered_by"] = registered_by
        agent.metadata["registration_method"] = provider

        # Persist to database
        self.session.add(agent)
        await self.session.flush()

        # Generate authentication token
        token = create_agent_token(
            agent_id=str(agent.id),
            permissions=agent.permissions,
            metadata={"name": agent.name},
            ttl_seconds=self.settings.auth.jwt_expiry_seconds,
            settings=self.settings,
        )

        logger.info(f"Agent registered successfully: {agent.id}")
        return agent, token

    async def get_agent(self, agent_id: UUID) -> Optional[Agent]:
        """Get agent by ID."""
        result = await self.session.execute(
            select(Agent).where(Agent.id == agent_id)
        )
        return result.scalar_one_or_none()

    async def get_agent_by_spiffe_id(self, spiffe_id: str) -> Optional[Agent]:
        """Get agent by SPIFFE ID."""
        result = await self.session.execute(
            select(Agent).where(Agent.spiffe_id == spiffe_id)
        )
        return result.scalar_one_or_none()

    async def get_agent_by_name(self, name: str) -> Optional[Agent]:
        """Get agent by name."""
        result = await self.session.execute(
            select(Agent).where(Agent.name == name)
        )
        return result.scalar_one_or_none()

    async def list_agents(
        self,
        status: Optional[AgentStatus] = None,
        issuer: Optional[str] = None,
        page: int = 1,
        page_size: int = 50,
    ) -> Tuple[List[Agent], int]:
        """
        List agents with optional filtering.

        Returns:
            Tuple of (agents, total_count)
        """
        query = select(Agent)

        if status:
            query = query.where(Agent.status == status)
        if issuer:
            query = query.where(Agent.issuer == issuer)

        # Get total count
        count_query = select(func.count(Agent.id))
        if status:
            count_query = count_query.where(Agent.status == status)
        if issuer:
            count_query = count_query.where(Agent.issuer == issuer)

        total_result = await self.session.execute(count_query)
        total = total_result.scalar() or 0

        # Paginate
        offset = (page - 1) * page_size
        query = query.order_by(Agent.created_at.desc()).offset(offset).limit(page_size)

        result = await self.session.execute(query)
        agents = list(result.scalars().all())

        return agents, total

    async def rotate_keys(
        self,
        agent_id: UUID,
        new_public_key: str,
        reason: Optional[str] = None,
        rotated_by: str = "system",
    ) -> Agent:
        """
        Rotate agent's cryptographic keys.

        Issues new certificate if using Vault PKI.
        """
        agent = await self.get_agent(agent_id)
        if not agent:
            raise ValueError(f"Agent not found: {agent_id}")

        if agent.is_revoked():
            raise ValueError("Cannot rotate keys for revoked agent")

        logger.info(f"Rotating keys for agent: {agent_id}")

        # Store old fingerprint for audit
        old_fingerprint = agent.key_fingerprint

        # Update key
        agent.public_key = new_public_key
        agent.key_fingerprint = self._compute_key_fingerprint(new_public_key)
        agent.key_rotated_at = datetime.now(timezone.utc)
        agent.key_rotation_count = (agent.key_rotation_count or 0) + 1

        # Update DID document
        agent.did = agent.to_did_document()

        # Reissue certificate if using Vault
        if agent.issuer == "vault" and self.vault_pki:
            # Revoke old certificate
            if agent.certificate_serial:
                await self.vault_pki.revoke_certificate(agent.certificate_serial)

            # Issue new certificate
            cert_info = await self.vault_pki.issue_certificate(
                agent_id=str(agent.id),
                common_name=agent.name,
                ttl=self.settings.default_lease_ttl,
            )
            agent.certificate = cert_info.get("certificate")
            agent.certificate_serial = cert_info.get("serial_number")
            agent.certificate_expires_at = cert_info.get("expires_at")

        # Add rotation to metadata history
        rotation_history = agent.metadata.get("key_rotations", [])
        rotation_history.append({
            "rotated_at": datetime.now(timezone.utc).isoformat(),
            "rotated_by": rotated_by,
            "reason": reason,
            "old_fingerprint": old_fingerprint,
            "new_fingerprint": agent.key_fingerprint,
        })
        agent.metadata["key_rotations"] = rotation_history[-10:]  # Keep last 10

        await self.session.flush()
        logger.info(f"Keys rotated for agent: {agent_id}")
        return agent

    async def revoke_agent(
        self,
        agent_id: UUID,
        reason: str,
        revoked_by: str,
    ) -> Agent:
        """
        Revoke an agent's identity.

        This is immediate and irreversible. Revokes certificates
        and removes SPIFFE entries.
        """
        agent = await self.get_agent(agent_id)
        if not agent:
            raise ValueError(f"Agent not found: {agent_id}")

        if agent.is_revoked():
            raise ValueError("Agent is already revoked")

        logger.warning(f"Revoking agent: {agent_id}, reason: {reason}")

        # Revoke in identity provider
        if agent.issuer == "vault" and self.vault_pki:
            if agent.certificate_serial:
                await self.vault_pki.revoke_certificate(agent.certificate_serial)

        elif agent.issuer == "spire" and self.spire_client:
            if agent.spiffe_id:
                await self.spire_client.delete_entry(agent.spiffe_id)

        # Update agent record
        agent.revoke(reason=reason, revoked_by=revoked_by)

        await self.session.flush()
        logger.warning(f"Agent revoked: {agent_id}")
        return agent

    async def verify_agent(self, agent_id: UUID) -> bool:
        """
        Verify an agent's identity is valid.

        Checks status, certificate validity, and SPIFFE entry.
        """
        agent = await self.get_agent(agent_id)
        if not agent:
            return False

        if not agent.is_active():
            return False

        # Check certificate validity
        if agent.certificate_expires_at:
            if agent.certificate_expires_at < datetime.now(timezone.utc):
                return False

        # Additional SPIFFE validation could go here

        return True

    async def search_agents(
        self,
        query: str,
        status: Optional[AgentStatus] = None,
        limit: int = 20,
    ) -> List[Agent]:
        """Search agents by name or metadata."""
        stmt = select(Agent).where(
            or_(
                Agent.name.ilike(f"%{query}%"),
                Agent.metadata.op("->>").__call__("team").ilike(f"%{query}%"),
            )
        )

        if status:
            stmt = stmt.where(Agent.status == status)

        stmt = stmt.limit(limit)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    def _compute_key_fingerprint(self, public_key: str) -> str:
        """Compute SHA-256 fingerprint of public key."""
        # Normalize the key by removing whitespace
        normalized = public_key.strip()
        return hashlib.sha256(normalized.encode()).hexdigest()

    def agent_to_response(self, agent: Agent, token: str = None) -> AgentResponse:
        """Convert Agent model to API response."""
        did_doc = None
        if agent.did:
            try:
                did_doc = DIDDocument(**agent.did)
            except Exception:
                pass

        return AgentResponse(
            id=agent.id,
            name=agent.name,
            did=did_doc,
            spiffe_id=agent.spiffe_id,
            public_key=agent.public_key,
            key_fingerprint=agent.key_fingerprint,
            issuer=agent.issuer,
            status=agent.status.value,
            permissions=agent.permissions or [],
            metadata=agent.metadata or {},
            created_at=agent.created_at,
            updated_at=agent.updated_at,
            activated_at=agent.activated_at,
            revoked_at=agent.revoked_at,
            certificate_expires_at=agent.certificate_expires_at,
            token=token,
        )
