---
phase: 04-streaming-hash-content-addressed-store
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/media.ts
  - test/media.test.ts
autonomous: true
requirements:
  - MEDIA-05
  - MEDIA-06
user_setup: []
estimate:
  tokens: 50000
  raw_tokens: 30000
  tasks: 3
  confidence: low
must_haves:
  truths:
    - "MEDIA-05: For every reconciled media file, SHA-256 digest and byte size are computed by streaming the extract pipe via a node:crypto Transform piped inline with the disk write — no whole file is ever buffered; the digest+size are attached to the produced MediaEntry."
    - "MEDIA-06: Each unique content is stored exactly once at media/<sha256[:16]>.<ext> (extension preserved from the zip entry). A later occurrence whose hash matches an existing canonical file is NOT written (skip-if-exists, O(1) name check, no re-read); both original refs resolve to the same canonical relPath. The write is atomic (temp file -> rename)."
    - "Renderers resolve every message's media correctly through the unchanged MediaEntry.relPath (buildMediaMap consults the in-run reconcile map); the backup opens standalone in a browser with all media displayed and dedup is invisible to readers."
    - "--inline still embeds each referenced copy (reads the canonical file per ref), while the media/ folder is collapsed to one copy per unique content."
    - "Unresolved / missing media refs never crash the run and still render as placeholders (unchanged contract)."
  artifacts:
    - "src/media.ts: new constant MEDIA_HASH_PREFIX_LEN = 16"
    - "src/media.ts: extractEntry returns { hash: string; size: number } and pipes bytes through a streaming SHA-256 Transform (no buffering)"
    - "src/media.ts: helper canonicalMediaName(hash, ext) -> '<hash[:16]><ext>'"
    - "src/media.ts: reconcileMedia writes to a temp file, computes canonical name, skips write when media/<hash[:16]>.<ext> exists (D-04), else atomic rename; records EVERY original ref -> MediaEntry with canonical relPath; populates the in-run map; returns mediaMap"
    - "src/media.ts: module-level activeReconcileMap + setActiveReconcileMap(); buildMediaMap consults it first, falls back to the existing disk scan"
    - "src/media.ts: ReconcileResult gains optional mediaMap: Map<string, MediaEntry>"
    - "test/media.test.ts: reconcileMedia assertions updated to hash-pattern + mediaMap; new duplicate-content test added"
  key_links:
    - "extractEntry hash Transform -> canonical name (trust the stream, D-04)"
    - "reconcileMedia temp -> rename (atomic) / exists-skip (dedup) -> activeReconcileMap"
    - "activeReconcileMap -> buildMediaMap -> renderers (src/render/* UNTOUCHED, D-06)"
---

<objective>
Implement streaming SHA-256 + size (MEDIA-05) and a content-addressed store that writes each unique media file once as media/<sha256[:16]>.<ext>, skipping the write when the canonical path already exists (MEDIA-06). The original-ref -> canonical relPath mapping is computed during reconcileMedia and delivered to renderers through the unchanged MediaEntry.relPath (via buildMediaMap consulting an in-run map), so the backup stays fully viewable and no renderer or the Message model is modified.

Purpose: Deduplicate byte-identical media on disk (space savings) while preserving memory-safe streaming and standalone browser viewing.
Output: Modified src/media.ts (streaming hash primitive + CAS store + in-run bridge) and updated/extended tests; no new runtime dependencies (D-02, D-06).
</objective>

<execution_context>
@/Users/guionardo/.config/opencode/gsd-core/workflows/execute-plan.md
@/Users/guionardo/.config/opencode/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/phases/04-streaming-hash-content-addressed-store/04-CONTEXT.md
@.planning/research/SUMMARY.md
@.planning/research/FEATURES.md
@.planning/research/ARCHITECTURE.md
@.planning/research/PITFALLS.md
@src/media.ts
@src/model.ts
@src/render/html.ts
@src/render/md.ts
@src/render/json.ts
@test/media.test.ts
@test/html-media.test.ts
</context>

<tasks>

