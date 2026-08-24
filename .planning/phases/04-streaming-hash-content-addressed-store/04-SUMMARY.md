---
phase: 04-streaming-hash-content-addressed-store
plan: 01
subsystem: media
tags: [sha-256, content-addressed-store, dedup, streaming, crypto, node-crypto]

# Dependency graph
requires:
  - phase: 03-media-reconciliation
    provides: reconcileMedia/extractEntry streaming extract pipeline that this phase extends in-place
provides:
  - Streaming SHA-256 + size primitive inside extractEntry (MEDIA-05)
  - Content-addressed store media/<sha256[:16]>.<ext> with skip-if-exists + atomic rename (MEDIA-06)
  - In-run activeReconcileMap bridge so renderers resolve canonical relPath untouched (D-06)
affects: [phase-5-manifest, phase-6-savings-report]

# Actuals (#2632)
actuals:
  tokens: 2321
  tasks: 3
  commits: 4

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Content-addressed media filename media/<sha256[:16]>.<ext> (extension preserved from zip entry) — D-01"
    - "In-run reconcile map (activeReconcileMap) bridges original ref -> canonical relPath to renderers without editing src/render/* (D-06)"
    - "Streaming hash via explicit node:crypto Transform in the extract pipe; never buffer a whole media file (MEDIA-05)"

key-files:
  created: []
  modified:
    - src/media.ts
    - test/media.test.ts
    - test/render.test.ts

key-decisions:
  - "Obeyed all locked decisions: D-01 (media/<sha256[:16]>.<ext>), D-02 (pure node:crypto, no new deps), D-03 (--inline still embeds each copy), D-04 (trust-the-stream skip, no re-verify), D-05/D-06 (relPath bridge, renderers/model untouched)."
  - "extractEntry returns {hash,size} by piping bytes through an explicit Transform (crypto.Hash does not forward bytes, so a wrapper Transform is required)."
  - "reconcileMedia records EVERY original ref (Map<norm,string[]>) so duplicate names sharing content all map to the same canonical relPath (Pitfall 8)."

patterns-established:
  - "CAS write: extract to media/.tmp-<uuid> -> compute canonical name -> exists-skip (O(1), D-04) or atomic renameSync (temp->final)."
  - "Module-global activeReconcileMap + setActiveReconcileMap() consumed by buildMediaMap; tests reset it via afterEach to avoid cross-test leakage."

requirements-completed: [MEDIA-05, MEDIA-06]

coverage:
  - id: D1
    description: "Streaming SHA-256 digest + byte size computed inside extractEntry via an inline node:crypto Transform; no whole media file buffered (MEDIA-05)"
    requirement: MEDIA-05
    verification:
      - kind: unit
        ref: "test/media.test.ts#CAS: byte-identical different names stored once, both refs resolve"
        status: pass
    human_judgment: false
  - id: D2
    description: "Each unique media file stored once at media/<sha256[:16]>.<ext>; duplicate content skipped (exists-check, no re-read); atomic temp->rename write (MEDIA-06)"
    requirement: MEDIA-06
    verification:
      - kind: unit
        ref: "test/media.test.ts#CAS: byte-identical different names stored once, both refs resolve"
        status: pass
      - kind: manual_procedural
        ref: "node --import tsx src/index.ts fixtures/Notas.zip --out /tmp/wa-verify (media/ holds only <16hex>.<ext>; 7 resolved refs collapsed to 3 unique files)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Original-ref -> canonical relPath mapping delivered to renderers via unchanged MediaEntry.relPath (buildMediaMap consults activeReconcileMap); src/render/* and model.ts untouched (D-06)"
    requirement: MEDIA-06
    verification:
      - kind: integration
        ref: "test/html-media.test.ts#html: photo/sticker imgs get media-img class + thumbnail css"
        status: pass
      - kind: unit
        ref: "test/media.test.ts#reconcileMedia on Notas pessoais sample: mediaMap relPath/mime"
        status: pass
    human_judgment: false

# Metrics
duration: 7min
completed: 2026-08-24
status: complete
---

# Phase 4 Plan 01: Streaming Hash & Content-Addressed Store Summary

