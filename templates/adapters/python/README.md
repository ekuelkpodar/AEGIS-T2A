# Python Adapter Template

A starter template for building AEGIS action adapters in Python.

## Interface

Implement `AdapterPlugin` methods:

- `connect(config)`
- `validate(payload)`
- `simulate(payload, context)`
- `execute(payload, context)`
- `rollback(payload, context)`
- `health_check()`

## Included example

- `aegis_adapter_template/twilio_simulated.py`: simulated Twilio adapter.
- `example.py`: runs sandbox simulation/execution.

## Run

```bash
python example.py
```

For production adapters:

1. Use provider SDKs in `execute`.
2. Resolve secrets via Vault/environment indirection.
3. Keep simulation deterministic for approval previews.
