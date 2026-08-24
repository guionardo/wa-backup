# Feature Landscape: Media Deduplication (v1.1 — "Media Hygiene")

**Domain:** Disk-space optimization feature for an existing TypeScript/Node ESM CLI (`wa-backup`) that parses WhatsApp "Export chat" ZIPs and emits Markdown/HTML/JSON backups with reconciled media.
**Researched:** 2026-08-24
**Research mode:** Ecosystem (features dimension), scoped to the v1.1 deduplication requirement
**Overall confidence:** HIGH for the *mechanism* (corroborated across multiple independent production backup tools and a reference Rust implementation); MEDIUM for exact code-path integration (that is phase-level research, flagged below).

---

## Executive Summary

The requirement is concrete and well-understood: **verify each reconciled media file by its size + a cryptographic hash, and when two referenced files are byte-identical, store the bytes exactly once and point every reference at that single copy.** This is whole-file, content-addressed deduplication. It is a solved, low-risk problem with a clear canonical shape, so the research value here is in scoping *what not to build* and pinning down *end-user behavior* — not in discovering new technique.

The dominant pattern in every mature dedup tool (Borg, restic, zbackup, GitLab Artifact Registry, `dedup.rs`, `fdupes`-style scripts) is a **two-stage filter**:
1. **Group by size.** Files with a unique size *cannot* be duplicates, so they are copied as-is and never hashed.
2. **Hash only the size-collision groups.** Within a group of same-size files, compute a cryptographic digest (SHA-256) and group by digest; every digest group with >1 member is a duplicate set.

For `wa-backup` the right storage model is **content-addressed filenames inside `media/`**, not hardlinks or symlinks. The three renderers (MD/HTML/JSON) already resolve media through a single `MediaEntry.relPath` indirection (see `src/media.ts` `buildMediaMap`), so deduplication is achieved by changing *what `relPath` points to* — the duplicate physical copies are simply never written, and every distinct ref that hashes to the same content resolves to one canonical file. This keeps the output folder **portable** (no symlink that `file://` browsers or a copy to another disk will break) and **memory-safe** (hash is streamed during extraction; unique-size files are never buffered).

End-user behavior, which the feature must guarantee:
- **Disk savings** — WhatsApp re-exports and cross-chat forwards duplicate identical photos/videos; collapsing them to one copy typically reclaims a meaningful fraction of `media/` bytes in group chats.
- **Deterministic output** — the same ZIP always yields the same file set with the same canonical names and hashes (enables trust, diffing, re-running).
- **Idempotent re-runs** — re-running `wa-backup` on the same ZIP reproduces the identical `media/` without growing it; message de-dupe already exists (`mergeCsv`), dedup extends that property to media.
- **`--inline` coexistence** — deduplication always applies to the on-disk `media/` copy; with `--inline` the single HTML embeds each occurrence independently, so the *file-level* disk saving is not realized inside the inlined HTML (it is one self-contained file regardless). This is acceptable and must be documented, not "fixed" by fuzzy logic.

---

## How Media Deduplication by Size + Hash Works (the mechanism)

```
For each reconciled media file (post-extraction):
  stage 1: bucket by file SIZE
     └─ size is unique  → write once, skip hashing (cannot be a duplicate)
  stage 2: for each size bucket with >1 file:
       hash each file (SHA-256, streamed during extraction)
       bucket by HASH
       └─ hash is unique → write once
       └─ hash collides  → duplicate set:
            pick ONE canonical file (deterministic rule)
            write it once; map every other ref → canonical relPath
            (optionally delete / never write the extra copies)
```

