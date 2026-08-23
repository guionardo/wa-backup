# Codebase Structure

**Analysis Date:** 2026-08-23

## Directory Layout

```
wa-backup/
├── src/                      # TypeScript source (ESM, "type":"module")
│   ├── index.ts              # CLI entry (commander), buildCli()
│   ├── model.ts              # Orchestrator: runParser() + renderOutputs()
│   ├── extract.ts            # ZIP streaming → _chat.txt lines; chat name/slug
│   ├── media.ts              # Media reconcile + buildMediaMap + inline rules
│   ├── title.ts              # URL→title enrichment (per-platform fetch)
│   ├── csv.ts                # CSV source-of-truth read/write/merge
│   ├── parse/                # Parsing sublayer
│   │   ├── types.ts          # Message / MessageType model
│   │   ├── timestamp.ts      # TS_RE, detectFormat, tryParseTimestamp
│   │   └── message.ts        # parseMessages line state-machine
│   └── render/               # Rendering sublayer
│       ├── json.ts           # renderJson + buildEnvelope + dayOf/timeOf
│       ├── md.ts             # renderMarkdown (day-sectioned log)
│       ├── html.ts           # renderHtml (WhatsApp-style bubbles)
│       ├── colors.ts         # accentHue / getAccentColor / initials
│       └── js/               # Plain .js, Node + browser shared
│           ├── linkify.js     # URL_RE, linkifyHtml/Markdown, deriveTitle
│           ├── transcript.js  # browser viewer logic (search/filter/theme)
│           └── xss-sanitize.js# textContent-only notes
├── test/                     # Node:test suites (*.test.ts)
├── dist/                     # tsup build output (gitignored-ish; bin target)
├── out/ output/ backup/      # Generated sample outputs (per-run dirs)
├── docs/                     # Project docs (superpowers plans/specs)
├── tsup.config.ts            # Build config (ESM, node22, entry src/index.ts)
├── tsconfig.json             # strict TS, Bundler resolution, include src+test
└── package.json              # deps + scripts (dev/build/typecheck/test)
```

## Directory Purposes

**`src/` (root):**
- Purpose: top-level pipeline modules (CLI, orchestrator, extraction, CSV, media, title).
- Contains: `index.ts`, `model.ts`, `extract.ts`, `media.ts`, `title.ts`, `csv.ts`.
- Key files: `src/model.ts` (orchestration), `src/csv.ts` (source-of-truth).

**`src/parse/`:**
- Purpose: the parsing sublayer — converting raw `_chat.txt` lines into `Message` objects.
- Contains: `types.ts` (model), `timestamp.ts` (date detection/parsing), `message.ts` (line state-machine).
- Key files: `src/parse/message.ts:82` `parseMessages`, `src/parse/timestamp.ts:92` `detectFormat`.

**`src/render/`:**
- Purpose: the rendering sublayer — emitting the three synchronized outputs from the CSV.
- Contains: `json.ts`, `md.ts`, `html.ts`, `colors.ts`, `js/` (shared browser-safe helpers).
- Key files: `src/render/html.ts:248` `renderHtml`, `src/render/json.ts:79` `renderJson`.

**`src/render/js/`:**
- Purpose: plain `.js` modules safe to run in both Node and the browser (no `node:` imports).
- Contains: `linkify.js` (shared by `html.ts`, `md.ts`, browser `transcript.js`), `transcript.js` (inlined into HTML), `xss-sanitize.js`.
- Key files: `src/render/js/linkify.js` (`URL_RE`, `linkifyHtml`, `linkifyMarkdown`, `deriveTitle`).

**`test/`:**
- Purpose: `node --test` suites co-located by concern.
- Contains: `classify.test.ts`, `csv.test.ts`, `html-media.test.ts`, `integration.test.ts`, `linkify.test.ts`, `media.test.ts`, `render.test.ts`, `theme.test.ts`, `timestamp.test.ts`, `title.test.ts`, `tracer.test.ts`.

## Key File Locations

**Entry Points:**
- `src/index.ts`: CLI entry (`buildCli().parseAsync(process.argv)` at `:78`); `bin.wa-backup` → `dist/index.js`.
- `src/model.ts:83` `runParser`: programmatic entry to the full pipeline.

**Configuration:**
- `package.json`: deps (`commander`, `date-fns`, `fflate`, `picocolors`), scripts (`dev`/`build`/`typecheck`/`test`).
- `tsup.config.ts`: build entry `src/index.ts`, ESM, target `node22`, `outDir: dist`.
- `tsconfig.json`: `strict: true`, `moduleResolution: Bundler`, `include: ["src","test"]`.

**Core Logic:**
- `src/model.ts`: orchestration of extract → parse → merge → enrich → reconcile → render.
- `src/csv.ts`: the canonical `messages.csv` read/write/merge.
- `src/parse/message.ts`: the streaming `Message` parser.

