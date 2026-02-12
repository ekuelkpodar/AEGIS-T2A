"""Role-based access control for the automation platform."""

from typing import Dict, Iterable, List, Set

from fastapi import HTTPException

from ...common.auth.middleware import AgentIdentity


class RBACService:
    """Evaluates role and permission access for automation endpoints."""

    ROLE_PERMISSIONS: Dict[str, Set[str]] = {
        "platform_admin": {
            "automation:*",
            "automation:definitions:*",
            "automation:tasks:*",
            "automation:integrations:*",
            "automation:audit:read",
        },
        "industry_operator": {
            "automation:definitions:read",
            "automation:tasks:write",
            "automation:tasks:read",
            "automation:tasks:trigger",
            "automation:integrations:read",
        },
        "reviewer": {
            "automation:tasks:read",
            "automation:tasks:review",
            "automation:audit:read",
        },
        "integration_admin": {
            "automation:integrations:write",
            "automation:integrations:read",
            "automation:definitions:write",
            "automation:definitions:read",
        },
        "auditor": {
            "automation:audit:read",
            "automation:tasks:read",
            "automation:definitions:read",
        },
    }

    def get_roles(self, identity: AgentIdentity) -> List[str]:
        roles = identity.metadata.get("roles") if identity.metadata else []
        if isinstance(roles, list):
            return [str(role) for role in roles]
        if isinstance(roles, str):
            return [roles]
        return []

    def get_effective_permissions(self, identity: AgentIdentity) -> Set[str]:
        permissions = set(identity.permissions or [])
        for role in self.get_roles(identity):
            permissions.update(self.ROLE_PERMISSIONS.get(role, set()))
        return permissions

    @staticmethod
    def _matches(permission: str, granted: str) -> bool:
        if granted in {"*", permission}:
            return True

        # wildcard permission matching: foo:bar:* covers foo:bar:baz
        if granted.endswith(":*") and permission.startswith(granted[:-1]):
            return True

        # broad namespace wildcard: automation:*
        if granted.endswith("*") and permission.startswith(granted[:-1]):
            return True

        return False

    def is_allowed(self, identity: AgentIdentity, permission: str) -> bool:
        return any(self._matches(permission, granted) for granted in self.get_effective_permissions(identity))

    def enforce(self, identity: AgentIdentity, permission: str) -> None:
        if not self.is_allowed(identity, permission):
            raise HTTPException(status_code=403, detail=f"Missing permission: {permission}")

    def audit_roles(self, identity: AgentIdentity) -> Iterable[str]:
        return self.get_roles(identity)
