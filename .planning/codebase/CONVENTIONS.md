# Coding Conventions

**Analysis Date:** 2026-08-23

## Project Constraints (Hard Rules)

These constraints are enforced by the architecture and must be honored in every change:

- **No new runtime dependencies.** `package.json` lists exactly four runtime deps: `commander`, `date-fns`, `fflate`, `picocolors`. Network title-fetching (`src/title.ts`) uses the built-in `fetch` (Node global) — no HTTP client library. Do not add runtime packages without explicit approval. Dev-only tooling (`tsx`, `tsup`, `typescript`, `@types/node`) is the only other allowed surface.
- **Memory-safe / streaming.** Large chats and media are handled with streaming APIs, never loaded fully into memory. Parsing uses `node:readline` over a `Readable` (`src/parse/message.ts`); ZIP extraction pipes per-entry streams to disk (`src/media.ts`, `src/extract.ts`). Avoid buffering entire files into `Buffer`/`string` when a stream alternative exists.
- **XSS-safe output.** All untrusted message content is escaped before being placed into HTML/Markdown. The canonical helper is `escapeHtml` in `src/render/js/linkify.js` (lines 7–14); linkified text always flows through `linkifyHtml`/`linkifyMarkdown`, which escape before wrapping. The browser viewer enforces the `textContent`-only rule via `src/render/js/xss-sanitize.js` (`setText`, `textNode`) — never assign untrusted strings to `innerHTML`.
- **Offline-capable by default.** Title enrichment degrades to an offline-derived title (`deriveTitle` in `src/render/js/linkify.js`) whenever the network is unavailable, blocked, or times out. LinkedIn/X titles are derived purely from the URL slug — no network call (see `src/title.ts`).

## Language & Module System

- **TypeScript**, target `ES2022` (`tsconfig.json`), `strict: true`, `moduleResolution: Bundler`.
- **ESM only.** `"type": "module"` in `package.json`. All internal imports use explicit `.js` extensions even though sources are `.ts` (e.g. `import { URL_RE } from './render/js/linkify.js'` in `src/title.ts:3`). This is required so the same code loads under `tsx` and in the browser bundle.
- No barrel files; modules import sibling modules by relative path directly.

## Naming Conventions

**Files:**
- Source files: `kebab-case.ts` (e.g. `src/parse/message.ts`, `src/render/html.ts`, `src/title.ts`).
- Browser-side runtime scripts (intentionally `.js`, not `.ts`): `src/render/js/linkify.js`, `src/render/js/transcript.js`, `src/render/js/xss-sanitize.js`. These are plain ESM shared with the static viewer.
- Test files: `kebab-case.test.ts` under `test/` (e.g. `test/title.test.ts`, `test/linkify.test.ts`).

**Functions / variables:**
- `camelCase` for functions and variables (`enrichTitles`, `deriveTitle`, `unwrapUrl`, `escapeHtml`).
- `PascalCase` for types/interfaces (`RunOptions`, `RenderResult`, `Platform`, `Message`) — see `src/model.ts:15`, `src/title.ts:51`, `src/parse/types.ts`.
- Exported constants are `UPPER_SNAKE_CASE` where they are regex/constants (`URL_RE` in `src/render/js/linkify.js:5`, `TITLE_RE` in `src/title.ts:11`).

**Types:**
- Domain model lives in `src/parse/types.ts` (`Message`, etc.); import as `import type { Message } from './parse/types'` (type-only imports).

## Import Organization

Order observed across the codebase:
1. Node built-ins (`node:fs/promises`, `node:path`, `node:http`, `node:assert/strict`).
2. External packages (`commander`, `picocolors`, `fflate`).
3. Local relative imports (`./extract`, `./parse/message`, etc.).

Example from `src/model.ts:1-13`. Type-only and value imports are kept separate (`import type` vs `import`).

## Error Handling

