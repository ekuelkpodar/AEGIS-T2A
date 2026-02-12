"""Automation platform API handlers."""

from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from ...common.auth.middleware import AgentIdentity, get_current_identity
from ..models.automation import DefinitionStatus, TaskStatus
from ..models.schemas import (
    AuditRecordResponse,
    AutomationDefinitionCreate,
    AutomationDefinitionResponse,
    AutomationDefinitionUpdate,
    AutomationTaskCreate,
    AutomationTaskListResponse,
    AutomationTaskResponse,
    IntegrationConnectorCreate,
    IntegrationConnectorResponse,
    NLPInterpretRequest,
    NLPInterpretResponse,
    QueueProcessRequest,
    ServiceStatsResponse,
    TaskReviewDecision,
    TaskTriggerRequest,
)
from ..services.automation_service import AutomationService, get_automation_service

router = APIRouter(prefix="/automation", tags=["automation"])


def _roles(service: AutomationService, identity: AgentIdentity):
    return list(service.rbac.audit_roles(identity))


@router.post("/integrations", response_model=IntegrationConnectorResponse, status_code=201)
async def create_connector(
    payload: IntegrationConnectorCreate,
    identity: AgentIdentity = Depends(get_current_identity),
    service: AutomationService = Depends(get_automation_service),
):
    service.rbac.enforce(identity, "automation:integrations:write")
    try:
        return await service.create_connector(payload, actor=identity.agent_id, actor_roles=_roles(service, identity))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/integrations", response_model=list[IntegrationConnectorResponse])
async def list_connectors(
    active_only: bool = Query(True),
    identity: AgentIdentity = Depends(get_current_identity),
    service: AutomationService = Depends(get_automation_service),
):
    service.rbac.enforce(identity, "automation:integrations:read")
    return await service.list_connectors(active_only=active_only)


@router.post("/definitions", response_model=AutomationDefinitionResponse, status_code=201)
async def create_definition(
    payload: AutomationDefinitionCreate,
    identity: AgentIdentity = Depends(get_current_identity),
    service: AutomationService = Depends(get_automation_service),
):
    service.rbac.enforce(identity, "automation:definitions:write")
    try:
        return await service.create_definition(payload, actor=identity.agent_id, actor_roles=_roles(service, identity))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/definitions", response_model=list[AutomationDefinitionResponse])
async def list_definitions(
    industry_domain: Optional[str] = Query(None),
    status: Optional[DefinitionStatus] = Query(None),
    identity: AgentIdentity = Depends(get_current_identity),
    service: AutomationService = Depends(get_automation_service),
):
    service.rbac.enforce(identity, "automation:definitions:read")
    return await service.list_definitions(industry_domain=industry_domain, status=status)