- **Why size-first:** hashing is the expensive step. Most media in a single chat have distinct sizes, so the size pre-filter eliminates the vast majority of hash computations for free. This is the universally recommended optimization (confirmed in `dedup.rs` `build_dedup_plan` and the FNV-64a optimization write-up).
- **Why SHA-256:** cryptographic strength makes collisions astronomically improbable (birthday bound ≈ 2^128 distinct objects before 50% collision risk — far beyond any single-chat or even single-user scale). Production systems (GitLab, Borg, restic) treat SHA-256 as collision-free and do *not* byte-compare on match. BLAKE3 is a faster alternative with equal security if speed becomes a concern on very large media sets.
- **Collision paranoia (optional):** Borg adds a *cheap* secondary check on hash-match — compare the stored **size** of the new chunk to the stored size of the existing chunk; a size mismatch on equal hash is treated as a collision and handled. This costs nothing extra because size is already known. Recommended as an optional safeguard, not a default necessity.
- **Streaming, memory-safe hash:** compute the digest *while extracting* (pipe the inflate stream through `crypto.createHash`), so no file is re-read and nothing is buffered — this satisfies the project's hard "stream-parse / memory-safe" constraint and matches GitLab's "streaming hash during write" ADR.
- **Content-addressed storage vs links:** store the canonical bytes under a name derived from content (e.g., `media/<sha256>.<ext>`, or keep the *primary* original name and have others point to it). Avoid hardlinks/symlinks as the primary mechanism because they break portability — a backup copied to another disk, zipped, or opened via `file://` loses links, defeating the core "open years later, anywhere" value.

---

## Expected End-User Behavior (acceptance framing)

| Behavior | What the user sees | How the design delivers it |
|----------|--------------------|----------------------------|
| **Disk savings** | `media/` folder is smaller; "X duplicates removed, Y MB saved" on stderr | Two-stage dedup collapses identical files to one physical copy |
| **Deterministic output** | Re-running on the same ZIP yields byte-identical `media/` (same names, same hashes) | Canonical selection is a fixed, deterministic rule (see Differentiators) |
| **Idempotent re-runs** | Running the tool twice does not duplicate media or grow `media/` | Hashes are content-derived and stable; `mergeCsv` already makes messages idempotent |
| **No broken references** | MD/HTML/JSON all still render every message's media correctly | `relPath` rewrite keeps the `MediaEntry` indirection intact |
| **`--inline` still works** | Single HTML still opens with all media embedded | Inline reads the canonical file; embeds per occurrence (see caveat) |
| **Portable backup preserved** | Folder copies/zips to another machine and still opens in a browser | No symlinks/hardlinks; canonical file is a normal file in `media/` |

**`--inline` caveat (must be documented, not "fixed"):** when `--inline` is set, the HTML embeds each media occurrence as an independent base64 blob. Deduplication of the on-disk `media/` copy still happens, but the * HTML file itself does not shrink from dedup* because each message that references the duplicate still inlines its own copy. This is correct and expected — the user chose a single self-contained file. Do **not** attempt cross-occurrence base64 sharing inside one HTML as a v1.1 requirement (see Anti-Features).

---

## Existing v1.0 Features This Builds On (dependency context)

The deduplication feature is an *add-on* to already-shipped media handling. It must integrate with, not replace, these:

| Existing piece | File / symbol | Role in dedup |
|----------------|---------------|---------------|
| **Media reconciliation** | `src/media.ts` → `reconcileMedia` | Extracts zip entries into `media/`. Dedup hooks in here: compute hash during extraction, decide canonical, skip writing duplicates. |
| **Media map** | `src/media.ts` → `buildMediaMap` returning `Map<string, MediaEntry>` with `relPath` | **The integration seam.** Change `relPath` so duplicate refs point to the canonical file. Renderers consume only `relPath`, so they need no change. |
| **Inline eligibility** | `src/media.ts` → `INLINE_MAX_BYTES`, `isInlineable(mime, size)` | Unchanged. Inline reads from the canonical `relPath`. |
| **Message source-of-truth** | `src/model.ts` → `mergeCsv` (idempotent) | Gives deterministic, stable message order → drives deterministic canonical selection (first-occurrence rule). |
| **Media reporting** | `src/model.ts` → stderr `media: N resolved, M unresolved` | Dedup stats (duplicates, bytes saved) should print to stderr the same way, keeping artifacts clean. |
| **Three renderers** | `render/{json,md,html}.ts` | Consume `MediaEntry.relPath`. No logic change needed beyond receiving deduped `relPath`. |

