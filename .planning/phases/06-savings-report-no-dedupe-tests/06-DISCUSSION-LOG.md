# Phase 6: Savings Report, `--no-dedupe`, & Tests — Discussion Log

**Date:** 2026-08-24
**Mode:** default
**Scope:** MEDIA-09 (savings report) + MEDIA-10 (`--no-dedupe`) + Tests

## Participants
- User
- GSD discuss-phase agent

## Session

### Gray-area selection
Presented 4 phase-specific gray areas (multi-select):
1. `--no-dedupe` naming
2. Manifest under `--no-dedupe`
3. Savings report + `--inline` (MEDIA-09)
4. Flag name & tests

User selected: **`--no-dedupe` naming** only. Areas 2–4 were not discussed and are carried as research defaults in `06-CONTEXT.md`.

### Deep-dive: `--no-dedupe` naming

**Q1 — Filename basis when `--no-dedupe` is on**
- Options: By original ref (`m.media`) [recommended] vs By ZIP entry basename.
- User chose: **By original ref (`m.media`)** → `media/<ref>`, consistent with manifest / buildMediaMap / messages.csv.
- Recorded as **D-06.1**.

**Q2 — Collision handling**
- Options: Append disambiguator [recommended] vs Overwrite.
- User chose: **Append disambiguator** → on name collision (incl. case-insensitive FS), append `-2` / `<shortsha>`; never overwrite.
- Recorded as **D-06.2**.

### Carried defaults (not discussed)
- Manifest still written under `--no-dedupe` with original `relPath` + full 64-hex hash (honors D-05.1); `duplicatesRemoved`/`bytesSaved` = 0.
- MEDIA-09: keep Phase 5 dedup savings line; add a separate `--inline` inlined-bytes stderr line.
- Flag: `--no-dedupe` (opt-out; dedup default). Tests: round-trip, savings line, inline interaction.

## Outcomes
- D-06.1, D-06.2 locked.
- Remaining MEDIA-09 / MEDIA-10 details resolved via research defaults for the planner.
- Deferred: `--verify` integrity re-scan (future phase).

*Phase: 06-savings-report-no-dedupe-tests*
