# Automation Blueprint Artifacts

This folder contains implementation-ready artifacts for evolving AEGIS-T2A into a general-purpose enterprise Text-to-Action platform.

## Included

- `schemas/action.schema.json`: Canonical, industry-agnostic action definition schema.
- `examples/*.json`: Example actions for logistics, healthcare, and energy.
- `openapi/action-registry.openapi.yaml`: API contract for action registry + validation + simulation.
- `rag/`: RAG ingestion and provenance prompt templates.
- `../../templates/adapters/`: Node/Python adapter SDK templates with simulated Twilio examples.
- `../../policies/examples/industry/`: Rego templates for healthcare, logistics, and finance.

## How to use

1. Validate each action definition against `schemas/action.schema.json` in CI.
2. Register valid definitions via the action-registry API.
3. Run `simulate` endpoint before enabling production execution for high-risk actions.
4. Keep action versions immutable; create a new semantic version for every breaking change.
