# Security Policy

## Supported versions

This project is a reference implementation under active development. Security
fixes are applied to the `main` branch only.

## Reporting a vulnerability

Please report suspected vulnerabilities privately rather than opening a public
issue. Use GitHub's **[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)**
on this repository (Security → Report a vulnerability).

When reporting, please include:

- affected area (protocol, server, client) and version/commit,
- reproduction steps or a proof of concept,
- the `traceId` from any `INTERNAL_ERROR` event, if applicable,
- impact assessment.

You can expect an initial acknowledgement within a few days. Please allow time
for a fix before any public disclosure.

## Scope notes

This repository intentionally models production concerns without being a
hardened deployment. Known deployment-scale limitations (single-process state,
per-process rate limiting, unauthenticated read/metrics endpoints) are
documented in [`docs/ROADMAP.md`](./docs/ROADMAP.md) and are out of scope for
vulnerability reports unless they enable an attack beyond those documented
constraints.