**Streaming SHA-256 + size in the extract pipe and a content-addressed store (media/<sha256[:16]>.<ext>) that writes each unique file once and bridges the original-ref -> canonical relPath to renderers without touching them**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-08-24T11:38:19Z
- **Completed:** 2026-08-24T11:45:05Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- `extractEntry` now pipes the extracted bytes through a `node:crypto` SHA-256 `Transform` that also sums size, returning `{ hash, size }` — no whole media file is ever buffered (MEDIA-05, D-02).
- `reconcileMedia` stores each unique file once as `media/<sha256[:16]>.<ext>`: extracts to a temp file, computes the canonical name from the hash, skips the write when the canonical path already exists (trust-the-stream, D-04), else atomically renames. Duplicate-content refs survive as one on-disk file (MEDIA-06).
- The original-ref -> canonical relPath mapping is built during reconcileMedia and delivered to renderers through the unchanged `MediaEntry.relPath`: `buildMediaMap` consults an in-run `activeReconcileMap` first, falling back to the existing disk scan. `src/render/*` and `src/model.ts` are untouched (D-06).
- `ReconcileResult` gains an additive `mediaMap` field; no new runtime dependencies were introduced.

## Task Commits

Each task was committed atomically:

1. **Task 1 (tracer): streaming SHA-256 + CAS store, end-to-end** - `baea3ee` (feat)
2. **Task 2 (expand): record every ref + skip-if-exists dedup** - `208b579` (feat)
3. **Task 3 (tests): CAS assertions + dedup coverage** - `472e813` (test)
4. **Deviation: render markdown test expects CAS path** - `dbb67e3` (fix)

## Files Created/Modified

- `src/media.ts` - streaming hash primitive, `canonicalMediaName`, `MEDIA_HASH_PREFIX_LEN`, CAS write in `reconcileMedia`, `activeReconcileMap` bridge consumed by `buildMediaMap`, `ReconcileResult.mediaMap`.
- `test/media.test.ts` - reconcileMedia assertions updated to hash names + mediaMap; new duplicate-content test; `afterEach` resets `activeReconcileMap`.
- `test/render.test.ts` - one assertion updated to match content-addressed media path in rendered Markdown.

## Decisions Made

- Kept the `crypto.Hash`-does-not-forward-bytes caveat in mind: an explicit `Transform` wraps `hash.update(chunk)` and forwards `chunk` downstream (MEDIA-05 streaming, memory-safe).
- `reconcileMedia` records all distinct refs per normalized key (`Map<norm,string[]>`) so byte-identical files with different names still produce a single on-disk file while every original ref resolves to it.
- `--inline` is unaffected: renderers read the canonical `entry.relPath` (now hash-named) and inline per copy; the media/ folder simply collapses (D-03).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Test contract] render.test.ts asserted the original media filename in rendered Markdown**
- **Found during:** Task 3 (full `npm test` run)
- **Issue:** MEDIA-06 renames on-disk files to `media/<sha256[:16]>.<ext>`, so the assertion `md.includes('![...](media/00003010-STICKER-...webp)')` failed — the rendered output correctly uses the hash path, not the original name.
- **Fix:** Updated the assertion to match a content-addressed `media/<16hex>.webp` image reference and to confirm the original filename is no longer used as the media path. This keeps the full suite green and satisfies the plan's "no test asserts an original media filename" criterion.
- **Files modified:** test/render.test.ts
- **Verification:** `npm test` full suite passes (104/104).
- **Committed in:** `dbb67e3`

---

**Total deviations:** 1 auto-fixed (Rule 1 — test contract refresh)
**Impact on plan:** Necessary to keep the full suite green after the intended MEDIA-06 filename change. No scope creep; renderers/model untouched as required.

## Issues Encountered

- A stray `git checkout` earlier in the session left `src/media.ts` staged at the base version, which briefly polluted the Task-3 commit; fixed by re-staging the correct working-tree `src/media.ts` and amending, then committing the render.test.ts fix separately. Final HEAD contains the complete CAS implementation and the full suite is green.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 5 can consume `ReconcileResult.mediaMap` (already populated in-run) to persist `media/manifest.json` and make `buildMediaMap` manifest-first with a legacy directory-scan fallback (MEDIA-07). The in-run `activeReconcileMap` bridge is the Phase-4 shim to be replaced by the persisted manifest.
- Phase 6 can consume `reconcileMedia`'s resolved/dedup counts for the savings report and the `--no-dedupe` flag (MEDIA-09/10).
- No blockers; `--inline` and unresolved/placeholder rendering remain unchanged and verified.

---
*Phase: 04-streaming-hash-content-addressed-store*
*Completed: 2026-08-24*
