# Architecture Research: Media Deduplication (v1.1 — Media Hygiene)

**Project:** WhatsApp Chat Backup (`wa-backup`)
**Researched:** 2026-08-24
**Mode:** Architecture — feature integration into an existing TypeScript/Node ESM CLI
**Overall confidence:** HIGH (claims verified against the actual source: `src/media.ts`, `src/model.ts`, `src/render/*.ts`, `src/parse/message.ts`, `src/csv.ts`, `src/parse/types.ts`, `test/media.test.ts`)

---

## Executive Recommendation

Implement deduplication as **content-addressed storage at reconcile time**, with a
**`media/manifest.json` bridge** that decouples the renderers from the on-disk
filename.

- The message model (`Message`, `messages.csv`) is **untouched**. Deduplication lives
  entirely in the media layer (`reconcileMedia` + a new manifest + `buildMediaMap`).
- During the existing streaming extraction, compute a **SHA-256** hash (and size) of
  each media entry **without buffering the file** (a `Transform` over the inflate/data
  stream — preserves the PARSE-02 memory guarantee).
- Name the stored file by content: `media/<sha256>.<ext>` (ext from the zip entry).
  Two references with byte-identical content hash to the same path, so the second
  extraction is skipped (temp file discarded) and **one physical copy is kept** — disk
  savings are automatic.
- Persist `media/manifest.json` mapping each *original* ref → `{ hash, relPath, size,
  mime }`. `buildMediaMap` reads the manifest instead of guessing by normalized
  filename. This simultaneously (a) enables content dedup, (b) makes re-rendering from
  CSV without the ZIP robust (today it re-derives by fragile name matching), and
  (c) satisfies the "verify media by size + hash" requirement as a first-class artifact.
- Renderers need **no logic change** (they already read `entry.relPath`); optionally add
  a per-render base64 cache keyed by `relPath` so `--inline` doesn't re-encode identical
  bytes.

**Why this over the alternatives:** a separate post-process pass doubles I/O and still
ends in a rename; hardlink-based dedup is fragile cross-platform (Windows) and breaks
the "folder opens standalone in any browser" goal less cleanly than a manifest. CAS-at-
reconcile is the only option that adds *zero* extra archive passes and yields idempotent,
verifiable output.

---

## Context: Current Architecture (verified)

### Component map (relevant slice)

| Component | Responsibility | Key facts (from code) |
|-----------|----------------|------------------------|
| `src/parse/message.ts` | Streaming parser → `Message[]` | `Message.media` = original referenced filename (or `''`). Never a path. |
| `src/csv.ts` | `messages.csv` source-of-truth | `readCsv`/`writeCsv`/`mergeCsv`. `Message` shape: `timestamp_iso,type,author,text,media,url_titles`. **No media-path column** — only the original ref string. |
| `src/media.ts` `reconcileMedia` | Copy matched zip entries → `<dir>/media/` | Matches refs→zip entries by `normalizeMediaName`. Writes to `mediaDir/<zip-basename>`. Returns `{ resolved, unresolved }` (original ref strings). |
| `src/media.ts` `buildMediaMap` | Disk-resident media map | **Scans `<dir>/media/*`**, builds `normalized→actualFilename`, then for each message resolves `m.media` → `MediaEntry { relPath: 'media/<hit>', mime, size, inlineable }`. Missing refs are absent from the map (renderers show placeholders). |
| `src/media.ts` `extractEntry` | Stream one zip member → disk | Bounded `ReadStream` + `zlib.createInflateRaw()`; the whole archive is never buffered (PARSE-02). |
| `src/render/{json,md,html}.ts` | Three outputs | Each calls `buildMediaMap(outDir, messages)` then reads `entry.relPath` for `src`/`href`/data-URI. `m.media` is used **only** for `alt` text and placeholder labels. |
| `src/model.ts` `runParser` | Orchestration | Parses → `mergeCsv` → enrich titles → `reconcileMedia(zip, dir, distinctMedia)` → `renderOutputs` → stderr media report. |
| `src/index.ts` | CLI (commander) | Flags: `<zip>`, `--out`, `--inline`, `--verbose`, `--day-first/--month-first`, `--no-fetch-titles`. |

