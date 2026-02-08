# Contributing to AEGIS-T2A

Thanks for contributing! This guide focuses on tool adapters and integration contributions.

## Quick start
1. Fork the repo.
2. Create a feature branch.
3. Run `npm install` and `npm run test:evaluation`.

## Tool adapter guidelines
- Each adapter must define capabilities, input/output schema, and risk level.
- Provide compensation action guidance for side-effect adapters.
- Ensure adapters declare rate limits and timeouts when applicable.
- Add fallback entries if using external bridges (e.g., Zapier MCP).

## Testing expectations
- Add or update golden intent/eval fixtures when behavior changes.
- Include at least one integration smoke test (mocked).

## Security expectations
- Do not log secrets.
- Ensure DLP filters are applied to outputs.
- Use the audit ledger for state-changing actions.

## Pull request checklist
- [ ] Tests passing (`npm run test:evaluation`)
- [ ] Updated docs (README or module docs)
- [ ] Added/updated schemas if needed