**Pattern: fail-soft with reporting, not hard throws for recoverable gaps.**
- Recoverable parse/network issues are swallowed and degraded. `src/title.ts` wraps every platform fetch in `try/catch` and falls back to `deriveTitle` (offline) — see the per-platform blocks in `fetchTitle` (lines 195–248) and the outer `catch` returning `deriveTitle(target)` (line 248).
- `src/title.ts:fn` pure `try/catch` helpers that return sensible defaults: `deriveTitle` returns raw URL on parse error (line 41), `unwrapUrl` returns input unchanged on error (line 65), `platformOf` returns `'generic'` on error (line 72), `faviconFor` returns `''` on error (line 119).
- CLI surface reports through `picocolors`-styled `console.error` and sets `process.exitCode = 1` rather than calling `process.exit` directly (see `src/index.ts:42,72`). User-facing errors are printed as `pc.red('✗ ' + message)` (`src/index.ts:71`).
- Media reconciliation never throws on missing media; unresolved refs are collected into `mediaReport.unresolved` and printed as warnings (`src/model.ts:143-154`, `src/media.ts:157-216`).
- The only hard `throw` in the core is a malformed-ZIP guard: `throw new Error('ZIP end-of-central-directory record not found')` in `src/media.ts:90`.

**Console usage:** runtime/user output goes through `console.error` (stderr) and `console.log` (stdout, only for the final success summary in `src/index.ts:58-68`). Many `console.error` lines carry `// eslint-disable-next-line no-console` comments (9 occurrences across `src/` and `test/`), though **no ESLint config is present** — the comment is a carried-over convention, not enforced by current tooling.

## Special Patterns

### Per-message title resolver (linkify)
`linkifyHtml`/`linkifyMarkdown` (`src/render/js/linkify.js:71,96`) accept an optional `resolver` callback that maps a URL to a display title, defaulting to `deriveTitle`. Callers build a **per-message** resolver closing over that message's fetched title map, so each link shows its resolved page title with a safe offline fallback:
```ts
// src/render/html.ts:126-127
const resolve = (u: string) => m.urlTitles?.[u] ?? deriveTitle(u);
const icon = (u: string) => faviconFor(u);
```
The Markdown renderer does the same at `src/render/md.ts:68,110,115`. This keeps rendering pure (no I/O) and the resolver injects pre-fetched data.

### Bounded-concurrency promise pool (enrichTitles)
`src/title.ts:260-316` fetches unique URLs in parallel but caps concurrency. A shared `cursor` index is advanced by N worker closures (default `concurrency: 8`); each worker loops `while (cursor < urls.length)` pulling the next URL — a manual promise-pool, no external queue library. Unique URLs are deduplicated up front with `new Set(...)` (line 274) so every distinct URL is fetched exactly once, then the result map is applied back onto each message.

### Dynamic import for optional-heavy path
Title enrichment is loaded lazily so the core parse path stays light: `const { enrichTitles } = await import('./title.js')` in `src/model.ts:113`.

### AbortController-based timeouts
Network fetches use `AbortController` + `setTimeout` to bound each request (`src/title.ts:187-188,249-250`), not `Promise.race` wrappers.

## Documentation Comments

- JSDoc `/** ... */` is used on exported functions (`deriveTitle`, `linkifyHtml`, `fetchTitle`, `enrichTitles`).
- Inline comments explain *why* (e.g. `src/render/js/linkify.js:23-27` explains why `)`/`]` are excluded from trailing-punctuation trimming; `src/title.ts:5-9` explains the browser-like UA).
- Code is written to be self-documenting; comments focus on non-obvious invariants rather than restating code.

## Testing Conventions (see TESTING.md)

Tests are colocated in `test/*.test.ts`, use `node:test` + `node:assert/strict`, and run via `node --import tsx --test "test/*.test.ts"`. No `describe` blocks — flat `test(...)` calls with descriptive string names. Mocks are local `node:http` servers or `globalThis.fetch` swaps, not a mocking library.

---

*Convention analysis: 2026-08-23*
