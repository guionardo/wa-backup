# Domain Pitfalls — Media Deduplication (v1.1, Media Hygiene)

**Feature:** Add size + hash deduplication to the existing `wa-backup` CLI so byte-identical
referenced media is stored once and every reference points at that single copy.
**Researched:** 2026-08-24
**Overall confidence:** HIGH (every pitfall is derived from reading the actual source:
`src/media.ts`, `src/model.ts`, `src/render/{html,md,json}.ts`; cross-platform link limits and
streaming-hash API corroborated against Microsoft Learn + Node.js docs).

---

## How the current system works (the integration surface)

This is what a dedup feature must slot into — every pitfall below references these facts:

- `reconcileMedia(zipPath, dir, refs)` (`src/media.ts:171`) reads the ZIP central directory,
  matches each distinct `_chat.txt` ref to a zip entry by **normalized name**
  (`normalizeMediaName`, lowercases, strips `(1)`, collapses spaces/`-`/`_`), and copies the
  matched entry to `<dir>/media/<base>` where `<base>` is the **zip's own filename**.
- `buildMediaMap(dir, messages)` (`src/media.ts:236`) scans `<dir>/media/*`, indexes by
  normalized name, and for each message with `m.media` returns `relPath: "media/<actualFile>"`,
  `size`, `mime`, `inlineable`. It is keyed by the **original ref** (`m.media`) but looked up via
  the normalized name.
- The **three renderers** (`html.ts`, `md.ts`, `json.ts`) each call `buildMediaMap(outDir, messages)`.
  - `html.ts` `mediaHtml` / `readFileAsDataUri`: `entry.relPath` → `<img src="media/F">` or a
    `data:<mime>;base64,…` URI when `--inline` and `inlineable`.
  - `md.ts` `mediaMarkdown`: same, `![alt](media/F)` or `data:` URI.
  - `json.ts` `toRendered`: stores `mediaPath = relPath`.
- `messages.csv` is the **source of truth** (`src/model.ts:109` `mergeCsv`). It stores `m.media`
  as the **original ref** from `_chat.txt`. Renderers re-read the CSV + media folder; **no ZIP is
  needed to re-render**.
- `INLINE_MAX_BYTES = 8 MiB`, videos never inlined (`src/media.ts:13`, `isInlineable`).
- AppleDouble `._*` / `__MACOSX` are skipped at reconcile (`isAppleDouble`, `src/media.ts:55`).
- Unresolved media must **never crash** the run — it renders as a placeholder (PROJECT.md, MEDIA-03).

---

## Proposed phase structure (used in the assignments below)

| Phase | ID | Scope |
|-------|----|-------|
| 1 | **MED-DEDUP-1** | Content-addressed media store: streaming SHA-256 inside extraction, write `media/<sha256>.<ext>`, emit a derived `media-manifest.json` mapping **original ref → canonical relPath**, rewire `buildMediaMap` + 3 renderers through the manifest, exclude AppleDouble, preserve ext/MIME, survive corrupt/unresolved, **key dedup on SHA-256 (never on name/size)**, **no filesystem linking**. |
| 2 | **MED-DEDUP-2** | Collapse byte-identical entries to one copy, delete originals, size pre-filter + bounded concurrency + incremental hashing, report accurate bytes-saved. |
| 3 | **MED-DEDUP-3** | Idempotency & safety: manifest is derived/regenerated each run, deterministic canonical-name selection, re-render snapshot test, verify link-free on exFAT, collision + corrupt-entry fixtures. |

---

## Critical Pitfalls

### Pitfall 1 — Dedup keyed on the wrong identity (name or size instead of content)
**What goes wrong:** If dedup merges files by normalized name, two genuinely different photos that
normalize-equal (`IMG 1.jpg` vs `IMG-1.jpg`) get collapsed into one (data loss); conversely,
byte-identical files with different names are never merged (no savings). If dedup keys on
`size` alone, a 4 KB collision of different content shares a name → corruption.
**Why it happens:** The existing match is name-based (`normalizeMediaName`); it's tempting to reuse
it for dedup. Size is tempting as a "fast" key.
**Consequences:** Silent data corruption or zero deduplication benefit; defeats the entire feature.
**Prevention:** Dedup key = **SHA-256 of the raw bytes**. Use `size` only as a pre-filter (skip
hashing when no other entry shares the same byte size). Never store under a size-derived name.
**Detection:** Unit test with a fixture ZIP containing (a) two byte-identical files with different
names, and (b) two same-size different-content files — assert (a) merges, (b) does not.
**Phase:** MED-DEDUP-1.

