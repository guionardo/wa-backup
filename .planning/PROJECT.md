# WhatsApp Chat Backup

## What This Is

A TypeScript/Node command-line tool that reads the official WhatsApp chat-export ZIP (a `_chat.txt` transcript plus media folders) and produces a self-contained, fully-viewable backup of a single conversation. It emits three synchronized outputs — Markdown, HTML (WhatsApp-like), and structured JSON — with media referenced in a local folder by default and optionally inlined.

## Core Value

A person can open their WhatsApp history years later and see the full conversation — text and media together — without needing WhatsApp, a phone, or any account.

## Motivation

Some chats and groups are no longer active, but their history is still worth keeping — or the
phone needs the storage space back. Exporting and deleting them from the device is easy; the
hard part is that the raw WhatsApp export is awkward to read later and stays tied to having
WhatsApp installed. This tool exists to turn that export into a portable, easily-viewed backup
(Markdown, HTML, JSON) you can open in any browser — freeing the phone without losing the
conversation.

## Current State

**Shipped: v1.0 MVP (2026-08-24) — published to npm as `wa-backup@0.1.1`.**

- 3 phases, 8 plans, 14 tasks across 93 commits.
- Streaming, locale-tolerant parser → `messages.csv` source-of-truth.
- Three synchronized outputs (JSON / Markdown / WhatsApp-like HTML), XSS-safe.
- Media reconciliation + `--inline` base64 embedding; placeholders preserved.
- URL title enrichment (YouTube, Reddit, LinkedIn, Medium, Stack Overflow, X) with favicons.
- Green CI (lint → test → build) on Node 22/24; npm publish with provenance.
- Full README, public GitHub repo.

## Requirements

### Validated

- ✓ CLI parses a WhatsApp export ZIP into a normalized message model — v1.0
- ✓ CLI emits Markdown, HTML, and JSON representations of the chat — v1.0
- ✓ HTML output renders messages in a WhatsApp-like layout (bubbles, per-sender color, timestamps) — v1.0
- ✓ Media files placed in a local folder, referenced by relative path — v1.0
- ✓ A flag inlines media as base64 into a single HTML file — v1.0
- ✓ `<Media omitted>` and deleted-message lines preserved as visible placeholders — v1.0
- ✓ Parser handles large files without loading the whole transcript into memory — v1.0
- ✓ Output defaults to a chat-named folder; `--out` overrides it — v1.0
- ✓ Web link titles resolved (YouTube/Reddit/LinkedIn/Medium/Stack Overflow/X) — v1.0

### Active (v1.1 — Media Hygiene, in planning)

- [ ] Media deduplication: verify media by size + hash to detect duplicates and save disk space
- [ ] (propose more in `/gsd-new-milestone`)

### Out of Scope

- Web upload UI — future v2, reuses the parsing core (why: separate delivery channel)
- System-event styling (joined/left/encryption) — v1 renders them as plain lines (why: lean v1)
- Sticker/GIF mapping from media folders — not in v1 (why: txt has no reference; later work)
- Contact-list / participant aggregation — not in v1 (why: lean v1)
- Batch processing of multiple zips in one run — v1 is one chat per run (why: simpler, web covers scale)
- Encryption of the backup output — not in v1 (why: out of core value scope)

## Context

- Input is the WhatsApp "Export chat" ZIP (`_chat.txt` + media), not the Google Drive encrypted backup.
- `_chat.txt` uses a locale-dependent date/time format; robust, locale-tolerant parsing is the central hard problem (solved in v1.0 with day/month majority vote + 12h/24h detection).
- Media files are named in the txt but stored in sibling folders; reconciled by basename (case-insensitive, ignoring `(1)` and dash/space variance).
- The parsing core is deliberately isolated so the future web version can import it directly.

## Constraints

- **Tech stack**: TypeScript / Node (ESM) — chosen so the core is reusable in the future web frontend.
- **Performance**: Must stream-parse to stay memory-safe on large chats (videos, long histories).
- **Portability**: Output folder must open standalone in any browser with no server.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| TypeScript/Node for v1 | Reuse same core in future web version | ✓ Good |
| Three outputs (MD+HTML+JSON) | Covers viewing, editing, and structured reuse | ✓ Good |
| Media folder-referenced by default | Portable, avoids huge single files | ✓ Good |
| WhatsApp-like HTML | Familiar, "fully visualizable" goal | ✓ Good |
| CLI first, web later | CLI solves personal need now; web scales to others | ✓ Good |
| Media reconciliation via ZIP central directory + random-access inflate | fflate streaming inflate breaks on data-descriptor members (nested `.zip` attachment) | ✓ Good (deviation from planned fflate streaming) |
| URL title enrichment with `--no-fetch-titles` opt-out | Local-only by default; titles optional, network-off capable | ✓ Good |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-08-24 after v1.0 milestone; v1.1 (Media Hygiene) started*
