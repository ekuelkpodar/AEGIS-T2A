"""
Vault PKI Service

Integration with HashiCorp Vault for certificate management.
Supports issuing, renewing, and revoking agent certificates.
"""

import logging
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, Optional

import httpx

from ...common.config.settings import Settings, get_settings

logger = logging.getLogger(__name__)


class VaultPKIService:
    """
    HashiCorp Vault PKI integration.

    Issues short-lived certificates for agent authentication.
    Supports certificate rotation and revocation.
    """

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
        self.vault_url = self.settings.vault.url
        self.token = self.settings.vault.token
        self.pki_mount = self.settings.vault.pki_mount
        self.pki_role = self.settings.vault.pki_role
        self.namespace = self.settings.vault.namespace

        self._client: Optional[httpx.AsyncClient] = None

    @property
    def client(self) -> httpx.AsyncClient:
        """Get or create HTTP client."""
        if self._client is None:
            headers = {"X-Vault-Token": self.token}
            if self.namespace:
                headers["X-Vault-Namespace"] = self.namespace

            self._client = httpx.AsyncClient(
                base_url=self.vault_url,
                headers=headers,
                verify=self.settings.vault.verify_ssl,
                timeout=30.0,
            )
        return self._client

    async def close(self):
        """Close the HTTP client."""
        if self._client:
            await self._client.aclose()
            self._client = None

    async def health_check(self) -> Dict[str, Any]:
        """Check Vault connectivity and status."""
        try:
            response = await self.client.get("/v1/sys/health")
            data = response.json()
            return {
                "status": "healthy" if response.status_code == 200 else "degraded",
                "initialized": data.get("initialized"),
                "sealed": data.get("sealed"),
                "version": data.get("version"),
            }
        except Exception as e:
            logger.error(f"Vault health check failed: {e}")
            return {
                "status": "unhealthy",
                "error": str(e),
            }

    async def issue_certificate(
        self,
        agent_id: str,
        common_name: str,
        ttl: int = 3600,
        alt_names: list = None,
        ip_sans: list = None,
    ) -> Dict[str, Any]:
        """
        Issue a new certificate for an agent.

        Args:
            agent_id: Agent identifier
            common_name: Certificate CN (usually agent name)
            ttl: Certificate TTL in seconds
            alt_names: Additional DNS SANs
            ip_sans: IP SANs

        Returns:
            Dictionary with certificate, private_key, serial_number, expires_at
        """
        logger.info(f"Issuing certificate for agent: {agent_id}")

        payload = {
            "common_name": common_name,
            "ttl": f"{ttl}s",
            "format": "pem",
        }

        # Add SPIFFE ID as a URI SAN
        uri_sans = [f"spiffe://{self.settings.spire.trust_domain}/agent/{agent_id}"]
        payload["uri_sans"] = ",".join(uri_sans)

        if alt_names:
            payload["alt_names"] = ",".join(alt_names)
        if ip_sans:
            payload["ip_sans"] = ",".join(ip_sans)

        try:
            response = await self.client.post(
                f"/v1/{self.pki_mount}/issue/{self.pki_role}",
                json=payload,
            )
            response.raise_for_status()
            data = response.json()

            cert_data = data.get("data", {})

            # Calculate expiration
            expires_at = datetime.now(timezone.utc) + timedelta(seconds=ttl)

            result = {
                "certificate": cert_data.get("certificate"),
                "private_key": cert_data.get("private_key"),
                "ca_chain": cert_data.get("ca_chain", []),
                "serial_number": cert_data.get("serial_number"),
                "expires_at": expires_at,
                "issuing_ca": cert_data.get("issuing_ca"),
            }

            logger.info(f"Certificate issued for agent: {agent_id}, serial: {result['serial_number']}")
            return result

        except httpx.HTTPStatusError as e:
            logger.error(f"Failed to issue certificate: {e.response.text}")
            raise RuntimeError(f"Vault PKI error: {e.response.text}")
        except Exception as e:
            logger.error(f"Failed to issue certificate: {e}")
            raise

    async def revoke_certificate(self, serial_number: str) -> bool:
        """
        Revoke a certificate by serial number.

        This is immediate and permanent.
        """
        logger.warning(f"Revoking certificate: {serial_number}")

        try:
            response = await self.client.post(
                f"/v1/{self.pki_mount}/revoke",
                json={"serial_number": serial_number},
            )
            response.raise_for_status()

            logger.warning(f"Certificate revoked: {serial_number}")
            return True

        except httpx.HTTPStatusError as e:
            logger.error(f"Failed to revoke certificate: {e.response.text}")
            raise RuntimeError(f"Vault revocation error: {e.response.text}")
        except Exception as e:
            logger.error(f"Failed to revoke certificate: {e}")
            raise

    async def get_ca_certificate(self) -> str:
        """Get the CA certificate for trust anchoring."""
        try:
            response = await self.client.get(
                f"/v1/{self.pki_mount}/ca/pem",
            )
            response.raise_for_status()
            return response.text
        except Exception as e:
            logger.error(f"Failed to get CA certificate: {e}")
            raise

    async def get_crl(self) -> str:
        """Get the Certificate Revocation List."""
        try:
            response = await self.client.get(
                f"/v1/{self.pki_mount}/crl/pem",
            )
            response.raise_for_status()
            return response.text
        except Exception as e:
            logger.error(f"Failed to get CRL: {e}")
            raise

    async def tidy_certificates(self) -> Dict[str, Any]:
        """
        Tidy up expired certificates and CRL entries.

        Should be run periodically (e.g., daily).
        """
        logger.info("Running certificate tidy operation")

        try:
            response = await self.client.post(
                f"/v1/{self.pki_mount}/tidy",
                json={
                    "tidy_cert_store": True,
                    "tidy_revoked_certs": True,
                    "safety_buffer": "72h",
                },
            )
            response.raise_for_status()
            return {"status": "started"}
        except Exception as e:
            logger.error(f"Failed to tidy certificates: {e}")
            raise


