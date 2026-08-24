# Phase 6: Savings Report, `--no-dedupe`, & Tests - Context

**Gathered:** 2026-08-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Final v1.1 phase. Delivers MEDIA-09 (report dedup savings — files and bytes saved — to stderr at end of run) and MEDIA-10 (a `--no-dedupe` flag to disable deduplication and keep original per-ref filenames), plus the test coverage that closes the milestone.

Scope is fixed by ROADMAP.md / REQUIREMENTS.md: dedup savings reporting + opt-out flag + tests. No new media capabilities.

</domain>

<decisions>
## Implementation Decisions

### Discussed this session

- **D-06.1 — `--no-dedupe` stores files by the original ref (`m.media`).** Filename = `media/<ref>` (the referenced filename from `_chat.txt`, sanitized). One consistent key across `manifest.json`, `buildMediaMap`, and `messages.csv`. The content-addressed `media/<sha256[:16]>.<ext>` naming (Phase 4 D-01) is used ONLY when dedup is on (the default). — **Reversibility:** reversible (local naming branch in `reconcileMedia`).
- **D-06.2 — Collision handling under `--no-dedupe`: append a disambiguator, never overwrite.** If the generated `media/<ref>` path already exists (e.g. case-insensitive FS: `photo.jpg` vs `PHOTO.JPG`), append a short disambiguator (`-2`, or `<shortsha>` when the colliding file differs) so both files are kept. No silent data loss. — **Reversibility:** reversible.

### Carried as research defaults (NOT separately discussed this session)

- **Manifest under `--no-dedupe` (default):** `reconcileMedia` STILL writes `media/manifest.json` when `--no-dedupe` is on, with `relPath = media/<ref>` (original), one entry per ref, and the full 64-hex `hash` still computed (it is cheap streaming and keeps CSV re-render + a future `--verify` working — honors Phase 5 D-05.1). `duplicatesRemoved` / `bytesSaved` = 0 (no dedup happened). `buildMediaMap` manifest-first still resolves correctly because `relPath` points at the original-named file.
- **Savings report + `--inline` (MEDIA-09, default):** Phase 5 already prints `N duplicate(s) removed (X saved)` to stderr when `duplicatesRemoved > 0`. Keep that line. Additionally, when `--inline` is set, add a separate stderr line reporting total bytes inlined into the HTML (a distinct metric from folder-disk savings — dedup still shrinks the folder, `--inline` embeds each copy). Format: keep the existing human-readable summary block; the `--inline` line is additive, not a replacement.
- **CLI flag design (MEDIA-10, default):** exact flag `--no-dedupe` (opt-out; deduplication remains the default). No companion `--dedupe` flag needed. Thread the flag through `index.ts` → `runParser` options → `reconcileMedia`.
- **Tests scope (default):** add coverage for (a) `--no-dedupe` round-trip — files stored by original ref, no collapse, disambiguator applied on collision; (b) dedup savings line present in stderr when duplicates exist; (c) `--inline` dedup interaction (folder shrinks via dedup, inline embeds each copy). Existing dedup + manifest tests must stay green.

### Carried forward from earlier phases (do not re-litigate)

- **Phase 4 D-01** — dedup-on filename `media/<sha256[:16]>.<ext>` (ext preserved).
- **Phase 4 D-04** — trust-the-stream skip-if-exists (no re-verify of written bytes).
- **Phase 4 D-05** — original→canonical mapping via `MediaEntry.relPath`; renderers/`Message`/`messages.csv` untouched.
- **Phase 4 D-06** — no new runtime deps; memory-safe streaming (no full-file buffering); no hardlinks/symlinks.
- **Phase 5 D-05.1** — manifest `hash` = full 64-hex sha256 (filename keeps 16-hex prefix).
- **Phase 5 D-05.2** — one manifest entry per original ref.
- **Phase 5** — `buildMediaMap` manifest-first EXCLUSIVE + legacy directory-scan fallback; atomic manifest write; `ReconcileResult.duplicatesRemoved`/`bytesSaved`; `runParser` already prints the dedup savings line.

### the agent's Discretion

