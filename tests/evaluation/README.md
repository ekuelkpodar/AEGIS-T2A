# Evaluation Harness

This directory contains lightweight evaluation scaffolding for AEGIS-T2A.

- `golden-intents.json`: small golden dataset for intent parsing checks.
- `runner.ts`: heuristic evaluation runner (safe for offline CI).

Run locally:

```bash
npx tsx tests/evaluation/runner.ts
```

The runner exits non-zero if any checks fail.
