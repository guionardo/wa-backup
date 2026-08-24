---
phase: 05-manifest-bridge
plan: 01
subsystem: media
tags: [manifest, dedup, reconcile, content-addressed-storage, streaming-sha256]

# Dependency graph
requires:
  - phase: 04
    provides: streaming SHA-256 + content-addressed store + activeReconcileMap bridge
provides:
  - media/manifest.json artifact (ref -> canonical file map, full sha256)
  - manifest-first buildMediaMap with legacy directory-scan fallback
  - ReconcileResult.duplicatesRemoved / bytesSaved + stderr report
affects: [06-no-dedupe-inline, re-render-from-csv, verify-integrity]

# Actuals (#2632) — chars/4 over the realized diff (18071 chars)
actuals:
  tokens: 4518
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - atomic-write: '.tmp-<uuid> -> renameSync' for manifest persistence
    - manifest-first-exclusive: manifest authoritative; missing file => absent
    - legacy-fallback: directory scan when no manifest.json (pre-v1.1 folders)

key-files:
  created:
    - src/media-manifest.ts
    - test/media-manifest.test.ts
  modified:
    - src/media.ts
    - src/model.ts
    - test/media.test.ts

key-decisions:
  - "D-05.1 honored: manifest entry hash = full 64-hex sha256; filename keeps 16-hex prefix (Phase 4 D-01)"
  - "D-05.2 honored: one manifest entry per original ref; duplicates repeat hash/relPath/size/mime"
  - "buildMediaMap = manifest-first EXCLUSIVE; legacy dir-scan fallback when no manifest.json"
  - "dedup key = canonical name (hash[:16]+ext), not bare hash — keeps same-content/different-extension files resolvable"
  - "Renderers / Message / messages.csv unchanged; MediaEntry.hash optional, ignored by renderers"

patterns-established:
  - "Atomic manifest write via temp + rename; never leaves a half-written manifest"
  - "legacyScan excludes manifest.json / .tmp-* / ._ files"

requirements-completed:
  - MEDIA-07
  - MEDIA-08

coverage:
  - id: D1
    description: "reconcileMedia writes media/manifest.json with one entry per original ref, full 64-hex hash, CAS relPath"
    requirement: MEDIA-07
    verification:
      - kind: unit
        ref: "test/media-manifest.test.ts#manifest bridge: reconcileMedia writes manifest.json; buildMediaMap reads it"
        status: pass
    human_judgment: false
  - id: D2
    description: "buildMediaMap reads manifest first (manifest-first, exclusive) with legacy dir-scan fallback for pre-v1.1 folders"
    requirement: MEDIA-07
    verification:
      - kind: unit
        ref: "test/media.test.ts#buildMediaMap: resolves disk files tolerant of (1) variance + inlineable flag"
        status: pass
    human_judgment: false
  - id: D3
    description: "Duplicate sets collapse to one canonical file; two runs on same ZIP are byte-identical; first-occurrence canonical chosen deterministically"
    requirement: MEDIA-08
    verification:
      - kind: unit
        ref: "test/media.test.ts#CAS: byte-identical different names stored once, both refs resolve"
        status: pass
    human_judgment: false
  - id: D4
    description: "ReconcileResult carries duplicatesRemoved/bytesSaved; runParser prints them to stderr when > 0"
    requirement: MEDIA-08
    verification:
      - kind: integration
        ref: "runParser on synthetic duplicate fixture -> stderr contains 'duplicate(s) removed'"
        status: pass
    human_judgment: false

# Metrics
duration: 8min
completed: 2026-08-24
status: complete
---

# Phase 5 Plan 1: Manifest Bridge Summary

**Persisted `media/manifest.json` mapping every original media ref to its content-addressed canonical file, switched `buildMediaMap` to manifest-first with a legacy directory-scan fallback, and surfaced dedup savings on stderr — delivering MEDIA-07 + MEDIA-08.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-08-24T12:26:11Z
- **Completed:** 2026-08-24T12:34:03Z
- **Tasks:** 3
- **Files modified:** 5 (2 new, 3 modified)

## Accomplishments

- New `src/media-manifest.ts`: `writeManifest` (atomic `.tmp-<uuid>.json` -> `renameSync`), `readManifest` (shape guard — throws if `entries` is not an array, T-05-01), `legacyScan` (directory scan that excludes `manifest.json` / `.tmp-*` / `._`).
- `reconcileMedia` now writes `media/manifest.json` at end of extraction: one `MediaManifestEntry` per original ref (D-05.2), full 64-hex `hash` (D-05.1), and tracks `duplicatesRemoved` / `bytesSaved`.
- `buildMediaMap` is manifest-first and EXCLUSIVE: reads the manifest; a ref whose file is missing on disk is treated as absent (no re-scan). Falls back to `activeReconcileMap` then to `legacyScan` for pre-v1.1 folders without a manifest.
- `runParser` stderr media report now appends `N duplicate(s) removed (X saved)` whenever `duplicatesRemoved > 0`.
- `MediaEntry` gained optional `hash`; `ReconcileResult` gained `duplicatesRemoved` / `bytesSaved`. Renderers, `Message`, and `messages.csv` are untouched (D-06).

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end manifest bridge (write in reconcileMedia, read in buildMediaMap)** - `8a80023` (feat)
2. **Task 2: Surface dedup savings on stderr in runParser** - `58bfe40` (feat)
3. **Task 3: Keep test/media.test.ts green + add four required manifest coverages** - `f43ecda` (test)