### Pitfall 2 — Renaming files to hashes breaks the CSV source-of-truth and renderer lookups
**What goes wrong:** CSV keeps `m.media` = original ref (PROJECT.md, `mergeCsv`). Renderers resolve
via `buildMediaMap` scanning disk. If files are renamed to `media/<sha256>.ext` and nothing maps the
original ref → canonical file, every `media.get(m.media)` returns `undefined` → all media becomes
placeholders. The JSON `mediaPath` contract also changes silently.
**Why it happens:** The ref→file bridge that `normalizeMediaName` previously provided is destroyed
once filenames are content-addressed.
**Consequences:** Total media regression on the very feature being added; consumers of `messages.json`
`mediaPath` break.
**Prevention:** Emit a **derived `media-manifest.json`** (next to `messages.csv`) mapping
`originalRef → "media/<sha256>.<ext>"`. `buildMediaMap` consults the manifest keyed by **exact
original ref**, with a normalized-name fallback for legacy/odd cases. `messages.csv` stays the sole
source of truth; the manifest is a derived index, not an input.
**Detection:** Assert `buildMediaMap` returns the correct `relPath` for a ref whose on-disk file is a
hash-named copy; snapshot-test `messages.json` `mediaPath`.
**Phase:** MED-DEDUP-1.

### Pitfall 3 — Re-renders without the ZIP cannot find files
**What goes wrong:** `renderOutputs` (`model.ts:69`) re-reads `messages.csv` + media folder; the ZIP
is gone for old backups. If the ref→canonical mapping lives only in memory during `runParser`, a later
`--inline` re-render produces broken `data:` URIs / placeholders.
**Why it happens:** The manifest isn't persisted, or renderers don't read it.
**Consequences:** Backups become un-renderable over time — violates the core "open years later" value.
**Prevention:** `media-manifest.json` is written every run (`reconcileMedia`/`buildMediaMap` phase) and
read by all three renderers. No ZIP required for re-render.
**Detection:** Integration test: run once (no `--inline`), then re-render `--inline` from CSV+folder
only; assert identical media resolution.
**Phase:** MED-DEDUP-1 (wiring) + MED-DEDUP-3 (idempotency test).

### Pitfall 4 — Hash collisions / weak hash function
**What goes wrong:** Using MD5 or size as the identity key lets two different contents collide to one
name → one overwrites the other (corruption).
**Why it happens:** MD5 is fast and "good enough"-looking; size is even cheaper.
**Consequences:** Irrecoverable media corruption presented as a successful dedup.
**Prevention:** SHA-256 (or BLAKE3) of content. Collision resistance ≈ 2^128 — treat as cryptographically
safe. Keep size strictly as an optimization pre-filter, never the key.
**Detection:** Lint/rule: dedup key must be a SHA-256 hex digest; a code review gate rejects `md5`/`size`
as the key.
**Phase:** MED-DEDUP-1.

### Pitfall 5 — Cross-platform hardlink/symlink failures on exFAT / USB backup targets
**What goes wrong:** A link-based dedup (one physical file + hardlinks/symlinks for each duplicate ref)
produces **broken or missing** files when the backup lands on exFAT or FAT32, which **do not support
hardlinks or symlinks** (Microsoft Learn filesystem comparison: exFAT/FAT32 = No for both). Backups are
exactly the kind of artifact copied to USB sticks.
**Why it happens:** Hardlinks look like the cleanest "store once, reference many" solution on the dev's
NTFS/APFS machine.
**Consequences:** On the user's actual backup drive the HTML opens but media 404s/broken-image — violates
"output folder must open standalone in any browser, no server" (PROJECT.md Constraints).
**Prevention:** **Do not use filesystem links at all.** Store the physical bytes **once** under a
content-address name (`media/<sha256>.<ext>`) and point every ref at that single file via the manifest.
All `relPath`s are plain files; the browser resolves `media/<sha256>.jpg` directly. Hardlinks, if ever
added as an optional optimization, must fall back to a real copy on `EOPNOTSUPP`/`EPERM`.
**Detection:** CI job that writes a backup to a FAT-formatted loop image (or asserts zero symlinks/
hardlinks in output) and opens the HTML to confirm media resolves.
**Phase:** MED-DEDUP-1 (architecture decision: link-free) + MED-DEDUP-3 (exFAT verification).

