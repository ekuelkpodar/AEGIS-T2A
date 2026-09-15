# Documentation Index

Project documentation for AEGIS-T2A, organized by purpose.

## Roadmaps & status

- [`AEGIS_T2A_250_IMPROVEMENTS.md`](./AEGIS_T2A_250_IMPROVEMENTS.md) — Research-backed roadmap of 250 improvements with primary sources (identity, orchestration, RAG, sandboxing, integrations, observability, compliance, cost, DevEx).
- [`IMPLEMENTATION_ROADMAP.md`](./IMPLEMENTATION_ROADMAP.md) — Prioritized delivery sequence (MVP → Next → Long Term).
- [`IMPLEMENTATION_REPORT.md`](./IMPLEMENTATION_REPORT.md) — Phase-by-phase implementation status (Phases 1–16), including per-phase completion percentages. This is the most honest maturity signal in the repo — read it before the marketing-style sections of the README.
- [`DASHBOARD_ENHANCEMENTS.md`](./DASHBOARD_ENHANCEMENTS.md) — Dashboard feature roadmap.

## Engineering references

- [`CLAUDE.md`](./CLAUDE.md) — Contributor guide for AI assistants working in this repo (architecture conventions, coding standards, testing).
- [`automation/`](./automation) — Canonical action contract, JSON schemas, OpenAPI spec, examples, and RAG grounding docs. Guarded by CI (`.github/workflows/automation-guards.yml`).
- [`constraints/`](./constraints) — Operating constraints: failure modes, human override, observability, rollback.
- [`implementation/`](./implementation) — Week-by-week implementation notes (e.g., SPIFFE identity).

## Repo root

`README.md`, `CONTRIBUTING.md`, and `SECURITY.md` stay at the repository root.
