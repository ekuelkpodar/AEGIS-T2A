"""
AEGIS-T2A Control Plane Settings

Environment-based configuration for all control plane services.
Follows 12-factor app principles with secure defaults.
"""

import os
from functools import lru_cache
from typing import Optional, List
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings


class DatabaseSettings(BaseModel):
    """Database connection settings."""
    host: str = "localhost"
    port: int = 5432
    name: str = "aegis_controlplane"
    user: str = "aegis"
    password: str = ""
    pool_size: int = 10
    max_overflow: int = 20

    @property
    def url(self) -> str:
        """Generate SQLAlchemy database URL."""
        return f"postgresql+asyncpg://{self.user}:{self.password}@{self.host}:{self.port}/{self.name}"

    @property
    def sync_url(self) -> str:
        """Generate synchronous database URL for migrations."""
        return f"postgresql://{self.user}:{self.password}@{self.host}:{self.port}/{self.name}"


class VaultSettings(BaseModel):
    """HashiCorp Vault settings for PKI and secrets."""
    enabled: bool = False
    url: str = "http://localhost:8200"
    token: str = ""
    pki_mount: str = "pki"
    pki_role: str = "aegis-agent"
    namespace: str = ""
    verify_ssl: bool = True


class SPIRESettings(BaseModel):
    """SPIFFE/SPIRE settings for workload identity."""
    enabled: bool = False
    server_address: str = "localhost:8081"
    trust_domain: str = "aegis.local"
    agent_socket: str = "/tmp/spire-agent/public/api.sock"


class OPASettings(BaseModel):
    """Open Policy Agent settings."""
    enabled: bool = True
    url: str = "http://localhost:8181"
    policy_path: str = "/v1/data/aegis/policy"
    bundle_url: str = ""
    decision_log_enabled: bool = True


class EventStoreSettings(BaseModel):
    """Compliance Event Store settings."""
    genesis_hash: str = "0000000000000000000000000000000000000000000000000000000000000000"
    s3_enabled: bool = False
    s3_bucket: str = "aegis-events"
    s3_endpoint: str = ""
    s3_access_key: str = ""
    s3_secret_key: str = ""
    s3_object_lock: bool = True
    retention_days: int = 2555  # ~7 years for compliance


class AuthSettings(BaseModel):
    """Authentication and authorization settings."""
    jwt_secret: str = ""
    jwt_algorithm: str = "RS256"
    jwt_expiry_seconds: int = 3600
    mtls_enabled: bool = False
    ca_cert_path: str = "/etc/aegis/ca.crt"
    server_cert_path: str = "/etc/aegis/server.crt"
    server_key_path: str = "/etc/aegis/server.key"
    allowed_issuers: List[str] = []


class Settings(BaseSettings):
    """
    Main settings class for AEGIS Control Plane.

    All settings can be overridden via environment variables with AEGIS_ prefix.
    Example: AEGIS_DATABASE__HOST=postgres sets database.host
    """

    # Service identification
    service_name: str = "aegis-controlplane"
    service_version: str = "0.1.0"
    environment: str = "development"
    debug: bool = False

    # API settings
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    api_prefix: str = "/api/v1"
    cors_origins: List[str] = ["*"]

    # Component settings
    database: DatabaseSettings = Field(default_factory=DatabaseSettings)
    vault: VaultSettings = Field(default_factory=VaultSettings)
    spire: SPIRESettings = Field(default_factory=SPIRESettings)
    opa: OPASettings = Field(default_factory=OPASettings)
    eventstore: EventStoreSettings = Field(default_factory=EventStoreSettings)
    auth: AuthSettings = Field(default_factory=AuthSettings)

    # Lease defaults
    default_lease_ttl: int = 3600  # 1 hour
    max_lease_ttl: int = 86400  # 24 hours
    lease_renewal_grace_period: int = 300  # 5 minutes

    # Autonomy tiers
    autonomy_tiers: List[str] = ["READ", "RECOMMEND", "EXECUTE"]

    class Config:
        env_prefix = "AEGIS_"
        env_nested_delimiter = "__"
        case_sensitive = False

    def is_production(self) -> bool:
        """Check if running in production environment."""
        return self.environment.lower() == "production"

    def get_identity_provider(self) -> str:
        """Determine which identity provider to use."""
        if self.spire.enabled:
            return "spire"
        elif self.vault.enabled:
            return "vault"
        else:
            return "local"


@lru_cache()
def get_settings() -> Settings:
    """
    Get cached settings instance.

    Settings are loaded once and cached for performance.
    Use dependency injection in FastAPI endpoints.
    """
    return Settings()


def load_settings_from_file(path: str) -> Settings:
    """
    Load settings from a YAML or JSON file.

    Useful for Kubernetes ConfigMap or Docker secrets.
    """
    import json
    import yaml

    with open(path, 'r') as f:
        if path.endswith('.yaml') or path.endswith('.yml'):
            data = yaml.safe_load(f)
        else:
            data = json.load(f)

    return Settings(**data)