### Current data flow (media)

```
parseMessages(_chat.txt)  ──►  Message[].media = ORIGINAL ref string
        │
        ▼  mergeCsv  ──►  messages.csv  (source-of-truth; stores ONLY original ref)
        │
        ▼  reconcileMedia(zip, dir, distinctMedia)
        │     • match ref → zip entry (by normalized name)
        │     • extractEntry → media/<zip-basename>     ◄── stores under ORIGINAL-ish name
        │     • returns { resolved[], unresolved[] }
        │
        ▼  renderOutputs  ──► each renderer:
              buildMediaMap(dir, messages)
                 • SCAN media/ dir, match normalized filename → actual file
                 • MediaEntry.relPath = 'media/<hit>'
              render src = entry.relPath   (original ref only used for alt/placeholder)
```

**The coupling that matters:** `buildMediaMap` reconstructs the ref→file link by
*scanning the directory and matching normalized names*. Today that works because
`reconcileMedia` wrote files under names derived from the zip entry. Any change to the
stored filename (e.g. hashing) **breaks re-render unless the link is persisted** — that
is exactly what the manifest supplies.

---

## The Dedup Problem, Restated

Two distinct situations:

1. **Name-variant dedup (already handled, partially).** `photo.jpg` vs `Photo (1).jpg`
   normalize equal → only one entry is extracted today, and `buildMediaMap` re-resolves
   both messages to the same file. This is *name* equality, not *content* equality.
2. **Content dedup (the new requirement).** `IMG-2024-WA0001.jpg` and
   `IMG-2024-WA0002.jpg` have *different* names but **byte-identical** content (common in
   WhatsApp exports — re-sent photos, stickers, or the same video forwarded twice). Today
   both are extracted and stored as two separate files. The feature wants them stored
   **once**, with every reference pointing at the single copy.

The solution must also satisfy "verify media by **size + cryptographic hash**" — so the
hash is a deliverable, not just an internal trick.

---

## Integration Analysis: Where Should Dedup Happen?

| Option | What it does | Verdict |
|--------|--------------|---------|
| **A. Content-addressed storage at reconcile time** (RECOMMENDED) | During streaming extraction compute SHA-256+size; write file as `media/<hash>.<ext>`; if that path already exists (same hash), skip the write. Persist `manifest.json`. | ✅ One archive pass, streaming, memory-safe, idempotent, verifiable. Minimal blast radius. |
| **B. Post-process after reconcile** | Extract everything to original names, then a second pass hashes `media/*`, finds duplicates, deletes extras, rewrites references. | ❌ Double I/O; still needs a manifest/rewrite to fix `relPath`; more code, same end state. No advantage. |
| **C. Decide-dedup but store by original name + hardlink** | Keep original names; point duplicates at the same inode via hardlinks. | ❌ Hardlinks are unreliable on Windows / some FS; complicates the "standalone folder opens in any browser" story; cross-ref cleanup is messy. |

**Decision: Option A.** It is the only design that adds the feature without adding a pass
over the archive or a second write cycle, and it turns the "verify by hash" requirement
into a durable artifact (the manifest).

---

## Recommended Design (detailed)

### New component: `MediaManifest`

Persisted to `<dir>/media/manifest.json` by `reconcileMedia`; consumed by `buildMediaMap`.

```ts
interface MediaManifestEntry {
  ref: string;          // original referenced filename (one entry per original ref)
  hash: string;         // sha256 hex (the "verify by hash" deliverable)
  relPath: string;      // 'media/<sha256>.<ext>' — content-addressed storage path
  size: number;         // bytes (the "verify by size" deliverable)
  mime: string;         // from extension
}
interface MediaManifest {
  version: 1;
  generatedAt: string;            // ISO timestamp
  entries: MediaManifestEntry[];  // all RESOLVED original refs
  unresolved: string[];           // refs with no matching zip entry
  duplicatesRemoved: number;      // refs that mapped to an existing hash
  bytesSaved: number;             // approx sum of sizes of deduped refs
}
```

