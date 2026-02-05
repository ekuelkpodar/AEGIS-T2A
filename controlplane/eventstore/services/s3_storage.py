"""
S3 Storage Service

Handles storage of large event payloads in S3 with Object Lock
for immutability guarantees.
"""

import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional
from dataclasses import dataclass

import boto3
from botocore.exceptions import ClientError

from ...common.config.settings import get_settings

logger = logging.getLogger(__name__)


@dataclass
class StoredObject:
    """Metadata for a stored object."""
    bucket: str
    key: str
    version_id: str
    etag: str
    content_hash: str
    size_bytes: int
    stored_at: datetime


class S3StorageService:
    """
    S3 storage for large event payloads with Object Lock.

    Features:
    - Content-addressable storage (hash-based keys)
    - Object Lock for immutability
    - Retention period management
    - Integrity verification
    """

    def __init__(self):
        self.settings = get_settings()
        self.client = self._create_client()
        self.bucket = self.settings.s3_bucket
        self.retention_days = self.settings.s3_retention_days

    def _create_client(self):
        """Create S3 client with optional endpoint override for MinIO."""
        config = {
            "region_name": self.settings.s3_region,
        }

        if self.settings.s3_endpoint:
            config["endpoint_url"] = self.settings.s3_endpoint

        if self.settings.s3_access_key and self.settings.s3_secret_key:
            config["aws_access_key_id"] = self.settings.s3_access_key
            config["aws_secret_access_key"] = self.settings.s3_secret_key

        return boto3.client("s3", **config)

    def _compute_content_hash(self, data: bytes) -> str:
        """Compute SHA-256 hash of content."""
        return hashlib.sha256(data).hexdigest()

    def _generate_key(self, event_id: str, content_hash: str) -> str:
        """Generate S3 key for event payload."""
        # Use date-based partitioning for efficient queries
        date = datetime.now(timezone.utc).strftime("%Y/%m/%d")
        return f"events/{date}/{event_id}/{content_hash}.json"

    async def store_payload(
        self,
        event_id: str,
        payload: Dict[str, Any],
        retention_days: Optional[int] = None,
    ) -> StoredObject:
        """
        Store event payload in S3 with Object Lock.

        Args:
            event_id: Event identifier
            payload: Event payload data
            retention_days: Override default retention period

        Returns:
            StoredObject with storage metadata
        """
        # Serialize payload
        data = json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
        content_hash = self._compute_content_hash(data)
        key = self._generate_key(event_id, content_hash)

        retention = retention_days or self.retention_days
        retain_until = datetime.now(timezone.utc) + timedelta(days=retention)

        try:
            # Put object with Object Lock retention
            put_params = {
                "Bucket": self.bucket,
                "Key": key,
                "Body": data,
                "ContentType": "application/json",
                "Metadata": {
                    "event-id": event_id,
                    "content-hash": content_hash,
                },
            }

            # Add Object Lock if enabled
            if self.settings.s3_object_lock_enabled:
                put_params["ObjectLockMode"] = "GOVERNANCE"
                put_params["ObjectLockRetainUntilDate"] = retain_until

            response = self.client.put_object(**put_params)

            logger.info(
                f"Stored payload for event {event_id}",
                extra={
                    "event_id": event_id,
                    "key": key,
                    "content_hash": content_hash,
                    "size_bytes": len(data),
                },
            )

            return StoredObject(
                bucket=self.bucket,
                key=key,
                version_id=response.get("VersionId", ""),
                etag=response.get("ETag", "").strip('"'),
                content_hash=content_hash,
                size_bytes=len(data),
                stored_at=datetime.now(timezone.utc),
            )

        except ClientError as e:
            logger.error(f"Failed to store payload: {e}")
            raise

    async def get_payload(
        self,
        key: str,
        version_id: Optional[str] = None,
        verify_hash: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Retrieve event payload from S3.

        Args:
            key: S3 object key
            version_id: Specific version to retrieve
            verify_hash: Expected content hash for verification

        Returns:
            Payload data as dictionary

        Raises:
            ValueError: If hash verification fails
        """
        try:
            get_params = {"Bucket": self.bucket, "Key": key}
            if version_id:
                get_params["VersionId"] = version_id

            response = self.client.get_object(**get_params)
            data = response["Body"].read()

            # Verify integrity if hash provided
            if verify_hash:
                actual_hash = self._compute_content_hash(data)
                if actual_hash != verify_hash:
                    raise ValueError(
                        f"Hash mismatch: expected {verify_hash}, got {actual_hash}"
                    )

            return json.loads(data.decode("utf-8"))

        except ClientError as e:
            if e.response["Error"]["Code"] == "NoSuchKey":
                raise KeyError(f"Payload not found: {key}")
            logger.error(f"Failed to retrieve payload: {e}")
            raise

    async def verify_integrity(self, key: str, expected_hash: str) -> bool:
        """
        Verify stored object integrity without full retrieval.

        Uses S3 metadata if available, otherwise downloads and hashes.
        """
        try:
            # First try to get metadata
            head_response = self.client.head_object(Bucket=self.bucket, Key=key)
            stored_hash = head_response.get("Metadata", {}).get("content-hash")

            if stored_hash:
                return stored_hash == expected_hash

            # Fall back to full verification
            await self.get_payload(key, verify_hash=expected_hash)
            return True

        except (KeyError, ValueError):
            return False
        except ClientError:
            return False

    async def list_event_payloads(
        self,
        event_id: str,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
    ) -> list:
        """List all payloads for an event ID."""
        # Build prefix based on event ID
        # Note: This requires scanning multiple date partitions
        results = []

        try:
            paginator = self.client.get_paginator("list_objects_v2")

            # If dates provided, scan specific partitions
            if start_date and end_date:
                current = start_date
                while current <= end_date:
                    prefix = f"events/{current.strftime('%Y/%m/%d')}/{event_id}/"
                    async for page in self._paginate(paginator, prefix):
                        results.extend(page)
                    current += timedelta(days=1)
            else:
                # Scan all events (expensive, use with caution)
                prefix = f"events/"
                async for page in self._paginate(paginator, prefix):
                    for obj in page:
                        if f"/{event_id}/" in obj["Key"]:
                            results.append(obj)

            return results

        except ClientError as e:
            logger.error(f"Failed to list payloads: {e}")
            raise

    async def _paginate(self, paginator, prefix: str):
        """Async wrapper for S3 paginator."""
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            yield page.get("Contents", [])

    async def extend_retention(
        self,
        key: str,
        additional_days: int,
        version_id: Optional[str] = None,
    ) -> datetime:
        """
        Extend retention period for an object.

        Only allowed in GOVERNANCE mode.
        """
        new_retain_until = datetime.now(timezone.utc) + timedelta(days=additional_days)

        try:
            params = {
                "Bucket": self.bucket,
                "Key": key,
                "Retention": {
                    "Mode": "GOVERNANCE",
                    "RetainUntilDate": new_retain_until,
                },
            }
            if version_id:
                params["VersionId"] = version_id

            self.client.put_object_retention(**params)
            logger.info(f"Extended retention for {key} until {new_retain_until}")
            return new_retain_until

        except ClientError as e:
            logger.error(f"Failed to extend retention: {e}")
            raise

    async def create_bucket_if_not_exists(self) -> bool:
        """
        Create the storage bucket with Object Lock enabled.

        Returns True if bucket was created, False if it already exists.
        """
        try:
            # Check if bucket exists
            self.client.head_bucket(Bucket=self.bucket)
            return False
        except ClientError as e:
            if e.response["Error"]["Code"] != "404":
                raise

        try:
            # Create bucket with Object Lock
            create_params = {
                "Bucket": self.bucket,
                "ObjectLockEnabledForBucket": True,
            }

            # Add location constraint for non-us-east-1 regions
            if self.settings.s3_region != "us-east-1":
                create_params["CreateBucketConfiguration"] = {
                    "LocationConstraint": self.settings.s3_region
                }

            self.client.create_bucket(**create_params)

            # Configure default retention
            if self.settings.s3_object_lock_enabled:
                self.client.put_object_lock_configuration(
                    Bucket=self.bucket,
                    ObjectLockConfiguration={
                        "ObjectLockEnabled": "Enabled",
                        "Rule": {
                            "DefaultRetention": {
                                "Mode": "GOVERNANCE",
                                "Days": self.retention_days,
                            }
                        },
                    },
                )

            # Enable versioning (required for Object Lock)
            self.client.put_bucket_versioning(
                Bucket=self.bucket,
                VersioningConfiguration={"Status": "Enabled"},
            )

            logger.info(f"Created bucket {self.bucket} with Object Lock enabled")
            return True

        except ClientError as e:
            logger.error(f"Failed to create bucket: {e}")
            raise


# Singleton instance
_storage_service: Optional[S3StorageService] = None


def get_s3_storage() -> S3StorageService:
    """Get S3 storage service singleton."""
    global _storage_service
    if _storage_service is None:
        _storage_service = S3StorageService()
    return _storage_service
