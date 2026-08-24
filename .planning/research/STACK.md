# STACK — Media Deduplication (v1.1 "Media Hygiene")

**Project:** wa-backup (`wa-backup@0.1.1`, TypeScript/Node ESM CLI)
**Feature:** v1.1 — verify media by size + cryptographic hash; store each unique
file once (content-addressed) and point all identical references at the single
copy to save disk.
**Researched:** 2026-08-24
**Overall confidence:** HIGH

---

## Executive Recommendation

Implement deduplication with **zero new runtime dependencies** for the core path:
use Node's built-in `node:crypto` SHA-256 as a **streaming** Transform wired into
the existing `extractEntry()` pipe. Store each unique file **once** under a
content-addressed name (`media/<sha256[:16]><ext>`) and emit a small
`media/manifest.json` that maps every referenced media name to its canonical
`relPath`. Update `buildMediaMap()` to read that manifest (falling back to the
current filename scan for pre-v1.1 backups). This is the layout used by OCFL,
GitLab Artifact Registry, and Kopia — it is portable, needs no hardlinks, and
extends cleanly to cross-backup global CAS later.

A **fast non-cryptographic pre-filter (xxhash-wasm @ 1.1.0)** is the only
*optional* dependency, used as a two-stage gate so we skip the SHA-256 pass for
obviously-different large videos. It is WASM (no native binary), so it preserves
the "core reusable in the browser" property the project already bought with
fflate. `@node-rs/xxhash` (native) and `xxhashjs` (pure-JS, 10–350× slower) are
rejected.

Hardlinks are **not** part of the dedup mechanism. Content-addressing already
stores each blob once, so disk is saved without filesystem links. Hardlinks are
only worth considering as an optional convenience layer that also keeps the
original WhatsApp filename on disk; on Windows (FAT/ReFS) and cross-volume they
fail, so they must always fall back to copy.

---

## Recommended Stack Additions

| Concern | Add? | Technology | Version | Purpose | Why | Confidence |
|---------|------|------------|---------|---------|-----|------------|
| Authoritative hash | **No dep** | `node:crypto` `createHash('sha256')` | built-in (Node ≥22.12) | Streaming content hash per extracted media file | Collision-resistant, zero-dep, HW-accelerated (SHA-NI), satisfies "cryptographic hash" requirement | HIGH |
| Fast pre-filter | **Optional dep** | `xxhash-wasm` | 1.1.0 | Cheap first-stage fingerprint to skip SHA-256 on mismatches | ~10–50× faster than SHA-256, WASM (no native binary), runs in browser too → keeps core web-reusable | HIGH (version) / MEDIUM (bundle) |
| Manifest store | **No dep** | JSON written to `media/manifest.json` | — | Map `ref → {relPath, hash, size}` | Portable content-addressing; no DB, no links | HIGH |
| Disk saving | **No dep** | content-addressed filenames + `fs.rename` | built-in | Store once, reference many | Inherent dedup; no hardlink portability issues | HIGH |
| CLI flag | **No dep** | `--no-dedupe` opt-out | — | Allow disabling for debugging/forensics | Parity with `--no-fetch-titles` pattern already in code | HIGH |

**Net new runtime deps: 0 (core). 1 optional (`xxhash-wasm`) if two-stage is wanted.**

---

## 1. Hashing — SHA-256 via `node:crypto` (streaming, memory-safe)

`crypto.Hash` is a `Transform` (both readable & writable). The existing
`extractEntry()` already pipes `ReadStream → (inflate) → WriteStream`. We insert
the hash Transform **in that same pipe** so bytes are hashed exactly once while
they are written — constant memory regardless of video size (directly satisfies
the v1 "stream-parse / memory-safe" constraint).

Use `stream/promises.pipeline` (NOT bare `.pipe()`): `pipeline` destroys all
streams and rejects on the first error, so a truncated read can never yield a
silent wrong digest. (Confirmed best-practice in Node crypto docs and AppSignal
streaming guidance.)

```ts
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';

// source = inflate output (method 8) or raw rs (method 0) — same as today
const hash = createHash('sha256');
const tmp = path.join(mediaDir, `.${base}.tmp`);
await pipeline(source, hash, createWriteStream(tmp));
const digest = hash.digest('hex');          // 64-char lowercase hex
const size = (await fs.stat(tmp)).size;
```

