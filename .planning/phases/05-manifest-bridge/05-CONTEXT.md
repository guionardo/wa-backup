# Phase 5 — Context

**Milestone:** v1.1 Media Hygiene
**Phase #:** 5
**Features:** MEDIA-07, MEDIA-08
**Title:** Manifest Bridge & Deterministic Canonical Selection
**Date created:** 2026-08-24
**Mode:** discuss-phase (context captured; no research re-run — `--skip-research` will be used at plan)

---

## Objective

Persist a `media/manifest.json` that maps every **original** media ref (`Message.media`)
to its content-addressed canonical file (`media/<sha256[:16]>.<ext>`), so that:

1. Re-rendering from `messages.csv` (no ZIP) resolves media deterministically via the
   manifest instead of fragile directory-scan + normalized-name guessing.
2. The "verify media by size + cryptographic hash" requirement becomes a first-class,
   durable artifact (the manifest).
3. `buildMediaMap` is switched to **manifest-first** with a **legacy directory-scan
   fallback** for pre-v1.1 folders (no manifest).

Phase 4 already shipped the streaming SHA-256, the content-addressed store, and an
in-run `activeReconcileMap` bridge that proves the ref→relPath link. Phase 5 **persists**
that bridge as `media/manifest.json` and makes `buildMediaMap` read it.

---

## Current State (post Phase 4)

- `src/media.ts` `extractEntry` streams SHA-256 + size (`src/media.ts:131-170`).
- `reconcileMedia` writes `media/<sha256[:16]>.<ext>`, skips write if the path exists
  (dedup), records every original ref via the in-module `activeReconcileMap`
  (`src/media.ts:181-185`, `:253-259`, `:276`).
- `buildMediaMap` currently resolves via `activeReconcileMap` when set, else a directory
  scan (`src/media.ts:297-341`). It does **not** yet write or read a manifest.
- Renderers (`json/md/html`) and `Message`/`messages.csv` are untouched (D-06) and must
  stay so.
- No `media/manifest.json` is produced yet.

---

## Decisions

### Discussed & locked

- **D-05.1 — Manifest persists the full SHA-256 (64-hex).**
  The on-disk filename uses the 16-hex prefix (Phase 4 D-01); the manifest stores the
  complete 64-hex hash so a future `--verify` can re-check integrity / bit-rot against a
  stored cryptographic value. `relPath` stays `media/<sha256[:16]>.<ext>`.

- **D-05.2 — One manifest entry per original ref.**
  `entries[]` contains one `{ ref, hash, relPath, size, mime }` per distinct original
  `Message.media` (duplicates repeat `hash`/`relPath`/`size`/`mime`, differing only in
  `ref`). `buildMediaMap` looks up `ref → entry` directly (no inverted index needed).

### Carried as research defaults (NOT separately discussed this session)

- **buildMediaMap policy — manifest-first, exclusive, with legacy fallback.**
  If `media/manifest.json` exists it is the **authoritative** source: a ref present in the
  manifest but whose file is missing on disk is treated as absent (placeholder), not
  re-scanned. If no manifest exists (pre-v1.1 folder), reproduce today's directory scan
  (skip `manifest.json` and `.tmp-*`, match by normalized name) so old backups + existing
  `test/media.test.ts` scan assertions stay green.

- **Determinism — hash-based idempotency.**
  Filename is content-addressed, so two runs over the same ZIP yield byte-identical
  `media/`. "First-occurrence" canonical selection = the primary ref is the first in message
  order; since all byte-identical refs map to the same `relPath`, output is reproducible.

- **Write policy — always write, atomic.**
  `reconcileMedia` always emits `media/manifest.json` (even a single file, even with
  `--inline`, and later with a `--no-dedupe` flag from Phase 6). Written atomically
  (`.tmp-<uuid>` → `renameSync`).

### Carried forward from Phase 4 (locked in phase 04; not re-tracked as new decisions here)

- D-01 (Phase 4): filename `media/<sha256[:16]>.<ext>` (ext preserved).
- D-04 (Phase 4): trust-the-stream skip-if-exists (no re-verify of written bytes).
- D-05 (Phase 4): original→canonical mapping via `MediaEntry.relPath`; renderers/model untouched.
- D-06 (Phase 4): no new deps; no hardlinks/symlinks; memory-safe streaming.

---

## Manifest Schema (canonical)

```ts
interface MediaManifestEntry {
  ref: string;     // original m.media filename (one entry per ref)  [D-05.2]
  hash: string;    // full 64-hex sha256                              [D-05.1]
  relPath: string; // 'media/<sha256[:16]>.<ext>'
  size: number;    // bytes
  mime: string;    // from extension
}
interface MediaManifest {
  version: number;            // 1
  generatedAt: string;        // ISO timestamp
  entries: MediaManifestEntry[];
  unresolved: string[];       // refs with no matching zip entry
  duplicatesRemoved: number;  // refs mapped to an existing hash
  bytesSaved: number;         // approx sum of sizes of deduped refs
}
```

New module `src/media-manifest.ts`: pure read/write + `legacyScan` fallback (no ZIP
needed). `reconcileMedia` writes the manifest; `buildMediaMap` reads it first.

---

## Non-Goals (Phase 5)

- No change to `Message` / `messages.csv` schema (original ref string only).
- No `--no-dedupe` flag (Phase 6) — but manifest write must already support it.
- No `--verify` integrity re-scan (Phase 6 / later).
- Renderers: no logic change (relPath contract stable). Optional `--inline` base64 cache is
  out of scope here.

---

## Open Questions

- None blocking. `--no-dedupe` (Phase 6) will reuse this manifest writer with dedup disabled.

---

## Phase Mapping

| Phase | Feature        | Delivers |
|-------|----------------|----------|
| 4     | MEDIA-05/06    | Streaming SHA-256 + content-addressed dedup store (DONE) |
| **5** | MEDIA-07/08    | `media/manifest.json` bridge + deterministic canonical + manifest-first `buildMediaMap` |
| 6     | MEDIA-09/10    | `--no-dedupe` flag + `--inline` dedup savings report |