Keep this in a small module `src/media-manifest.ts` (read/write + a `legacyScan` fallback
that reproduces today's `buildMediaMap` directory scan for pre-dedup folders). The split
improves testability and keeps `media.ts` focused.

### Modified: `reconcileMedia` (src/media.ts)

Algorithm (streaming, memory-safe):

1. Build `Map<norm, { meta: ZipEntryMeta, refs: string[] }>` — **collect all original
   refs per normalized name** (today `refsNormalized` is `Map<norm,ref>` and silently
   drops a second original ref with the same normalized name; this must be fixed so the
   manifest records *every* ref).
2. For each `{meta, refs}`:
   - Extract `meta` to a **temp file** `media/.tmp-<randomUUID>` while piping the
     inflate/raw stream through a `Transform` that `hash.update(chunk)`s (SHA-256) and
     forwards bytes (use `stream/promises` `pipeline`). Count size via `fs.statSync`
     after completion.
   - `relPath = 'media/<hash>.' + ext(zipBasename)`.
   - **Dedup decision:** if `media/<hash>.<ext>` already exists → `fs.unlinkSync(temp)`
     (the bytes are already on disk; this is the dedup win). Else `fs.renameSync(temp,
     media/<hash>.<ext>)`.
   - Record **every** original ref in `refs` → the same `{ hash, relPath, size, mime }`.
     Increment `duplicatesRemoved` / `bytesSaved` for each *additional* ref sharing a hash.
3. Write `media/manifest.json` (last, atomically — write to `.tmp` then rename).
4. Return `{ resolved, unresolved, duplicatesRemoved, bytesSaved }` (extend
   `ReconcileResult`; `resolved` stays "distinct original refs with a match" so existing
   callers/reports are unaffected).

Temp files are cleaned in a `try/finally` so an interrupted run never leaves orphan
`.tmp-*` files that `buildMediaMap` could mistake for media.

### Modified: `buildMediaMap` (src/media.ts)

- **Primary path:** if `media/manifest.json` exists → read it; for each message with
  `m.media`, look up its ref → `MediaEntry { relPath, mime, size, inlineable, hash }`.
  Missing refs → absent from map (placeholders, as today).
- **Legacy fallback:** if no manifest (pre-dedup output folder) → reproduce today's
  behavior (scan `media/*`, skip `manifest.json` and `.tmp-*`, match by normalized name).
  This preserves re-renderability of v1.0 backups **and** keeps existing
  `test/media.test.ts` scan-based assertions green.
- Add optional `hash?: string` to `MediaEntry` (used by an optional `--verify` and the
  inline cache; renderers ignore it).

### Unchanged: the Message model & `messages.csv`

`Message.media` remains the original ref string. **No CSV schema change.** This is the key
architectural decision: deduplication is purely a media-layer concern; the source-of-
truth keeps the human/original filename, and the manifest is the only thing that maps it
to the content-addressed physical path. Re-render from CSV (no ZIP) keeps working because
the manifest lives in `media/` next to the files.

### Modified: `runParser` (src/model.ts)

- Extend the stderr media report to surface `duplicatesRemoved` and `bytesSaved` in
  `--verbose` (and whenever `duplicatesRemoved > 0`):
  `media: 17 resolved, 2 unresolved, 3 duplicates removed (4.2 MB saved)`.
- No change to the call signature or ordering of `reconcileMedia` → `renderOutputs`.

### Renderers (json/md/html): no logic change required

They consume `entry.relPath` and `entry.mime`/`size`/`inlineable`; the fact that
`relPath` now points at `media/<hash>.<ext>` is transparent. `m.media` is still used only
for `alt`/placeholder text, preserving human-readable labels.

**Optional enhancement (separate, low-priority step):** in `html.ts`/`md.ts`, add a
`Map<string,string>` base64 cache keyed by `entry.relPath` during a render pass, so
`--inline` doesn't re-read + re-encode the same identical bytes for every message that
references a deduped file. Pure optimization; not required for correctness.

### `--inline` interaction

`readFileAsDataUri` / `mediaMarkdown` read `path.join(dir, entry.relPath)`. With CAS,
`relPath` is `media/<hash>.<ext>`; the read still works. Inlineable check (`size <=
INLINE_MAX_BYTES && !video/`) is unchanged — it operates on `entry.size` which the
manifest provides. Identical files are inlined once per *reference* unless the optional
cache is added; correctness is unaffected.

---

## Integration Points (explicit)

| Integration point | Current | After dedup | Risk |
|-------------------|---------|------------|------|
| `reconcileMedia` output filename | `media/<zip-basename>` | `media/<sha256>.<ext>` | MED — changes on-disk layout; mitigated by manifest |
| `reconcileMedia` return type | `{resolved,unresolved}` | + `duplicatesRemoved`, `bytesSaved` | LOW — additive |
| `buildMediaMap` ref→file link | directory scan + normalized match | manifest read (+ legacy scan fallback) | MED — must keep fallback or old backups break |
| `MediaEntry` shape | `{relPath,mime,size,inlineable}` | + optional `hash` | LOW — additive |
| `runParser` media report | resolved/unresolved counts | + dedup savings | LOW |
| `Message` / `messages.csv` | original ref string | **unchanged** | NONE |
| Renderers | read `entry.relPath` | unchanged (relPath now CAS) | LOW |
| `media/manifest.json` | does not exist | new artifact in `media/` | MED — must be excluded from any dir scan; written atomically |

---

## New vs Modified Components

| Component | Status | Summary |
|-----------|--------|---------|
| `src/media-manifest.ts` | **NEW** | Read/write `manifest.json` + legacy directory-scan fallback. Pure, no ZIP needed. |
| `reconcileMedia` (src/media.ts) | MODIFIED | Streaming SHA-256+size; temp→rename dedup; writes manifest; records all original refs. |
| `extractEntry` (src/media.ts) | MODIFIED | Add optional hash Transform + return `{hash,size}`; write to caller-supplied temp path. |
| `buildMediaMap` (src/media.ts) | MODIFIED | Manifest-first; legacy fallback preserved. |
| `ReconcileResult` (src/media.ts) | MODIFIED | + `duplicatesRemoved`, `bytesSaved`. |
| `MediaEntry` (src/media.ts) | MODIFIED | + optional `hash`. |
| `runParser` (src/model.ts) | MODIFIED | Enhanced stderr dedup report. |
| `render/{json,md,html}.ts` | UNCHANGED (optional cache) | No logic change; optional per-render inline cache. |
| `Message` / `csv.ts` | UNCHANGED | No schema change — dedup stays in media layer. |
| `test/media.test.ts` | MODIFIED (test only) | Add manifest-path coverage; legacy scan assertions remain via fallback. See "Test Impact". |

---

## Data Flow — After Dedup

```
parseMessages  ──►  Message[].media = ORIGINAL ref string   (unchanged)
        │
        ▼  mergeCsv  ──►  messages.csv   (unchanged; original ref only)
        │
        ▼  reconcileMedia(zip, dir, distinctMedia)
        │     • match ref → zip entry (normalized name; collect ALL original refs)
        │     • extractEntry → media/.tmp-<uuid>  +  SHA-256 + size  (streaming)
        │     • relPath = media/<hash>.<ext>
        │     • if exists → unlink temp (DEDUP) ; else rename temp → relPath
        │     • record every original ref → {hash, relPath, size, mime}
        │     • write media/manifest.json  (atomic)
        │     • returns { resolved, unresolved, duplicatesRemoved, bytesSaved }
        │
        ▼  renderOutputs  ──► each renderer:
              buildMediaMap(dir, messages)
                 • READ media/manifest.json  (legacy dir-scan fallback if absent)
                 • MediaEntry.relPath = 'media/<hash>.<ext>'
              render src = entry.relPath     (original ref only for alt/placeholder)
```

---

## Suggested Build Order (dependency-respecting)

Order is dictated by: hash must exist before the dedup *decision*; the dedup decision +
manifest write must exist before `buildMediaMap` can be switched to manifest-backed;
renderers are last and need no logic change.

| # | Step | Depends on | Why this order | Pitfalls owned |
|---|------|-----------|----------------|----------------|
| **1** | Streaming hash+size primitive in `media.ts` — `extractEntry` gains a `Transform` (SHA-256) + returns `{hash,size}`; writes to a caller temp path. No behavioral change yet. | nothing | Isolates the only novel, memory-critical piece. Unit-testable on a buffer/stream without the rest of the pipeline. | P6 (must stay streaming), P2 (interrupted temp cleanup) |
| **2** | Content-addressed naming + dedup decision in `reconcileMedia`: compute `relPath` from hash, temp→rename, skip write if exists; collect **all** original refs per hash; emit `duplicatesRemoved`/`bytesSaved`. | Step 1 | Needs the hash from Step 1 to decide the filename and detect duplicates. Still writes files; `buildMediaMap` not yet changed. | P1 (don't break re-render yet — mitigate in Step 3), P4 (ext/type on collision), P7 (exclude manifest from scans) |
| **3** | `media-manifest.ts` (new) + `buildMediaMap` manifest-first with legacy fallback. | Step 2 (manifest schema) | Once the manifest is produced (Step 2), the map can stop guessing by filename. Fallback preserves old backups + existing tests. **This step closes the P1 re-render break.** | P1, P7, P8 (stale manifest on re-run with different zip) |
| **4** | `runParser` report enhancement (stderr dedup savings). | Step 2 (new fields) | Pure reporting; safe once `ReconcileResult` carries the data. | — |
| **5** | Renderers: verify no change; **optional** per-render base64 cache keyed by `relPath` for `--inline`. | Step 3 (relPath stable) | Logic unchanged; cache is an optimization only, built after the map contract is fixed. | P5 (inline re-encode cost) |
| **6** | Tests: add `media-manifest` unit tests (write→read round-trip, dedup produces one file, legacy fallback); keep existing scan-based `test/media.test.ts` assertions valid via the fallback. Add an integration test asserting `bytesSaved > 0` on a known-duplicate export. | Steps 1–3 | Lock behavior before the next milestone. | (regression safety) |
| **7** | (Optional, later) `--verify` flag: re-hash on-disk `media/*` against manifest to confirm integrity / detect bit-rot. | Step 3 | Uses the already-stored `hash`. Out of v1.1 core scope but cheap given the manifest. | P2 |

**Dependency rationale:** Step 1 (hash) is the leaf. Step 2 cannot decide dedup without
it. Step 3 must follow Step 2 because it consumes the manifest that Step 2 writes — and
until Step 3 lands, re-rendering a deduped folder would break (P1), so Steps 2→3 are
shipped together as one coherent change. Renderers (Step 5) are intentionally last: their
contract (`entry.relPath`) is stable throughout, so they need verification, not
rewriting.

---

## Pitfalls (feature-specific)

| # | Pitfall | Why it happens | Prevention / Mitigation |
|---|---------|----------------|--------------------------|
| **P1** | Re-render from CSV breaks after switching to hash-named files | `buildMediaMap` currently re-derives the link by scanning + normalized-name match; hash names defeat that. | Step 3 persists `manifest.json` and switches `buildMediaMap` to read it. Ship Steps 2+3 together. |
| **P2** | Interrupted extraction leaves orphan `.tmp-*` or partial files | Crash mid-extract. | Write to `media/.tmp-<uuid>`, `unlink` temp in `finally`; atomic rename to final; verify file exists post-rename. |
| **P3** | MIME/extension lost under content naming | Browser needs correct extension to open `media/<hash>.jpg`. | Preserve the zip entry's extension in `relPath`; `mimeFromExt` keeps working. |
| **P4** | Two refs, identical bytes, different extensions/types | Rare (e.g. re-sent file renamed). First writer's ext wins; a message typed as `video` could point at a `.jpg`. | Acceptable edge; note as known limitation. Could prefer the more specific ext if conflicts arise. |
| **P5** | `--inline` re-encodes identical bytes per reference | Each message reads + base64-encodes the same `relPath`. | Optional Step 5 cache keyed by `relPath`. Correctness unaffected. |
| **P6** | Memory blow-up if hashing loads whole file | Tempting to `fs.readFile` + `crypto`. | Hash via a `Transform` over the existing streaming extract (PARSE-02 guarantee preserved). Never buffer. |
| **P7** | Manifest / temp files mistaken for media | Any directory scan must ignore them. | Manifest is read directly (not scanned). Legacy fallback explicitly skips `manifest.json` and `.tmp-*`. |
| **P8** | Stale manifest on re-run with a *different* zip | User points tool at a new export into the same dir. | Overwrite manifest each run from current refs; orphan files from removed refs are harmless (minor disk waste). Optional prune later. |
| **P9** | Existing `test/media.test.ts` pins old naming | Line 104 asserts `relPath === 'media/photo (1).jpg'` via manual dir setup. | Keep legacy scan fallback (Step 3) so that test still passes; add new manifest-path tests (Step 6). |

---

## Web-Reuse Consistency

This change stays entirely inside `src/media.ts` / new `media-manifest.ts` — both are
**Node adapters** (they import `node:fs`, `node:zlib`, `node:crypto`). The `core/`
parser (`parse/message.ts`) is untouched, so the "future web frontend reuses the parsing
core" constraint (PROJECT.md) is preserved. The dedup *decision logic* (ref→hash→relPath,
manifest schema) is portable; only the hashing primitive would swap `node:crypto` for
`crypto.subtle.digest` in a browser adapter. No core change required for v1.1.

---

## Test Impact (call out for the plan phase)

- `test/media.test.ts` line 88–104 builds a `media/photo (1).jpg` file and asserts
  `buildMediaMap` returns `relPath === 'media/photo (1).jpg'`. This remains valid **only
  if** the legacy directory-scan fallback (Step 3) is kept. Plan to keep it.
- `test/media.test.ts` line 49 asserts `reconcileMedia` → `17 resolved, 0 unresolved` on
  the Notas pessoais sample. `resolved` semantics (distinct original refs matched) are
  preserved, so this still passes; the on-disk file count may drop below 17 due to dedup
  (add a `bytesSaved > 0` assertion as new coverage).
- Add unit tests for `media-manifest.ts`: write→read round-trip; two identical-content
  refs → one physical file + two manifest entries; legacy fallback resolves a pre-dedup
  folder.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Where dedup lives (media layer, model untouched) | HIGH | Verified `Message`/`csv.ts` carry only the original ref; renderers use `relPath`. |
| CAS-at-reconcile feasibility | HIGH | `extractEntry` already streams; adding a hash `Transform` is mechanical and memory-safe. |
| Manifest as the re-render bridge | HIGH | Directly resolves the P1 break; legacy fallback de-risks old backups + tests. |
| Hash algorithm (SHA-256, node:crypto) | HIGH | Built-in, no dep, satisfies "cryptographic hash". |
| Renderer impact | HIGH | No logic change; `relPath` contract stable. |
| Edge cases (P4 type/ext, P8 re-run) | MEDIUM | Real-export impact is low; flagged as known limitations, not blockers. |

---

## Sources (confidence)

- First-hand reading of `src/media.ts`, `src/model.ts`, `src/render/{json,md,html}.ts`,
  `src/parse/message.ts`, `src/csv.ts`, `src/parse/types.ts`, `src/index.ts`,
  `test/media.test.ts` (wa-backup repo, 2026-08-24) — **HIGH**: every claim above is
  traced to actual code, not assumption.
- `PROJECT.md` / `AGENTS.md` (existing planning context) — **HIGH**: confirms the
  "core reusable in web," "memory-safe streaming," and "standalone folder" constraints
  that bound the recommended design.
- Prior research `.planning/research/ARCHITECTURE.md` (greenfield Hexagonal design,
  2026-08-21) — **HIGH**: confirms `media.ts` is a Node adapter, so the change stays off
  the `core/` path and preserves web reuse.
