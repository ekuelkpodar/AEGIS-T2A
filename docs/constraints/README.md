# AEGIS-T2A System Constraints

This directory contains the authoritative documentation for all system constraints that govern the AEGIS-T2A Text-to-Action Anywhere platform.

## Constraint Categories

| Document | Description |
|----------|-------------|
| [FAILURE_MODES.md](./FAILURE_MODES.md) | Failure modes the system must tolerate with mitigation strategies |
| [HUMAN_OVERRIDE.md](./HUMAN_OVERRIDE.md) | Human override semantics and approval workflows |
| [OBSERVABILITY.md](./OBSERVABILITY.md) | Observability primitives and retention requirements |
| [ROLLBACK.md](./ROLLBACK.md) | Rollback granularity and compensation strategies |

## Confirmed Design Constraints

The following constraints have been confirmed and apply to all downstream design decisions:

1. **All Failure Modes = MUST Tolerate** - Every enumerated failure mode is a hard requirement
2. **Human Override = Hybrid Model** - Low-risk auto-execute; medium-risk async approval; high-risk multi-signer
3. **Observability = Full Coverage** - Signed JSON audit logs, hash-chained events, OTEL traces, replayability
4. **Rollback = Hybrid Strategy** - Per-action compensation + per-workflow fallback + time-travel for supported systems

## Constraint Enforcement

These constraints are enforced at multiple levels:

- **Design Phase**: All architectural primitives must address enumerated failure modes
- **Implementation Phase**: Testable assertions verify constraint compliance
- **Runtime Phase**: Policy engine validates operations against constraints
- **Audit Phase**: Observability stack captures evidence of constraint adherence

## Requirements Traceability

Each constraint maps to:
- Architectural primitives responsible for enforcement
- Testable assertions for verification
- Monitoring/alerting for runtime detection

See individual documents for detailed mappings.