class VaultPKIServiceMock:
    """
    Mock Vault PKI service for testing and local development.

    Generates self-signed certificates without Vault.
    """

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
        self._serial_counter = 0

    async def health_check(self) -> Dict[str, Any]:
        return {
            "status": "healthy",
            "mock": True,
            "message": "Using mock PKI service",
        }

    async def issue_certificate(
        self,
        agent_id: str,
        common_name: str,
        ttl: int = 3600,
        **kwargs,
    ) -> Dict[str, Any]:
        """Generate a mock certificate."""
        from cryptography import x509
        from cryptography.x509.oid import NameOID
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.hazmat.backends import default_backend

        self._serial_counter += 1

        # Generate key pair
        private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=2048,
            backend=default_backend(),
        )

        # Build certificate
        subject = issuer = x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "AEGIS-T2A"),
        ])

        now = datetime.now(timezone.utc)
        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(private_key.public_key())
            .serial_number(self._serial_counter)
            .not_valid_before(now)
            .not_valid_after(now + timedelta(seconds=ttl))
            .add_extension(
                x509.SubjectAlternativeName([
                    x509.UniformResourceIdentifier(
                        f"spiffe://{self.settings.spire.trust_domain}/agent/{agent_id}"
                    ),
                ]),
                critical=False,
            )
            .sign(private_key, hashes.SHA256(), default_backend())
        )

        from cryptography.hazmat.primitives import serialization

        cert_pem = cert.public_bytes(serialization.Encoding.PEM).decode()
        key_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode()

        return {
            "certificate": cert_pem,
            "private_key": key_pem,
            "ca_chain": [],
            "serial_number": str(self._serial_counter),
            "expires_at": now + timedelta(seconds=ttl),
        }

    async def revoke_certificate(self, serial_number: str) -> bool:
        logger.info(f"Mock revocation of certificate: {serial_number}")
        return True

    async def close(self):
        pass
