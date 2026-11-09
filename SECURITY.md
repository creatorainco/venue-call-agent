# Security

## Visibility

This repository is public by Peter's ruling of 2026-09-15 ("keep the venue call agent to be
public"; "Scrub, then public"). It holds no product facts: the `verify` check fails on a hardcoded
product noun, and in CI on a real venue name. It holds no credentials: every secret is read from the
environment, and `.env` is never committed.

Public does not mean open source. The code is all rights reserved; see [LICENSE](LICENSE).

## Reporting an issue

Email peter@creatorain.com. Please do not open a public issue or pull request for a security
problem, and do not include a live credential in the report.