### Pitfall 6 — Memory-safety violated by hashing large videos
**What goes wrong:** Computing the hash with `fs.readFile(...).toString('base64')` then `createHash` on a
multi-GB video loads the whole file into memory → OOM, breaking the memory-safety constraint
(PROJECT.md) and the "stream-parse" guarantee.
**Why it happens:** `readFileAsDataUri` already reads whole files for inline; it's tempting to reuse that
buffer for hashing.
**Consequences:** CLI crashes on large exports — the exact scenario v1.0 was built to survive.
**Prevention:** Hash **by streaming**: `createReadStream(file).pipe(createHash('sha256'))` (Node `Hash` is a
Transform stream — confirmed in Node.js docs; a 2.5 GB `hash.update` throws `ERR_OUT_OF_RANGE`, but piping
does not). Better: integrate the hash **into `extractEntry`** (`media.ts:123`) so each zip member is hashed
once as it streams to disk — no second read pass.
**Detection:** Test on a ≥2 GB video fixture asserting heap stays bounded (e.g., `--max-old-space-size`
guard or a memory sampler) and hash matches `sha256sum`.
**Phase:** MED-DEDUP-1.

### Pitfall 7 — Non-idempotent re-runs leave originals behind (no actual savings)
**What goes wrong:** Extraction writes `IMG1.jpg`; dedup then creates `hash.jpg` but leaves `IMG1.jpg`.
Re-running the same ZIP regenerates both → storage roughly doubles and the manifest may reference stale
names.
**Why it happens:** Extraction and dedup are two separate passes with no cleanup step.
**Consequences:** Feature reports "saved" but the disk disagrees; re-runs are non-deterministic.
**Prevention:** Make reconcile→dedup a **single atomic pass**: extract/compute hash → if content already
has a canonical file, skip writing a second copy (or write temp then rename into place and remove the temp).
Re-running the same ZIP yields byte-identical `media/<sha256>.<ext>` names → idempotent.
**Detection:** Run twice on the same ZIP; assert output `media/` contents are identical and
`bytesSaved` is stable/reproducible.
**Phase:** MED-DEDUP-1 (single pass) + MED-DEDUP-3 (idempotency test).

### Pitfall 8 — Normalization-shadowing of distinct-content files (pre-existing bug, worsened by dedup)
**What goes wrong:** `normalizeMediaName('IMG 1.jpg') === normalizeMediaName('IMG-1.jpg')`. Today
`buildMediaMap` indexes by normalized name and the **first** match wins, so two different photos that
normalize-equal shadow each other. With content addressing, if the manifest is keyed by normalized name
the same shadowing persists and dedup can't tell them apart.
**Why it happens:** Normalization was designed for tolerant matching, not identity.
**Consequences:** One of two distinct photos silently disappears from output.
**Prevention:** Key the manifest by the **exact original ref** (`m.media`), not the normalized form.
Renderer lookup: exact ref first, normalized fallback only for legacy/odd refs. Distinct refs that
normalize-equal but differ in content each get their own `media/<sha256>.<ext>`.
**Detection:** Fixture with two different photos whose names normalize-equal; assert both render.
**Phase:** MED-DEDUP-1.

### Pitfall 9 — Hashing the already-inlined base64 instead of the raw bytes
**What goes wrong:** `--inline` base64-encodes file bytes (`readFileAsDataUri`, `md.ts:60`). If a future
step computes the dedup hash from the **base64 string** (e.g., from a JSON `data:` URI) instead of raw
bytes, the digest won't match the on-disk file digest → dedup fails or inline/media diverge.
**Why it happens:** Base64 is "the bytes" from a render perspective and is easy to grab.
**Consequences:** Dedup misses real duplicates; or the same content is stored twice (once as file, once
inlined) with mismatched identities.
**Prevention:** Dedup **always** hashes raw file bytes at extraction time, before any encoding. Inline is a
pure render-time transform of the canonical file and must never feed back into dedup. Keep dedup strictly
in the `reconcileMedia`/`extractEntry` layer.
**Detection:** Assert the dedup digest equals `sha256sum` of the raw file, and that `--inline` output's
bytes decode back to that same file.
**Phase:** MED-DEDUP-1.

