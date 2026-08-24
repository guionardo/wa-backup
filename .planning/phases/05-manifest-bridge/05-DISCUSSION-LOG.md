# Phase 5 — Discussion Log

**Phase:** 5 — Manifest Bridge & Deterministic Canonical Selection (MEDIA-07, MEDIA-08)
**Mode:** discuss-phase (no research re-run; `--skip-research` at plan)
**Date:** 2026-08-24

---

## Session summary

Phase 4 already delivered the streaming hash, content-addressed store, and an in-run
`activeReconcileMap` bridge. Phase 5's job is to persist that bridge as
`media/manifest.json` and make `buildMediaMap` manifest-first with a legacy fallback.

The user was offered four discussion areas (Manifest schema, buildMediaMap policy,
Determinism, Write policy). They chose **Manifest schema** only; the other three are
carried as research defaults and recorded as non-discussed in `05-CONTEXT.md`.

---

## Decisions recorded

### D-05.1 — Manifest persists the full SHA-256 (64-hex)  [discussed]
- User chose **full 64-hex** over the 16-hex filename prefix.
- Rationale: the filename already encodes the 16-hex prefix; storing the full hash makes
  the manifest a real "verify by hash" artifact and enables a future `--verify` re-scan
  without re-deriving the hash.

### D-05.2 — One manifest entry per original ref  [discussed]
- User chose **one entry per ref** over grouping by hash with a `refs[]` array.
- Rationale: matches research recommendation; `buildMediaMap` looks up `ref → entry`
  directly with no inverted index. Duplicate refs repeat `hash`/`relPath`/`size`/`mime`.

### Carried research defaults (not separately discussed)
- **buildMediaMap policy:** manifest-first, exclusive (manifest authoritative; missing file
  → placeholder), legacy directory-scan fallback when no manifest (pre-v1.1 folders).
- **Determinism:** content-addressed filename ⇒ byte-identical `media/` across re-runs;
  first-occurrence canonical = first ref in message order.
- **Write policy:** always write `media/manifest.json`, atomic (`.tmp` → rename); supports
  `--inline` and a future `--no-dedupe`.

---

## Carry-forward (Phase 4)
D-01 (16-hex filename), D-04 (trust-stream skip), D-05 (relPath bridge, renderers/model
untouched), D-06 (no new deps, no hardlinks, streaming).

---

## Next
`/gsd-plan-phase 5 --skip-research` → derive `05-PLAN.md` from `05-CONTEXT.md` +
`.planning/research/ARCHITECTURE.md` (Step 3 of the research build order) + requirements
MEDIA-07/MEDIA-08.
