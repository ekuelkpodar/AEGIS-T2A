"""RAG ingestion starter with Pinecone-compatible upsert payloads.

Usage:
  python docs/automation/rag/ingest_pinecone.py \
    --input docs/automation/rag/sample_documents.jsonl \
    --index aegis-action-knowledge \
    --namespace tenant-a \
    --dry-run

Input format (JSONL):
  {"id": "doc-1", "text": "...", "source_uri": "...", "source_timestamp": "2026-02-12T00:00:00Z", "tenant_id": "tenant-a", "tags": ["policy"]}
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List


@dataclass(slots=True)
class SourceDocument:
    doc_id: str
    text: str
    source_uri: str
    source_timestamp: str
    tenant_id: str
    tags: List[str]


def load_documents(path: Path) -> List[SourceDocument]:
    docs: List[SourceDocument] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue

            payload = json.loads(line)
            try:
                docs.append(
                    SourceDocument(
                        doc_id=str(payload["id"]),
                        text=str(payload["text"]),
                        source_uri=str(payload["source_uri"]),
                        source_timestamp=str(payload["source_timestamp"]),
                        tenant_id=str(payload["tenant_id"]),
                        tags=[str(item) for item in payload.get("tags", [])],
                    )
                )
            except KeyError as exc:
                raise ValueError(f"Missing field {exc} on line {line_number}") from exc

    return docs


def chunk_text(text: str, chunk_size: int = 600, overlap: int = 80) -> Iterable[str]:
    if chunk_size <= overlap:
        raise ValueError("chunk_size must be greater than overlap")

    cursor = 0
    length = len(text)
    while cursor < length:
        yield text[cursor : cursor + chunk_size]
        cursor += chunk_size - overlap


def pseudo_embedding(text: str, dimensions: int = 64) -> List[float]:
    """Deterministic hash embedding for local testing without external model dependencies."""
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    vector: List[float] = []
    for i in range(dimensions):
        byte = digest[i % len(digest)]
        vector.append(round((byte / 255.0) * 2 - 1, 6))
    return vector


def build_vector_records(documents: List[SourceDocument]) -> List[Dict[str, Any]]:
    records: List[Dict[str, Any]] = []

    for document in documents:
        for idx, chunk in enumerate(chunk_text(document.text)):
            chunk_id = f"{document.doc_id}::chunk::{idx}"
            records.append(
                {
                    "id": chunk_id,
                    "values": pseudo_embedding(chunk),
                    "metadata": {
                        "doc_id": document.doc_id,
                        "chunk_index": idx,
                        "text": chunk,
                        "source_uri": document.source_uri,
                        "source_timestamp": document.source_timestamp,
                        "tenant_id": document.tenant_id,
                        "tags": document.tags,
                    },
                }
            )

    return records


def upsert_pinecone(index_name: str, namespace: str, vectors: List[Dict[str, Any]]) -> None:
    api_key = os.getenv("PINECONE_API_KEY")
    if not api_key:
        raise RuntimeError("PINECONE_API_KEY is not set")

    try:
        from pinecone import Pinecone
    except Exception as exc:  # pragma: no cover - dependency optional in template
        raise RuntimeError("pinecone package is not installed; run 'pip install pinecone' first") from exc

    client = Pinecone(api_key=api_key)
    index = client.Index(index_name)

    batch_size = 100
    for offset in range(0, len(vectors), batch_size):
        batch = vectors[offset : offset + batch_size]
        index.upsert(vectors=batch, namespace=namespace)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build and optionally upsert RAG vectors with provenance metadata")
    parser.add_argument("--input", required=True, help="JSONL input file")
    parser.add_argument("--index", required=True, help="Pinecone index name")
    parser.add_argument("--namespace", required=True, help="Pinecone namespace")
    parser.add_argument("--dry-run", action="store_true", help="Do not call Pinecone; emit payload only")
    parser.add_argument(
        "--out",
        default="docs/automation/rag/upsert_payload.preview.json",
        help="Dry-run output path for generated vectors",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    docs = load_documents(input_path)
    vectors = build_vector_records(docs)

    if args.dry_run:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps({"index": args.index, "namespace": args.namespace, "vectors": vectors}, indent=2), encoding="utf-8")
        print(f"Dry run complete: wrote {len(vectors)} vectors to {out_path}")
        return

    upsert_pinecone(index_name=args.index, namespace=args.namespace, vectors=vectors)
    print(f"Upserted {len(vectors)} vectors to index={args.index}, namespace={args.namespace}")


if __name__ == "__main__":
    main()