<task type="tracer">
  <name>Tracer: streaming SHA-256 hash in extractEntry + CAS store for one file, end-to-end through a renderer</name>
  <files>src/media.ts</files>
  <read_first>
    - src/media.ts (extractEntry lines 123-151; reconcileMedia lines 171-217; buildMediaMap lines 236-276; ReconcileResult lines 153-158; MediaEntry lines 219-226)
    - .planning/research/ARCHITECTURE.md (CAS-at-reconcile design, lines 116-169)
    - .planning/research/PITFALLS.md (Pitfall 6 memory-safety, Pitfall 4 SHA-256 key, Pitfall 12 ext preservation)
  </read_first>
  <action>
    Prove the architecture end-to-end on ONE media file before expanding.

    1. In src/media.ts add imports: `import { createHash, randomUUID } from 'node:crypto';` and `import { Transform } from 'node:stream';`. Add constant `export const MEDIA_HASH_PREFIX_LEN = 16;`.

    2. Add a helper `canonicalMediaName(hash: string, ext: string): string` returning `${hash.slice(0, MEDIA_HASH_PREFIX_LEN)}${ext}` where `ext` is the original zip entry extension (e.g. `.jpg`), lower-cased and kept as-is. This is D-01.

    3. Change `extractEntry` so it pipes the inflated/raw source through a `stream.Transform` that calls `hash.update(chunk)` and forwards `chunk` downstream (do NOT rely on crypto.Hash forwarding bytes — wrap it in an explicit Transform). Collect size by summing `chunk.length` in the same transform. After the pipe resolves, call `hash.digest('hex')` and return `{ hash, size }` from extractEntry. Preserve the existing error handling and `finally` file-handle close. This is MEDIA-05 (streaming, no buffering).

     4. Change `reconcileMedia` minimally for the single-ref-per-normalized-name case it already iterates: extract to a temp path `path.join(mediaDir, '.tmp-' + randomUUID())`, get `{ hash, size }`, compute `canonicalName = canonicalMediaName(hash, path.extname(base))` and `canonicalPath = path.join(mediaDir, canonicalName)`. Wrap the temp extraction in try/catch/finally so that if extraction fails the `.tmp-<uuid>` file is unlinked (resilience — Fix #3). If `fs.existsSync(canonicalPath)` is true, `fs.unlinkSync(tmp)` and skip the write (D-04 — trust the stream, never re-read the existing file). Otherwise `fs.renameSync(tmp, canonicalPath)` (atomic). Build a `MediaEntry { relPath: 'media/' + canonicalName, mime: mimeFromExt(ext), size, inlineable: isInlineable(mime, size) }`. Record `ref -> entry` for the matched original ref.

    5. Add module-level `let activeReconcileMap: Map<string, MediaEntry> | null = null;` and `export function setActiveReconcileMap(m: Map<string, MediaEntry> | null)`; call it at the end of reconcileMedia with the built map. Modify `buildMediaMap` to FIRST look up `m.media` in `activeReconcileMap` (when non-null) and, if present, set `map.set(m.media, entry)` and `continue`; else keep the existing disk-scan fallback unchanged. This bridges the canonical relPath to renderers without editing src/render/* (D-06).

    Verify the single path works (extraction -> hash -> CAS name -> render resolves) using the command in <verify>.
  </action>
  <verify>
    <automated>
      npx tsx -e "import {zipSync} from 'fflate'; import * as fs from 'node:fs'; import * as os from 'node:os'; import * as path from 'node:path'; import {reconcileMedia, buildMediaMap} from './src/media.ts'; const png=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3]); const z=zipSync({'chat/_chat.txt':Buffer.from(''),'chat/IMG.png':png}); const d=fs.mkdtempSync(path.join(os.tmpdir(),'cas-')); const zp=path.join(d,'a.zip'); fs.writeFileSync(zp,z); const o=fs.mkdtempSync(path.join(os.tmpdir(),'out-')); await reconcileMedia(zp,o,['IMG.png']); const files=fs.readdirSync(path.join(o,'media')); if(files.length!==1) throw new Error('expected 1 file, got '+files.length); if(!/^[0-9a-f]{16}\.png$/.test(files[0])) throw new Error('CAS name wrong: '+files[0]); const m=buildMediaMap(o,[{media:'IMG.png'} as any]); const e=m.get('IMG.png'); if(!e||!e.relPath.includes(files[0])) throw new Error('relPath mismatch: '+JSON.stringify(e)); console.log('CAS TRACER OK '+files[0]);"
    </automated>
  </verify>
  <acceptance_criteria>Streaming SHA-256 is computed inside extractEntry via an inline Transform; one media file is extracted and stored as `media/<16hex>.<ext>`; `buildMediaMap` resolves the original ref to the canonical relPath; the inline assertion prints the computed hash. The tracer command prints "CAS TRACER OK &lt;hash&gt;.png". No renderer file was modified.</acceptance_criteria>
  <done>One media file is extracted, hashed streaming, stored as media/<16hex>.png, and buildMediaMap resolves the original ref 'IMG.png' to that canonical relPath. The tracer command prints "CAS TRACER OK &lt;hash&gt;.png". No renderer file was modified.</done>
</task>

<task type="auto">
  <name>Expand: all refs recorded, skip-if-exists dedup, atomic write, mediaMap returned</name>
  <files>src/media.ts</files>
  <read_first>
    - src/media.ts (reconcileMedia lines 171-217; MediaEntry lines 219-226; ReconcileResult lines 153-158)
    - .planning/phases/04-streaming-hash-content-addressed-store/04-CONTEXT.md (D-03, D-04, D-05)
    - .planning/research/PITFALLS.md (Pitfall 1 dedup by SHA-256 not name, Pitfall 8 every ref recorded, Pitfall 11 AppleDouble)
  </read_first>
  <action>
    Generalize the tracer slice to the full reconcile behavior (MEDIA-06 completion).

    1. Collect ALL original refs, not just one per normalized name. Replace the `Map<norm, ref>` (lines 176-180) with a `Map<norm, string[]>` built by iterating `refs` and pushing each original ref under its normalized key. This ensures duplicate original refs (name variants) are all recorded and map to the same canonical file (Pitfall 8). Keep `isAppleDouble` / `_chat.txt` exclusion.

    2. In the write loop, for each `[norm, refList]` matched to a `meta`: extract once to temp, get `{ hash, size }`, compute canonical name/ext from the zip `base` (D-01, Pitfall 12 — preserve extension). Skip-if-exists via `fs.existsSync(canonicalPath)` -> `unlinkSync(tmp)` and do NOT write (D-04, O(1)). Else `renameSync(tmp, canonicalPath)` (atomic). For EVERY ref in `refList`, set `map.set(ref, entry)` so each distinct original ref carries the canonical relPath (D-05). Accumulate into `mediaMap`.

    3. After the loop, call `setActiveReconcileMap(mediaMap)` (already added in tracer). Extend `ReconcileResult` with `mediaMap: Map<string, MediaEntry>` and return it alongside `resolved`/`unresolved` (additive; model.ts uses only resolved/unresolved so it is unaffected). `resolved` keeps its current semantics (distinct original refs matched) so existing reports stay correct.

    4. Confirm `--inline` is unaffected: inline reads `path.join(dir, entry.relPath)` from the canonical file (html.ts:69, md.ts:60) — unchanged logic, just a hash-named path. D-03 satisfied (each ref still embedded; media/ collapsed). Do NOT modify src/render/* or src/model.ts.

    Keep memory safety: the hash Transform from the tracer is reused; never call fs.readFile on the media for hashing.
  </action>
  <verify>
    <automated>
      npx tsx -e "import {zipSync} from 'fflate'; import * as fs from 'node:fs'; import * as os from 'node:os'; import * as path from 'node:path'; import {reconcileMedia, buildMediaMap} from './src/media.ts'; const blob=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,9,9,9]); const z=zipSync({'c/_chat.txt':Buffer.from(''),'c/A.png':blob,'c/B.png':blob}); const d=fs.mkdtempSync(path.join(os.tmpdir(),'dup-')); const zp=path.join(d,'a.zip'); fs.writeFileSync(zp,z); const o=fs.mkdtempSync(path.join(os.tmpdir(),'o-')); const res=await reconcileMedia(zp,o,['A.png','B.png']); const files=fs.readdirSync(path.join(o,'media')); if(files.length!==1) throw new Error('dedup failed, files='+files.length); if(res.mediaMap.size!==2) throw new Error('both refs must map, size='+res.mediaMap.size); const ra=res.mediaMap.get('A.png').relPath, rb=res.mediaMap.get('B.png').relPath; if(ra!==rb) throw new Error('refs do not share canonical path'); const m=buildMediaMap(o,[{media:'A.png'} as any,{media:'B.png'} as any]); if(m.get('A.png').relPath!==m.get('B.png').relPath) throw new Error('buildMediaMap mismatch'); console.log('DEDUP OK '+ra);"
    </automated>
  </verify>
  <acceptance_criteria>Two byte-identical source files (A.png, B.png) produce exactly ONE file in media/ (skip-if-exists trusted, no re-read); both original refs map to the same canonical relPath via both the returned mediaMap and buildMediaMap; reconcileMedia returns a `mediaMap`; memory-safe streaming is preserved. resolved reports 2, the on-disk file count is 1. No renderer or model file changed.</acceptance_criteria>
  <done>Two byte-identical files with different names (A.png, B.png) produce exactly ONE file in media/; both refs resolve to the same canonical relPath via both the returned mediaMap and buildMediaMap. resolved reports 2, the on-disk file count is 1. No renderer or model file changed.</done>
</task>

<task type="auto">
  <name>Tests: update reconcileMedia assertions for CAS + add duplicate-content coverage; run suite</name>
  <files>test/media.test.ts</files>
  <read_first>
    - test/media.test.ts (reconcileMedia test lines 49-86; buildMediaMap test lines 88-115; --inline test lines 117-144; unresolved test lines 146-190)
    - test/html-media.test.ts (renderNotas lines 12-16 — re-run must still resolve media via in-run map)
    - .planning/phases/04-streaming-hash-content-addressed-store/04-CONTEXT.md (D-06 renderers untouched)
  </read_first>
  <action>
    Keep the existing behavioral contract green while reflecting the new CAS layout.

    1. In the `reconcileMedia on Notas pessoais sample` test (lines 49-86): the on-disk files are now hash-named. Remove the two `files.includes('<originalName>')` assertions (lines 78-85) and the strict `files.length === 17` original-name assumption. Replace with: assert `res.resolved.length === 17` and `res.unresolved.length === 0`; assert `files.length >= 1 && files.length <= 17`; assert every file matches `/^[0-9a-f]{16}\.[a-z0-9]+$/i`; assert `res.mediaMap` has an entry for a known ref (e.g. '00000089-VIDEO-2026-05-27-17-26-38.mp4') whose `relPath` is `media/` + that file's basename and whose `mime === 'video/mp4'`.

    2. Add a new test `CAS: byte-identical different names stored once, both refs resolve` using the same fflate-based synthetic zip pattern as the verify command in the previous task (two identical files A.png/B.png -> one media/ file, mediaMap size 2, shared relPath).

     3. Do NOT modify the `buildMediaMap` test (lines 88-115) or the `--inline` test (117-144) or the `unresolved` test (146-190): with no prior reconcileMedia call, `activeReconcileMap` is null, so buildMediaMap uses its unchanged disk-scan fallback and these remain green. To harden against cross-test leakage of the module-global `activeReconcileMap` (Fix #2), add an `afterEach` hook to the test file that calls `setActiveReconcileMap(null)` so any state set by the reconcileMedia tests is reset before the buildMediaMap/--inline/unresolved tests run. Also reset `setActiveReconcileMap(null)` at the start of the `buildMediaMap` test block as a defensive measure.

    4. Run the targeted then full suite. If the Notas fixture happens to contain byte-identical duplicates, `files.length` may be below 17 — the updated `>=1 && <=17` assertion tolerates this while `resolved.length === 17` still pins correctness.
  </action>
  <verify>
    <automated>npx tsx --test test/media.test.ts</automated>
    <automated>npm test</automated>
  </verify>
  <acceptance_criteria>`npx tsx --test test/media.test.ts` passes with hash-name + mediaMap assertions (reconcileMedia CAS assertions + new duplicate-content test green; buildMediaMap, --inline, and unresolved tests unchanged and green); `npm test` full suite passes; `--inline` and unresolved/placeholder tests still green. html-media.test.ts still renders .media-img imgs because buildMediaMap resolves refs to canonical hash files via the in-run map. No test asserts an original media filename.</acceptance_criteria>
  <done>`npx tsx --test test/media.test.ts` passes (reconcileMedia CAS assertions + new duplicate-content test green; buildMediaMap, --inline, and unresolved tests unchanged and green). `npm test` (full suite) passes — html-media.test.ts still renders .media-img imgs because buildMediaMap resolves refs to canonical hash files via the in-run map. No test asserts an original media filename.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| zip -> disk | Untrusted export bytes cross from the ZIP into the output media/ folder via the streaming extract. |
| in-run map -> renderers | The activeReconcileMap (module state) bridges refs to canonical paths consumed by renderers. |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-04-01 | Tampering | reconcileMedia skip-if-exists (D-04) | low | accept | Trusting an existing media/<sha256[:16]>.<ext> by name is safe: a 16-hex (2^64) prefix collision within a single backup is astronomically improbable; SHA-256 is the authoritative key (Pitfall 4). No re-read of the existing file is performed, matching the streaming/trust-the-stream decision. |
| T-04-02 | Tampering | extractEntry streaming hash | low | mitigate | Hash is computed over the exact bytes written via an inline Transform (Pitfall 6); the digest is derived from the same stream the renderer will later read, so inline/base64 diverge from the canonical file is impossible (Pitfall 9). |
| T-04-03 | Information Disclosure | no CRC/integrity check on extracted media | low | accept | CONCERNS.md (line 51) already notes the absence of a CRC check; Phase 4 deliberately does NOT add integrity verification (per D-04 note). Integrity verification, if ever wanted, is a separate later concern, not this phase. |
| T-04-SC | Tampering | npm/pip/cargo installs | high | mitigate | No new runtime or dev dependencies are introduced (D-02, D-06). No install tasks exist; package-legitimacy gate N/A. |
</threat_model>

<verification>
- `npx tsx --test test/media.test.ts` — all media tests pass including new CAS/dedup coverage.
- `npm test` — full suite green; html-media.test.ts renders media-img imgs (relPath resolves to canonical hash files).
- Manual confidence check: run `node --import tsx src/index.ts fixtures/<Notas zip> --out /tmp/wa-verify` and confirm `media/` contains only `<16hex>.<ext>` files and `messages.html` shows `<img class="media-img" src="media/<hash>.<ext>">`.
</verification>

<success_criteria>
- MEDIA-05 satisfied: extractEntry computes SHA-256 + size by streaming the extract pipe; no whole file buffered.
- MEDIA-06 satisfied: each unique content stored once at media/<sha256[:16]>.<ext>; duplicate occurrence skipped (exists-check, no re-read); write is atomic (temp->rename).
- The original-ref -> canonical relPath mapping is computed in reconcileMedia and delivered to renderers via the unchanged MediaEntry.relPath (buildMediaMap consults the in-run map); src/render/* and src/model.ts are NOT modified (D-06).
- Existing behavioral contracts hold: media resolution never throws; unresolved refs -> placeholders; --inline still embeds each copy while media/ is collapsed (D-03).
- No new runtime dependencies (D-02, D-06). Full test suite passes.
</success_criteria>

<output>
Create `.planning/phases/04-streaming-hash-content-addressed-store/04-SUMMARY.md` when done (filled by the execute-phase agent), then update ROADMAP.md Phase 4 Plans line from "TBD" to "1 plan" and list `04-PLAN.md`.
</output>

<artifacts_produced>
This phase produces the following new/changed symbols in `src/media.ts`:

- `MEDIA_HASH_PREFIX_LEN = 16` (exported constant) — D-01.
- `canonicalMediaName(hash: string, ext: string): string` — derives `media/<sha256[:16]>.<ext>`; extension preserved from the zip entry.
- `extractEntry(...): Promise<{ hash: string; size: number }>` — now pipes an inline `stream.Transform` that `hash.update(chunk)`s (SHA-256 via node:crypto, D-02) and forwards bytes; returns streaming hash + size with no whole-file buffering (MEDIA-05).
- `reconcileMedia(...)` changes: extracts to `media/.tmp-<uuid>`, computes canonical name, skips the write when `media/<sha256[:16]>.<ext>` exists (D-04), else atomic `renameSync`; records EVERY original ref -> MediaEntry with canonical relPath; populates the in-run map; returns `mediaMap` (MEDIA-06, D-05).
- `activeReconcileMap` (module-level) + `setActiveReconcileMap(...)` — the in-run bridge consulted by `buildMediaMap` so renderers stay untouched (D-06).
- `buildMediaMap(...)` — consults `activeReconcileMap` first, falls back to the existing disk scan.
- `ReconcileResult.mediaMap?: Map<string, MediaEntry>` — additive field.

No changes to: `src/render/*` (D-06), `src/model.ts`, `src/parse/types.ts` (Message), `messages.csv` schema. `media/manifest.json` persistence is intentionally deferred to Phase 5 (per D-05); the in-run map is the Phase-4 bridge and will be replaced by the persisted manifest in Phase 5.
</artifacts_produced>
