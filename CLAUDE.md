# AEGIS-T2A Assistant Guide

## Project overview
AEGIS-T2A is a governed, multi-agent automation platform. The core runtime is TypeScript with modular services for intent parsing, planning, execution, audit, and policy.

## Architecture conventions
- Prefer small modules with explicit exports.
- Keep security boundaries obvious (gateway → planner → executor → audit).
- Use existing schemas in `src/core/types.ts`.

## Coding standards
- TypeScript, ES2022, NodeNext module resolution.
- Avoid new dependencies unless required.
- Prefer `apply_patch` for single-file edits.

## Safety and governance
- Ensure audit trail updates for actions that mutate state.
- Apply DLP redaction where outputs are serialized.

## Testing
- Run `npm run test:evaluation` for quick checks.
- Keep tests deterministic; avoid network access in unit tests.
