# Project Research Summary

**Feature:** v1.1 "Media Hygiene" — deduplicate reconciled media in `wa-backup`
(TypeScript/Node ESM CLI that parses WhatsApp export ZIPs into Markdown/HTML/JSON
backups). **Researched:** 2026-08-24. **Overall confidence:** HIGH across all four
research dimensions (stack, features, architecture, pitfalls) — every claim is
traced to actual source (`src/media.ts`, `src/model.ts`, `src/render/*`,
`src/csv.ts`, `src/parse/*`) and corroborated by ≥4 independent production backup
systems (GitLab CAS, Borg, restic, Kopia, OCFL) plus Node.js / Microsoft Learn
docs.

The requirement is solved and low-risk: verify each reconciled media file by size +
a cryptographic hash, and when two referenced files are byte-identical, store the
bytes once and point every reference at that single copy. The dominant research
value is in scoping *what not to build* and pinning *end-user behavior*, not in
discovering new technique.

---

## Key Findings

Consolidated, de-duplicated decisions across STACK / FEATURES / ARCHITECTURE /
PITFALLS:

**Hashing primitive — zero new runtime deps.**
- Use Node's built-in `node:crypto` `createHash('sha256')` as a **streaming
  Transform** wired into the existing `extractEntry()` pipe (`pipeline(source, hash,
  writeStream)`), so bytes are hashed exactly once while written — constant memory
  regardless of video size (satisfies the v1 memory-safety / PARSE-02 constraint).
- **SHA-256, never MD5/SHA-1/size** as the identity key. MD5/SHA-1 have practical
  collision attacks; size-only keying causes silent corruption. SHA-256 collision
  bound ≈ 2^128 → treated as definitive equality (production tools do not
  byte-compare on match).
- Never hash in-memory (`fs.readFile` + `createHash` on a multi-GB video → OOM).
  Never hash the already-inlined base64 — dedup works only on raw bytes at
  extraction time, before any encoding.

**Content-addressed storage (CAS) layout — no filesystem links.**
- Store each unique file once as `media/<sha256[:16]>.<ext>` (16-hex prefix ≈ 2^64
  space per chat; bump to full 64 only for a future global cross-backup store).
  Extension preserved from the zip entry so browsers / `mimeFromExt` keep working.
- **No hardlinks, no symlinks.** CAS already stores each blob once, so disk is saved
  portably. Links break on exFAT/FAT32/ReFS and cross-volume, and break the core
  "folder opens standalone in any browser, survives copy/zip" value. If a
  `--hardlink` polish is ever added, it must fall back to copy on
  `EXDEV|EPERM|EACCES|ENOTSUP` — never on the critical path.

**Two-stage size-then-hash (memory + CPU safety).**
- Stage 1: group by size. A unique size ⇒ file cannot be a duplicate ⇒ copied as-is,
  never hashed (most media in a chat have distinct sizes, so this eliminates the vast
  majority of hash work for free).
- Stage 2: within a same-size group, compute SHA-256; group by digest; >1 member =
  duplicate set. On a SHA-256 match, an optional cheap size re-check (Borg's
  safeguard) is default-on, zero-cost.

**Manifest as the re-render bridge.**
- Emit `media/manifest.json` mapping **every original ref →
  `{relPath, hash, size, mime}`** (one entry per original ref; all refs sharing a
  hash point at the same canonical file). This is the artifact that (a) enables
  content dedup, (b) makes "verify by size + hash" a first-class deliverable, and
  (c) fixes today's fragile filename-based re-render: `buildMediaMap` reads the
  manifest **keyed by exact original ref** (normalized-name fallback only for
  legacy/odd refs), so a later `--inline` re-render from CSV+folder (no ZIP) still
  resolves media.
- The manifest is **derived and regenerated every run** from current refs;
  `messages.csv` stays the sole source of truth. Never read the manifest as input
  (prevents staleness/rot on re-run with a different export).
- Determinism: canonical selection = **first-occurrence rule** (sort colliding refs
  by stable message index) so identical ZIP ⇒ byte-identical `media/` across
  runs/machines.

**Integration seam — media layer only, renderers untouched.**
- `reconcileMedia` does the hash + temp→rename dedup + manifest write; `buildMediaMap`
  becomes manifest-first with a legacy directory-scan fallback (preserves v1.0
  backups and existing `test/media.test.ts` assertions). `Message` / `messages.csv`
  schema is unchanged. The three renderers consume only `MediaEntry.relPath`, which
  now points at the canonical hash file — **no renderer logic change** required.
- Idempotent re-runs: temp file written to `media/.tmp-<uuid>`, `unlink` in
  `finally`, atomic rename; re-running yields identical `media/`, never grows.

