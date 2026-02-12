"""Tamper-evident audit logging service."""

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy import and_, desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.automation import AutomationAuditLog
from .compliance_service import ComplianceService

GENESIS_HASH = "0" * 64


class AuditService:
    """Appends hash-linked audit records for every automation action."""

    def __init__(self, session: AsyncSession, compliance: ComplianceService):
        self.session = session
        self.compliance = compliance

    async def _last_hash(self) -> str:
        result = await self.session.execute(
            select(AutomationAuditLog.event_hash).order_by(desc(AutomationAuditLog.created_at)).limit(1)
        )
        return result.scalar_one_or_none() or GENESIS_HASH

    @staticmethod
    def _compute_hash(payload: Dict[str, Any]) -> str:
        canonical = json.dumps(payload, sort_keys=True, default=str, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    async def log(
        self,
        entity_type: str,
        entity_id: str,
        action: str,
        actor: str,
        actor_roles: Iterable[str],
        before_state: Optional[Dict[str, Any]] = None,
        after_state: Optional[Dict[str, Any]] = None,
        context: Optional[Dict[str, Any]] = None,
        compliance_tags: Optional[List[str]] = None,
        correlation_id: Optional[str] = None,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
    ) -> AutomationAuditLog:
        prev_hash = await self._last_hash()

        before_redacted = self.compliance.redact(before_state or {})
        after_redacted = self.compliance.redact(after_state or {})

        now = datetime.now(timezone.utc)
        hash_payload = {
            "timestamp": now.isoformat(),
            "entity_type": entity_type,
            "entity_id": entity_id,
            "action": action,
            "actor": actor,
            "before": before_redacted,
            "after": after_redacted,
            "context": context or {},
            "prev_hash": prev_hash,
        }
        event_hash = self._compute_hash(hash_payload)

        record = AutomationAuditLog(
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            actor=actor,
            actor_roles=list(actor_roles),
            before_state=before_redacted,
            after_state=after_redacted,
            context=context or {},
            compliance_tags=compliance_tags or [],
            correlation_id=correlation_id,
            prev_hash=prev_hash,
            event_hash=event_hash,
            ip_address=ip_address,
            user_agent=user_agent,
            created_at=now,
        )

        self.session.add(record)
        await self.session.flush()
        return record

    async def list_records(
        self,
        entity_type: Optional[str] = None,
        entity_id: Optional[str] = None,
        actor: Optional[str] = None,
        correlation_id: Optional[str] = None,
        offset: int = 0,
        limit: int = 100,
    ) -> Tuple[List[AutomationAuditLog], int]:
        query = select(AutomationAuditLog)
        count_query = select(func.count(AutomationAuditLog.id))

        conditions = []
        if entity_type:
            conditions.append(AutomationAuditLog.entity_type == entity_type)
        if entity_id:
            conditions.append(AutomationAuditLog.entity_id == entity_id)
        if actor:
            conditions.append(AutomationAuditLog.actor == actor)
        if correlation_id:
            conditions.append(AutomationAuditLog.correlation_id == correlation_id)

        if conditions:
            query = query.where(and_(*conditions))
            count_query = count_query.where(and_(*conditions))

        total_result = await self.session.execute(count_query)
        total = total_result.scalar() or 0

        result = await self.session.execute(
            query.order_by(desc(AutomationAuditLog.created_at)).offset(offset).limit(limit)
        )
        return list(result.scalars().all()), total