**Size + hash verification (two-stage, optional):**
1. `size` is available for free after the write (`fs.stat`). If two refs have
   different sizes they are definitively different — no hash needed.
2. If sizes match, compare `sha256`. (SHA-256 collision probability is
   astronomically low, so size+sha256 is treated as definitive equality.)
3. *Optional fast gate:* compute `xxhash` first; only run SHA-256 when the
   xxhash already matches a seen one. Saves CPU on archives with many large
   *distinct* videos. SHA-256 over every byte is still fine and HW-accelerated,
   so the xxhash stage is an optimization, not a requirement.

**Why SHA-256, not MD5/SHA-1:** both have practical collision attacks; they are
unacceptable for any integrity/fixity use. SHA-256 (or SHA-512) is the
normative choice for content-addressing (OCFL requires sha256/sha512). SHA-512
is marginally faster on 64-bit but SHA-256 is sufficient and standard.

---

## 2. Optional fast pre-filter — `xxhash-wasm@1.1.0`

**Version verified current** via `npm view` (latest = `1.1.0`, 2026-08-24).
Engines: Node ≥ 15 (fine with our `>=22.12`). Bundle: ~11.4 kB / 2.3 kB gzipped.

| Option | Verdict | Reason |
|--------|---------|--------|
| `xxhash-wasm` 1.1.0 | **RECOMMENDED (optional)** | WASM, no native build, runs in Node *and* browser (keeps web-reuse promise), ~5.7M ops/s on 1-byte, ~34 ops/s on 100 MB — 10–50× faster than SHA-256. Streaming API (`create64().update().digest()`) mirrors `crypto`. |
| `@node-rs/xxhash` 1.7.7 | Reject for v1.1 | Fastest (native `.node`), but ships platform-specific prebuilt binaries. Breaks the zero-native-dependency / browser-reusable philosophy the stack already committed to with fflate. Reserve for a future Node-only batch daemon. |
| `xxhashjs` 0.2.2 | Reject | Pure-JS, uses `cuint` for u64; 10–350× slower than wasm (36 ops/s on 1 MB). Pointless overhead. |
| `xxhash-addons` | Reject | `npm view` lookup failed (not reliably published / deprecated). No reason to chase it. |

**Integration note (MEDIUM confidence):** `xxhash-wasm` instantiates a WASM
instance once (~2 ms in Node). Confirm during implementation that esbuild/tsup
bundles it without an external `.wasm` fetch — the package advertises
self-contained bundles, so it should inline as base64. If tsup emits a separate
`.wasm`, set `tsup` `loader`/`noExternal` or keep it external. Flag for the
execution phase, not a blocker.

---

## 3. Content-Addressed Storage (CAS) Layout

### On-disk shape (replaces today's `media/<originalName>`)

```
output/<chat>/
├── messages.csv
├── messages.{json,md,html}
└── media/
    ├── manifest.json            # NEW — ref → canonical mapping
    ├── <sha256[:16]>.jpg        # canonical, stored ONCE
    ├── <sha256[:16]>.mp4
    └── ...
```

- Canonical filename = first 16 hex chars of the SHA-256 + original extension
  (preserves type for browsers/`mimeFromExt`). 16 chars ≈ 2^64 space → no
  realistic collision within a single chat's media set; bump to full 64 if ever
  doing a *global* cross-backup store.
- `manifest.json`:
  ```json
  {
    "algorithm": "sha256",
    "entries": {
      "<normalizedRef>": { "relPath": "media/<hash16>.<ext>", "hash": "<sha256hex>", "size": 12345 }
    }
  }
  ```

### Why CAS over "keep original name + hardlink duplicates"

OCFL, GitLab, and Kopia all converge on the same pattern: **content hash is the
storage key; a manifest maps references → content; "if destination exists, skip
the write."** Benefits here:

- **Disk saved with zero filesystem links** — the whole point of the feature,
  achieved portably.
- `buildMediaMap()` consumes `relPath` directly; renderers (`md`/`html`/`json`
  + `--inline`) already take `relPath`, so the only change is *where relPath
  comes from*.
- Trivially extensible to **cross-backup global CAS** later: a shared
  `~/.wa-backup/store/<hash>` with per-backup manifests — without redesign.
- OCFL explicitly warns hard/symlinks "work at odds with" portable
  content-addressing and should be avoided. Same conclusion.

