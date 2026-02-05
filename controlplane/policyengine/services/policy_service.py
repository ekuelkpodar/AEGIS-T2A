"""
Policy Service

Core business logic for policy management and evaluation.
"""

import fnmatch
import logging
import time
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Tuple
from uuid import UUID, uuid4

from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.policy import Policy, PolicyVersion, PolicyStatus, PolicyType
from ..models.schemas import (
    PolicyCreate,
    PolicyUpdate,
    PolicyEvaluationRequest,
    PolicyEvaluationResult,
    PolicyDecision,
    PolicyMatch,
)
from .opa_client import OPAClient, OPAError, get_opa_client
from ...common.config.settings import Settings, get_settings
from ...eventstore.services.event_service import log_event

logger = logging.getLogger(__name__)


class PolicyService:
    """
    Service for managing policies and performing evaluations.

    Provides:
    - Policy CRUD operations
    - Policy versioning
    - Policy evaluation via OPA
    - Policy synchronization with OPA
    """

    def __init__(
        self,
        session: AsyncSession,
        opa_client: Optional[OPAClient] = None,
        settings: Optional[Settings] = None,
    ):
        self.session = session
        self.opa = opa_client or get_opa_client()
        self.settings = settings or get_settings()

    # =========================================================================
    # Policy CRUD
    # =========================================================================

    async def create_policy(
        self,
        data: PolicyCreate,
        created_by: str,
    ) -> Policy:
        """
        Create a new policy.

        The policy starts in DRAFT status and must be activated
        to take effect.
        """
        # Check for duplicate name
        existing = await self.get_policy_by_name(data.name)
        if existing:
            raise ValueError(f"Policy with name '{data.name}' already exists")

        # Validate Rego code
        await self._validate_rego(data.rego_code)

        policy = Policy(
            id=uuid4(),
            name=data.name,
            description=data.description,
            policy_type=PolicyType(data.policy_type.value),
            status=PolicyStatus.DRAFT,
            rego_code=data.rego_code,
            applies_to_agents=data.applies_to_agents,
            applies_to_actions=data.applies_to_actions,
            applies_to_resources=data.applies_to_resources,
            priority=data.priority,
            version=1,
            labels=data.labels,
            annotations=data.annotations,
            created_by=created_by,
        )

        self.session.add(policy)
        await self.session.flush()

        # Create initial version
        await self._create_version(policy, created_by, "Initial version")

        logger.info(f"Policy created: {policy.name} ({policy.id})")
        return policy

    async def get_policy(self, policy_id: UUID) -> Optional[Policy]:
        """Get policy by ID."""
        result = await self.session.execute(
            select(Policy).where(
                Policy.id == policy_id,
                Policy.deleted_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    async def get_policy_by_name(self, name: str) -> Optional[Policy]:
        """Get policy by name."""
        result = await self.session.execute(
            select(Policy).where(
                Policy.name == name,
                Policy.deleted_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    async def list_policies(
        self,
        status: Optional[PolicyStatus] = None,
        policy_type: Optional[PolicyType] = None,
        labels: Optional[Dict[str, str]] = None,
        offset: int = 0,
        limit: int = 100,
    ) -> Tuple[List[Policy], int]:
        """
        List policies with optional filtering.

        Returns:
            Tuple of (policies, total_count)
        """
        query = select(Policy).where(Policy.deleted_at.is_(None))
        count_query = select(func.count(Policy.id)).where(Policy.deleted_at.is_(None))

        conditions = []
        if status:
            conditions.append(Policy.status == status)
        if policy_type:
            conditions.append(Policy.policy_type == policy_type)
        if labels:
            for key, value in labels.items():
                conditions.append(Policy.labels[key].astext == value)

        if conditions:
            query = query.where(and_(*conditions))
            count_query = count_query.where(and_(*conditions))

        total_result = await self.session.execute(count_query)
        total = total_result.scalar() or 0

        query = query.order_by(Policy.priority.desc(), Policy.name).offset(offset).limit(limit)
        result = await self.session.execute(query)
        policies = list(result.scalars().all())

        return policies, total

    async def update_policy(
        self,
        policy_id: UUID,
        data: PolicyUpdate,
        updated_by: str,
    ) -> Policy:
        """
        Update a policy.

        Creates a new version and increments the version number.
        """
        policy = await self.get_policy(policy_id)
        if not policy:
            raise ValueError(f"Policy not found: {policy_id}")

        # Validate Rego if changed
        if data.rego_code:
            await self._validate_rego(data.rego_code)

        # Update fields
        if data.description is not None:
            policy.description = data.description
        if data.rego_code is not None:
            policy.rego_code = data.rego_code
        if data.applies_to_agents is not None:
            policy.applies_to_agents = data.applies_to_agents
        if data.applies_to_actions is not None:
            policy.applies_to_actions = data.applies_to_actions
        if data.applies_to_resources is not None:
            policy.applies_to_resources = data.applies_to_resources
        if data.priority is not None:
            policy.priority = data.priority
        if data.labels is not None:
            policy.labels = data.labels
        if data.annotations is not None:
            policy.annotations = data.annotations

        policy.version += 1
        policy.updated_by = updated_by
        policy.updated_at = datetime.now(timezone.utc)

        await self.session.flush()

        # Create version record
        await self._create_version(policy, updated_by, data.change_reason)

        # Sync to OPA if active
        if policy.status == PolicyStatus.ACTIVE:
            await self._sync_policy_to_opa(policy)

        logger.info(f"Policy updated: {policy.name} v{policy.version}")
        return policy

    async def delete_policy(
        self,
        policy_id: UUID,
        deleted_by: str,
    ) -> bool:
        """
        Soft delete a policy.

        Also removes it from OPA if it was active.
        """
        policy = await self.get_policy(policy_id)
        if not policy:
            return False

        # Remove from OPA
        if policy.status == PolicyStatus.ACTIVE:
            await self.opa.delete_policy(str(policy.id))

        policy.deleted_at = datetime.now(timezone.utc)
        policy.status = PolicyStatus.ARCHIVED
        await self.session.flush()

        logger.info(f"Policy deleted: {policy.name}")
        return True

    # =========================================================================
    # Policy Lifecycle
    # =========================================================================

    async def activate_policy(
        self,
        policy_id: UUID,
        activated_by: str,
    ) -> Policy:
        """
        Activate a policy.

        Pushes the policy to OPA and marks it as active.
        """
        policy = await self.get_policy(policy_id)
        if not policy:
            raise ValueError(f"Policy not found: {policy_id}")

        if policy.status == PolicyStatus.ACTIVE:
            return policy

        # Push to OPA
        await self._sync_policy_to_opa(policy)

        policy.status = PolicyStatus.ACTIVE
        policy.updated_by = activated_by
        policy.updated_at = datetime.now(timezone.utc)
        await self.session.flush()

        logger.info(f"Policy activated: {policy.name}")
        return policy

    async def deactivate_policy(
        self,
        policy_id: UUID,
        deactivated_by: str,
    ) -> Policy:
        """
        Deactivate a policy.

        Removes the policy from OPA.
        """
        policy = await self.get_policy(policy_id)
        if not policy:
            raise ValueError(f"Policy not found: {policy_id}")

        if policy.status != PolicyStatus.ACTIVE:
            return policy

        # Remove from OPA
        await self.opa.delete_policy(str(policy.id))

        policy.status = PolicyStatus.DEPRECATED
        policy.updated_by = deactivated_by
        policy.updated_at = datetime.now(timezone.utc)
        await self.session.flush()

        logger.info(f"Policy deactivated: {policy.name}")
        return policy

    # =========================================================================
    # Policy Evaluation
    # =========================================================================

    async def evaluate(
        self,
        request: PolicyEvaluationRequest,
    ) -> PolicyEvaluationResult:
        """
        Evaluate all applicable policies for an action.

        Returns the aggregated decision based on policy priorities
        and types.
        """
        start_time = time.time()

        # Find applicable policies
        applicable = await self._find_applicable_policies(
            agent_id=request.agent_id,
            action=request.action,
            resource=request.resource,
        )

        if not applicable:
            # No policies apply - default allow
            return PolicyEvaluationResult(
                decision=PolicyDecision.ALLOW,
                allowed=True,
                matched_policies=[],
                evaluation_time_ms=(time.time() - start_time) * 1000,
                evaluated_at=datetime.now(timezone.utc),
            )

        # Build OPA input
        opa_input = {
            "agent": {"id": request.agent_id},
            "action": request.action,
            "resource": request.resource,
            "context": request.context,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        # Evaluate each policy
        matched_policies = []
        denial_reasons = []
        approval_reasons = []

        for policy in applicable:
            try:
                result = await self.opa.evaluate(
                    f"aegis/policies/{policy.id}",
                    opa_input,
                )

                decision = self._interpret_result(policy, result.result)
                matched_policies.append(PolicyMatch(
                    policy_id=str(policy.id),
                    policy_name=policy.name,
                    decision=decision.decision,
                    reason=decision.reason,
                    priority=policy.priority,
                ))

                if decision.decision == PolicyDecision.DENY:
                    denial_reasons.append(decision.reason or f"Denied by {policy.name}")
                elif decision.decision == PolicyDecision.REQUIRE_APPROVAL:
                    approval_reasons.append(decision.reason or f"Approval required by {policy.name}")

            except OPAError as e:
                logger.warning(f"Policy evaluation failed for {policy.name}: {e}")

        # Determine final decision
        final_decision = self._aggregate_decisions(matched_policies)
        elapsed_ms = (time.time() - start_time) * 1000

        return PolicyEvaluationResult(
            decision=final_decision,
            allowed=final_decision == PolicyDecision.ALLOW,
            requires_approval=final_decision == PolicyDecision.REQUIRE_APPROVAL,
            denial_reasons=denial_reasons,
            approval_reasons=approval_reasons,
            matched_policies=matched_policies,
            evaluation_time_ms=elapsed_ms,
            evaluated_at=datetime.now(timezone.utc),
        )

    async def _find_applicable_policies(
        self,
        agent_id: str,
        action: str,
        resource: Dict[str, Any],
    ) -> List[Policy]:
        """Find all active policies that apply to this request."""
        # Get all active policies, sorted by priority
        result = await self.session.execute(
            select(Policy)
            .where(
                Policy.status == PolicyStatus.ACTIVE,
                Policy.deleted_at.is_(None),
            )
            .order_by(Policy.priority.desc())
        )
        all_policies = list(result.scalars().all())

        applicable = []
        resource_id = resource.get("id", "")
        resource_type = resource.get("type", "")

        for policy in all_policies:
            # Check agent match
            if policy.applies_to_agents:
                if not any(
                    fnmatch.fnmatch(agent_id, pattern)
                    for pattern in policy.applies_to_agents
                ):
                    continue

            # Check action match
            if policy.applies_to_actions:
                if not any(
                    fnmatch.fnmatch(action, pattern)
                    for pattern in policy.applies_to_actions
                ):
                    continue

            # Check resource match
            if policy.applies_to_resources:
                resource_str = f"{resource_type}:{resource_id}"
                if not any(
                    fnmatch.fnmatch(resource_str, pattern) or
                    fnmatch.fnmatch(resource_id, pattern) or
                    fnmatch.fnmatch(resource_type, pattern)
                    for pattern in policy.applies_to_resources
                ):
                    continue

            applicable.append(policy)

        return applicable

    def _interpret_result(self, policy: Policy, result: Any) -> PolicyMatch:
        """Interpret OPA result based on policy type."""
        reason = None

        if isinstance(result, dict):
            # Check for explicit deny
            if result.get("deny"):
                deny_reasons = result.get("deny", [])
                if isinstance(deny_reasons, list) and deny_reasons:
                    reason = deny_reasons[0] if isinstance(deny_reasons[0], str) else str(deny_reasons[0])
                return PolicyMatch(
                    policy_id=str(policy.id),
                    policy_name=policy.name,
                    decision=PolicyDecision.DENY,
                    reason=reason,
                    priority=policy.priority,
                )

            # Check for require_approval
            if result.get("require_approval"):
                approval_reasons = result.get("require_approval", [])
                if isinstance(approval_reasons, list) and approval_reasons:
                    reason = approval_reasons[0] if isinstance(approval_reasons[0], str) else str(approval_reasons[0])
                return PolicyMatch(
                    policy_id=str(policy.id),
                    policy_name=policy.name,
                    decision=PolicyDecision.REQUIRE_APPROVAL,
                    reason=reason,
                    priority=policy.priority,
                )

            # Check for explicit allow
            if result.get("allow"):
                return PolicyMatch(
                    policy_id=str(policy.id),
                    policy_name=policy.name,
                    decision=PolicyDecision.ALLOW,
                    reason=None,
                    priority=policy.priority,
                )

        elif isinstance(result, bool):
            if result:
                return PolicyMatch(
                    policy_id=str(policy.id),
                    policy_name=policy.name,
                    decision=PolicyDecision.ALLOW,
                    reason=None,
                    priority=policy.priority,
                )
            else:
                return PolicyMatch(
                    policy_id=str(policy.id),
                    policy_name=policy.name,
                    decision=PolicyDecision.DENY,
                    reason=f"Policy {policy.name} returned false",
                    priority=policy.priority,
                )

        # Default to not applicable
        return PolicyMatch(
            policy_id=str(policy.id),
            policy_name=policy.name,
            decision=PolicyDecision.NOT_APPLICABLE,
            reason=None,
            priority=policy.priority,
        )

    def _aggregate_decisions(self, matches: List[PolicyMatch]) -> PolicyDecision:
        """
        Aggregate policy decisions.

        Priority order:
        1. Any DENY -> DENY
        2. Any REQUIRE_APPROVAL -> REQUIRE_APPROVAL
        3. Any ALLOW -> ALLOW
        4. Default -> ALLOW (if no policies matched)
        """
        has_allow = False

        # Sort by priority (highest first)
        sorted_matches = sorted(matches, key=lambda m: m.priority, reverse=True)

        for match in sorted_matches:
            if match.decision == PolicyDecision.DENY:
                return PolicyDecision.DENY
            elif match.decision == PolicyDecision.REQUIRE_APPROVAL:
                return PolicyDecision.REQUIRE_APPROVAL
            elif match.decision == PolicyDecision.ALLOW:
                has_allow = True

        return PolicyDecision.ALLOW if has_allow else PolicyDecision.NOT_APPLICABLE

    # =========================================================================
    # OPA Synchronization
    # =========================================================================

    async def sync_all_policies(self) -> int:
        """
        Sync all active policies to OPA.

        Returns the number of policies synced.
        """
        policies, _ = await self.list_policies(status=PolicyStatus.ACTIVE)
        count = 0

        for policy in policies:
            try:
                await self._sync_policy_to_opa(policy)
                count += 1
            except Exception as e:
                logger.error(f"Failed to sync policy {policy.name}: {e}")

        logger.info(f"Synced {count} policies to OPA")
        return count

    async def _sync_policy_to_opa(self, policy: Policy) -> None:
        """Push a single policy to OPA."""
        # Wrap policy in package
        wrapped_code = self._wrap_policy_code(policy)
        await self.opa.put_policy(str(policy.id), wrapped_code)

    def _wrap_policy_code(self, policy: Policy) -> str:
        """Wrap policy code with proper package declaration."""
        # Check if code already has package declaration
        if policy.rego_code.strip().startswith("package"):
            return policy.rego_code

        # Add package declaration
        return f"package aegis.policies.{policy.id}\n\n{policy.rego_code}"

    # =========================================================================
    # Version Management
    # =========================================================================

    async def _create_version(
        self,
        policy: Policy,
        changed_by: str,
        change_reason: Optional[str] = None,
    ) -> PolicyVersion:
        """Create a version record for a policy."""
        version = PolicyVersion(
            id=uuid4(),
            policy_id=policy.id,
            version=policy.version,
            rego_code=policy.rego_code,
            applies_to_agents=policy.applies_to_agents,
            applies_to_actions=policy.applies_to_actions,
            applies_to_resources=policy.applies_to_resources,
            priority=policy.priority,
            change_reason=change_reason,
            changed_by=changed_by,
        )

        self.session.add(version)
        await self.session.flush()
        return version

    async def get_policy_versions(
        self,
        policy_id: UUID,
        offset: int = 0,
        limit: int = 20,
    ) -> List[PolicyVersion]:
        """Get version history for a policy."""
        result = await self.session.execute(
            select(PolicyVersion)
            .where(PolicyVersion.policy_id == policy_id)
            .order_by(PolicyVersion.version.desc())
            .offset(offset)
            .limit(limit)
        )
        return list(result.scalars().all())

    # =========================================================================
    # Validation
    # =========================================================================

    async def _validate_rego(self, code: str) -> None:
        """Validate Rego code by attempting to compile it."""
        try:
            # Try to compile the policy
            test_id = f"_validate_{uuid4().hex[:8]}"
            wrapped = f"package {test_id}\n\n{code}" if not code.strip().startswith("package") else code

            await self.opa.put_policy(test_id, wrapped)
            await self.opa.delete_policy(test_id)

        except OPAError as e:
            raise ValueError(f"Invalid Rego code: {e}")


# Singleton
_policy_service: Optional[PolicyService] = None


def get_policy_service() -> PolicyService:
    """Get policy service singleton."""
    global _policy_service
    if _policy_service is None:
        from ...common.db.database import get_db
        db = get_db()
        _policy_service = PolicyService(db.get_session())
    return _policy_service
