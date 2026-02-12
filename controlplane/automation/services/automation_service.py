"""Core automation orchestration service."""

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from fastapi import Depends
from sqlalchemy import and_, asc, desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...common.config.settings import Settings, get_settings
from ...common.db.database import get_session
from ..models.automation import (
    AutomationDefinition,
    AutomationTask,
    DefinitionStatus,
    IntegrationConnector,
    RiskLevel,
    TaskStatus,
)
from ..models.schemas import (
    AutomationDefinitionCreate,
    AutomationDefinitionUpdate,
    AutomationTaskCreate,
    ComplianceContext,
    IntegrationConnectorCreate,
    NLPInterpretResponse,
)
from .ai_service import AIService
from .audit_service import AuditService
from .compliance_service import ComplianceService
from .integration_service import IntegrationExecutionError, IntegrationService
from .rbac_service import RBACService


class AutomationService:
    """Manages definitions, queueing, execution, and auditing."""

    def __init__(self, session: AsyncSession, settings: Optional[Settings] = None):
        self.session = session
        self.settings = settings or get_settings()

        self.rbac = RBACService()
        self.compliance = ComplianceService()
        self.ai = AIService()
        self.integration = IntegrationService()
        self.audit = AuditService(session=session, compliance=self.compliance)

    @staticmethod
    def _risk_rank(level: RiskLevel) -> int:
        ranks = {
            RiskLevel.LOW: 1,
            RiskLevel.MEDIUM: 2,
            RiskLevel.HIGH: 3,
            RiskLevel.CRITICAL: 4,
        }
        return ranks[level]

    @classmethod
    def _max_risk(cls, *levels: RiskLevel) -> RiskLevel:
        return max(levels, key=cls._risk_rank)

    # ------------------------------------------------------------------
    # Connectors
    # ------------------------------------------------------------------

    async def create_connector(self, data: IntegrationConnectorCreate, actor: str, actor_roles: List[str]) -> IntegrationConnector:
        connector = IntegrationConnector(
            name=data.name,
            integration_type=data.integration_type,
            base_url=data.base_url,
            auth_type=data.auth_type,
            auth_config=data.auth_config,
            secret_ref=data.secret_ref,
            verify_tls=data.verify_tls,
            timeout_seconds=data.timeout_seconds,
            allowed_hosts=data.allowed_hosts,
            extra_config=data.extra_config,
            is_active=True,
            created_by=actor,
        )
        self.session.add(connector)
        await self.session.flush()

        await self.audit.log(
            entity_type="connector",
            entity_id=str(connector.id),
            action="connector.created",
            actor=actor,
            actor_roles=actor_roles,
            after_state={
                "name": connector.name,
                "integration_type": connector.integration_type.value,
                "base_url": connector.base_url,
                "auth_type": connector.auth_type.value,
                "allowed_hosts": connector.allowed_hosts,
            },
        )
        return connector

    async def list_connectors(self, active_only: bool = True) -> List[IntegrationConnector]:
        query = select(IntegrationConnector)
        if active_only:
            query = query.where(IntegrationConnector.is_active.is_(True))

        result = await self.session.execute(query.order_by(IntegrationConnector.created_at.desc()))
        return list(result.scalars().all())

    # ------------------------------------------------------------------
    # Definitions
    # ------------------------------------------------------------------

    async def create_definition(
        self,
        data: AutomationDefinitionCreate,
        actor: str,
        actor_roles: List[str],
    ) -> AutomationDefinition:
        if data.integration_id:
            connector = await self.get_connector(data.integration_id)
            if connector is None:
                raise ValueError(f"Connector not found: {data.integration_id}")

        definition = AutomationDefinition(
            name=data.name,
            industry_domain=data.industry_domain,
            description=data.description,
            action_type=data.action_type,
            trigger_mode=data.trigger_mode,
            integration_id=data.integration_id,
            action_config=data.action_config,
            input_schema=data.input_schema,
            compliance_tags=data.compliance_tags,
            default_risk_level=data.default_risk_level,
            requires_human_review=data.requires_human_review,
            max_retries=data.max_retries,
            created_by=actor,
            updated_by=actor,
            extra_metadata=data.extra_metadata,
            status=DefinitionStatus.ACTIVE,
        )

        self.session.add(definition)
        await self.session.flush()

        await self.audit.log(
            entity_type="definition",
            entity_id=str(definition.id),
            action="definition.created",
            actor=actor,
            actor_roles=actor_roles,
            after_state={
                "name": definition.name,
                "industry_domain": definition.industry_domain,
                "action_type": definition.action_type,
                "status": definition.status.value,
            },
            compliance_tags=definition.compliance_tags,
        )
        return definition

    async def list_definitions(
        self,
        industry_domain: Optional[str] = None,
        status: Optional[DefinitionStatus] = None,
    ) -> List[AutomationDefinition]:
        query = select(AutomationDefinition)
        conditions = []

        if industry_domain:
            conditions.append(AutomationDefinition.industry_domain == industry_domain)
        if status:
            conditions.append(AutomationDefinition.status == status)

        if conditions:
            query = query.where(and_(*conditions))

        result = await self.session.execute(query.order_by(AutomationDefinition.created_at.desc()))
        return list(result.scalars().all())

    async def get_definition(self, definition_id: UUID) -> Optional[AutomationDefinition]:
        result = await self.session.execute(
            select(AutomationDefinition).where(AutomationDefinition.id == definition_id)
        )
        return result.scalar_one_or_none()

    async def update_definition(
        self,
        definition_id: UUID,
        updates: AutomationDefinitionUpdate,
        actor: str,
        actor_roles: List[str],
    ) -> AutomationDefinition:
        definition = await self.get_definition(definition_id)
        if definition is None:
            raise ValueError("Definition not found")

        before_state = {
            "description": definition.description,
            "trigger_mode": definition.trigger_mode,
            "status": definition.status.value,
            "requires_human_review": definition.requires_human_review,
            "max_retries": definition.max_retries,
            "version": definition.version,
        }

        payload = updates.model_dump(exclude_unset=True)

        for field, value in payload.items():
            setattr(definition, field, value)

        definition.updated_by = actor
        definition.version += 1

        await self.session.flush()

        await self.audit.log(
            entity_type="definition",
            entity_id=str(definition.id),
            action="definition.updated",
            actor=actor,
            actor_roles=actor_roles,
            before_state=before_state,
            after_state={
                "description": definition.description,
                "trigger_mode": definition.trigger_mode,
                "status": definition.status.value,
                "requires_human_review": definition.requires_human_review,
                "max_retries": definition.max_retries,
                "version": definition.version,
            },
            compliance_tags=definition.compliance_tags,
        )

        return definition

    # ------------------------------------------------------------------
    # AI Interpretation
    # ------------------------------------------------------------------

    async def interpret_prompt(self, prompt: str, industry_hint: Optional[str] = None) -> NLPInterpretResponse:
        interpretation = await self.ai.interpret_task(prompt=prompt, industry_hint=industry_hint)
        return NLPInterpretResponse(
            action_type=interpretation.action_type,
            normalized_payload=interpretation.normalized_payload,
            risk_level=interpretation.risk_level,
            confidence=interpretation.confidence,
            requires_human_review=interpretation.requires_human_review,
            review_reasons=interpretation.review_reasons,
            compliance_frameworks=interpretation.compliance_frameworks,
        )

    # ------------------------------------------------------------------
    # Tasks
    # ------------------------------------------------------------------

    async def queue_task(
        self,
        data: AutomationTaskCreate,
        actor: str,
        actor_roles: List[str],
    ) -> AutomationTask:
        if data.idempotency_key:
            existing = await self._get_task_by_idempotency_key(data.idempotency_key)
            if existing:
                return existing

        definition = await self.get_definition(data.definition_id)
        if definition is None:
            raise ValueError(f"Definition not found: {data.definition_id}")
        if definition.status != DefinitionStatus.ACTIVE:
            raise ValueError("Definition is not active")

        ai_confidence: Optional[float] = None
        ai_summary: Dict[str, Any] = {}
        review_reasons: List[str] = []

        risk_level = data.risk_level or definition.default_risk_level
        normalized_payload = dict(data.payload)
        inferred_frameworks: List[str] = []

        if data.natural_language_prompt:
            interpretation = await self.ai.interpret_task(
                prompt=data.natural_language_prompt,
                industry_hint=definition.industry_domain,
            )
            normalized_payload = {**interpretation.normalized_payload, **normalized_payload}
            ai_confidence = interpretation.confidence
            ai_summary = {
                "action_type": interpretation.action_type,
                "confidence": interpretation.confidence,
                "review_reasons": interpretation.review_reasons,
            }
            risk_level = self._max_risk(risk_level, interpretation.risk_level)
            inferred_frameworks.extend(interpretation.compliance_frameworks)
            review_reasons.extend(interpretation.review_reasons)

        frameworks = list(
            {
                *[tag.lower() for tag in definition.compliance_tags],
                *[tag.lower() for tag in data.compliance.frameworks],
                *[tag.lower() for tag in inferred_frameworks],
            }
        )

        compliance = self.compliance.evaluate(
            payload=normalized_payload,
            frameworks=frameworks,
            contains_personal_data=data.compliance.contains_personal_data,
            contains_phi=data.compliance.contains_phi,
            lawful_basis=data.compliance.lawful_basis,
            retention_days=data.compliance.retention_days,
            risk_level=risk_level,
            ai_confidence=ai_confidence,
            definition_requires_review=definition.requires_human_review,
        )

        if not compliance.valid:
            raise ValueError("; ".join(compliance.violations))

        all_review_reasons = list({*review_reasons, *compliance.review_reasons})
        requires_human_review = compliance.requires_human_review

        status = TaskStatus.WAITING_REVIEW if requires_human_review else TaskStatus.QUEUED

        task = AutomationTask(
            definition_id=definition.id,
            status=status,
            priority=int(data.priority.value),
            requested_by=actor,
            payload=data.payload,
            normalized_payload=normalized_payload,
            risk_level=risk_level,
            ai_confidence=ai_confidence,
            ai_summary=ai_summary,
            requires_human_review=requires_human_review,
            review_reason="; ".join(all_review_reasons) if all_review_reasons else None,
            compliance_context=self._build_compliance_context(data.compliance, frameworks),
            scheduled_at=data.scheduled_at or datetime.now(timezone.utc),
            max_attempts=max(1, definition.max_retries + 1),
            idempotency_key=data.idempotency_key,
            correlation_id=data.correlation_id,
        )

        self.session.add(task)
        await self.session.flush()

        await self.audit.log(
            entity_type="task",
            entity_id=str(task.id),
            action="task.queued",
            actor=actor,
            actor_roles=actor_roles,
            after_state={
                "definition_id": str(task.definition_id),
                "status": task.status.value,
                "risk_level": task.risk_level.value,
                "requires_human_review": task.requires_human_review,
                "scheduled_at": task.scheduled_at.isoformat(),
            },
            compliance_tags=frameworks,
            correlation_id=task.correlation_id,
        )

        return task

    async def get_task(self, task_id: UUID) -> Optional[AutomationTask]:
        result = await self.session.execute(select(AutomationTask).where(AutomationTask.id == task_id))
        return result.scalar_one_or_none()

    async def list_tasks(
        self,
        status: Optional[TaskStatus] = None,
        definition_id: Optional[UUID] = None,
        correlation_id: Optional[str] = None,
        offset: int = 0,
        limit: int = 100,
    ) -> Tuple[List[AutomationTask], int]:
        query = select(AutomationTask)
        count_query = select(func.count(AutomationTask.id))

        conditions = []
        if status:
            conditions.append(AutomationTask.status == status)
        if definition_id:
            conditions.append(AutomationTask.definition_id == definition_id)
        if correlation_id:
            conditions.append(AutomationTask.correlation_id == correlation_id)

        if conditions:
            query = query.where(and_(*conditions))
            count_query = count_query.where(and_(*conditions))

        total_result = await self.session.execute(count_query)
        total = total_result.scalar() or 0

        result = await self.session.execute(
            query.order_by(desc(AutomationTask.created_at)).offset(offset).limit(limit)
        )
        return list(result.scalars().all()), total

    async def approve_task(self, task_id: UUID, actor: str, actor_roles: List[str], notes: Optional[str]) -> AutomationTask:
        task = await self.get_task(task_id)
        if task is None:
            raise ValueError("Task not found")
        if task.status != TaskStatus.WAITING_REVIEW:
            raise ValueError(f"Task is not awaiting review: {task.status.value}")

        before_status = task.status.value
        task.status = TaskStatus.QUEUED
        task.approved_by = actor
        task.approved_at = datetime.now(timezone.utc)
        if notes:
            task.review_reason = f"{task.review_reason or ''} | approval_notes: {notes}".strip(" |")

        await self.session.flush()

        await self.audit.log(
            entity_type="task",
            entity_id=str(task.id),
            action="task.approved",
            actor=actor,
            actor_roles=actor_roles,
            before_state={"status": before_status},
            after_state={"status": task.status.value},
            context={"notes": notes} if notes else {},
            compliance_tags=task.compliance_context.get("frameworks", []),
            correlation_id=task.correlation_id,
        )
        return task

    async def reject_task(self, task_id: UUID, actor: str, actor_roles: List[str], notes: Optional[str]) -> AutomationTask:
        task = await self.get_task(task_id)
        if task is None:
            raise ValueError("Task not found")
        if task.status != TaskStatus.WAITING_REVIEW:
            raise ValueError(f"Task is not awaiting review: {task.status.value}")

        before_status = task.status.value
        task.status = TaskStatus.REJECTED
        task.rejected_by = actor
        task.rejected_at = datetime.now(timezone.utc)
        task.error_message = notes or "Rejected during human review"

        await self.session.flush()

        await self.audit.log(
            entity_type="task",
            entity_id=str(task.id),
            action="task.rejected",
            actor=actor,
            actor_roles=actor_roles,
            before_state={"status": before_status},
            after_state={"status": task.status.value, "error": task.error_message},
            compliance_tags=task.compliance_context.get("frameworks", []),
            correlation_id=task.correlation_id,
        )
        return task

    async def trigger_task(
        self,
        task_id: UUID,
        actor: str,
        actor_roles: List[str],
        scheduled_at: Optional[datetime],
    ) -> AutomationTask:
        task = await self.get_task(task_id)
        if task is None:
            raise ValueError("Task not found")
        if task.status in {TaskStatus.REJECTED, TaskStatus.CANCELLED, TaskStatus.SUCCEEDED}:
            raise ValueError(f"Task cannot be triggered from status {task.status.value}")

        before_status = task.status.value
        task.status = TaskStatus.QUEUED
        task.scheduled_at = scheduled_at or datetime.now(timezone.utc)

        await self.session.flush()

        await self.audit.log(
            entity_type="task",
            entity_id=str(task.id),
            action="task.triggered",
            actor=actor,
            actor_roles=actor_roles,
            before_state={"status": before_status},
            after_state={"status": task.status.value, "scheduled_at": task.scheduled_at.isoformat()},
            compliance_tags=task.compliance_context.get("frameworks", []),
            correlation_id=task.correlation_id,
        )
        return task

    async def process_due_tasks(self, worker_id: str, batch_size: int = 20) -> Dict[str, int]:
        now = datetime.now(timezone.utc)

        result = await self.session.execute(
            select(AutomationTask)
            .where(
                AutomationTask.status == TaskStatus.QUEUED,
                AutomationTask.scheduled_at <= now,
            )
            .order_by(desc(AutomationTask.priority), asc(AutomationTask.scheduled_at))
            .limit(batch_size)
            .with_for_update(skip_locked=True)
        )
        tasks = list(result.scalars().all())

        stats = {"processed": 0, "succeeded": 0, "failed": 0, "retried": 0}

        for task in tasks:
            outcome = await self._execute_task(task=task, worker_id=worker_id)
            stats["processed"] += 1
            if outcome == "succeeded":
                stats["succeeded"] += 1
            elif outcome == "failed":
                stats["failed"] += 1
            elif outcome == "retried":
                stats["retried"] += 1

        return stats

    async def _execute_task(self, task: AutomationTask, worker_id: str) -> str:
        task.status = TaskStatus.RUNNING
        task.started_at = datetime.now(timezone.utc)
        task.attempt_count += 1

        await self.session.flush()

        await self.audit.log(
            entity_type="task",
            entity_id=str(task.id),
            action="task.execution_started",
            actor=worker_id,
            actor_roles=["system"],
            after_state={
                "status": task.status.value,
                "attempt_count": task.attempt_count,
            },
            compliance_tags=task.compliance_context.get("frameworks", []),
            correlation_id=task.correlation_id,
        )

        definition = await self.get_definition(task.definition_id)
        if definition is None or definition.status != DefinitionStatus.ACTIVE:
            return await self._mark_task_failed(
                task,
                worker_id,
                "Definition missing or disabled",
                retriable=False,
            )

        if definition.integration_id is None:
            task.status = TaskStatus.SUCCEEDED
            task.completed_at = datetime.now(timezone.utc)
            task.result_payload = {
                "status": "validated",
                "message": "Task completed without external connector",
            }
            await self.session.flush()

            await self.audit.log(
                entity_type="task",
                entity_id=str(task.id),
                action="task.succeeded",
                actor=worker_id,
                actor_roles=["system"],
                after_state={"status": task.status.value},
                compliance_tags=task.compliance_context.get("frameworks", []),
                correlation_id=task.correlation_id,
            )
            return "succeeded"

        connector = await self.get_connector(definition.integration_id)
        if connector is None:
            return await self._mark_task_failed(task, worker_id, "Connector not found", retriable=False)

        try:
            result = await self.integration.execute(
                connector=connector,
                operation=definition.action_config,
                payload=task.normalized_payload or task.payload,
            )

            task.status = TaskStatus.SUCCEEDED
            task.result_payload = result
            task.completed_at = datetime.now(timezone.utc)
            task.error_message = None

            await self.session.flush()

            await self.audit.log(
                entity_type="task",
                entity_id=str(task.id),
                action="task.succeeded",
                actor=worker_id,
                actor_roles=["system"],
                after_state={
                    "status": task.status.value,
                    "result_status": result.get("status_code") or result.get("status"),
                },
                compliance_tags=task.compliance_context.get("frameworks", []),
                correlation_id=task.correlation_id,
            )
            return "succeeded"

        except IntegrationExecutionError as exc:
            return await self._mark_task_failed(task, worker_id, str(exc), retriable=True)
        except Exception as exc:
            return await self._mark_task_failed(task, worker_id, f"Unexpected execution error: {exc}", retriable=True)

    async def _mark_task_failed(self, task: AutomationTask, worker_id: str, error_message: str, retriable: bool) -> str:
        retry_allowed = retriable and task.attempt_count < task.max_attempts

        if retry_allowed:
            backoff_seconds = min(300, 2 ** max(1, task.attempt_count))
            task.status = TaskStatus.QUEUED
            task.scheduled_at = datetime.now(timezone.utc) + timedelta(seconds=backoff_seconds)
            task.error_message = error_message[:2000]
            outcome = "retried"
        else:
            task.status = TaskStatus.FAILED
            task.completed_at = datetime.now(timezone.utc)
            task.error_message = error_message[:2000]
            outcome = "failed"

        await self.session.flush()

        await self.audit.log(
            entity_type="task",
            entity_id=str(task.id),
            action="task.failed" if outcome == "failed" else "task.retry_scheduled",
            actor=worker_id,
            actor_roles=["system"],
            after_state={
                "status": task.status.value,
                "attempt_count": task.attempt_count,
                "error": task.error_message,
                "next_scheduled_at": task.scheduled_at.isoformat() if task.status == TaskStatus.QUEUED else None,
            },
            compliance_tags=task.compliance_context.get("frameworks", []),
            correlation_id=task.correlation_id,
        )
        return outcome

    async def _get_task_by_idempotency_key(self, idempotency_key: str) -> Optional[AutomationTask]:
        result = await self.session.execute(
            select(AutomationTask).where(AutomationTask.idempotency_key == idempotency_key)
        )
        return result.scalar_one_or_none()

    async def get_connector(self, connector_id: UUID) -> Optional[IntegrationConnector]:
        result = await self.session.execute(
            select(IntegrationConnector).where(IntegrationConnector.id == connector_id)
        )
        return result.scalar_one_or_none()

    @staticmethod
    def _build_compliance_context(context: ComplianceContext, frameworks: List[str]) -> Dict[str, Any]:
        return {
            "frameworks": frameworks,
            "contains_personal_data": context.contains_personal_data,
            "contains_phi": context.contains_phi,
            "lawful_basis": context.lawful_basis,
            "retention_days": context.retention_days,
        }

    # ------------------------------------------------------------------
    # Observability / stats
    # ------------------------------------------------------------------

    async def queue_metrics(self) -> Dict[str, int]:
        counts: Dict[str, int] = {}
        for status in [
            TaskStatus.QUEUED,
            TaskStatus.WAITING_REVIEW,
            TaskStatus.RUNNING,
            TaskStatus.FAILED,
            TaskStatus.SUCCEEDED,
        ]:
            result = await self.session.execute(
                select(func.count(AutomationTask.id)).where(AutomationTask.status == status)
            )
            counts[status.value] = result.scalar() or 0

        return {
            "queued": counts.get(TaskStatus.QUEUED.value, 0),
            "waiting_review": counts.get(TaskStatus.WAITING_REVIEW.value, 0),
            "running": counts.get(TaskStatus.RUNNING.value, 0),
            "failed": counts.get(TaskStatus.FAILED.value, 0),
            "succeeded": counts.get(TaskStatus.SUCCEEDED.value, 0),
        }

    async def service_stats(self) -> Dict[str, Any]:
        queue = await self.queue_metrics()

        definitions_result = await self.session.execute(select(func.count(AutomationDefinition.id)))
        connectors_result = await self.session.execute(select(func.count(IntegrationConnector.id)))

        return {
            "queue": queue,
            "definitions": definitions_result.scalar() or 0,
            "connectors": connectors_result.scalar() or 0,
            "timestamp": datetime.now(timezone.utc),
        }


async def get_automation_service(session: AsyncSession = Depends(get_session)) -> AutomationService:
    return AutomationService(session=session)
