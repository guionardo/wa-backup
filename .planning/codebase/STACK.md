# Technology Stack

**Analysis Date:** 2026-08-23

## Languages

**Primary:**
- TypeScript 5.x (`^5` in `package.json`, devDependency) — entire `src/` tree is `.ts`; one plain-JS module (`src/render/js/*.js`) is deliberately `.js` so it can run untranspiled in both Node and the browser viewer.
- JavaScript (ES2022) — `src/render/js/xss-sanitize.js`, `linkify.js`, `transcript.js` are hand-written ESM `.js` shared between Node renderers and the standalone browser viewer.

**Secondary:**
- JSON — `package.json`, `tsconfig.json`, `tsup.config.ts` config; output `messages.json` is a data artifact, not source.

## Runtime

**Environment:**
- Node.js — `package.json` sets no `engines` field, but `tsup.config.ts` targets `node22` and `package-lock.json` pins `@types/node@26.2.0`; local dev runtime is **v26.5.0** (`node --version`). Built output runs on Node ≥ 22 (esbuild `target: 'node22'`).
- Module system: **ESM** — `"type": "module"` in `package.json`. All imports use bare/relative specifiers with explicit `.js`/no extension; built-ins are imported via the `node:` prefix (`node:fs`, `node:path`, `node:stream`, `node:readline`, `node:crypto`, `node:zlib`).

**Package Manager:**
- npm 11.17.0 (local). Lockfile: **present** — `package-lock.json` (committed, 64.7K).

## Frameworks

**Core:**
- None (no web/UI framework). The tool is a headless CLI. The HTML output (`src/render/html.ts`) is a hand-rolled static string template; the browser viewer (`src/render/js/transcript.js`) is dependency-free vanilla JS.

**Testing:**
- Node built-in test runner — `node --test` (`"test": "node --import tsx --test \"test/*.test.ts\""`). No external test framework (no vitest/jest/mocha).

**Build/Dev:**
- `tsx` 4.23.12 — dev/start/exec runner (`"dev"`/`"start"`: `tsx src/index.ts`).
- `tsup` 8.5.1 — distributable bundle builder (`"build": "tsup"`), esbuild-based, emits a single ESM `dist/index.js` with shebang (`bin` entry `wa-backup`).
- `typescript` ^5 — type-check only (`"typecheck": "tsc --noEmit"`); `tsc` is NOT used for builds (tsup/esbuild does transpilation).
- `tsconfig.json` `compilerOptions`: `target: ES2022`, `module: ESNext`, `moduleResolution: Bundler`, `strict: true`, `esModuleInterop: true`, `skipLibCheck: true`, `noEmit: true`, `resolveJsonModule: true`, `types: ["node"]`. `include: ["src", "test"]`.

## Key Dependencies

**Runtime (`dependencies` in `package.json`):**

| Package | Version | Purpose |
|---------|---------|---------|
| `commander` | 15.0.0 | CLI argument parsing and command wiring (`src/index.ts` `buildCli()`). Zero-dependency, ESM-native. |
| `date-fns` | 4.4.0 | Date rendering/output formatting. Currently imported only in `src/parse/timestamp.ts` (`import { format } from 'date-fns'`). Tree-shakeable. |
| `fflate` | 0.8.3 | Streaming ZIP/`Unzip` + `AsyncUnzipInflate` for reading WhatsApp export archives without buffering (`src/extract.ts`, `src/media.ts`). Browser-compatible (reuse win). 8KB. |
| `picocolors` | 1.1.1 | Terminal color output in the CLI and title-enrichment verbosity (`src/index.ts`, `src/title.ts`). |

**Dev/build (`devDependencies`):**

| Package | Version | Purpose |
|---------|---------|---------|
| `@types/node` | 26.2.0 | Node type definitions matching the dev runtime (Node 26). |
| `tsx` | 4.23.12 | Run `.ts` directly with no emit step. |
| `tsup` | 8.5.1 | Bundle to ESM + inject shebang (transitive: esbuild; `package-lock.json` also pulls `@esbuild/*` and `@rollup/rollup-*`). |
| `typescript` | ^5 | `tsc --noEmit` type-check. |

## Configuration

**Environment:**
- No `.env` / `.npmrc` / `.nvmrc` files present in the repo (none detected). Configuration is done entirely via CLI flags (`src/index.ts`):
  - `[zip]` positional or `--zip <path>`
  - `--out <dir>`
  - `--day-first` / `--month-first`
  - `--verbose`
  - `--inline` (base64-embed media into single HTML)
  - `--no-fetch-titles` (skip network title fetching → offline mode)
- No secrets, API keys, or auth tokens are required or stored.

**Build:**
- `tsup.config.ts` — `entry: { index: 'src/index.ts' }`, `format: ['esm']`, `target: 'node22'`, `outDir: 'dist'`, `clean: true`, `dts: false`, `shims: true`, `sourcemap: false`. Produces `dist/index.js` mapped by `package.json` `bin.wa-backup`.
- `tsconfig.json` — see Frameworks/Build above.

**.gitignore:** `node_modules/`, `dist/`, `test/fixtures/`, `data/`, `*.log`, `out/`, `output/`, `.DS_Store`. Output artifacts (`output/<slug>/`) are intentionally untracked.

## Platform Requirements

**Development:**
- Node.js ≥ 22 (dev uses v26.5.0). npm ≥ 11. No native modules; pure JS/TS.
- Install: `npm install` (reads `package-lock.json`).

**Production:**
- Distributed as an npm binary (`wa-backup`) via `npm i -g` / `npx`; runs on Node ≥ 22 with no external services. Output is a standalone folder (`output/<slug>/` with `messages.csv`, `messages.json`, `messages.md`, `messages.html`, `media/`) that opens in any browser with no server.

## Notable Constraints

- **ESM-only.** `"type": "module"`; no CommonJS. Cross-runtime `.js` files (`src/render/js/*.js`) must stay plain ESM so the same source loads in Node (via `tsx`) and in the browser viewer.
- **No-new-dependency philosophy.** XSS sanitization (`src/render/js/xss-sanitize.js`), URL→link conversion (`src/render/js/linkify.js`), Markdown/HTML/JSON renderers, CSV read/write (`src/csv.ts`), ZIP central-directory parsing (`src/media.ts` `readCentralDirectory`), and MIME mapping (`src/media.ts` `mimeFromExt`) are all hand-rolled with zero dependencies. Resist adding libraries where a small built-in suffices.
- **Memory-safe streaming is a hard requirement.** The chat transcript is parsed line-by-line via `node:readline` over a `PassThrough` fed by fflate's streaming `Unzip` (`src/extract.ts`). Media is extracted entry-by-entry using a hand-rolled ZIP central-directory index + `node:zlib` inflate (`src/media.ts`), so the whole archive is never buffered — critical for large videos.
- **Browser reuse boundary.** Core logic is kept Node/browser agnostic where it must be shared (renderers + `linkify.js` + `transcript.js`); platform-specific APIs (`node:fs`, `fetch`) are confined to Node-only modules.
- **Network is optional.** Title fetching (`src/title.ts`) is gated behind `--no-fetch-titles`; offline mode derives titles from the URL string only (no `fetch`). The HTML viewer embeds per-site `/favicon.ico` `<img>` tags that load at view time in the browser (not a CLI network call).

---

*Stack analysis: 2026-08-23*
