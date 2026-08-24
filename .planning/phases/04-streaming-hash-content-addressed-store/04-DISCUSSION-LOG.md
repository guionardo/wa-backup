# Phase 4: Streaming Hash & Content-Addressed Store - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-24
**Phase:** 4-Streaming Hash & Content-Addressed Store
**Areas discussed:** Disk filename strategy, Hash algorithm, --inline interaction, Verify-on-skip

---

## Disk filename strategy

| Option | Description | Selected |
|--------|-------------|----------|
| media/&lt;sha256[:16]&gt;.&lt;ext&gt; (opaque, stable, ext kept) | Recommended by research; smallest collision risk within one backup | ✓ |
| media/&lt;full-64-hex-sha256&gt;.&lt;ext&gt; | Globally unique, zero collision, longer names | |
| Original name + hash sidecar | Preserves human-readable names but defeats CAS on disk | |

**User's choice:** Hash[:16].ext (Recommended)
**Notes:** Keeps the original extension so MIME resolution and recovery stay correct; filenames stay short.

## Hash algorithm

| Option | Description | Selected |
|--------|-------------|----------|
| Pure SHA-256 (node:crypto streaming) | Zero new deps, portable, correctness-first | ✓ |
| SHA-256 + xxhash-wasm pre-filter | Faster on large video archives, +1 dependency | |

**User's choice:** Pure SHA-256 (Recommended)
**Notes:** Matches PROJECT.md zero-dep / browser-reusable profile; speed cost on huge videos accepted.

## --inline interaction

| Option | Description | Selected |
|--------|-------------|----------|
| Dedupe + report | Run dedup; --inline still embeds each copy, folder deduped, savings shown | ✓ |
| Skip dedup on --inline | No disk savings; no misleading report | |
| Full HTML dedup | Dedupe data: URIs in HTML too (needs shared-asset map) | |

**User's choice:** Dedupe + report (Recommended)
**Notes:** --inline stays self-contained; user accepts dedup saves disk but not the inlined HTML size.

## Verify-on-skip

| Option | Description | Selected |
|--------|-------------|----------|
| Trust stream | Skip if hash[:16].ext exists, no re-read | ✓ |
| Re-verify existing | Re-read + re-hash before skipping (integrity, more I/O) | |

**User's choice:** Trust stream (Recommended)
**Notes:** 16-hex collisions astronomically rare within one backup; addresses speed, not the separate CRC concern in CONCERNS.md.

---

## the agent's Discretion

None — all four areas were explicitly decided by the user.

## Deferred Ideas

None — discussion stayed within phase scope.