**Critical implication:** because renderers already go through `MediaEntry.relPath`, deduplication is almost entirely a *media-layer* change. The riskiest part is deciding the canonical name deterministically and ensuring `reconcileMedia` does not write the duplicate physical files.

---

## Table Stakes

Features the deduplication feature **must** have to be credible. Missing any = the feature feels broken or unsafe.

| Feature | Why Expected | Complexity | Notes / Dependency |
|---------|--------------|------------|--------------------|
| **Detect duplicates by size + SHA-256 hash; store each unique file once** | This *is* the feature. Without it there is no dedup. | **MED** | Stream hash during `extractEntry` (node:crypto). Group by size first, hash only collisions. |
| **Two-stage size pre-filter** | Performance + memory-safety: most media have unique sizes; hashing them is wasted CPU and risks buffering. | **LOW** | Size already known from `fs.statSync` / central directory. Skip hashing unique-size files. |
| **All three outputs reference the single canonical copy (no broken links)** | Users expect every message's media to still render after dedup. | **LOW–MED** | Achieved by rewriting `relPath` in `buildMediaMap`; renderers untouched. |
| **Portable storage (no symlink/hardlink as primary mechanism)** | Core value: folder must open via `file://` and survive copy/zip to another disk. | **MED** | Canonical file is a normal file in `media/`; refs point to it by name. |
| **Idempotent / deterministic re-runs** | Re-running must reproduce identical `media/`; trust + versioning depend on it. | **LOW–MED** | Content hashes are stable; canonical selection must be a fixed rule (see Differentiators). |
| **Dedup stats reported to stderr** | Mirrors existing media reporting; keeps JSON/MD/HTML artifacts clean. | **LOW** | `duplicates found`, `bytes saved`. Hook into existing stderr report. |
| **Memory-safe on large chats/videos** | Project constraint; dedup must not buffer whole files. | **MED** | Streaming hash during extraction; unique-size files never read into memory for hashing. |
| **Does not modify the source ZIP** | Project non-negotiable: only reads the ZIP. | **LOW** | Dedup operates only on the output `media/` layer. |

---

## Differentiators

Features that set the implementation apart or add real value beyond the bare minimum. Not all are required for v1.1; rank by effort/value.

| Feature | Value Proposition | Complexity | Recommendation |
|---------|-------------------|------------|----------------|
| **Deterministic canonical-name selection (first-occurrence rule)** | Picking the canonical file by "first message that referenced it" makes output byte-stable across runs/machines — a quality differentiator and a table-stakes enabler for determinism. | **LOW** | **Build it.** Sort duplicate group by first message index; use that ref's original name as the canonical filename. |
| **Optional collision double-check (size on hash-match)** | Paranoid archival safety: on a SHA-256 match, also confirm the stored byte-size equals the new file's size (Borg's cheap safeguard). | **LOW** | **Build it** as a default-on, zero-cost check (size is already known). |
| **Checksum/media manifest (`media/manifest.json`)** | Lists each canonical file's hash, size, and the original refs that map to it. Enables future verification, re-derivation, and cross-run dedup without re-scanning. | **MED** | Strong differentiator; recommended for v1.1 if effort allows. Portable (lives in output folder). |
| **`--hardlink` opt-in for same-filesystem backups** | Power users who keep the backup in place (not copied) save space *and* keep original per-ref filenames. | **MED** | Optional flag; default OFF (preserve portability). Conflicts with "portable by default" → opt-in only. |
| **Hash algorithm abstraction (SHA-256 default, BLAKE3 option)** | BLAKE3 is faster for very large media sets; SHA-256 is the safe default. | **LOW** | Optional; only if profiling shows hashing is a bottleneck. Default SHA-256. |
| **Cross-chat / persistent hash index dedup** | Dedupe media shared across multiple exported chats (e.g., same photo forwarded into 5 groups). | **MED–HIGH** | **Defer to v2** (batch processing is already out-of-scope for v1; privacy/portability argue against an external index). |
| **Perceptual/near-duplicate image detection** | Catch "same photo, slightly re-encoded" copies. | **HIGH** | **Out of scope** — needs ML/perceptual hashing; exact-hash is the v1.1 contract. |

