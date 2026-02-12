# Adapter Templates

Pluggable adapter starter kits for AEGIS automation connectors.

- `node/`: TypeScript adapter template + simulated Twilio adapter.
- `python/`: Python adapter template + simulated Twilio adapter.

Both templates expose the same lifecycle contract:

- `connect`
- `validate`
- `simulate`
- `execute`
- `rollback`
- `health_check`

Use these templates to build production adapters for CRM, ERP, telephony, and database systems.
