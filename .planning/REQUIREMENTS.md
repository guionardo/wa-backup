# Requirements: WhatsApp Chat Backup (v1.1 — Media Hygiene)

**Defined:** 2026-08-24
**Core Value:** A person can open their WhatsApp history years later and see the full conversation — text and media together — without needing WhatsApp, a phone, or any account.

## v1.1 Requirements

Media deduplication: verify media by size + hash to detect duplicates and save disk space (users keep many inactive chats/groups; WhatsApp re-exports and cross-chat copies duplicate the same image/video).

### Media Deduplication

- [ ] **MEDIA-05**: During media reconciliation, compute each file's size and SHA-256 *streamingly* (memory-safe, via a `node:crypto` Transform in the extract pipe) to identify duplicates — no full-file buffering.
- [ ] **MEDIA-06**: Store each unique media file once under a content-addressed name `media/<sha256[:16]>.<ext>`; skip the write when the canonical path already exists (dedup at reconcile time).
- [ ] **MEDIA-07**: Emit `media/manifest.json` mapping each original media ref → `{ hash, relPath, size, mime }`, and make `buildMediaMap` manifest-first with a legacy directory-scan fallback so pre-v1.1 backups and existing tests stay green.
- [ ] **MEDIA-08**: Select the canonical copy deterministically (first-occurrence by stable message order) so re-runs are idempotent and output reproducible.
- [ ] **MEDIA-09**: Report dedup savings (files and bytes saved) to stderr at the end of the run.
- [ ] **MEDIA-10**: Provide a `--no-dedupe` flag to disable deduplication and keep original per-ref filenames.

### Deferred (not in v1.1)

- Cross-backup global store (`~/.wa-backup/store`) — needs v2 batch processing.
- Perceptual / near-duplicate detection (e.g. resized copies).
- Hardlink / symlink-based dedup — breaks portable `file://` viewing on exFAT/FAT32.
- Content-defined chunking (CDC) — no payoff for byte-identical re-exports.

## Out of Scope (carried from v1.0)

| Feature | Reason |
|---------|--------|
| Web UI in v1 | Separate delivery channel; web is v2 (reuses core) |
| System-event styling | v1 renders joined/left/encryption lines as plain lines |
| Sticker / GIF mapping | `_chat.txt` has no reference to them |
| Contact-list / participant aggregation | Lean; analytics is a later differentiator |
| Batch multiple zips in one run | One chat per run; web covers scale |
| Encryption of the backup output | Out of core-value scope |
| Parsing Google-Drive encrypted backup | Different, far larger problem |

## Traceability

Which phases cover which requirements (filled by the roadmap).

| Requirement | Phase | Status |
|-------------|-------|--------|
| MEDIA-05 | — | Planned |
| MEDIA-06 | — | Planned |
| MEDIA-07 | — | Planned |
| MEDIA-08 | — | Planned |
| MEDIA-09 | — | Planned |
| MEDIA-10 | — | Planned |

---
*Requirements defined: 2026-08-24 for v1.1 (Media Hygiene)*
