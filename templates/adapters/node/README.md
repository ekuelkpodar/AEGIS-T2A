# Node Adapter Template

A starter template for building AEGIS action adapters in Node/TypeScript.

## Interface

Adapters implement:

- `connect(config)`
- `validate(payload)`
- `simulate(payload, context)`
- `execute(payload, context)`
- `rollback(payload, context)`
- `healthCheck()`

## Included example

- `src/twilio_simulated.ts`: simulated Twilio adapter for sandbox execution.

## Run

```bash
npm install
npm run dev
```

For production adapters:

1. Replace simulated `execute` with provider SDK calls.
2. Inject secrets from Vault/env indirection, not plaintext.
3. Keep `simulate` behavior deterministic for approval previews.