**Shared Abstractions:**
- `src/parse/types.ts`: `Message` interface (the central data model).
- `src/render/js/linkify.js`: link rendering shared everywhere.

**Testing:**
- `test/` — `*.test.ts` run via `node --import tsx --test "test/*.test.ts"`.

## Naming Conventions

**Files:**
- `kebab-case.ts` for source modules (e.g. `message.ts`, `timestamp.ts`, `media.ts`, `html.ts`, `json.ts`, `md.ts`).
- Sublayer directories: `parse/` and `render/` group related modules.
- Browser-shared helpers live in `render/js/` with a `.js` extension (not `.ts`) so they run untranspiled in the browser.
- Test files mirror the unit under test: `<concern>.test.ts` (e.g. `csv.test.ts`, `title.test.ts`).

**Exports / functions:**
- Functions: `camelCase` verb phrases — `parseMessages`, `detectFormat`, `mergeCsv`, `enrichTitles`, `reconcileMedia`, `renderJson`, `renderHtml`, `buildEnvelope`, `buildMediaMap`, `slugifyChatName`.
- Types / interfaces: `PascalCase` — `Message`, `MessageType`, `Detection`, `ParsedTimestamp`, `JsonEnvelope`, `RenderedMessage`, `MediaEntry`, `ReconcileResult`, `RunOptions`.
- Constants: `SCREAMING_SNAKE` for regexes/enums — `TS_RE`, `SENDER_RE`, `ATTACHED_RE`, `OMITTED_RE`, `DELETED_RE`, `URL_RE`, `INLINE_MAX_BYTES`.
- CSV column names: `snake_case` — `timestamp_iso`, `type`, `author`, `text`, `media`, `url_titles`.

**Streaming idiom:**
- Async generators (`async function*`) for line/record streams: `parseMessages` (`src/parse/message.ts:82`), `readLines` (`src/extract.ts:73`).
- Renderers follow a uniform signature: `(csvPath: string, outDir: string, chatName: string, opts?: {inline?: boolean}) => Promise<string>`.

## Where to Add New Code

**New output format (4th renderer):**
- Implementation: `src/render/<format>.ts` exporting `render<Format>(csvPath, outDir, chatName, opts)` that calls `readCsv(csvPath)` + `buildMediaMap(outDir, messages)`.
- Register it: add a call in `renderOutputs` (`src/model.ts:69-81`) and a summary line in `src/index.ts:63-68`.
- Reuse: `dayOf`/`timeOf` (`src/render/json.ts:32`), `linkify.js` (`src/render/js/linkify.js`).

**New message type / classification:**
- Implementation: extend `MessageType` in `src/parse/types.ts:1` and the classifier order in `classifyType` (`src/parse/message.ts:40`).
- Adjust `MEDIA_ICON` maps in `src/render/html.ts:20` and `src/render/md.ts:23` if a bubble/label is needed.

**New timestamp locale:**
- Implementation: extend `TS_RE` (`src/parse/timestamp.ts:32`) and the vote logic in `detectFormat` (`src/parse/timestamp.ts:92`); add a `resolveYear` edge case if needed.

**New title-extraction platform:**
- Implementation: add a branch in `platformOf` (`src/title.ts:61`) + a `fetch*`/`derive*` function, then wire it in `fetchTitle` (`src/title.ts:181`).

**New media handling:**
- Implementation: `src/media.ts` — add MIME types to `MIME_BY_EXT` (`:28`), adjust `isInlineable` (`:51`), or refine `normalizeMediaName` (`:24`).

**Utilities / shared helpers:**
- Node-only helpers: add to the relevant `src/` module.
- Node + browser helpers: add to `src/render/js/` as `.js` with **no `node:` imports** (so they can be inlined into the HTML).

**Tests:**
- Add `test/<concern>.test.ts` and ensure it matches the `test/*.test.ts` glob in `package.json`.

## Special Directories

**`dist/`:**
- Purpose: built ESM bundle from `tsup` (entry `dist/index.js`).
- Generated: Yes (by `npm run build`).
- Committed: No (build artifact).

**`output/`, `out/`, `backup/`:**
- Purpose: per-run generated backups (`<slug>/messages.csv`, `messages.json`, `messages.md`, `messages.html`, `media/`).
- Generated: Yes (by `runParser` into `opts.out` default `output`).
- Committed: No (runtime output; contains user data).

**`src/render/js/`:**
- Purpose: dual-runtime (Node + browser) JS.
- Generated: No.
- Committed: Yes — required at runtime (read from disk by `renderHtml` and executed in the browser).

**`.planning/`, `_reversa*/`:**
- Purpose: GSD planning artifacts and Reversa analysis (not application code).

---

*Structure analysis: 2026-08-23*
