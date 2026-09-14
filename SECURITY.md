# Security Policy

AEGIS-T2A is a security and governance platform. We take vulnerability reports seriously and ask that you do the same: please report issues privately so we can fix them before they are publicly disclosed.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Use one of these private channels:

1. **GitHub private vulnerability reporting** (preferred): open a draft security advisory on this repository via the *Security* tab → *Report a vulnerability*. This keeps the report confidential between you and the maintainers.
2. If private reporting is unavailable, open a minimal issue titled "Security contact request" with no details, and a maintainer will establish a private channel.

## What to include

- A description of the vulnerability and its potential impact
- Steps to reproduce (proof of concept where possible)
- Affected version / commit, and environment details
- Any suggested mitigation, if you have one

## What to expect

- **Acknowledgement** within 3 business days of your report.
- **Status updates** as triage and remediation progress.
- **Coordinated disclosure**: we will work with you on a fix and a disclosure timeline before anything is published. We ask that you do not publicly disclose the issue until we have had a reasonable opportunity to address it.

## Scope

In scope: the AEGIS-T2A application (`src/`), the enterprise control-plane services (`controlplane/`), shipped policies and schemas (`policies/`, `docs/automation/`), and the reference deployment assets (`controlplane/docker-compose.yml`, `controlplane/spire/`).

Out of scope: denial-of-service volume testing, social engineering, physical attacks, and vulnerabilities in third-party dependencies without a demonstrated path to impact AEGIS-T2A itself (please report those to the upstream project).

## Safe harbor

We consider good-faith security research that follows this policy to be authorized. We will not pursue legal action against researchers who act in good faith, avoid privacy violations and service disruption, and give us reasonable time to remediate before disclosure.

## No bounty program (yet)

There is currently no paid bug-bounty program. Valid reports will be credited in release notes (unless you prefer to remain anonymous).