### Code-change map (integration with current `src/media.ts`)

| Current | Change for v1.1 |
|---------|-----------------|
| `extractEntry(zipPath, meta, outPath)` | New `extractEntryDedup(zipPath, meta, mediaDir, seen)` → writes to `.<base>.tmp`, hashes via `pipeline(source, hash, ws)`, then `fs.stat` for size; canonical = `<digest16>.<ext>`; if `media/<canonical>` exists → `fs.unlink(tmp)` (dup, no disk write); else `fs.rename(tmp, canonical)`. Returns `{ digest, size, relPath }`. |
| `reconcileMedia()` loop `extractEntry(...path.join(mediaDir, base))` | Call `extractEntryDedup`; accumulate `seen: Map<hash, {relPath,size}>` and `refMap: Map<normalizedRef, {relPath,hash,size}>`. After `Promise.all`, write `media/manifest.json`. |
| `buildMediaMap(dir, messages)` | **Read `manifest.json` first**; for each message `m.media` look up `entries[normalizeMediaName(m.media)]` → `MediaEntry {relPath, mime, size, inlineable}`. **Fallback:** if no manifest (pre-v1.1 backup), keep current disk-scan. Preserves "re-render old backup without ZIP" feature. |
| `model.runParser()` | After `reconcileMedia`, print dedup stats (`N files → M unique, saved X MB`) when `--verbose`. Add `--no-dedupe` to skip (writes original names, no manifest). |

### Two-phase extract is atomic & safe
Write to a hidden temp, compute hash, then `rename` to the hash path. A crash
mid-extract leaves only a `.tmp` that a later run ignores/overwrites. Idempotent:
re-running on the same dir never creates a second copy of identical content.

---

## 4. Hardlink vs Copy — Trade-off Analysis

This matters **only if** we also want the original WhatsApp filename on disk
(e.g. for human browsing / other tools). With pure CAS it is unnecessary. If we
ever add a `--keep-original-names` convenience layer, use this rule:

**Try `fs.link(canonical, originalName)`; on failure fall back to
`fs.copyFile(canonical, originalName)`.** Match the exact fallback set
`EXDEV | EPERM | EACCES | ENOTSUP` (the pattern Microsoft's TypeScript repo uses
for git hooks).

