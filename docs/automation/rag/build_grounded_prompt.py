"""Build a provenance-aware prompt for action planning.

This script takes retrieval hits and produces a prompt block that:
1. grounds model output in evidence,
2. enforces citation requirements,
3. can be persisted in audit logs.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List


def build_prompt(user_intent: str, retrieval_hits: List[Dict[str, Any]]) -> str:
    evidence_lines = []
    for i, hit in enumerate(retrieval_hits, start=1):
        evidence_lines.append(
            f"[{i}] source_uri={hit.get('source_uri')} | source_timestamp={hit.get('source_timestamp')} | score={hit.get('score')}"
        )
        evidence_lines.append(f"[{i}] excerpt={hit.get('text')}")

    evidence_block = "\n".join(evidence_lines)

    return f"""You are an enterprise automation planner.

User intent:
{user_intent}

Retrieved evidence (authoritative context):
{evidence_block}

Requirements:
- Produce a structured action plan JSON.
- For each plan step, cite evidence IDs (e.g., [1], [2]).
- If evidence is insufficient, output `requires_human_review=true` and explain gaps.
- Never invent source facts beyond the provided evidence block.
"""


def main() -> None:
    retrieval_path = Path("docs/automation/rag/retrieval_hits.sample.json")
    payload = json.loads(retrieval_path.read_text(encoding="utf-8"))
    prompt = build_prompt(payload["user_intent"], payload["hits"])

    output_path = Path("docs/automation/rag/grounded_prompt.sample.txt")
    output_path.write_text(prompt, encoding="utf-8")
    print(f"Wrote grounded prompt to {output_path}")


if __name__ == "__main__":
    main()
