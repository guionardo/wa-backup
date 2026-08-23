<!-- refreshed: 2026-08-23 -->
# Architecture

**Analysis Date:** 2026-08-23

## System Overview

```text
┌───────────────────────────────────────────────────────────────────────────┐
│  CLI entry — `src/index.ts` (commander)                                    │
│  buildCli().parseAsync() → program.action → runParser()                    │
└───────────────────────────────┬───────────────────────────────────────────┘
                                  │ zip path + RunOptions
                                  ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  Orchestrator — `src/model.ts` : runParser()                                │
│  (the vertical pipeline; returns message count, drives side-effects)      │
└───────┬───────────┬──────────────┬───────────────┬────────────────────────┘
        │           │              │               │
        ▼           ▼              ▼               ▼
┌──────────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐
│ Extraction   │ │ Parsing  │ │ Enrich-  │ │ Media         │
│ `extract.ts` │ │ `parse/*`│ │ `title.ts`│ │ `media.ts`    │
│ stream ZIP → │ │ line SM  │ │ fetch URL│ │ reconcile +   │
│ _chat.txt    │ │ →Message │ │ titles   │ │ buildMediaMap │
│ lines        │ │ []       │ │          │ │               │
└──────┬───────┘ └────┬─────┘ └────┬─────┘ └───────┬──────┘
       │             │            │               │
       └─────────────┴────────────┴───────────────┘
                     │  merge into
                     ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  Source-of-truth — `src/csv.ts` : messages.csv (UTF-8, no BOM)             │
│  columns: timestamp_iso,type,author,text,media,url_titles                  │
└───────────────────────────────┬───────────────────────────────────────────┘
                                 │  readCsv() — re-read from disk
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                         ▼
┌──────────────┐        ┌──────────────┐        ┌──────────────┐
│ `render/     │        │ `render/md.ts`│        │ `render/      │
│  json.ts`    │        │              │        │  html.ts`     │
│ buildEnvelope│        │ day-sectioned│        │ WhatsApp-like  │
│              │        │ log          │        │ bubbles + JS   │
└──────────────┘        └──────────────┘        └──────────────┘
        │                        │                         │
        ▼                        ▼                         ▼
 messages.json            messages.md               messages.html  (all under <out>/<slug>/)
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| CLI / entry | Parse args, wire options, print summary | `src/index.ts` |
| Orchestrator | Run the full vertical pipeline end-to-end | `src/model.ts` |
| ZIP extraction | Stream `_chat.txt` from ZIP (no media buffering); derive chat name/slug | `src/extract.ts` |
| Timestamp detection | Per-file day/month + 12h/24h vote; parse to ISO | `src/parse/timestamp.ts` |
| Message parser | Streaming line state-machine → `Message[]` | `src/parse/message.ts` |
| Message model | `Message` / `MessageType` types | `src/parse/types.ts` |
| CSV store | Read/write/merge CSV source-of-truth; escaping | `src/csv.ts` |
| Title enrichment | Fetch & cache URL→title map (per platform) | `src/title.ts` |
| Media reconciliation | Copy matched media to `media/`; resolve disk map | `src/media.ts` |
| JSON renderer | `JsonEnvelope` with metadata + messages | `src/render/json.ts` |
| Markdown renderer | Day-sectioned `## date` log | `src/render/md.ts` |
| HTML renderer | WhatsApp-style bubbles + theme/search/filter | `src/render/html.ts` |
| Shared render helpers | Accent color + initials per author | `src/render/colors.ts` |
| Linkify (shared JS) | URL→safe link for Node + browser; offline title | `src/render/js/linkify.js` |
| Browser viewer JS | client-side search/filter/theme (loaded in html) | `src/render/js/transcript.js` |
| XSS guard (browser) | `textContent`-only notes | `src/render/js/xss-sanitize.js` |

## Pattern Overview

**Overall:** Streaming transform pipeline with a CSV source-of-truth (single-writer, multi-reader).

**Key Characteristics:**
- Everything streams: the ZIP is inflated entry-by-entry (`src/extract.ts:16` `extractChatTxt`), `_chat.txt` is consumed as an async line iterator (`src/extract.ts:73` `readLines`), and the parser is an async generator (`src/parse/message.ts:82` `parseMessages`) — memory stays O(lines), never O(whole-chat).
- The CSV at `<out>/<slug>/messages.csv` is the single canonical artifact. Parsers produce `Message[]`; the CSV is written once via `mergeCsv`; renderers **re-read it from disk** (`renderJson`/`renderMarkdown`/`renderHtml` each call `readCsv`) so old backups can be re-rendered without the original ZIP.
- Enrichment and media reconciliation are separate, idempotent side-stages that read the same `Message[]`/CSV and write back (titles into CSV column 6; media files into `media/`).
- Renderers are pure functions of `(csvPath, outDir, chatName, opts)` and share `buildMediaMap` (`src/media.ts:236`) and `linkify.js` helpers — adding a 4th format means adding one more `renderX` caller in `renderOutputs`.

## Layers

**CLI layer (`src/index.ts`):**
- Purpose: arg parsing + user-facing output. No business logic.
- Location: `src/index.ts`
- Contains: `buildCli()` (commander program), `program.action` handler.
- Depends on: `runParser` (`src/model.ts`), `chatInfoFromZip` (`src/extract.ts`).
- Used by: `npm run dev` / `tsx src/index.ts` / `dist/index.js` (the `bin`).

**Orchestration layer (`src/model.ts`):**
- Purpose: sequence extraction → parse → merge → enrich → reconcile → render, and report counts.
- Location: `src/model.ts`
- Contains: `runParser(zipPath, opts)` (`:83`), `renderOutputs(dir, chatName, opts)` (`:69`), `verboseReport` (`:27`).
- Depends on: `extract.ts`, `parse/message.ts`, `csv.ts`, `title.ts`, `media.ts`, `render/*`.
- Used by: `src/index.ts`.

**Extraction layer (`src/extract.ts`):**
- Purpose: turn ZIP bytes into a streaming `AsyncIterable<string>` over `_chat.txt`, plus chat-name resolution.
- Location: `src/extract.ts`
- Contains: `extractChatTxt` (`:16`), `readLines` (`:73`), `slugifyChatName` (`:118`), `chatNameFromZip` (`:151`), `chatInfoFromZip` (`:177`).
- Key detail: fflate `Unzip` with `onfile`; only the `_chat.txt` entry is `file.start()`-ed. AppleDouble `._*` and `__MACOSX` are skipped so videos are never inflated (`src/extract.ts:25-29`).

**Parsing layer (`src/parse/*`):**
- Purpose: convert raw lines into normalized `Message` objects.
- Location: `src/parse/`
- Contains: `parseMessages` (`src/parse/message.ts:82`), `detectFormat`/`tryParseTimestamp` (`src/parse/timestamp.ts:92`/`:142`), regexes `TS_RE`, `SENDER_RE`, `ATTACHED_RE`, `OMITTED_RE`, `DELETED_RE` (`src/parse/message.ts:15-24`), `Message`/`MessageType` (`src/parse/types.ts`).
- Depends on: `src/parse/timestamp.ts` invisible-stripping helpers.
- Used by: `src/model.ts` (imports `parseMessages`).

**Persistence layer (`src/csv.ts`):**
- Purpose: the canonical on-disk representation.
- Location: `src/csv.ts`
- Contains: `csvField`/`unescapeField` (`:9`/`:21`), `csvRow` (`:44`), `readCsv` (`:104`), `writeCsv` (`:124`), `mergeCsv` (`:144`), `dedupeKey` (`:59`).
- CSV header: `timestamp_iso,type,author,text,media,url_titles` (`src/csv.ts:51`). `url_titles` is a JSON-encoded `Record<string,string>`.

**Enrichment layer (`src/title.ts`):**
- Purpose: attach human-readable page titles to shared URLs (`urlTitles`).
- Location: `src/title.ts`
- Contains: `enrichTitles` (`:260`), `fetchTitle` (`:181`), `platformOf` (`:61`), and per-platform extractors (`youTubeOembedUrl`, `redditJsonUrl`, `stackExchangeApiUrl`, `deriveLinkedInTitle`, `deriveXTitle`).
- Used by: `src/model.ts` (`runParser` calls `enrichTitles` then `writeCsv` again).

**Media layer (`src/media.ts`):**
- Purpose: copy matched ZIP media into `media/` and resolve a disk map for renderers.
- Location: `src/media.ts`
- Contains: `reconcileMedia` (`:171`), `buildMediaMap` (`:236`), `normalizeMediaName` (`:24`), `readCentralDirectory` (`:76`), `extractEntry` (`:123`), `mimeFromExt`/`isInlineable`.
- Used by: `src/model.ts` (reconcile) and `render/*` (buildMediaMap).

**Render layer (`src/render/*`):**
- Purpose: produce the three synchronized outputs.
- Location: `src/render/`
- Contains: `renderJson` (`src/render/json.ts:79`), `renderMarkdown` (`src/render/md.ts:84`), `renderHtml` (`src/render/html.ts:248`), `buildEnvelope`/`dayOf`/`timeOf` (`src/render/json.ts`), `getAccentColor`/`initials` (`src/render/colors.ts`), `linkify.js` shared helpers.
- Used by: `src/model.ts:renderOutputs`.

## Data Flow

### Primary Request Path (single CLI invocation)

1. `src/index.ts:33` `program.action` receives `zip` path + options, calls `runParser(zip, opts)` (`src/index.ts:46`).
2. `runParser` (`src/model.ts:83`): `chatInfoFromZip(zip)` → `{slug, name}` (`src/model.ts:87`); `fs.mkdir(dir)` (`src/model.ts:90`).
3. `extractChatTxt(zip)` returns an `AsyncIterable<string>` of `_chat.txt` lines (`src/model.ts:92`).
4. `parseMessages(lines, {dayFirst, monthFirst, warnings, onDetection})` streams `Message` objects; format detection runs once over the first ≤200 lines (`src/parse/message.ts:64-184`). `runParser` pushes each into `messages[]` (`src/model.ts:96-105`).
5. `mergeCsv(dir/messages.csv, messages)` dedupes + stable-sorts ascending by `timestamp_iso` and writes the CSV source-of-truth (`src/model.ts:109`, `src/csv.ts:144`).
6. `enrichTitles(readCsv(...), {enabled, concurrency:8, timeoutMs:5000})` fetches URL titles and `writeCsv` persists them back into column 6 (`src/model.ts:113-121`).
7. `reconcileMedia(zip, dir, distinctMedia)` streams matched media entries into `dir/media/` (`src/model.ts:126-127`, `src/media.ts:171`).
8. `renderOutputs(dir, name, {inline})` re-reads `messages.csv` from disk and writes `messages.json`, `messages.md`, `messages.html` (`src/model.ts:131`, `src/model.ts:69-81`).
9. `index.ts` prints the `✓ Merged N message(s)` summary (`src/index.ts:58-68`).

### Re-render path (no ZIP needed)

- Any renderer can be invoked on an existing `messages.csv`: each calls `readCsv(csvPath)` at the top (`src/render/json.ts:85`, `src/render/md.ts:90`, `src/render/html.ts:254`). This is why the CSV — not the `Message[]` in memory — is the source-of-truth.

### Title-enrichment detail

1. `enrichTitles` collects unique `http(s)` URLs via `URL_RE` (`src/title.ts:274-280`).
2. A bounded worker pool (default `concurrency:8`) fetches each URL once and fills a `map[url]=title` (`src/title.ts:287-302`).
3. Titles are mapped back onto each message's `urlTitles` using either the fetched title or `deriveTitle(url)` offline fallback (`src/title.ts:303-314`).

**State Management:** No global mutable state. The pipeline is a sequence of pure-ish transforms over `Message[]` and the CSV file. `runParser` holds `messages[]` and `detection` only as local variables. `renderOutputs` is stateless (reads from disk). Per-request transient state: `detection` (format decision), `warnings[]` (verbose), `mediaReport` (resolved/unresolved).

## Key Abstractions

**Streaming ZIP reader (`extractChatTxt` / `readLines`):**
- Purpose: memory-safe access to `_chat.txt` without inflating media.
- Examples: `src/extract.ts:16`, `src/extract.ts:73`.
- Pattern: fflate `Unzip` → only `_chat.txt` `file.start()` → `readline.Interface` over a `PassThrough`; a hand-rolled async-iterator queue (`readLines`) avoids Node 26 `for await` hang on async-fed streams.

**Line state-machine parser (`parseMessages`):**
- Purpose: robustly split a free-form export into messages, handling multi-line continuations, held-empty attachment merging, and per-file format detection.
- Examples: `src/parse/message.ts:82`, `src/parse/message.ts:103` `processLine`.
- Pattern: async generator yielding `Message`; continuation lines appended to `current`/`heldEmpty` (`src/parse/message.ts:92`); empty-body timestamped lines held then merged with a same-author attachment (`src/parse/message.ts:139-155`).

**CSV source-of-truth (`csv.ts`):**
- Purpose: one canonical, re-readable artifact; single physical line per row (newlines backslash-escaped in `csvField`).
- Examples: `src/csv.ts:9` `csvField`, `src/csv.ts:59` `dedupeKey` (uses U+001F Unit Separator so legitimate content can't collide), `src/csv.ts:144` `mergeCsv` (stable ascending sort by `timestamp_iso`).
- Pattern: RFC-4180 writer/reader with a custom single-left-to-right unescape to avoid double-unescaping `\n`.

**Title enrichment (`enrichTitles` / `fetchTitle`):**
- Purpose: attach context to links without blocking the pipeline.
- Examples: `src/title.ts:260`, `src/title.ts:181`.
- Pattern: per-platform dispatch (`platformOf`) — YouTube oEmbed, Reddit `.json`, Stack Exchange API, Medium HTML, LinkedIn/X offline slug-derivation, generic `<title>` — each with safe fallbacks; result cached in `urlTitles`.

**Media reconciliation (`reconcileMedia` / `buildMediaMap`):**
- Purpose: tolerant filename matching + disk-resident media map for renderers.
- Examples: `src/media.ts:171`, `src/media.ts:236`.
- Pattern: read ZIP central directory only (`readCentralDirectory`, `src/media.ts:76`) for authoritative sizes; stream each matched entry out (`extractEntry`, `src/media.ts:123`); `normalizeMediaName` drops `(1)` markers and whitespace so `Photo (1).JPG` matches `photo.jpg`.

**Renderer contract (`render<Format>`):**
- Purpose: uniform way to emit an output from the CSV.
- Examples: `src/render/json.ts:79`, `src/render/md.ts:84`, `src/render/html.ts:248` — all `(csvPath, outDir, chatName, opts) => Promise<string>` returning the written path.
- Pattern: `readCsv` + `buildMediaMap` + shared `linkify.js`; JSON/MD/HTML re-use `dayOf`/`timeOf` (`src/render/json.ts:32-38`) and `linkifyHtml`/`linkifyMarkdown`/`deriveTitle` (`src/render/js/linkify.js`).

## Entry Points

**CLI binary (`src/index.ts`):**
- Location: `src/index.ts`
- Triggers: `node dist/index.js`, `npm run dev`, `npx tsx src/index.ts`.
- Responsibilities: commander setup (positional `[zip]`, flags `--zip/--out/--day-first/--month-first/--verbose/--inline/--no-fetch-titles`), then `runParser`. The `#!/usr/bin/env node` shebang + `bin.wa-backup` in `package.json` make it a CLI.

**Library entry (`src/model.ts` `runParser`):**
- Location: `src/model.ts:83`
- Triggers: the CLI action.
- Responsibilities: own the full pipeline (steps listed in Data Flow).

## Architectural Constraints

- **Module system:** ESM-only (`"type": "module"` in `package.json`); `tsup` builds to `dist/index.js` as ESM (`tsup.config.ts`). Dynamic `await import('./title.js')` (`src/model.ts:113`) is used to lazy-load the network-dependent enrichment only when needed.
- **Browser-shared JS:** `src/render/js/*.js` are plain `.js` (no TS, no Node imports) so they load both in Node renderers and in the browser viewer (`src/render/html.ts:264` reads `transcript.js` from disk and inlines it). They must not `import` from `node:*`.
- **Single physical line per CSV row:** enforced by `csvField` backslash-escaping newlines (`src/csv.ts:9-17`) — renderers rely on this.
- **Global state:** none. All transient state is local to `runParser` or renderer calls. (The only module-level constants are regexes and the `MIME_BY_EXT` map.)
- **Circular imports:** not present. Dependency direction is strictly `index → model → {extract, parse, csv, title, media, render}`; `render → {csv, media, parse/types, render/js}`; `csv → parse/types` only.
- **Threading:** single-threaded Node event loop; concurrency is cooperative (async workers in `enrichTitles` bounded by `concurrency`, `src/title.ts:282`; `Promise.all` over media writes, `src/media.ts:211`).

## Anti-Patterns

### Reading the whole archive into memory

**What happens:** using jszip-style load-the-entire-ZIP APIs would buffer videos.
**Why it's wrong:** violates the memory-safety constraint (large WhatsApp zips with video).
**Do this instead:** fflate streaming `Unzip` + central-directory reads as in `src/extract.ts:16` and `src/media.ts:76` — only `_chat.txt` is inflated; media is streamed entry-by-entry.

### Treating the in-memory `Message[]` as the source-of-truth

**What happens:** writing outputs directly from the parsed array.
**Why it's wrong:** breaks idempotent re-render and the title-merge step that writes back to disk.
**Do this instead:** renderers call `readCsv(csvPath)` (`src/render/json.ts:85`) and operate on the persisted CSV.

## Error Handling

**Strategy:** fail-soft and report, never throw on missing media or unparseable lines.

**Patterns:**
- Unparseable timestamps are treated as continuations (`src/parse/message.ts:112-117`, `tryParseTimestamp` returns `null`).
- Missing media → placeholder in renderers (`src/render/html.ts:61`, `src/render/md.ts:54`), `reconcileMedia` returns `unresolved[]` and never throws (`src/media.ts:171`).
- User-facing errors are caught in `src/index.ts:69` and printed via `picocolors` red; `process.exitCode = 1`.
- Title fetch failures fall back to offline `deriveTitle` (`src/title.ts:246-248`).

## Cross-Cutting Concerns

**Logging:** `picocolors` (`pc`) for stderr/progress; verbose reporting via `verboseReport` (`src/model.ts:27`). Artifacts (json/md/html) stay clean — diagnostics go to stderr.

**Validation:** `isValidYmd` sanity check + year window (`src/parse/timestamp.ts:76`, `:167`); CSV row-count guard in `readCsv` (`src/csv.ts:108`).

**Authentication:** none (local-only tool, no accounts/secrets).

**Security / XSS:** all untrusted chat text is HTML-escaped (`escapeHtml` in `src/render/html.ts:11`, `src/render/js/linkify.js:7`) before being placed in anchors; `</script` is neutralized in the JSON island (`src/render/html.ts:262`); browser viewer uses `textContent` (`src/render/js/xss-sanitize.js`).

**Output portability:** `messages.html` is standalone (CSS inlined, JS inlined), opens in any browser with no server; media referenced via relative `media/` paths or `data:` URIs under `--inline`.

---

*Architecture analysis: 2026-08-23*
