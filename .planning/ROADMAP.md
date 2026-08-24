# Roadmap: WhatsApp Chat Backup

## Milestones

- ✅ **v1.0 MVP** — Phases 1-3 (shipped 2026-08-24; npm `wa-backup@0.1.1`)
- 🔄 **v1.1 Media Hygiene** — Phases 4-6 (in planning)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1-3) — SHIPPED 2026-08-24</summary>

- [x] Phase 1: Parsing & Model Core (7/7 plans) — completed 2026-08-21
- [x] Phase 2: Multi-Format Rendering (1/1 plan) — completed 2026-08-22
- [x] Phase 3: Media Reconciliation & Embedding (1/1 plan) — completed 2026-08-22

Full phase detail archived in `milestones/v1.0-ROADMAP.md`.

</details>

- [x] **Phase 4: Streaming Hash & Content-Addressed Store** - MEDIA-05, MEDIA-06 — hash each file with `node:crypto` SHA-256 in the extract pipe and store unique bytes once as `media/<sha256[:16]>.<ext>` — completed 2026-08-24
- [ ] **Phase 5: Manifest Bridge & Deterministic Canonical Selection** - MEDIA-07, MEDIA-08 — emit `media/manifest.json` and make `buildMediaMap` manifest-first with legacy fallback; first-occurrence canonical selection
- [ ] **Phase 6: Savings Report, `--no-dedupe`, & Tests** - MEDIA-09, MEDIA-10 — report dedup savings to stderr, add `--no-dedupe` flag, certify with tests

## Phase Details

### Phase 4: Streaming Hash & Content-Addressed Store
**Goal**: Duplicate media bytes are stored only once on disk (saving space) while the export still opens standalone and renders every message's media — with no full-file buffering even for large videos.
**Depends on**: Phase 3 (existing `reconcileMedia`/`extractEntry` in `src/media.ts`)
**Requirements**: MEDIA-05, MEDIA-06
**Plans**: 1 plan
- [x] 04-PLAN.md — Streaming SHA-256 hash in extractEntry + content-addressed store (media/<sha256[:16]>.<ext>), skip-if-exists dedup, in-run relPath bridge (renderers untouched)
**Success Criteria** (what must be TRUE):
  1. Running the tool on an export containing byte-identical media yields fewer files in `media/` than the number of distinct message-media refs, and no duplicate bytes exist on disk (verifiable by deduplicating refs that point at the same file).
  2. Each stored media file is named `media/<sha256[:16]>.<ext>` (extension preserved from the zip entry) so `mimeFromExt` and the browser still resolve/display it.
  3. The generated backup opens standalone in any browser and every message's media displays correctly — dedup is invisible to readers, visible only as reduced disk usage.
   4. A large export (e.g. a multi-GB video) completes without buffering the whole file in memory (the SHA-256 `Transform` is wired into the `extractEntry` pipe, hashing bytes exactly once while written).
**Plans**: 1/1 complete

### Phase 5: Manifest Bridge & Deterministic Canonical Selection
**Goal**: A machine-readable `media/manifest.json` maps every original media ref to its canonical hash file, `buildMediaMap` resolves media by exact ref (with legacy directory-scan fallback), and duplicate sets always pick the same canonical copy so re-runs are reproducible.
**Depends on**: Phase 4 (must produce hash + canonical path)
**Requirements**: MEDIA-07, MEDIA-08
**Success Criteria** (what must be TRUE):
  1. After a run, `media/manifest.json` exists and lists every resolved media ref with `{ relPath, hash, size, mime }`; refs that are byte-identical share the same `relPath`.
  2. Re-rendering from `messages.csv` + the output folder (no ZIP — e.g. a later `--inline` re-render) still resolves all media correctly, because `buildMediaMap` looks the ref up in the manifest instead of guessing by filename.
  3. Two runs on the same ZIP produce a byte-identical `media/` folder (idempotent) — the canonical file for a duplicate set is always the first-occurring ref by stable message order.
   4. A pre-v1.1 backup (media named by original filename, no manifest) still renders correctly via the legacy directory-scan fallback inside `buildMediaMap`, keeping existing `test/media.test.ts` assertions green.
**Plans**: 1 plan
- [ ] 05-01-PLAN.md — media/manifest.json bridge: new src/media-manifest.ts, reconcileMedia writes manifest (atomic), buildMediaMap manifest-first with legacy fallback, runParser dedup report, tests keep legacy assertions green

### Phase 6: Savings Report, `--no-dedupe`, & Tests
**Goal**: Users see how much space dedup saved, can opt out of dedup to keep per-ref filenames, and the whole feature is certified by an integration + unit test suite.
**Depends on**: Phase 5 (manifest + canonical selection required for accurate reporting and round-trip tests)
**Requirements**: MEDIA-09, MEDIA-10
**Success Criteria** (what must be TRUE):
  1. At the end of a run that found duplicates, stderr reports the space saved (e.g. "N duplicate file(s) removed, Y MB saved") with accurate per-run counting.
  2. Passing `--no-dedupe` makes the tool keep original per-ref filenames in `media/` (no hash naming, no manifest dedup) for users who prefer portable per-ref names.
  3. `wa-backup --help` lists the `--no-dedupe` flag alongside the existing options in `src/index.ts`.
  4. The test suite covers manifest round-trip, dedup integration (asserts `bytesSaved > 0`), legacy fallback, and idempotency / re-render-from-CSV — all green.
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 4. Streaming Hash & Content-Addressed Store | 0/1 | Not started | - |
| 5. Manifest Bridge & Deterministic Canonical Selection | 1/TBD | Not started | - |
| 6. Savings Report, `--no-dedupe`, & Tests | 0/TBD | Not started | - |

---
*Roadmap for v1.1 (Media Hygiene) created 2026-08-24. v1.0 archive preserved above. Full v1.0 history in `milestones/v1.0-ROADMAP.md`.*
