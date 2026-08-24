# Retrospective

## Milestone: v1.0 — MVP

**Shipped:** 2026-08-24
**Phases:** 3 | **Plans:** 8 | **Tasks:** 14 | **Commits:** 93

### What Was Built

- Streaming, locale-tolerant WhatsApp `_chat.txt` parser → `messages.csv` source-of-truth.
- Three synchronized outputs (JSON / Markdown / WhatsApp-like HTML), XSS-escaped.
- Media reconciliation + `--inline` base64 embedding; `<Media omitted>`/deleted/missing preserved as placeholders.
- URL title enrichment (YouTube, Reddit, LinkedIn, Medium, Stack Overflow, X) with favicons and `--no-fetch-titles` offline opt-out.
- Full README, public GitHub repo, green CI (lint → test → build on Node 22/24), npm publish with provenance.

### What Worked

- Single CLI run re-reading `messages.csv` kept renderers decoupled from the parser (clean re-render without the ZIP).
- `overrides` for esbuild cleanly cleared the Dependabot advisory without touching runtime deps.
- Generating synthetic, non-personal fixtures in CI made the suite portable and privacy-safe.

### What Was Inefficient

- fflate's streaming inflate broke on data-descriptor members (nested `.zip` attachment); had to switch to ZIP central-directory + random-access inflate mid-phase.
- Two npm publish attempts failed (2FA token, then duplicate version) before landing on `0.1.1`.

### Patterns Established

- CSV as authoritative model; JSON/MD/HTML are projections.
- Media matched by basename (case-insensitive, ignoring `(1)`/dash/space variance).

### Key Lessons

- Decouple the CI publish trigger from milestone tags: a `vX.Y` milestone tag should not republish the npm package at a different semver (use `v<npm-version>` tags, or gate publish on tag == package version).
- Keep the npm version and the GSD milestone version independent; communicate both.

### Cost Observations

- Single-developer project; milestone closed via GSD complete-milestone workflow.
- Notable: the publish job's `v*` trigger is a latent hazard for milestone tags.

---

## Cross-Milestone Trends

_(first milestone — baseline established)_