---

## Anti-Features

Deliberately **do not build** these for v1.1. Building them would explode scope, break portability, or contradict project principles.

| Anti-Feature | Why Avoid | What To Do Instead |
|--------------|-----------|--------------------|
| **Chunk-level / content-defined (CDC) deduplication (Rabin/FastCDC)** | Media are discrete, byte-identical re-exports — not slightly-edited versions. CDC adds rolling-hash chunking complexity for ~0 gain here. | Whole-file SHA-256 dedup. (Confirmed: CDC's value is edit-resilience, irrelevant to WhatsApp re-exports.) |
| **Symlink or hardlink as the *default* storage mechanism** | Breaks `file://` browser viewing, copy-to-another-disk, and zip portability — directly attacks the core value. | Content-addressed normal files in `media/`; optional `--hardlink` only (see Differentiators). |
| **Mutating previously generated backups / in-place `media/` rewriting** | Non-idempotent, risky, violates "generate fresh each run." | Each run regenerates `media/` deterministically from the ZIP. |
| **Network / remote hash-index dedup** | Contradicts the "runs locally, no upload" privacy principle (README FAQ). | Local-only dedup within one run's media set. |
| **Storing a hash index/DB *outside* the output folder** | Breaks portability (backup must be self-contained). | If a manifest is added, keep it inside the output folder. |
| **Fuzzy / perceptual matching to "recover" near-duplicates** | High complexity, false-positive risk, out of contract. | Exact-hash only; document the limitation. |
| **Sharing one base64 blob across multiple occurrences inside an inlined HTML** | Complex DOM/fragment bookkeeping; marginal win since `--inline` is already one self-contained file. | Embed per occurrence; document that `--inline` does not gain dedup disk savings. |
| **Assuming re-exports are never byte-identical / skipping dedup for "different names"** | `IMG-0001.jpg` and `IMG-0001 (1).jpg` ARE the same file (already normalized in `reconcileMedia`). | Dedup on content, not on name. |

---

## Feature Dependencies

```
reconcileMedia (extract zip → media/)
        │  [hook: stream SHA-256 during extraction; bucket by size then hash]
        ▼
   Dedup stage  ──► choose canonical file (first-occurrence, deterministic)
        │                │
        │                └──► write canonical ONCE; map duplicate refs → canonical relPath
        ▼
   buildMediaMap (MediaEntry.relPath)
        │  [relPath now points to canonical file for all duplicate refs]
        ├──► render JSON   (uses relPath)   ── no change
        ├──► render MD     (uses relPath)   ── no change
        └──► render HTML   (uses relPath; --inline embeds canonical file)
                                        │
   stderr media report  ──► + "N duplicates, Y bytes saved"
```

**Key dependencies:**
- Dedup is **downstream of `reconcileMedia`** and **upstream of `buildMediaMap`** — the two media-layer functions are the only code that must change; renderers are unaffected because they consume `relPath`.
- Deterministic canonical selection depends on **stable message order**, which `mergeCsv` already guarantees (idempotent source-of-truth).
- `--inline` depends on the **same `MediaEntry`**; dedup changes only which file `relPath` resolves to, so inline continues to work unchanged.
- Memory-safety depends on **streaming hash during extraction** (no separate re-read pass).

---

## Complexity & Effort Summary

| Sub-task | Complexity | Rationale |
|----------|------------|-----------|
| Stream SHA-256 during `extractEntry` | MED | Add a `crypto` hash transform to the existing pipe; one-time, no re-read. |
| Two-stage size pre-filter | LOW | Size already available; bucket before hashing. |
| Canonical selection (first-occurrence) | LOW | Sort duplicate group by first message index; deterministic. |
| `relPath` rewrite in `buildMediaMap` | LOW–MED | Map every duplicate ref's `MediaEntry.relPath` to canonical; core change. |
| Skip writing duplicate physical files | LOW–MED | Decide canonical before/at write time; delete extras if written. |
| `--inline` coexistence | LOW–MED | No code change needed; document behavior. |
| Dedup stats to stderr | LOW | Extend existing report. |
| Optional collision size-check | LOW | Compare sizes on hash-match (already known). |
| `media/manifest.json` | MED | New file; portable; optional. |
| `--hardlink` opt-in | MED | Platform fs call; default OFF. |

---

## MVP Recommendation for v1.1

Prioritize (in dependency order):
1. **Two-stage size+SHA-256 dedup during `reconcileMedia`** (core mechanism, MED) — stream hash, bucket by size then hash.
2. **Deterministic canonical selection (first-occurrence)** (LOW) — enables idempotency/determinism.
3. **`relPath` rewrite in `buildMediaMap`** (LOW–MED) — the actual disk saving; renderers unchanged.
4. **Dedup stats to stderr** (LOW) — mirrors existing media reporting.
5. **Optional collision size-check** (LOW) — cheap paranoia, default on.
6. *(If effort allows)* **`media/manifest.json`** (MED) — portable verification artifact.

Defer: `--hardlink` opt-in, hash-algorithm abstraction, cross-chat/persistent-index dedup, perceptual near-dup detection.

---

## Open Questions / Phase-Level Research Flags

- **Exact hook point in `extractEntry`:** confirm `crypto.createHash('sha256')` can be piped as a Transform alongside the file write without disturbing the existing `zlib.createInflateRaw()` pipe (phase-level, MED confidence on integration).
- **Canonical filename policy:** first-occurrence (recommended) vs shortest-name vs hash-named. First-occurrence is most intuitive and deterministic; verify it doesn't surprise users who expect original names. (LOW)
- **Should dedup run before or after `--inline`?** Recommend dedup first (canonical file exists, inline reads it). Confirm no double-embedding logic needed. (LOW)
- **Manifest format:** if `media/manifest.json` is built, define schema (hash, size, ext, refs[]). (MED, only if manifest is in scope)

---

## Sources (with confidence)

- `dedup.rs` `build_dedup_plan` — reference Rust impl showing the exact two-pass size→hash strategy. (web/docs.rs, **HIGH** corroboration of the mechanism)
- GitLab ADR-008 Content-Addressable Storage — SHA-256 identification, streaming hash during write, content-hash as storage path, collision treated as free. (web/gitlab.com, **HIGH**)
- Borg backup issue #170 (hash collision handling) — SHA-256 collision bound 2^128; Borg adds a cheap length-check on match. (web/github.com, **HIGH**)
- Unseel "Data Deduplication" overview — chunk/hash/lookup/branch model, SHA-256/BLAKE3, dedup ratios, index-RAM costs, collision note. (web/unseel.com, **HIGH**)
- "Efficient File Deduplication in Go Using SHA-256" (Medium, 2025) — two-phase size pre-filter + non-crypto hash optimization, fdupes comparison. (web/medium.com, **MEDIUM** — optimization write-up, corroborates size pre-filter)
- zbackup / restic / Borg design docs — whole-file vs chunk-level, rolling-hash CDC, immutable repos. (web, **HIGH** for "CDC is for edit-resilience, not discrete files")
- `wa-backup` source (`src/media.ts`, `src/model.ts`, `README.md`, `.planning/PROJECT.md`) — existing media reconciliation, inline, media map, and reporting behavior this feature integrates with. (local, **HIGH**)

**Confidence note:** The *deduplication mechanism* (size+hash, two-stage, content-addressed, SHA-256 collision-safety, streaming) is well-established and corroborated by ≥4 independent production systems → HIGH. Exact *integration specifics* into `wa-backup`'s `reconcileMedia`/`buildMediaMap` are flagged above as phase-level research (MED).
