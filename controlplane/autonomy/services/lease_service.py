"""
Lease Service

Core business logic for autonomy lease management.
"""

import fnmatch
import logging
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, List, Optional, Tuple
from uuid import UUID, uuid4

from sqlalchemy import select, func, and_, or_, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.lease import Lease, LeaseAudit, LeaseStatus, LeaseType, AutonomyLevel
from ..models.schemas import (
    LeaseCreate,
    LeaseRenewRequest,
    LeaseRevokeRequest,
    LeaseApproveRequest,
    AutonomyCheckRequest,
    AutonomyCheckResult,
)
from ...common.config.settings import Settings, get_settings

logger = logging.getLogger(__name__)


class LeaseService:
    """
    Service for managing autonomy leases.

    Provides:
    - Lease creation, renewal, and revocation
    - Autonomy checks for action authorization
    - Lease expiration management
    - Audit trail
    """

    def __init__(
        self,
        session: AsyncSession,
        settings: Optional[Settings] = None,
    ):
        self.session = session
        self.settings = settings or get_settings()

    # =========================================================================
    # Lease CRUD
    # =========================================================================

    async def create_lease(
        self,
        data: LeaseCreate,
        granted_by: str,
    ) -> Lease:
        """
        Create a new autonomy lease.

        If requires_approval is True, the lease starts in PENDING status.
        Otherwise, it's immediately ACTIVE.
        """
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(seconds=data.ttl_seconds)

        lease = Lease(
            id=uuid4(),
            agent_id=data.agent_id,
            agent_name=data.agent_name,
            granted_by=granted_by,
            lease_type=LeaseType(data.lease_type.value),
            status=LeaseStatus.PENDING if data.requires_approval else LeaseStatus.ACTIVE,
            autonomy_level=data.autonomy_level.value,
            created_at=now,
            activated_at=None if data.requires_approval else now,
            expires_at=expires_at,
            ttl_seconds=data.ttl_seconds,
            max_renewals=data.max_renewals,
            allowed_actions=data.allowed_actions,
            allowed_resources=data.allowed_resources,
            denied_actions=data.denied_actions,
            denied_resources=data.denied_resources,
            max_actions_per_minute=data.max_actions_per_minute,
            max_actions_total=data.max_actions_total,
            constraints=data.constraints,
            context=data.context,
            metadata=data.metadata,
            requires_approval=data.requires_approval,
            approval_notes=data.approval_notes,
        )

        self.session.add(lease)
        await self.session.flush()

        # Create audit record
        await self._audit(
            lease_id=lease.id,
            action="created",
            actor=granted_by,
            new_status=lease.status,
            details={"lease_type": lease.lease_type.value, "ttl_seconds": data.ttl_seconds},
        )

        logger.info(f"Lease created: {lease.id} for agent {data.agent_id}")
        return lease

    async def get_lease(self, lease_id: UUID) -> Optional[Lease]:
        """Get lease by ID."""
        result = await self.session.execute(
            select(Lease).where(Lease.id == lease_id)
        )
        return result.scalar_one_or_none()

    async def get_active_lease(self, agent_id: UUID) -> Optional[Lease]:
        """Get the active lease for an agent."""
        result = await self.session.execute(
            select(Lease).where(
                Lease.agent_id == agent_id,
                Lease.status == LeaseStatus.ACTIVE,
                Lease.expires_at > datetime.now(timezone.utc),
            ).order_by(Lease.expires_at.desc())
        )
        return result.scalar_one_or_none()

    async def list_leases(
        self,
        agent_id: Optional[UUID] = None,
        status: Optional[LeaseStatus] = None,
        lease_type: Optional[LeaseType] = None,
        include_expired: bool = False,
        offset: int = 0,
        limit: int = 100,
    ) -> Tuple[List[Lease], int]:
        """
        List leases with optional filtering.

        Returns:
            Tuple of (leases, total_count)
        """
        query = select(Lease)
        count_query = select(func.count(Lease.id))

        conditions = []
        if agent_id:
            conditions.append(Lease.agent_id == agent_id)
        if status:
            conditions.append(Lease.status == status)
        if lease_type:
            conditions.append(Lease.lease_type == lease_type)
        if not include_expired:
            conditions.append(
                or_(
                    Lease.status.in_([LeaseStatus.ACTIVE, LeaseStatus.PENDING]),
                    Lease.expires_at > datetime.now(timezone.utc),
                )
            )

        if conditions:
            query = query.where(and_(*conditions))
            count_query = count_query.where(and_(*conditions))

        total_result = await self.session.execute(count_query)
        total = total_result.scalar() or 0

        query = query.order_by(Lease.created_at.desc()).offset(offset).limit(limit)
        result = await self.session.execute(query)
        leases = list(result.scalars().all())

        return leases, total

    # =========================================================================
    # Lease Lifecycle
    # =========================================================================

    async def approve_lease(
        self,
        lease_id: UUID,
        data: LeaseApproveRequest,
        approved_by: str,
    ) -> Lease:
        """Approve or reject a pending lease."""
        lease = await self.get_lease(lease_id)
        if not lease:
            raise ValueError(f"Lease not found: {lease_id}")

        if lease.status != LeaseStatus.PENDING:
            raise ValueError(f"Lease is not pending: {lease.status}")

        old_status = lease.status
        now = datetime.now(timezone.utc)

        if data.approved:
            # Apply modifications if provided
            if data.modified_ttl:
                lease.ttl_seconds = data.modified_ttl
                lease.expires_at = now + timedelta(seconds=data.modified_ttl)
            if data.modified_autonomy_level:
                lease.autonomy_level = data.modified_autonomy_level.value

            lease.status = LeaseStatus.ACTIVE
            lease.activated_at = now
            lease.approved_by = approved_by
            lease.approved_at = now
            lease.approval_notes = data.notes
        else:
            lease.status = LeaseStatus.REVOKED
            lease.revoked_by = approved_by
            lease.revoked_at = now
            lease.revocation_reason = data.notes or "Approval rejected"

        await self.session.flush()

        await self._audit(
            lease_id=lease.id,
            action="approved" if data.approved else "rejected",
            actor=approved_by,
            old_status=old_status,
            new_status=lease.status,
            details={"notes": data.notes},
        )

        logger.info(f"Lease {lease_id} {'approved' if data.approved else 'rejected'} by {approved_by}")
        return lease

    async def renew_lease(
        self,
        lease_id: UUID,
        data: LeaseRenewRequest,
        renewed_by: str,
    ) -> Lease:
        """
        Renew a lease, extending its expiration time.

        Args:
            lease_id: Lease to renew
            data: Renewal request with optional custom extension
            renewed_by: Who is renewing

        Returns:
            Updated lease
        """
        lease = await self.get_lease(lease_id)
        if not lease:
            raise ValueError(f"Lease not found: {lease_id}")

        if not lease.can_renew:
            raise ValueError(f"Lease cannot be renewed: status={lease.status}, renewals={lease.renewal_count}/{lease.max_renewals}")

        # Calculate new expiration
        extend_seconds = data.extend_seconds or lease.ttl_seconds
        new_expires_at = datetime.now(timezone.utc) + timedelta(seconds=extend_seconds)

        lease.expires_at = new_expires_at
        lease.renewal_count += 1
        lease.last_activity_at = datetime.now(timezone.utc)

        await self.session.flush()

        await self._audit(
            lease_id=lease.id,
            action="renewed",
            actor=renewed_by,
            details={
                "extend_seconds": extend_seconds,
                "new_expires_at": new_expires_at.isoformat(),
                "renewal_count": lease.renewal_count,
                "reason": data.reason,
            },
        )

        logger.info(f"Lease {lease_id} renewed ({lease.renewal_count}/{lease.max_renewals})")
        return lease

    async def revoke_lease(
        self,
        lease_id: UUID,
        data: LeaseRevokeRequest,
        revoked_by: str,
    ) -> Lease:
        """
        Revoke a lease, immediately terminating agent autonomy.

        Args:
            lease_id: Lease to revoke
            data: Revocation request with reason
            revoked_by: Who is revoking

        Returns:
            Updated lease
        """
        lease = await self.get_lease(lease_id)
        if not lease:
            raise ValueError(f"Lease not found: {lease_id}")

        if lease.status == LeaseStatus.REVOKED:
            return lease  # Already revoked

        old_status = lease.status
        lease.status = LeaseStatus.REVOKED
        lease.revoked_at = datetime.now(timezone.utc)
        lease.revoked_by = revoked_by
        lease.revocation_reason = data.reason

        await self.session.flush()

        await self._audit(
            lease_id=lease.id,
            action="revoked",
            actor=revoked_by,
            old_status=old_status,
            new_status=lease.status,
            details={"reason": data.reason, "immediate": data.immediate},
            reason=data.reason,
        )

        logger.warning(f"Lease {lease_id} revoked by {revoked_by}: {data.reason}")
        return lease

    async def suspend_lease(
        self,
        lease_id: UUID,
        reason: str,
        suspended_by: str,
    ) -> Lease:
        """Temporarily suspend a lease."""
        lease = await self.get_lease(lease_id)
        if not lease:
            raise ValueError(f"Lease not found: {lease_id}")

        if lease.status != LeaseStatus.ACTIVE:
            raise ValueError(f"Can only suspend active leases: {lease.status}")

        old_status = lease.status
        lease.status = LeaseStatus.SUSPENDED

        await self.session.flush()

        await self._audit(
            lease_id=lease.id,
            action="suspended",
            actor=suspended_by,
            old_status=old_status,
            new_status=lease.status,
            reason=reason,
        )

        logger.info(f"Lease {lease_id} suspended: {reason}")
        return lease

    async def resume_lease(
        self,
        lease_id: UUID,
        resumed_by: str,
    ) -> Lease:
        """Resume a suspended lease."""
        lease = await self.get_lease(lease_id)
        if not lease:
            raise ValueError(f"Lease not found: {lease_id}")

        if lease.status != LeaseStatus.SUSPENDED:
            raise ValueError(f"Lease is not suspended: {lease.status}")

        # Check if it would still be valid
        if datetime.now(timezone.utc) > lease.expires_at:
            raise ValueError("Lease has expired and cannot be resumed")

        old_status = lease.status
        lease.status = LeaseStatus.ACTIVE

        await self.session.flush()

        await self._audit(
            lease_id=lease.id,
            action="resumed",
            actor=resumed_by,
            old_status=old_status,
            new_status=lease.status,
        )

        logger.info(f"Lease {lease_id} resumed")
        return lease

    # =========================================================================
    # Autonomy Checks
    # =========================================================================

    async def check_autonomy(
        self,
        request: AutonomyCheckRequest,
    ) -> AutonomyCheckResult:
        """
        Check if an agent has autonomy to perform an action.

        Returns detailed result including lease info and any denial reasons.
        """
        now = datetime.now(timezone.utc)

        # Get active lease for agent
        lease = await self.get_active_lease(request.agent_id)

        if not lease:
            return AutonomyCheckResult(
                allowed=False,
                denial_reason="No active lease found",
                checked_at=now,
            )

        # Check lease validity
        if not lease.is_valid:
            return AutonomyCheckResult(
                allowed=False,
                lease_id=lease.id,
                lease_status=LeaseStatus(lease.status.value),
                denial_reason="Lease is not valid",
                checked_at=now,
            )

        # Check rate limits
        if lease.max_actions_total and lease.actions_taken >= lease.max_actions_total:
            return AutonomyCheckResult(
                allowed=False,
                lease_id=lease.id,
                lease_status=LeaseStatus(lease.status.value),
                autonomy_level=lease.autonomy_level,
                denial_reason="Action limit exceeded",
                checked_at=now,
            )

        # Check denied actions
        if lease.denied_actions:
            for pattern in lease.denied_actions:
                if fnmatch.fnmatch(request.action, pattern):
                    return AutonomyCheckResult(
                        allowed=False,
                        lease_id=lease.id,
                        lease_status=LeaseStatus(lease.status.value),
                        autonomy_level=lease.autonomy_level,
                        denial_reason=f"Action denied by pattern: {pattern}",
                        checked_at=now,
                    )

        # Check denied resources
        if request.resource and lease.denied_resources:
            for pattern in lease.denied_resources:
                if fnmatch.fnmatch(request.resource, pattern):
                    return AutonomyCheckResult(
                        allowed=False,
                        lease_id=lease.id,
                        lease_status=LeaseStatus(lease.status.value),
                        autonomy_level=lease.autonomy_level,
                        denial_reason=f"Resource denied by pattern: {pattern}",
                        checked_at=now,
                    )

        # Check allowed actions
        if lease.allowed_actions:
            action_allowed = any(
                fnmatch.fnmatch(request.action, pattern)
                for pattern in lease.allowed_actions
            )
            if not action_allowed:
                return AutonomyCheckResult(
                    allowed=False,
                    lease_id=lease.id,
                    lease_status=LeaseStatus(lease.status.value),
                    autonomy_level=lease.autonomy_level,
                    denial_reason=f"Action not in allowed list",
                    checked_at=now,
                )

        # Check allowed resources
        if request.resource and lease.allowed_resources:
            resource_allowed = any(
                fnmatch.fnmatch(request.resource, pattern)
                for pattern in lease.allowed_resources
            )
            if not resource_allowed:
                return AutonomyCheckResult(
                    allowed=False,
                    lease_id=lease.id,
                    lease_status=LeaseStatus(lease.status.value),
                    autonomy_level=lease.autonomy_level,
                    denial_reason=f"Resource not in allowed list",
                    checked_at=now,
                )

        # Update activity
        lease.actions_taken += 1
        lease.last_activity_at = now
        lease.last_action = request.action
        await self.session.flush()

        # Calculate remaining
        remaining_actions = None
        if lease.max_actions_total:
            remaining_actions = lease.max_actions_total - lease.actions_taken

        return AutonomyCheckResult(
            allowed=True,
            lease_id=lease.id,
            lease_status=LeaseStatus(lease.status.value),
            autonomy_level=lease.autonomy_level,
            remaining_actions=remaining_actions,
            remaining_seconds=lease.remaining_seconds,
            checked_at=now,
        )

    # =========================================================================
    # Bulk Operations
    # =========================================================================

    async def revoke_all_for_agent(
        self,
        agent_id: UUID,
        reason: str,
        revoked_by: str,
    ) -> int:
        """Revoke all active leases for an agent."""
        now = datetime.now(timezone.utc)

        result = await self.session.execute(
            update(Lease)
            .where(
                Lease.agent_id == agent_id,
                Lease.status.in_([LeaseStatus.ACTIVE, LeaseStatus.PENDING, LeaseStatus.SUSPENDED]),
            )
            .values(
                status=LeaseStatus.REVOKED,
                revoked_at=now,
                revoked_by=revoked_by,
                revocation_reason=reason,
            )
            .returning(Lease.id)
        )

        revoked_ids = [row[0] for row in result.fetchall()]

        for lease_id in revoked_ids:
            await self._audit(
                lease_id=lease_id,
                action="bulk_revoked",
                actor=revoked_by,
                new_status=LeaseStatus.REVOKED,
                reason=reason,
            )

        logger.warning(f"Revoked {len(revoked_ids)} leases for agent {agent_id}")
        return len(revoked_ids)

    async def expire_leases(self) -> int:
        """
        Mark expired leases as EXPIRED.

        Should be called periodically by a background job.
        """
        now = datetime.now(timezone.utc)

        result = await self.session.execute(
            update(Lease)
            .where(
                Lease.status == LeaseStatus.ACTIVE,
                Lease.expires_at <= now,
            )
            .values(status=LeaseStatus.EXPIRED)
            .returning(Lease.id)
        )

        expired_ids = [row[0] for row in result.fetchall()]

        for lease_id in expired_ids:
            await self._audit(
                lease_id=lease_id,
                action="expired",
                actor="system",
                new_status=LeaseStatus.EXPIRED,
            )

        if expired_ids:
            logger.info(f"Expired {len(expired_ids)} leases")

        return len(expired_ids)

    # =========================================================================
    # Statistics
    # =========================================================================

    async def get_stats(self) -> Dict[str, Any]:
        """Get lease statistics."""
        now = datetime.now(timezone.utc)

        # Total by status
        status_counts = {}
        for status in LeaseStatus:
            result = await self.session.execute(
                select(func.count(Lease.id)).where(Lease.status == status)
            )
            status_counts[status.value] = result.scalar() or 0

        # Active leases by agent
        agent_result = await self.session.execute(
            select(Lease.agent_id, func.count(Lease.id))
            .where(Lease.status == LeaseStatus.ACTIVE)
            .group_by(Lease.agent_id)
        )
        by_agent = {str(row[0]): row[1] for row in agent_result.fetchall()}

        # By type
        type_result = await self.session.execute(
            select(Lease.lease_type, func.count(Lease.id))
            .group_by(Lease.lease_type)
        )
        by_type = {row[0].value: row[1] for row in type_result.fetchall()}

        # Averages
        avg_result = await self.session.execute(
            select(
                func.avg(Lease.ttl_seconds),
                func.avg(Lease.renewal_count),
            ).where(Lease.status == LeaseStatus.ACTIVE)
        )
        avg_row = avg_result.fetchone()

        return {
            "total_leases": sum(status_counts.values()),
            "active_leases": status_counts.get("active", 0),
            "pending_leases": status_counts.get("pending", 0),
            "expired_leases": status_counts.get("expired", 0),
            "revoked_leases": status_counts.get("revoked", 0),
            "leases_by_agent": by_agent,
            "leases_by_type": by_type,
            "average_ttl_seconds": float(avg_row[0] or 0),
            "average_renewal_count": float(avg_row[1] or 0),
            "timestamp": now.isoformat(),
        }

    # =========================================================================
    # Audit
    # =========================================================================

    async def _audit(
        self,
        lease_id: UUID,
        action: str,
        actor: str,
        old_status: Optional[LeaseStatus] = None,
        new_status: Optional[LeaseStatus] = None,
        details: Optional[Dict[str, Any]] = None,
        reason: Optional[str] = None,
    ) -> None:
        """Create an audit record for a lease action."""
        audit = LeaseAudit(
            id=uuid4(),
            lease_id=lease_id,
            action=action,
            actor=actor,
            old_status=old_status,
            new_status=new_status,
            details=details or {},
            reason=reason,
        )
        self.session.add(audit)
        await self.session.flush()


# Singleton
_lease_service: Optional[LeaseService] = None


def get_lease_service() -> LeaseService:
    """Get lease service singleton."""
    global _lease_service
    if _lease_service is None:
        from ...common.db.database import get_db
        db = get_db()
        _lease_service = LeaseService(db.get_session())
    return _lease_service
