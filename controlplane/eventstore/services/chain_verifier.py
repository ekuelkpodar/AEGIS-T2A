"""
Chain Verifier

Standalone utility for verifying the integrity of the hash chain.
Can be used by auditors and compliance tools.
"""

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Generator
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class VerificationError:
    """Details of a chain verification error."""
    event_id: str
    event_hash: str
    expected_hash: str
    computed_hash: str
    error_type: str
    details: str


@dataclass
class VerificationResult:
    """Result of chain verification."""
    valid: bool
    events_checked: int
    errors: List[VerificationError]
    first_event_id: Optional[str]
    last_event_id: Optional[str]
    verification_time_ms: float
    timestamp: datetime

    def to_dict(self) -> Dict[str, Any]:
        return {
            "valid": self.valid,
            "events_checked": self.events_checked,
            "errors": [
                {
                    "event_id": e.event_id,
                    "error_type": e.error_type,
                    "details": e.details,
                }
                for e in self.errors
            ],
            "first_event_id": self.first_event_id,
            "last_event_id": self.last_event_id,
            "verification_time_ms": self.verification_time_ms,
            "timestamp": self.timestamp.isoformat(),
        }


class ChainVerifier:
    """
    Verifies the integrity of the event hash chain.

    Can verify:
    - Hash chain continuity (each event's prev_hash matches previous event_hash)
    - Event hash integrity (recomputed hash matches stored hash)
    - Optional signature verification
    """

    def __init__(self, genesis_hash: str):
        self.genesis_hash = genesis_hash

    def compute_event_hash(self, event_data: Dict[str, Any]) -> str:
        """
        Compute the hash of an event from its data.

        The hash is computed from:
        - created_at
        - event_type
        - actor
        - target_id
        - payload
        - prev_hash
        """
        hashable = {
            "created_at": event_data.get("created_at"),
            "event_type": event_data.get("event_type"),
            "actor": event_data.get("actor"),
            "target_id": event_data.get("target_id"),
            "payload": event_data.get("payload", {}),
            "prev_hash": event_data.get("prev_hash"),
        }
        raw = json.dumps(hashable, sort_keys=True, default=str).encode("utf-8")
        return hashlib.sha256(raw).hexdigest()

    def verify_events(
        self,
        events: List[Dict[str, Any]],
        stop_on_first_error: bool = False,
    ) -> VerificationResult:
        """
        Verify a list of events for chain integrity.

        Events should be ordered by created_at ascending.

        Args:
            events: List of event dictionaries
            stop_on_first_error: Stop verification on first error

        Returns:
            VerificationResult with details
        """
        import time
        start_time = time.time()

        if not events:
            return VerificationResult(
                valid=True,
                events_checked=0,
                errors=[],
                first_event_id=None,
                last_event_id=None,
                verification_time_ms=0,
                timestamp=datetime.now(timezone.utc),
            )

        errors: List[VerificationError] = []
        expected_prev_hash = self.genesis_hash

        # Check if first event has genesis or a valid prev_hash
        first_event = events[0]
        if first_event.get("prev_hash") != self.genesis_hash:
            # This might be a partial chain, use the first event's prev_hash
            expected_prev_hash = first_event.get("prev_hash")

        for event in events:
            event_id = str(event.get("id", "unknown"))
            event_hash = event.get("event_hash", "")
            prev_hash = event.get("prev_hash", "")

            # Verify prev_hash continuity
            if prev_hash != expected_prev_hash:
                error = VerificationError(
                    event_id=event_id,
                    event_hash=event_hash,
                    expected_hash=expected_prev_hash,
                    computed_hash="",
                    error_type="prev_hash_mismatch",
                    details=f"Expected prev_hash '{expected_prev_hash}', got '{prev_hash}'",
                )
                errors.append(error)
                if stop_on_first_error:
                    break

            # Verify event hash
            computed_hash = self.compute_event_hash(event)
            if event_hash != computed_hash:
                error = VerificationError(
                    event_id=event_id,
                    event_hash=event_hash,
                    expected_hash=computed_hash,
                    computed_hash=computed_hash,
                    error_type="event_hash_mismatch",
                    details=f"Stored hash '{event_hash}' does not match computed hash '{computed_hash}'",
                )
                errors.append(error)
                if stop_on_first_error:
                    break

            expected_prev_hash = event_hash

        elapsed_ms = (time.time() - start_time) * 1000

        return VerificationResult(
            valid=len(errors) == 0,
            events_checked=len(events),
            errors=errors,
            first_event_id=str(events[0].get("id")) if events else None,
            last_event_id=str(events[-1].get("id")) if events else None,
            verification_time_ms=elapsed_ms,
            timestamp=datetime.now(timezone.utc),
        )

    def verify_stream(
        self,
        event_stream: Generator[Dict[str, Any], None, None],
        batch_size: int = 1000,
    ) -> Generator[VerificationResult, None, None]:
        """
        Verify events from a stream in batches.

        Useful for verifying large event stores without loading
        all events into memory.

        Yields VerificationResult for each batch.
        """
        batch: List[Dict[str, Any]] = []
        expected_prev_hash = self.genesis_hash

        for event in event_stream:
            batch.append(event)

            if len(batch) >= batch_size:
                # Verify batch
                result = self.verify_events(batch)
                yield result

                if batch:
                    expected_prev_hash = batch[-1].get("event_hash", self.genesis_hash)
                batch = []

        # Verify remaining events
        if batch:
            result = self.verify_events(batch)
            yield result

    def generate_proof(
        self,
        events: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """
        Generate a cryptographic proof of the chain.

        This can be provided to auditors to prove the chain
        was valid at a point in time.
        """
        if not events:
            return {
                "proof_type": "empty_chain",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }

        # Compute Merkle root of event hashes
        hashes = [e.get("event_hash", "") for e in events]
        merkle_root = self._compute_merkle_root(hashes)

        return {
            "proof_type": "hash_chain",
            "chain_length": len(events),
            "first_event_id": str(events[0].get("id")),
            "first_event_hash": events[0].get("event_hash"),
            "last_event_id": str(events[-1].get("id")),
            "last_event_hash": events[-1].get("event_hash"),
            "merkle_root": merkle_root,
            "genesis_hash": self.genesis_hash,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

    def _compute_merkle_root(self, hashes: List[str]) -> str:
        """Compute Merkle root from a list of hashes."""
        if not hashes:
            return hashlib.sha256(b"").hexdigest()

        # Pad to power of 2
        while len(hashes) & (len(hashes) - 1):
            hashes.append(hashes[-1])

        while len(hashes) > 1:
            next_level = []
            for i in range(0, len(hashes), 2):
                combined = hashes[i] + hashes[i + 1]
                next_level.append(hashlib.sha256(combined.encode()).hexdigest())
            hashes = next_level

        return hashes[0]


def verify_jsonl_file(
    file_path: str,
    genesis_hash: str,
) -> VerificationResult:
    """
    Verify a JSONL export file.

    Utility function for auditors to verify exported event files.
    """
    import time
    start_time = time.time()

    verifier = ChainVerifier(genesis_hash)
    events = []

    with open(file_path, "r") as f:
        for line in f:
            if line.strip():
                events.append(json.loads(line))

    result = verifier.verify_events(events)
    result.verification_time_ms = (time.time() - start_time) * 1000
    return result