### Pitfall 10 — Unresolved / corrupt media must not crash the run
**What goes wrong:** A corrupt zip entry or a ref with no matching entry makes hashing/extraction throw;
if unhandled, the whole run dies — breaking the validated "unresolved never crashes" guarantee
(PROJECT.md MEDIA-03).
**Why it happens:** Adding a hash step to the loop without try/catch.
**Consequences:** One bad file aborts an entire chat backup.
**Prevention:** Wrap per-file extract+hash in try/catch; on failure treat the ref as **unresolved**
(placeholder), exactly as today. `reconcileMedia`'s resolved/unresolved split is computed *after* hashing,
never before.
**Detection:** Fixture ZIP with one CRC-broken entry; assert run completes and reports it unresolved.
**Phase:** MED-DEDUP-1 + MED-DEDUP-3 (corrupt fixture).

---

## Moderate Pitfalls

### Pitfall 11 — AppleDouble / `__MACOSX` leaking into dedup
**What goes wrong:** `._*` / `__MACOSX` entries get hashed, stored, and added to the manifest → junk
files and inflated "saved" numbers.
**Why it happens:** Dedup pass forgets to reuse `isAppleDouble`.
**Consequences:** Spurious media, broken placeholder logic, wrong savings.
**Prevention:** Reuse `isAppleDouble` (`media.ts:55`) in every dedup/scan step; never hash/write/record
these. The manifest contains only real media.
**Phase:** MED-DEDUP-1.