- Exact disambiguator format in D-06.2 (`-2` vs `<shortsha>`) — either is acceptable; pick the lower-risk one (no collision with real names).
- Exact wording/format of the `--inline` inlined-bytes stderr line (MEDIA-09 default) — keep it consistent with the existing dedup savings line.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — MEDIA-09 (savings report to stderr) + MEDIA-10 (`--no-dedupe` flag); v1.1 Deferred list (hardlinks, perceptual dedup, CDC all out of scope).
- `.planning/ROADMAP.md` — Phase 6 "Savings Report, `--no-dedupe`, & Tests" (final v1.1 phase).

### Prior phase context (this milestone)
- `.planning/phases/05-manifest-bridge/05-CONTEXT.md` — D-05.1 (full 64-hex hash), D-05.2 (one entry per ref), manifest-first-exclusive + legacy fallback, atomic write.
- `.planning/phases/05-manifest-bridge/05-01-SUMMARY.md` — what Phase 5 shipped: `media/manifest.json` bridge, `ReconcileResult.duplicatesRemoved`/`bytesSaved`, `runParser` dedup stderr report, `formatBytes` helper in `src/model.ts`.

### Research
- `.planning/research/ARCHITECTURE.md` §Step 4 (runParser report enhancement) and §Step 6 (optional `--verify` — out of v1.1 core) — design basis for the savings report and the opt-out flag.

### Code (current implementation to modify)
- `src/media.ts` — `reconcileMedia` (CAS naming + skip-if-exists dedup + manifest write), `canonicalMediaName`, `ReconcileResult` (`duplicatesRemoved`/`bytesSaved`), `buildMediaMap` (manifest-first + `legacyScan`).
- `src/media-manifest.ts` — `writeManifest` (atomic), `readManifest`, `legacyScan`.
- `src/model.ts` — `runParser` options + stderr media report + `formatBytes`.
- `src/index.ts` — CLI flags (currently `--inline`, `--no-fetch-titles`, `--verbose`; no `noDedupe` yet).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `canonicalMediaName(hash, ext)` (`src/media.ts`) — produces the dedup-on filename; reuse for the default path, add a separate `originalMediaName(ref)` branch for `--no-dedupe`.
- `writeManifest` / `readManifest` / `legacyScan` (`src/media-manifest.ts`) — pure module; `--no-dedupe` only changes the `relPath` values written, not these functions.
- `formatBytes` + the dedup-report line in `src/model.ts` `runParser` — extend for the `--inline` inlined-bytes line (MEDIA-09 default).
- `ReconcileResult.duplicatesRemoved` / `bytesSaved` — already computed in Phase 5; the report already consumes them; `--no-dedupe` simply yields 0.

### Established Patterns
- CLI flag threading: `index.ts` `.option(...)` → `runParser(zip, { ...opts })` → `reconcileMedia(zip, dir, refs, opts)`. Add `noDedupe` the same way `inline`/`verbose` flow.
- Atomic manifest write (`.tmp-<uuid>` → `renameSync`) — keep for `--no-dedupe` too.
- Renderers / `Message` / `messages.csv` stay untouched (D-05/D-06) — the `--no-dedupe` flag only changes `reconcileMedia` naming + the stderr report.

### Integration Points
- `reconcileMedia` is the single mutation point: branch on `noDedupe` to choose `originalMediaName(ref)` vs `canonicalMediaName(hash, ext)`, and to skip the `if exists → unlink` dedup.
- `buildMediaMap` needs no change — manifest-first already resolves by `relPath`; under `--no-dedupe` the manifest's `relPath` is the original name, so legacy/CSV re-render keeps working.

</code_context>

<specifics>
## Specific Ideas

No specific external references beyond the milestone research. User chose: name `--no-dedupe` files by original ref, disambiguate collisions (no overwrite).

</specifics>

<deferred>
## Deferred Ideas

- **`--verify` integrity re-scan** — re-hash on-disk `media/*` against `manifest.json` to detect bit-rot. Out of v1.1 core (research Step 6/Step 7); the durable manifest makes it cheap later. Belongs in a future phase, not Phase 6.
- **Hardlink/symlink dedup, perceptual dedup, CDC** — explicitly deferred in REQUIREMENTS.md (v1.1 Deferred).

</deferred>

---

*Phase: 06-savings-report-no-dedupe-tests*
*Context gathered: 2026-08-24*
