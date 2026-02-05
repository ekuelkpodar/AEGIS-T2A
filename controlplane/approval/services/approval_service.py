"""
Approval Service

Core business logic for approval request management.
"""

import fnmatch
import logging
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, List, Optional, Tuple
from uuid import UUID, uuid4

from sqlalchemy import select, func, and_, or_, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.approval import (
    ApprovalRequest,
    ApprovalAudit,
    ApprovalStatus,
    ApprovalType,
    EscalationLevel,
    EscalationRule,
)
from ..models.schemas import (
    ApprovalRequestCreate,
    ApprovalDecision,
    EscalateRequest,
)
from ...common.config.settings import Settings, get_settings

logger = logging.getLogger(__name__)


class ApprovalService:
    """
    Service for managing approval requests.

    Provides:
    - Approval request creation and management
    - Decision processing
    - Escalation handling
    - Expiration management
    """

    def __init__(
        self,
        session: AsyncSession,
        settings: Optional[Settings] = None,
    ):
        self.session = session
        self.settings = settings or get_settings()

    async def create_request(
        self,
        data: ApprovalRequestCreate,
        requested_by: str,
    ) -> ApprovalRequest:
        """Create a new approval request."""
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(seconds=data.ttl_seconds)

        # Find applicable escalation rule
        escalation_rule = await self._find_escalation_rule(data)

        request = ApprovalRequest(
            id=uuid4(),
            title=data.title,
            description=data.description,
            approval_type=ApprovalType(data.approval_type.value),
            status=ApprovalStatus.PENDING,
            agent_id=data.agent_id,
            agent_name=data.agent_name,
            requested_by=requested_by,
            action=data.action,
            resource=data.resource,
            payload=data.payload,
            context=data.context,
            risk_level=data.risk_level,
            risk_factors=data.risk_factors,
            impact_scope=data.impact_scope,
            escalation_level=EscalationLevel.LEVEL_1.value,
            created_at=now,
            expires_at=expires_at,
            ttl_seconds=data.ttl_seconds,
            notification_channels=data.notification_channels or ["slack"],
            metadata=data.metadata,
            tags=data.tags,
        )

        # Apply escalation rule if found
        if escalation_rule:
            request.escalation_chain = escalation_rule.escalation_chain
            if escalation_rule.escalation_chain:
                request.current_approver = escalation_rule.escalation_chain[0]

        self.session.add(request)
        await self.session.flush()

        await self._audit(
            request_id=request.id,
            action="created",
            actor=requested_by,
            new_status=ApprovalStatus.PENDING,
        )

        logger.info(f"Approval request created: {request.id}")
        return request

    async def get_request(self, request_id: UUID) -> Optional[ApprovalRequest]:
        """Get approval request by ID."""
        result = await self.session.execute(
            select(ApprovalRequest).where(ApprovalRequest.id == request_id)
        )
        return result.scalar_one_or_none()

    async def list_requests(
        self,
        status: Optional[ApprovalStatus] = None,
        agent_id: Optional[UUID] = None,
        approval_type: Optional[ApprovalType] = None,
        approver: Optional[str] = None,
        offset: int = 0,
        limit: int = 100,
    ) -> Tuple[List[ApprovalRequest], int]:
        """List approval requests with filtering."""
        query = select(ApprovalRequest)
        count_query = select(func.count(ApprovalRequest.id))

        conditions = []
        if status:
            conditions.append(ApprovalRequest.status == status)
        if agent_id:
            conditions.append(ApprovalRequest.agent_id == agent_id)
        if approval_type:
            conditions.append(ApprovalRequest.approval_type == approval_type)
        if approver:
            conditions.append(ApprovalRequest.current_approver == approver)

        if conditions:
            query = query.where(and_(*conditions))
            count_query = count_query.where(and_(*conditions))

        total_result = await self.session.execute(count_query)
        total = total_result.scalar() or 0

        query = query.order_by(ApprovalRequest.created_at.desc()).offset(offset).limit(limit)
        result = await self.session.execute(query)
        requests = list(result.scalars().all())

        return requests, total

    async def decide(
        self,
        request_id: UUID,
        decision: ApprovalDecision,
        decided_by: str,
    ) -> ApprovalRequest:
        """Make a decision on an approval request."""
        request = await self.get_request(request_id)
        if not request:
            raise ValueError(f"Request not found: {request_id}")

        if request.status != ApprovalStatus.PENDING:
            raise ValueError(f"Request is not pending: {request.status}")

        if request.is_expired:
            raise ValueError("Request has expired")

        old_status = request.status
        now = datetime.now(timezone.utc)

        request.status = ApprovalStatus.APPROVED if decision.approved else ApprovalStatus.REJECTED
        request.decided_at = now
        request.decided_by = decided_by
        request.decision_notes = decision.notes
        request.conditions = decision.conditions or {}
        request.modified_payload = decision.modified_payload

        await self.session.flush()

        await self._audit(
            request_id=request.id,
            action="decided",
            actor=decided_by,
            old_status=old_status,
            new_status=request.status,
            details={"approved": decision.approved},
            notes=decision.notes,
        )

        logger.info(f"Request {request_id} {'approved' if decision.approved else 'rejected'} by {decided_by}")
        return request

    async def escalate(
        self,
        request_id: UUID,
        escalate_request: EscalateRequest,
        escalated_by: str,
    ) -> ApprovalRequest:
        """Escalate an approval request."""
        request = await self.get_request(request_id)
        if not request:
            raise ValueError(f"Request not found: {request_id}")

        if request.status != ApprovalStatus.PENDING:
            raise ValueError(f"Request is not pending: {request.status}")

        old_level = request.escalation_level
        request.escalation_level += 1

        # Update current approver
        if escalate_request.target_approver:
            request.current_approver = escalate_request.target_approver
        elif request.escalation_chain and request.escalation_level <= len(request.escalation_chain):
            request.current_approver = request.escalation_chain[request.escalation_level - 1]

        await self.session.flush()

        await self._audit(
            request_id=request.id,
            action="escalated",
            actor=escalated_by,
            details={
                "old_level": old_level,
                "new_level": request.escalation_level,
                "reason": escalate_request.reason,
            },
            notes=escalate_request.reason,
        )

        logger.info(f"Request {request_id} escalated to level {request.escalation_level}")
        return request

    async def cancel(
        self,
        request_id: UUID,
        reason: str,
        cancelled_by: str,
    ) -> ApprovalRequest:
        """Cancel an approval request."""
        request = await self.get_request(request_id)
        if not request:
            raise ValueError(f"Request not found: {request_id}")

        if request.status != ApprovalStatus.PENDING:
            raise ValueError(f"Request is not pending: {request.status}")

        old_status = request.status
        request.status = ApprovalStatus.CANCELLED
        request.decision_notes = reason

        await self.session.flush()

        await self._audit(
            request_id=request.id,
            action="cancelled",
            actor=cancelled_by,
            old_status=old_status,
            new_status=ApprovalStatus.CANCELLED,
            notes=reason,
        )

        logger.info(f"Request {request_id} cancelled by {cancelled_by}")
        return request

    async def expire_requests(self) -> int:
        """Mark expired requests as EXPIRED."""
        now = datetime.now(timezone.utc)

        result = await self.session.execute(
            update(ApprovalRequest)
            .where(
                ApprovalRequest.status == ApprovalStatus.PENDING,
                ApprovalRequest.expires_at <= now,
            )
            .values(status=ApprovalStatus.EXPIRED)
            .returning(ApprovalRequest.id)
        )

        expired_ids = [row[0] for row in result.fetchall()]

        for request_id in expired_ids:
            await self._audit(
                request_id=request_id,
                action="expired",
                actor="system",
                new_status=ApprovalStatus.EXPIRED,
            )

        if expired_ids:
            logger.info(f"Expired {len(expired_ids)} approval requests")

        return len(expired_ids)

    async def get_stats(self) -> Dict[str, Any]:
        """Get approval statistics."""
        # Total by status
        status_counts = {}
        for status in ApprovalStatus:
            result = await self.session.execute(
                select(func.count(ApprovalRequest.id)).where(ApprovalRequest.status == status)
            )
            status_counts[status.value] = result.scalar() or 0

        # By type
        type_result = await self.session.execute(
            select(ApprovalRequest.approval_type, func.count(ApprovalRequest.id))
            .group_by(ApprovalRequest.approval_type)
        )
        by_type = {row[0].value: row[1] for row in type_result.fetchall()}

        # By risk
        risk_result = await self.session.execute(
            select(ApprovalRequest.risk_level, func.count(ApprovalRequest.id))
            .where(ApprovalRequest.risk_level.isnot(None))
            .group_by(ApprovalRequest.risk_level)
        )
        by_risk = {row[0]: row[1] for row in risk_result.fetchall()}

        # By agent
        agent_result = await self.session.execute(
            select(ApprovalRequest.agent_id, func.count(ApprovalRequest.id))
            .group_by(ApprovalRequest.agent_id)
            .limit(10)
        )
        by_agent = {str(row[0]): row[1] for row in agent_result.fetchall()}

        # Average decision time
        avg_result = await self.session.execute(
            select(
                func.avg(
                    func.extract('epoch', ApprovalRequest.decided_at - ApprovalRequest.created_at)
                )
            ).where(ApprovalRequest.decided_at.isnot(None))
        )
        avg_time = avg_result.scalar() or 0

        return {
            "total_requests": sum(status_counts.values()),
            "pending_requests": status_counts.get("pending", 0),
            "approved_requests": status_counts.get("approved", 0),
            "rejected_requests": status_counts.get("rejected", 0),
            "expired_requests": status_counts.get("expired", 0),
            "auto_approved_requests": status_counts.get("auto_approved", 0),
            "average_decision_time_seconds": float(avg_time),
            "requests_by_type": by_type,
            "requests_by_risk": by_risk,
            "requests_by_agent": by_agent,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

    async def _find_escalation_rule(
        self,
        data: ApprovalRequestCreate,
    ) -> Optional[EscalationRule]:
        """Find the most applicable escalation rule."""
        result = await self.session.execute(
            select(EscalationRule)
            .where(EscalationRule.is_active == True)
            .order_by(EscalationRule.priority.desc())
        )
        rules = list(result.scalars().all())

        for rule in rules:
            # Check if rule matches
            if rule.approval_types and data.approval_type.value not in rule.approval_types:
                continue
            if rule.risk_levels and data.risk_level and data.risk_level not in rule.risk_levels:
                continue
            if rule.action_patterns and data.action:
                if not any(fnmatch.fnmatch(data.action, p) for p in rule.action_patterns):
                    continue
            if rule.resource_patterns and data.resource:
                if not any(fnmatch.fnmatch(data.resource, p) for p in rule.resource_patterns):
                    continue

            return rule

        return None

    async def _audit(
        self,
        request_id: UUID,
        action: str,
        actor: str,
        old_status: Optional[ApprovalStatus] = None,
        new_status: Optional[ApprovalStatus] = None,
        details: Optional[Dict[str, Any]] = None,
        notes: Optional[str] = None,
    ) -> None:
        """Create an audit record."""
        audit = ApprovalAudit(
            id=uuid4(),
            request_id=request_id,
            action=action,
            actor=actor,
            old_status=old_status,
            new_status=new_status,
            details=details or {},
            notes=notes,
        )
        self.session.add(audit)
        await self.session.flush()


_approval_service: Optional[ApprovalService] = None


def get_approval_service() -> ApprovalService:
    """Get approval service singleton."""
    global _approval_service
    if _approval_service is None:
        from ...common.db.database import get_db
        db = get_db()
        _approval_service = ApprovalService(db.get_session())
    return _approval_service
