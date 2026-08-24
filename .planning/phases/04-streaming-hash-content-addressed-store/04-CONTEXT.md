# Phase 4: Streaming Hash & Content-Addressed Store - Context

**Gathered:** 2026-08-24
**Status:** Ready for planning

<domain>
## Phase Boundary

While extracting each media file from the ZIP, compute its SHA-256 (cheap) and size
on the streaming bytes, then store the file ONCE as `media/<sha256[:16]>.<ext>` instead
of `media/<originalName>`, skipping extraction when a file with that content-addressed
name already exists. Covers **MEDIA-05** (streaming size + SHA-256) and **MEDIA-06**
(content-addressed store, skip-if-exists, atomic write).

Out of scope here: manifest.json persistence and the original→canonical bridge consumed
by `buildMediaMap`/renderers (Phase 5), and the savings report / `--no-dedupe` flag
(Phase 6). The mapping computed in this phase must be recorded in-memory and flow through
`MediaEntry.relPath` so Phase 5 can persist it without re-reading bytes.

</domain>

<decisions>
## Implementation Decisions

### Disk filename strategy
- **D-01:** Content-addressed name `media/<sha256[:16]>.<ext>` — opaque but stable; the
  original file extension is preserved so MIME resolution (`mimeFromExt`) and recovery stay
  correct. — **Reversibility:** costly — changing the naming scheme renames every deduped
  file; existing extracted backups would need re-extraction to match.

### Hash algorithm
- **D-02:** Pure streaming **SHA-256** via `node:crypto` `Transform` on the extracted bytes.
  No `xxhash-wasm` / no extra dependency (keeps the zero-dep, browser-reusable profile from
  PROJECT.md). — **Reversibility:** reversible.

### `--inline` interaction
- **D-03:** Dedup runs **first**; when `--inline` is set, the HTML still embeds each
  referenced copy as a `data:` URI (so no size saving *inside* the self-contained HTML), but
  the `media/` folder is collapsed and the savings report is still shown for the folder.
  `--inline` stays fully self-contained as designed. — **Reversibility:** reversible.

### Verify-on-skip
- **D-04:** On a content-addressed name collision, **trust the stream** — if
  `media/<sha256[:16]>.<ext>` already exists, skip extraction without re-reading/verifying the
  existing file. 16-hex collisions are astronomically rare within one backup. — **Reversibility:** reversible.
  (Note: CONCERNS.md flags that media has no CRC check today; this phase does not add one —
  integrity verification, if ever wanted, is a separate concern.)

### Bridge to Phase 5 (carried from v1.1 research)
- **D-05:** The original-ref → canonical-hash-path mapping is computed during `reconcileMedia`
  and carried via `MediaEntry.relPath` (already the field renderers read). `buildMediaMap`
  (Phase 5) consumes it; `manifest.json` persistence is Phase 5 scope. No hardlinks/symlinks
  are used (portability — output must open from `file://` with no server).
- **D-06:** No new runtime dependencies. Streaming hash reuses the existing `extractEntry`
  write path; model (`Message`) and renderers (`src/render/*`) are untouched by this phase.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — MEDIA-05 (streaming size + SHA-256), MEDIA-06 (CAS store, skip-if-exists, atomic write); deferred list.
- `.planning/ROADMAP.md` — Phase 4 "Streaming Hash & Content-Addressed Store" (phases 4–6 overview).
- `.planning/research/SUMMARY.md` — v1.1 design consensus: streaming SHA-256 via `node:crypto`, content-addressed store, manifest bridge, no hardlinks, model/renderers untouched.
- `.planning/research/FEATURES.md` — dedup feature design (size→hash, savings report, `--no-dedupe`).
- `.planning/research/ARCHITECTURE.md` — v1.1 target architecture (CAS store, `media/manifest.json`, `buildMediaMap` manifest-first + legacy fallback).

### Existing code (integration points)
- `src/media.ts` — `extractEntry` (line 123, streaming write point where the hash Transform plugs in), `reconcileMedia` (line 171, writes `media/<base>` at line 203), `MediaEntry.relPath` (line 219, becomes the canonical hash path), `normalizeMediaName` (line 24), `buildMediaMap` (line 236, Phase 5 reads), `INLINE_MAX_BYTES` / `isInlineable` (lines 13, 51).
- `.planning/codebase/ARCHITECTURE.md` — media flow (steps 6–7, lines 103–127), `ReconcileResult` (line 173).
- `.planning/codebase/CONCERNS.md` — "No CRC / integrity check on extracted media" (line 51), "per-entry file open" (line 31) — relevant if Phase 4 also addresses reusing a single file handle.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `extractEntry` (`src/media.ts:123`) — the single point where entry bytes stream to disk; pipe the `ReadStream`/`InflateRaw` through a `crypto.createHash('sha256')` Transform (teed, not blocking) and capture size, then decide the canonical name and write target.
- `MediaEntry.relPath` (`src/media.ts:219`) — renderers already read this for `<img src>` / links; setting it to `media/<hash[:16]>.<ext>` is the only renderer-facing change, handled via the mapping bridge (D-05).
- `normalizeMediaName` (`src/media.ts:24`) — reuse for resolving the original message ref → canonical file at `buildMediaMap` time (Phase 5).
- `INLINE_MAX_BYTES` / `isInlineable` (`src/media.ts:13,51`) — gate `--inline` embedding; D-03 keeps this unchanged.

### Established Patterns
- `camelCase` functions, `SCREAMING_SNAKE_CASE` constants, `kebab-case` modules (CONVENTIONS.md) — new constant e.g. `MEDIA_HASH_PREFIX_LEN = 16`.
- Media resolution never throws; unresolved refs rendered as placeholders (CONVENTIONS.md line 58) — dedup must not change this contract.
- `createWriteStream` + `Promise` write pattern in `extractEntry` — extend, don't rewrite.

### Integration Points
- `reconcileMedia` (`src/media.ts:171`) — change the write target from `path.join(mediaDir, base)` to `path.join(mediaDir, <hash[:16] + ext>)` and accumulate the `originalRef → canonicalPath` map for `MediaEntry`.
- `runParser` / `src/model.ts` verbose report — Phase 6 consumes the dedup counts; Phase 4 just computes/stores them.

</code_context>

<specifics>
## Specific Ideas

- Canonical name uses first 16 hex chars of SHA-256 — user-approved as a stable, collision-safe-enough (within one backup) choice that keeps filenames short.
- `--inline` keeps embedding each copy: the user accepted that dedup saves disk (media/ folder) but not the inlined HTML size; the savings report still informs the user.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. (manifest.json persistence, `--no-dedupe`, and savings report are Phase 5–6 by roadmap.)

</deferred>

---

*Phase: 4-Streaming Hash & Content-Addressed Store*
*Context gathered: 2026-08-24*
