# Milestones

## v1.0 MVP (Shipped: 2026-08-24)

**Phases completed:** 3 phases, 8 plans, 14 tasks

**Key accomplishments:**

- Streaming, locale-tolerant parser turns a WhatsApp export ZIP into a `messages.csv` source-of-truth message model (Phase 1).
- Single CLI run emits synchronized JSON / Markdown / WhatsApp-like HTML, all XSS-escaped, with per-sender color, day dividers, and a click-to-zoom lightbox (Phase 2).
- Media reconciliation copies referenced files into the output folder with relative paths, and `--inline` produces a self-contained base64 HTML; `<Media omitted>`/deleted/missing refs render as placeholders without crashing (Phase 3).
- URL title enrichment resolves web link titles (YouTube, Reddit, LinkedIn, Medium, Stack Overflow, X) with favicons, with a `--no-fetch-titles` offline opt-out.
- Comprehensive README + public GitHub repo with green CI (lint → test → build on Node 22/24) and npm publish with provenance.
- Released to npm as `wa-backup@0.1.1`.

---