### Pitfall 12 — Extension / MIME loss under content addressing
**What goes wrong:** Storing as `media/<sha256>` (no extension) breaks `mimeFromExt` (`media.ts:45`) and
browser rendering (browsers don't reliably sniff `data:`/file MIME from content).
**Why it happens:** Hash is extensionless by default.
**Consequences:** Images/videos fail to render even though the bytes are correct.
**Prevention:** Preserve extension: `media/<sha256>.<ext>`, ext taken from the **representative** original
ref. When two refs are byte-identical but have different exts (`.jpeg` vs `.jpg`), store one file and map
both refs to it; browser MIME is resolved from the stored ext.
**Detection:** Fixture with `.jpeg`/`.jpg` duplicates; assert stored file has an ext and renders.
**Phase:** MED-DEDUP-1.

### Pitfall 13 — Hashing thousands of files is slow I/O
**What goes wrong:** Dedup adds a hash pass over every media file; on chats with thousands of photos the
run gets noticeably slower (and double I/O if hashing is a separate pass after extraction).
**Why it happens:** Naive "extract all, then hash all".
**Consequences:** Perceived regression in CLI speed; possible timeout in CI.
**Prevention:** (a) **Size pre-filter** — only compute a hash when ≥2 entries share the same byte size
(candidates); singletons are inherently unique. (b) **Bounded concurrency** (e.g., 8) for hashing.
(c) **Incremental** — store hash+size+mtime in the manifest; skip re-hashing a file already present with
matching size+mtime. (d) Hash **during** extraction (Pitfall 6) so bytes are read once.
**Phase:** MED-DEDUP-2.

### Pitfall 14 — Manifest staleness / rot on re-run with a different export
**What goes wrong:** If the manifest is treated as authoritative input and a *new* export of the same
chat is processed, stale entries point at files that no longer exist.
**Why it happens:** Persisting derived state as if it were source of truth.
**Consequences:** Re-render resolves to missing files; phantom "saved" bytes.
**Prevention:** The manifest is **derived and regenerated every run** from the current `media/` folder +
`messages.csv`. `messages.csv` remains the only source of truth. Never read the manifest as input.
**Detection:** Process export A, then export B into the same dir; assert manifest reflects only B.
**Phase:** MED-DEDUP-3.

### Pitfall 15 — Non-deterministic canonical-name selection across re-runs
**What goes wrong:** When two refs dedup, *which* original name/ext becomes the stored `media/<sha256>.<ext>`
may depend on iteration order → different runs yield different on-disk names → re-renders of the JSON/HTML
diverge (non-reproducible backups).
**Why it happens:** Picking "first seen" from an unordered `Map`/glob.
**Consequences:** Backup diffs are noisy; re-render snapshot tests flap.
**Prevention:** Choose the canonical representative **deterministically** — sort the colliding refs and pick
the first (or pick by zip central-directory order, which is stable). Hash filename depends only on content
→ already deterministic; only the *ext/representative* choice needs fixing.
**Detection:** Run twice; assert `media/` filenames identical (byte-for-byte snapshot).
**Phase:** MED-DEDUP-1 (decision) + MED-DEDUP-3 (snapshot test).

---

## Minor Pitfalls

### Pitfall 16 — Inaccurate disk-savings reporting / double counting
**What goes wrong:** "Saved N bytes" sums the canonical file too, or counts each ref. Real savings =
sum of the *duplicate copies removed* (everything except one canonical per content group).
**Why it happens:** Naive `Σ size of all refs`.
**Consequences:** Misleading CLI output; user distrust.
**Prevention:** `bytesSaved = Σ(size of each duplicate copy)` where duplicates = refs whose canonical file
is shared; the canonical is excluded. Surface alongside `resolved`/`unresolved` in the existing media report
(`model.ts:143`).
**Phase:** MED-DEDUP-2.

### Pitfall 17 — Dedup mutating message metadata (type/MIME) for byte-identical-but-different-type refs
**What goes wrong:** A photo and a sticker that are byte-identical share a file; if dedup also merges
message-level `type`/`mime`, the renderer picks the wrong element (`<img>` vs sticker).
**Why it happens:** Over-eager "merge everything about duplicates".
**Consequences:** Wrong UI element / alt text for some messages.
**Prevention:** Dedup affects **only storage + manifest path**. The message model (`m.type`, `m.media`) is
untouched; renderers keep using per-message `m.type`. The manifest maps ref→file; `m.type` decides the
element.
**Detection:** Fixture: identical bytes referenced once as `photo`, once as `sticker`; assert both render
with correct elements.
**Phase:** MED-DEDUP-1.

### Pitfall 18 — Git/portability of a content-addressed backup
**What goes wrong:** If a user commits the output to git, symlinked duplicates would be stored oddly;
content-addressed plain files are fine, but the `media-manifest.json` should also be committable.
**Why it happens:** N/A (mostly a note).
**Consequences:** Minor; a link-free design (Pitfall 5) already avoids the hard part.
**Prevention:** Keep output as plain files + a JSON manifest (both git-friendly). No symlinks ever.
**Phase:** MED-DEDUP-3 (optional verification).

---

## Phase → Pitfalls assignment (roadmap implication)

| Phase | Pitfalls addressed | Why here |
|-------|--------------------|----------|
| **MED-DEDUP-1** (content-addressed store) | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15(decision), 17 | Foundation: without content addressing + manifest + streaming hash + link-free + crash-safety, nothing else is safe. All integration-breaking pitfalls live here. |
| **MED-DEDUP-2** (collapse + savings) | 13, 16 | Performance and reporting depend on the store existing; safe to optimize after correctness. |
| **MED-DEDUP-3** (idempotency & safety) | 3, 7, 14, 15, 18 | Verification layer: proves re-runs are deterministic, manifest can't rot, link-free works on exFAT, collisions/corruption handled. |

**Ordering rationale:** Phase 1 must come first because Phases 2–3 are meaningless without a content-addressed
store and a persisted ref→canonical manifest. Phase 2 (optimization/reporting) is independent of Phase 3
(safety) but both depend on Phase 1; they can run in either order, with Phase 3 last to certify the whole.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Integration surface (CSV/manifest/renderer coupling) | HIGH | Read `media.ts`, `model.ts`, `render/*` directly; pitfalls cite exact functions/lines. |
| Cross-platform link limits (exFAT) | HIGH | Microsoft Learn filesystem comparison table: exFAT/FAT32 = No hardlinks/symlinks. |
| Streaming SHA-256 API | HIGH | Node.js `crypto` docs: `Hash` is a Transform stream; `hash.update` on huge buffers throws, piping works. |
| Hash-collision math | HIGH | SHA-256 collision resistance is standard cryptography; size-only key is the real risk. |
| Normalization-shadowing | HIGH | `normalizeMediaName` logic read; shadowing is a direct consequence of the current `buildMediaMap` index. |

## Gaps to address in later phase-specific research

- **Exact manifest schema** (`media-manifest.json` shape: `ref → {relPath, sha256, size, ext}`) — design in MED-DEDUP-1 plan.
- **Bounded-concurrency hashing number** (8 vs 16) — benchmark in MED-DEDUP-2.
- **Whether to keep `messages.json` `mediaPath` as the hash name or add a separate `mediaSha256` field** — API-compat decision in MED-DEDUP-1 (communicate as a breaking change or additive field).