## Files Created/Modified

- `src/media-manifest.ts` - new manifest read/write + legacyScan module (pure, no ZIP import)
- `src/media.ts` - `reconcileMedia` writes manifest + dedup accounting; `buildMediaMap` manifest-first; `ReconcileResult` + `MediaEntry` extended
- `src/model.ts` - `runParser` dedup report + `formatBytes` helper
- `test/media-manifest.test.ts` - new tracer test: write+read manifest, 17 entries, CAS relPath
- `test/media.test.ts` - filters `manifest.json`/`.tmp-*` in file enumeration; adds dedup/manifest assertions

## Decisions Made

- Carried D-05.1 / D-05.2 / manifest-first-exclusive / legacy-fallback / determinism exactly as locked in 05-CONTEXT.md.
- Dedup keyed on the **canonical name** (`hash[:16]+ext`) rather than the bare `hash` (deviation below) — required so byte-identical content under different extensions still resolves to a real on-disk file.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Correctness] Dedup key changed from bare hash to canonical name (`hash[:16]+ext`)**
- **Found during:** Task 1 (reconcileMedia write loop)
- **Issue:** The plan pseudocode keyed `committedHashes` on the bare `hash`. The Notas fixture (and real exports) can contain byte-identical bytes under *different* extensions (e.g. `.mp4` vs `.webp` as placeholder content). Keying on bare hash collapsed distinct files into one, so `buildMediaMap` could not resolve a ref whose extension differed from the first-written copy — breaking the "every ref resolves" success criterion and the tracer test (video ref unresolved).
- **Fix:** Tracked `committedNames = new Set<string>()` keyed on `canonicalName` (the actual on-disk identity). Same-content/same-ext refs still collapse to one file; same-content/different-ext refs each keep a resolvable file. Counting (within-norm redundancy + cross-norm duplicate) is unchanged.
- **Files modified:** `src/media.ts`
- **Verification:** `test/media-manifest.test.ts` resolves the video ref; `npm test` 105/105 pass; `duplicatesRemoved`/`bytesSaved` still correct for the CAS (A.png/B.png) case.
- **Committed in:** `8a80023`

**2. [Plan-checker warning #1] Task 2 verify made a positive assertion**
- **Found during:** Task 2 (verification)
- **Issue:** The plan's `<verify>` used `grep -E "duplicate|saved" || echo "no-dup-run-ok"`, which always exits 0 (false green).
- **Fix:** Replaced with a positive assertion — run `runParser` on a synthetic duplicate fixture and `grep` for `duplicate(s) removed`, exiting non-zero when absent. Verified it passes and fails when no duplicates exist.
- **Files modified:** (verification only — no source change required)
- **Committed in:** verified against `58bfe40`

### Qualification of MEDIA-08 "byte-identical" criterion (plan-checker warning #2)

- **media/ files** are byte-identical across two runs on the same ZIP (content-addressed, deterministic first-occurrence canonical).
- **manifest.json** content is content-deterministic: `entries`/`unresolved`/`duplicatesRemoved`/`bytesSaved` are fully determined by the ZIP + refs. The only non-substantive field is `generatedAt: new Date().toISOString()` (execution timestamp, kept per D-05 write policy). `generatedAt` is excluded from the byte-identical claim.

**Total deviations:** 2 (1 correctness auto-fix, 1 verification-strengthening). No scope creep; both required for the plan's success criteria to hold.

## Issues Encountered

- `npm run typecheck` and `npm run lint` already report pre-existing errors/warnings on `main` **unrelated to this plan**: `src/render/js/linkify.js` has no type declaration (TS7016/TS7006 in `src/render/{html,md}.ts`, `src/title.ts`, and `test/{linkify,render,title}.test.ts`), and `src/model.ts` carries 5 pre-existing lint warnings. These exist on the pristine `HEAD` (verified via `git stash`) and are outside this plan's scope (renderers/Message/csv are intentionally untouched, D-06). My changed files (`src/media-manifest.ts`, `src/media.ts`, `src/model.ts`, both test files) produce **zero** new type errors and the new files are lint-clean.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `media/manifest.json` is the durable ref->file bridge; Phase 6 (`--no-dedupe`, `--inline` savings report) and a future `--verify` integrity re-scan can consume it directly.
- Legacy (pre-v1.1) backups still render via `legacyScan`.

---
*Phase: 05-manifest-bridge*
*Completed: 2026-08-24*

## Self-Check: PASSED

- Created files exist: `src/media-manifest.ts`, `test/media-manifest.test.ts`, `05-01-SUMMARY.md` ✅
- Task commits present: `8a80023`, `58bfe40`, `f43ecda` ✅
- `npm test` 105/105 pass ✅
- No stubs / no broken windows ✅