@router.patch("/definitions/{definition_id}", response_model=AutomationDefinitionResponse)
async def update_definition(
    definition_id: UUID,
    payload: AutomationDefinitionUpdate,
    identity: AgentIdentity = Depends(get_current_identity),
    service: AutomationService = Depends(get_automation_service),
):
    service.rbac.enforce(identity, "automation:definitions:write")
    try:
        return await service.update_definition(
            definition_id=definition_id,
            updates=payload,
            actor=identity.agent_id,
            actor_roles=_roles(service, identity),
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/interpret", response_model=NLPInterpretResponse)
async def interpret_prompt(
    payload: NLPInterpretRequest,
    identity: AgentIdentity = Depends(get_current_identity),
    service: AutomationService = Depends(get_automation_service),
):
    service.rbac.enforce(identity, "automation:tasks:write")
    return await service.interpret_prompt(prompt=payload.prompt, industry_hint=payload.industry_hint)


@router.post("/tasks", response_model=AutomationTaskResponse, status_code=201)
async def queue_task(
    payload: AutomationTaskCreate,
    identity: AgentIdentity = Depends(get_current_identity),
    service: AutomationService = Depends(get_automation_service),
):
    service.rbac.enforce(identity, "automation:tasks:write")
    try:
        return await service.queue_task(payload, actor=identity.agent_id, actor_roles=_roles(service, identity))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/tasks", response_model=AutomationTaskListResponse)
async def list_tasks(
    status: Optional[TaskStatus] = Query(None),
    definition_id: Optional[UUID] = Query(None),
    correlation_id: Optional[str] = Query(None),
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    identity: AgentIdentity = Depends(get_current_identity),
    service: AutomationService = Depends(get_automation_service),
):
    service.rbac.enforce(identity, "automation:tasks:read")
    tasks, total = await service.list_tasks(
        status=status,
        definition_id=definition_id,
        correlation_id=correlation_id,
        offset=offset,
        limit=limit,
    )
    return AutomationTaskListResponse(tasks=tasks, total=total, offset=offset, limit=limit)


@router.get("/tasks/{task_id}", response_model=AutomationTaskResponse)
async def get_task(
    task_id: UUID,
    identity: AgentIdentity = Depends(get_current_identity),
    service: AutomationService = Depends(get_automation_service),
):
    service.rbac.enforce(identity, "automation:tasks:read")
    task = await service.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.post("/tasks/{task_id}/approve", response_model=AutomationTaskResponse)
async def approve_task(
    task_id: UUID,
    decision: TaskReviewDecision,
    identity: AgentIdentity = Depends(get_current_identity),
    service: AutomationService = Depends(get_automation_service),
):
    service.rbac.enforce(identity, "automation:tasks:review")
    try:
        return await service.approve_task(
            task_id=task_id,
            actor=identity.agent_id,
            actor_roles=_roles(service, identity),
            notes=decision.notes,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/tasks/{task_id}/reject", response_model=AutomationTaskResponse)
async def reject_task(
    task_id: UUID,
    decision: TaskReviewDecision,
    identity: AgentIdentity = Depends(get_current_identity),
    service: AutomationService = Depends(get_automation_service),
):
    service.rbac.enforce(identity, "automation:tasks:review")
    try:
        return await service.reject_task(
            task_id=task_id,
            actor=identity.agent_id,
            actor_roles=_roles(service, identity),
            notes=decision.notes,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/tasks/{task_id}/trigger", response_model=AutomationTaskResponse)
async def trigger_task(
    task_id: UUID,
    payload: TaskTriggerRequest,
    identity: AgentIdentity = Depends(get_current_identity),
    service: AutomationService = Depends(get_automation_service),
):
    service.rbac.enforce(identity, "automation:tasks:trigger")
    try:
        return await service.trigger_task(
            task_id=task_id,
            actor=identity.agent_id,
            actor_roles=_roles(service, identity),
            scheduled_at=payload.scheduled_at,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/tasks/process")
async def process_queue(
    payload: QueueProcessRequest,
    identity: AgentIdentity = Depends(get_current_identity),
    service: AutomationService = Depends(get_automation_service),
):
    service.rbac.enforce(identity, "automation:tasks:execute")
    result = await service.process_due_tasks(worker_id=identity.agent_id, batch_size=payload.batch_size)
    return {
        "processed": result["processed"],
        "succeeded": result["succeeded"],
        "failed": result["failed"],
        "retried": result["retried"],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/audit", response_model=list[AuditRecordResponse])
async def list_audit_logs(
    entity_type: Optional[str] = Query(None),
    entity_id: Optional[str] = Query(None),
    actor: Optional[str] = Query(None),
    correlation_id: Optional[str] = Query(None),
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    identity: AgentIdentity = Depends(get_current_identity),
    service: AutomationService = Depends(get_automation_service),
):
    service.rbac.enforce(identity, "automation:audit:read")
    records, _ = await service.audit.list_records(
        entity_type=entity_type,
        entity_id=entity_id,
        actor=actor,
        correlation_id=correlation_id,
        offset=offset,
        limit=limit,
    )
    return [
        AuditRecordResponse(
            id=item.id,
            entity_type=item.entity_type,
            entity_id=item.entity_id,
            action=item.action,
            actor=item.actor,
            actor_roles=item.actor_roles,
            before_state=item.before_state,
            after_state=item.after_state,
            context=item.context,
            compliance_tags=item.compliance_tags,
            correlation_id=item.correlation_id,
            prev_hash=item.prev_hash,
            event_hash=item.event_hash,
            ip_address=item.ip_address,
            user_agent=item.user_agent,
            created_at=item.created_at,
        )
        for item in records
    ]


@router.get("/stats", response_model=ServiceStatsResponse)
async def get_stats(
    identity: AgentIdentity = Depends(get_current_identity),
    service: AutomationService = Depends(get_automation_service),
):
    service.rbac.enforce(identity, "automation:tasks:read")
    return await service.service_stats()
