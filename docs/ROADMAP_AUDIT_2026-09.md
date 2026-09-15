# Roadmap Implementation Audit — September 2026

Branch: `roadmap-improvements` (base: `credibility-fixes` @ `1b983b9`).
Source roadmap: `docs/AEGIS_T2A_250_IMPROVEMENTS.md` (items 1–258 despite the "250" title).

Selection policy: make existing claims true first; then defense-relevant
security/supply-chain hardening; then reliability and observability; then
developer experience. No sprawling integrations, no large rewrites, no
speculative features. Every item below was verified by a passing test or a
CI check — not by assertion.

## Implemented (verified)

| Roadmap items | Change | Verification |
|---|---|---|
| #20 | Canonical cryptographic serialization: recursive key-sorted canonicalization for `hashObject`/`signObject`/`verifyObjectSignature` (fixes nested-field loss and idempotency collisions from the old `JSON.stringify` replacer-array approach) | `tests/core.test.ts` — 15/15 pass, incl. nested key-order determinism |
| #64 | DLP credit-card patterns now Luhn-validated (`luhnCheck`); card-shaped non-Luhn sequences no longer produce findings | `tests/security/dlp-luhn.test.ts` — 4/4 pass |
| #93 | `PromptInjectionDetector`: expanded from 12 to ~30 patterns, added real fourth layer (character-level Shannon entropy + low token-diversity detection), replaced the false "perplexity scoring" doc claim with an honest statistical-anomaly description | `tests/security/prompt-injection.test.ts` — 5/5 pass with a multi-category adversarial corpus + benign counterexamples |
| #94 | `LLMGuardrails` wired into the LLM completion path: `complete()` in `src/providers/llm/index.ts` now screens every response — blocks on critical violations (secret exposure), returns sanitized content on warnings; toggle via `LLM_GUARDRAILS_ENABLED` (default on) | `tests/providers/llm-facade.test.ts` — 3/3 pass |
| #94 | Fixed `LLMGuardrails.getStats()` (was hard-coded `blockedRequests: 0`, `requestCount` never incremented); removed dead `getDLPFilter()` call | `tests/security/llm-guardrails.test.ts` — 5/5 pass |
| #213 | Measured per-agent LLM token usage accounting: `TokenUsageTracker` + per-model pricing, reporter registry on the LLM facade, wired at startup; forwards cost to a budget recorder when attached | `tests/governance/token-usage.test.ts` — 5/5 pass |
| #60 | `approval_config` is now preserved through both OPA and local policy evaluation into `PolicyResult.metadata` (previously dropped, making policy-specific timeouts / `min_approvals` / `auto_deny_on_timeout` unreachable) | `tests/governance/policy-approval-config.test.ts` — 2/2 pass |
| #66 | Runtime `aegis.rego` restructured from overlapping `decision` rules to priority-ordered candidates — fixes real `eval_conflict_error` crashes (e.g. system_admin read, budget-exceeded read, dev-environment writes all errored before); 8 `opa test` unit tests added | `opa test src/governance/policy/opa/` — 8/8 pass |
| #66 | CI now runs `opa test` on the runtime policy (`opa-policy-checks` job in `automation-guards.yml`) and enforces `opa fmt` on it | workflow change |
| #147–149 | Temporal activities now carry an explicit retry policy (max 5 attempts, exponential backoff, non-retryable validation errors) and a 1-minute heartbeat timeout | typecheck clean; no live Temporal server required |
| #152 | Claim-check payload store: 7-day default TTL, expired payloads treated as missing (deleted on read), new `purgeExpiredPayloads()` for maintenance | `tests/workflow/temporal-payload.test.ts` — 4/4 pass |
| #155 | Removed the broken default `aegis-daily-compliance` schedule (started `planWorkflow` with an empty arg list, which the workflow rejects on every run) | documented in code |
| #16 | Sandbox path canonicalization: `~`/`$HOME`/`${HOME}` expansion, separator normalization, `.`/`..` resolution, canonical comparison against the blocklist | `tests/security/sandbox-guard.test.ts` — 12/12 pass |
| #199 | Removed false "Redis pub/sub" claim from revocation docs-code comments | wording fix |
| Defense | Supply-chain hardening: SPDX SBOM generation on every push/schedule (uploaded as CI artifact), weekly Dependabot for npm + GitHub Actions, advisory `npm audit` (high/critical) scan | `.github/workflows/supply-chain.yml`, `.github/dependabot.yml` |

## Quality gates (all verified 2026-09-15)

- `npm test`: **227 passing / 255 total**, 28 failing — the same 28 pre-existing failures as the `credibility-fixes` baseline (184/212); +43 new passing tests, zero regressions.
- `npm run typecheck`: **31 errors** — identical set to baseline (verified by diff against a clean worktree of `1b983b9`); zero new errors.
- `opa test src/governance/policy/opa/`: 8/8 pass; `opa fmt --fail`: clean.

## Audited and deliberately skipped

| Roadmap items | Reason for skipping |
|---|---|
| Vault integration (#44), Redis (#45) | Claimed-but-mock; making them real requires standing up external services — large integration work, correctly tiered as 📋 in the README. |
| Release signing / Sigstore provenance | No release pipeline exists in this repo; signing theater without a release workflow. Revisit when releases are cut. |
| `prom-client` metrics migration (#134) | The hand-written registry is label-less but functional; a swap touches every instrumented call site — a rewrite, not a fix. |
| Full ABAC dimensions in Rego (risk level, time-of-day, cost-vs-budget) | The runtime policy now evaluates correctly with priority ordering; adding speculative dimensions without consumers is feature theater. |
| OIDC / SPIRE issuance, Postgres main-runtime, Redis caching | All correctly tiered as 📋 planned; each is a multi-day integration, not a hardening fix. |
| Intent-plan semantic alignment upgrade | Current lexical/Jaccard alignment is real and tested; embedding-based alignment needs a model dependency. |

## New bugs found and fixed during this pass

1. **OPA `eval_conflict_error`**: the runtime `aegis.rego` defined 13 overlapping complete `decision` rules; any input matching two rules (system_admin + read, budget-exceeded + read, dev-environment + write, database-delete + dev) crashed policy evaluation instead of deciding. Restructured to priority-ordered candidates.
2. **Dropped `approval_config`**: both OPA and local evaluators discarded the policy's approval configuration, so `min_approvals`, `timeout_seconds`, and `auto_deny_on_timeout` never reached the approval service that reads them.
3. **Dead `complete()` facade**: the LLM provider facade had no guardrail or usage hooks; `LLMGuardrails` stats were hard-coded zeros.
4. **Broken default Temporal schedule**: `aegis-daily-compliance` started `planWorkflow` with `args: []`; the workflow throws on empty input, so every scheduled run failed.
5. **Payload store without expiry enforcement**: `expires_at` was stored but never checked; expired payloads lived forever.