**`--inline` caveat (document, don't "fix").**
- Dedup always applies to the on-disk `media/` copy. With `--inline`, the single HTML
  embeds each occurrence as an independent base64 blob, so the HTML file itself does
  **not** shrink from dedup (it's one self-contained file by design). Do **not**
  attempt cross-occurrence base64 sharing inside one HTML for v1.1.

**Optional pre-filter — `xxhash-wasm@1.1.0` (deferred / optional).**
- WASM (no native binary), runs in Node + browser, ~10–50× faster than SHA-256. Used
  only as a two-stage gate to skip SHA-256 on obvious mismatches; SHA-256 stays the
  authoritative key. **Core ships fine with SHA-256 only**; add xxhash later if
  profiling shows hashing is a bottleneck. Reject `@node-rs/xxhash` (native, breaks
  browser-reuse) and `xxhashjs` (10–350× slower).

**What NOT to build (anti-features):** chunk-level/CDC dedup (Rabin/FastCDC — for
edit-resilience, irrelevant to byte-identical re-exports); links as the default
mechanism; mutating previously generated backups; network/remote hash index; external
DB/index outside the output folder; perceptual/near-dup matching; fuzzy base64
sharing in inlined HTML.

---

## Implications for Roadmap

Build order is dictated by hard dependencies: hash must exist before the dedup
*decision*; the dedup decision + manifest write must exist before `buildMediaMap` can
switch to manifest-backed; renderers are last (verification only). Phases 1→2→3 below
also map cleanly to the PITFALLS phase structure (MED-DEDUP-1/2/3).

1. **Streaming hash primitive** — add the SHA-256 `Transform` to `extractEntry`,
   return `{hash, size}`, write to a caller temp path. No behavioral change yet.
   Isolates the only novel memory-critical piece; unit-testable standalone.
   *Avoids P6 (must stay streaming), P9 (hash raw bytes), P2 (temp cleanup).*

2. **CAS naming + dedup in `reconcileMedia`** — compute `relPath` from hash,
   temp→rename, skip write if exists; collect **all** original refs per hash; emit
   `duplicatesRemoved` / `bytesSaved`. *Avoids P1 (don't break re-render yet —
   closed in step 3), P4 (ext/type on collision), P7 (no links), P11 (AppleDouble),
   P12 (ext preserved).*

3. **`media/manifest.ts` (new) + `buildMediaMap` manifest-first with legacy
   fallback** — once Step 2 produces the manifest, `buildMediaMap` stops guessing by
   filename. Fallback preserves old backups + existing tests; **closes P1/P3** (the
   re-render break). *Avoids P8 (key by exact ref, not normalized), P14 (regenerate
   every run), P17 (model untouched).*

4. **Savings report + renderer verification** — extend `runParser` stderr report
   (`N duplicates removed, Y MB saved`, accurate counting per P16); verify renderers
   need no change; optionally add a per-render base64 cache keyed by `relPath` for
   `--inline` (P5 optimization, not required). Add `media-manifest` unit tests +
   integration test asserting `bytesSaved > 0`.

5. **Tests / idempotency certification (≈ MED-DEDUP-3)** — snapshot test of
   byte-identical re-runs; re-render-from-CSV test; exFAT link-free verification;
   collision + corrupt-entry fixtures (P3, P7, P10, P14, P15, P18).

**Optional / deferred:** `--hardlink` opt-in (default OFF, copy-fallback);
hash-abstraction (BLAKE3 option); cross-chat persistent global CAS
(`~/.wa-backup/store`); `--verify` integrity re-hash (cheap once manifest exists).
**Optional fast pre-filter:** `xxhash-wasm` — verify tsup WASM inlining during the
build phase (MEDIUM confidence); ship SHA-256-only if it misbehaves.

**Research flags for the roadmapper:**
- **Needs deeper phase research:** MED-DEDUP-1 (exact `extractEntry` hook point and
  manifest schema design), MED-DEDUP-2 (bounded-concurrency number 8 vs 16),
  MED-DEDUP-3 (exFAT CI verification approach).
- **Standard patterns, skip research:** CAS-at-reconcile, streaming SHA-256 via
  `node:crypto`, manifest-first `buildMediaMap` — all corroborated and source-verified.

---

## Sources

- `.planning/research/STACK.md` — Media Deduplication (v1.1) stack research:
  SHA-256 streaming via `node:crypto`, CAS layout, `xxhash-wasm` optional pre-filter,
  hardlink trade-off, no-new-dep conclusion. (HIGH confidence)
- `.planning/research/FEATURES.md` — Feature landscape: two-stage size+hash
  mechanism, table-stakes / differentiators / anti-features, `--inline` caveat, MVP
  dependency order. (HIGH mechanism / MEDIUM integration)
- `.planning/research/ARCHITECTURE.md` — Verified against actual source:
  CAS-at-reconcile + `MediaManifest` bridge, `reconcileMedia`/`buildMediaMap`
  rewrites, model untouched, 7-step build order, 9 feature pitfalls. (HIGH)
- `.planning/research/PITFALLS.md` — 18 pitfalls (10 critical/moderate/minor) with
  prevention + detection + phase assignment (MED-DEDUP-1/2/3), cross-platform link
  limits, streaming-hash API. (HIGH)