| OS / FS | Hardlink? | Notes |
|---------|-----------|-------|
| macOS (APFS) | ✅ Yes | Fully supported; same volume only (always true here — both paths in `media/`). |
| Linux (ext4/btrfs/xfs) | ✅ Yes | Fully supported. |
| Windows (NTFS) | ✅ Yes (usually) | `CreateHardLinkW` works for files the user owns on the **same volume**, no admin. But fails with `EPERM` if privilege missing, `EXDEV` cross-volume. |
| Windows (FAT/FAT32) | ❌ No | No hardlink support at all → must copy. |
| Windows (ReFS) | ⚠️ Mostly no | ReFS < v3.5 lacks hardlinks (`ENOTSUP`); later versions added them. Assume "no" for safety. |
| Any cross-volume | ❌ No | `EXDEV` — hardlinks cannot span volumes/filesystems. Both names live in one `media/` dir, so this only bites if the *canonical* and *alias* were ever on different mounts (they aren't). |

**Recommendation:** Do **not** rely on hardlinks for the dedup guarantee. CAS
already stores once. If original names are desired, hardlink-with-copy-fallback
is fine as an *optional* polish, never on the critical path. Symlinks are worse
(need admin/Developer Mode on Windows, can dangle) — avoid entirely.

---

## 5. Integration with the Existing Pipeline

| Layer | Impact | Detail |
|-------|--------|--------|
| **fflate** | None | We still use the custom central-directory random-access extractor (`readCentralDirectory` + `extractEntry`), *not* fflate streaming (fflate's streaming inflate mis-handles data-descriptor members — already a documented v1 deviation). Hashing plugs into `extractEntry`'s output pipe. |
| **tsup / esbuild build** | None for core; verify for `xxhash-wasm` | `node:crypto` is a built-in → left external automatically. If `xxhash-wasm` is added, confirm the WASM inlines (see §2 note). `bin: dist/index.js` ESM output unchanged. |
| **commander (CLI)** | Tiny | Add `--no-dedupe` flag mirroring `--no-fetch-titles`. No new command. |
| **date-fns / picocolors** | None | Unrelated. |
| **Renderers (md/html/json, `--inline`)** | Indirect | They already consume `MediaEntry.relPath`. With CAS, `relPath` points at the canonical hash file; `--inline` then base64-encodes each canonical blob **once** and reuses it for all identical refs — dedup extends to the inlined HTML too. |

No new CI matrix entry needed; existing Node 22/24 jobs cover `node:crypto`.

---

## 6. What NOT to Add

- ❌ **`@node-rs/xxhash` / any native binding** — contradicts the browser-reuse +
  zero-native-dep stance; adds per-platform prebuilt binaries to a personal CLI.
- ❌ **`xxhashjs`** — pure-JS, 10–350× slower; no benefit over `crypto`.
- ❌ **`multihashing` / `hasha` / generic hash wrappers** — unnecessary
  abstraction over a 3-line `crypto` call; adds deps for nothing.
- ❌ **A database (sqlite/leveldb)** — manifest JSON is enough; backups are
  small and read-once.
- ❌ **Hardlinks as the dedup mechanism** — CAS already dedupes; links add
  portability risk (FAT/ReFS/Windows) for zero correctness gain.
- ❌ **`blake3` / `xxhash` as the *authoritative* hash** — non-cryptographic; a
  maliciously crafted collision could merge two different files. SHA-256 is the
  trust anchor; non-crypto hashes are pre-filters only.
- ❌ **In-memory buffering of media to hash** — defeats the memory-safety
  constraint. Always hash in the extract pipe.

---

## 7. Versions Verified (quality gate)

| Package | Declared/Recommended | Status | Source | Confidence |
|---------|----------------------|--------|--------|------------|
| `node` | `>=22.12` (dev 26.5.0) | OK — `crypto.createHash` streaming stable since 0.x | Node docs (v26.7) | HIGH |
| `xxhash-wasm` | **1.1.0** | latest on npm, 2026-08-24 | `npm view xxhash-wasm version` | HIGH |
| `@node-rs/xxhash` | 1.7.7 | latest but rejected (native) | `npm view` | HIGH |
| `xxhashjs` | 0.2.2 | latest but rejected (slow) | `npm view` | HIGH |
| `commander` / `fflate` / `tsup` / `picocolors` / `date-fns` | unchanged from v1.0 | still current | project `package.json` | HIGH |

No version bumps required for the existing stack.

---

## 8. Phase-Level Research Flags (for roadmap)

- **CAS manifest + `buildMediaMap` rewrite** is the only non-trivial code change;
  needs a phase with fixture coverage for the pre-v1.1 fallback path.
- **`xxhash-wasm` + tsup bundling** — verify WASM inlining during the build phase
  (MEDIUM confidence); if it misbehaves, ship v1.1 with SHA-256 only (still
  fully functional) and add xxhash later.
- **Cross-backup global store** (`~/.wa-backup/store`) is a *future* milestone,
  not v1.1; the manifest design already supports it.

---

## 9. Sources

- Node.js `crypto` docs — `Hash` as stream, `pipeline` error semantics (nodejs.org/api/crypto, v26.7). HIGH.
- AppSignal "Use Streams…" — `pipeline` vs `.pipe()`, memory-safe 4 GB hashing. HIGH.
- `xxhash-wasm` GitHub/npm (jungomi) — benchmarks vs xxhashjs & Node crypto, WASM, browser+Node, v1.1.0. HIGH.
- `@node-rs/xxhash` npm — native napi-rs benchmarks (fastest, but native). HIGH.
- Microsoft Learn "Hard Links and Junctions" — NTFS hardlink rules, same-volume only, no admin for owned files. HIGH.
- nodejs/node#11663 + microsoft/TypeScript#61858 — `ENOTSUP`/`EXDEV`/`EPERM` hardlink failures → copy fallback pattern. HIGH.
- OCFL spec (ocfl.io) — content-addressing, manifest maps logical→content, "avoid hard/symlinks for dedup." HIGH.
- GitLab ADR-008 (CAS) & Kopia architecture — SHA-256 block ID, temp-then-move, skip-if-exists dedup. HIGH.
- `npm view` for xxhash-wasm / xxhashjs / @node-rs/xxhash versions. HIGH (authoritative).
