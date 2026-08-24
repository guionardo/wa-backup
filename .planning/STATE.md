---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Media Hygiene
current_phase: 06
status: discuss
stopped_at: Phase 6 discuss complete
last_updated: "2026-08-24T12:50:00.000Z"
last_activity: 2026-08-24
last_activity_desc: Phase 06 discuss complete — --no-dedupe naming (D-06.1/D-06.2)
progress:
  total_phases: 3
  completed_phases: 2
  total_plans: 2
  completed_plans: 2
current_phase_name: savings-report-no-dedupe-tests
state_head: de9073fcd3f5a3c9daabe81df90c6853a720127
---

# STATE.md

## Project Reference

See: .planning/PROJECT.md (updated 2026-08-21)
**Core value:** A person can open their WhatsApp history years later and see the full conversation — text and media together — without needing WhatsApp, a phone, or any account.
**Current focus:** Phase 05 — manifest-bridge

## Phase Status

| Phase | Status | Plans | Progress |
|-------|--------|-------|----------|
| 1 | ✓ Complete | 7/7 | 100% |
| 2 | ✓ Complete | 1/1 | 100% |
| 3 | ✓ Complete | 1/1 | 100% |
| 4 | ✓ Complete | 1/1 | 100% |
| 5 | ✓ Complete | 1/1 | 100% |
| 6 | ● Discuss complete | 0/TBD | 0% |

## Current Position

Phase: 06 — DISCUSS COMPLETE
Plan: 0/TBD
Status: Phase 06 discuss complete — ready for /gsd-plan-phase 6
Last activity: 2026-08-24 — Phase 06 discuss complete

## Active Feature

Phase 06 savings-report-no-dedupe-tests — MEDIA-09 (dedup savings report to stderr) + MEDIA-10 (`--no-dedupe` opt-out flag) + Tests.

## Recent Activity

- 2026-08-24: Milestone v1.1 "Media Hygiene" started — research synthesis complete (HIGH confidence).
- 2026-08-24: Roadmap v1.1 drafted — Phase 4 (MEDIA-05/06), Phase 5 (MEDIA-07/08), Phase 6 (MEDIA-09/10 + tests). 100% requirement coverage.
- 2026-08-22: Phase 3 COMPLETE — media reconciliation & embedding shipped; 43 tests pass.
- 2026-08-22: Phase 2 COMPLETE — multi-format rendering shipped; 37 tests pass.
- 2026-08-21: Phase 1 VERIFIED — streaming tracer parser + CSV source-of-truth.

## Session

**Last session:** 2026-08-24T12:50:00.000Z
**Stopped at:** Phase 6 discuss complete
**Resume file:** .planning/phases/06-savings-report-no-dedupe-tests/06-CONTEXT.md

## Performance Metrics

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 01 P01-01 | 45m | 2 tasks | 12 files |
| Phase 01 P01-02 | 25m | 2 tasks | 5 files |
| Phase 01 P01-03 | 20m | 2 tasks | 5 files |
| Phase 01 P01-04 | 15m | 2 tasks | 4 files |
| Phase 01 P01-05 | 10m | 1 tasks | 2 files |
| Phase 01 P01-06 | 10m | 1 tasks | 4 files |
| Phase 01 P01-07 | 5m | 1 tasks | 1 files |
| Phase 03 03-01 | 35m | 6 tasks | 6 files |

## Decisions

- [Phase 01]: extractChatTxt returns AsyncIterable<string> — Node 26 readline for-await hang workaround
- [Phase 01]: SENDER_RE separator `:` + whitespace or EOL — empty-body lines merge, URLs safe
- [Phase ?]: Omitted-marker brackets optional (Android drops them); detection is lazy in-stream single pass
- [Phase ?]: runParser returns added-count; CSV merge is the incremental source-of-truth mechanism (D-13/D-16/D-17)
- [Phase 02]: Single CLI run emits CSV+JSON+MD+HTML; renderers re-read messages.csv (D-20/D-22)
- [Phase 02]: metadata.chatName = display name (e.g. "Plataforma WK"); folder = slug (plataforma-wk)
- [Phase 02]: Outgoing side = most-frequent author (no self marker in export); SHA-256(author)%360 -> hue
- [Phase 02]: eta 4.6 unavailable offline -> HTML shell via inline TS templates (deviation)
- [Phase 03]: reconcileMedia reads the ZIP central directory (random-access) + streams each member via Node `zlib.createInflateRaw` — fflate streaming inflate breaks on data-descriptor members (deviation, Rule 1)
- [Phase 03]: match by entry BASENAME (not full path) so zips with a folder prefix also reconcile (MEDIA-01 robustness)
- [Phase 03]: disk-resident `buildMediaMap(dir, messages)` decouples renderers from the zip — re-render from CSV works without the archive (D-M5)
- [Phase 03]: `--inline` embeds inlineable files (< 8 MiB, non-video) as `data:` URIs; video/oversized stay placeholders; unresolved refs reported to stderr, never crash (MEDIA-03/04)
- [Phase 04-06 v1.1]: SHA-256 via `node:crypto` streaming Transform in `extractEntry` (constant memory); CAS `media/<sha256[:16]>.<ext>`; no hardlinks/symlinks; `media/manifest.json` regenerated every run from refs (messages.csv stays source-of-truth); first-occurrence canonical selection; `--no-dedupe` opt-out (research: HIGH confidence)
- [Phase 06 D-06.1]: `--no-dedupe` stores files by original ref `media/<ref>` (m.media from _chat.txt); dedup-on keeps CAS naming. One consistent key across manifest/buildMediaMap/csv.
- [Phase 06 D-06.2]: Under `--no-dedupe`, on name collision (incl. case-insensitive FS) append a short disambiguator (`-2` / `<shortsha>`); never overwrite.

## Operator Next Steps

- Begin Phase 6 planning with /gsd-plan-phase 6 --skip-research
