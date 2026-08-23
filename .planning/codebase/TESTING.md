# Testing Patterns

**Analysis Date:** 2026-08-23

## Test Framework

**Runner:** Node.js built-in test runner — `node:test` (no third-party framework, satisfying the no-new-dependency rule).

**Assertion library:** `node:assert/strict` (imported as `import assert from 'node:assert/strict'`). Deep equality via `assert.deepEqual`, thrown errors via `assert.throws`/`assert.rejects` where used, and `assert.ok` for boolean conditions.

**TypeScript execution:** Tests are `.ts` files run directly through `tsx` via the `--import tsx` loader. No separate compile step — the runner executes the same TypeScript sources as the app.

## Run Commands

```bash
node --import tsx --test "test/*.test.ts"   # run all tests
node --import tsx --test "test/title.test.ts"   # single file (glob the filename)
node --import tsx --test "test/*.test.ts" --watch  # watch mode (node:test supports --watch)
```

- `package.json` script: `"test": "node --import tsx --test \"test/*.test.ts\""`.
- The glob `test/*.test.ts` is passed as a single quoted argument; the shell expands it (or node:test's own globbing applies). Add a specific filename to run a subset.
- **No coverage tooling is configured** (no `c8`/`nyc` dependency; coverage is not enforced). `tsc --noEmit` (`npm run typecheck`) provides static verification instead.

## Test File Organization

**Location:** All tests live in `test/` at the repo root, one file per source module area:

| Test file | Covers |
|-----------|--------|
| `test/title.test.ts` | `src/title.ts` — `extractTitle`, `fetchTitle`, `enrichTitles`, platform classification, per-platform parsers |
| `test/linkify.test.ts` | `src/render/js/linkify.js` — `deriveTitle`, `linkifyHtml`, `linkifyMarkdown`, `unwrapUrl`, `faviconFor` |
| `test/timestamp.test.ts` | `src/parse/timestamp.ts` — date-format detection |
| `test/classify.test.ts` | message-type classification |
| `test/csv.test.ts` | `src/csv.ts` — CSV read/write/merge |
| `test/render.test.ts` | JSON/MD/HTML renderers |
| `test/html-media.test.ts` | HTML media rendering |
| `test/media.test.ts` | `src/media.ts` — media reconciliation |
| `test/theme.test.ts` | color/theme helpers (`src/render/colors.ts`) |
| `test/tracer.test.ts` | tracer/progress logging |
| `test/integration.test.ts` | full pipeline `runParser` over real sample chats |

**Naming:** `<area>.test.ts`, mirrored to the source module name. Test functions are named `test('short description', () => {...})`.

**Style — NO `describe` blocks.** The suite uses flat top-level `test(...)` calls with descriptive string names (verified across all 11 files — every import is `import { test } from 'node:test'` or `import test from 'node:test'`). Grouping is by comment banners like `// ---- unit: deriveTitle ----` (`test/linkify.test.ts:19`) rather than nested `describe` suites.

## Test Structure & Patterns

**Basic unit test:**
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTitle } from '../src/render/js/linkify.js';

test('deriveTitle: strips scheme, www, trailing slash, query', () => {
  assert.equal(deriveTitle('https://www.github.com/owner/repo?x=1'), 'github.com/owner/repo');
  assert.equal(deriveTitle('http://example.com/'), 'example.com');
});
```
(`test/linkify.test.ts:21-26`)

**Assertion helpers used:** `assert.equal` (strict equality), `assert.deepEqual` (`test/title.test.ts:103`), `assert.ok` with a message string (`test/title.test.ts:64,74`).

## Mocking Strategy

**No mocking library.** Two patterns:

### 1. Local `node:http` mock server (for real network reads)
Used in `test/title.test.ts` via a `startServer(body, { contentType, delayMs })` helper (`test/title.test.ts:22-40`) that:
- Creates `createServer` bound to `127.0.0.1:0` (ephemeral port).
- Returns `{ url, close }`; tests `try/finally` call `srv.close()` to free the port.
- Simulates latency (`delayMs`) to exercise the timeout fallback (`test/title.test.ts:60-68`) and wrong content-type (`test/title.test.ts:70-78`).

```ts
const srv = await startServer('<title>My Page</title>');
try {
  assert.equal(await fetchTitle(srv.url), 'My Page');
} finally {
  srv.close();
}
```
(`test/title.test.ts:51-58`)

### 2. `globalThis.fetch` swap (for platform-specific dispatches)
Network calls are intercepted by temporarily reassigning the global `fetch`, restoring it in `finally`:
```ts
const original = globalThis.fetch;
globalThis.fetch = (async (u: any) => {
  if (String(u).includes('/oembed')) {
    return new Response(JSON.stringify({ title: 'My Video' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('<title>ignored</title>', { status: 200 });
}) as any;
try {
  assert.equal(await fetchTitle('https://youtube.com/watch?v=1'), 'My Video');
} finally {
  globalThis.fetch = original;   // always restore
}
```
(`test/title.test.ts:288-304`). This pattern is used per-platform to assert:
- YouTube uses the oEmbed endpoint (`/oembed`) — line 288.
- Reddit uses the `.json` listing — line 306.
- Stack Overflow uses the Stack Exchange API — line 229.
- Medium uses `og:title` from mocked HTML — line 250.
- **LinkedIn and X are OFFLINE** — tests assert `networkCalled === false` after swapping `fetch` to a spy that flips a flag (`test/title.test.ts:271-284, 324-340`).

### Console spying
For verbose-logging tests, `console.error` is swapped to a capturing array and restored in `finally`:
```ts
const logs: string[] = [];
const orig = console.error;
console.error = (...a: unknown[]) => logs.push(a.join(' '));
try { await enrichTitles(msgs, { enabled: true, verbose: true }); }
finally { console.error = orig; }
```
(`test/title.test.ts:106-128`); assertions check `logs.some((l) => l.includes('[wa-backup] title:'))`.

## Integration / End-to-End Tests

**`test/integration.test.ts`** exercises the full `runParser` pipeline (`src/model.ts:83`) over **real sample chat data**:
- Reads `data/<chat>/_chat.txt` from disk (`data/WhatsApp Chat - Plataforma WK`, `data/WhatsApp Chat - Notas pessoais`), zips it in-memory with `zipSync` from `fflate`, writes to a temp dir via `fs.mkdtempSync(os.tmpdir(), ...)`, runs `runParser`, then asserts on the resulting `messages.csv` (parsed with a local minimal RFC-4180 reader `parseCsv` at `test/integration.test.ts:18-42`).
- The `data/` directory is **gitignored** (`data/` in `.gitignore`) — sample chats are real exports and must not be committed. Tests referencing `data/` only pass on a machine with those fixtures present.
- `test/linkify.test.ts:85-128` similarly builds an in-memory ZIP (`zipSync`) and asserts rendered HTML/MD/JSON outputs contain the expected anchors and that JSON text is left unchanged.

## Fixtures

- **`data/`** (gitignored): real WhatsApp `_chat.txt` exports used by `test/integration.test.ts`. Not committed; required locally for integration tests.
- **`test/fixtures/`**: listed in `.gitignore` (`test/fixtures/`) but currently unused by the suite — reserved for future binary/golden fixtures.
- In-memory fixtures dominate: network responses are synthesized by `startServer` or `globalThis.fetch` swaps; chat transcripts are built as strings and zipped with `fflate`'s `zipSync` (`test/linkify.test.ts:93`, `test/integration.test.ts:31`).

## Coverage of Title Fetching (the riskiest area)

`test/title.test.ts` is the most thorough suite and covers:
- Pure extraction: `extractTitle` `<title>` + `og:title` preference (`test/title.test.ts:42-49,197-202`).
- Per-platform URL builders + parsers: YouTube (`youTubeOembedUrl`/`parseYouTubeOembed`), Reddit (`redditJsonUrl`/`parseRedditJson`), LinkedIn (`deriveLinkedInTitle` offline), Medium (`fetchMediumTitle`), Stack Overflow (`stackExchangeApiUrl`/`parseStackOverflowJson`), X (`deriveXTitle`).
- Fallback behavior: timeout (`test/title.test.ts:60-68`), non-HTML content (`70-78`), oEmbed failure falling back to generic (`342-358`), LinkedIn redirect unwrapping to the real destination title (`366-386`).
- Concurrency/dedup + opt-out: `enrichTitles` maps URLs to titles and dedupes (`80-96`), `enabled:false` leaves `urlTitles = {}` (`98-104`), verbose logging toggle (`106-145`).
- Offline guarantee: LinkedIn and X never call `fetch` (`271-284, 324-340`).

## Common Patterns

**Async testing:** `async () => {...}` test functions; `await` the unit under test directly. No special setup/teardown framework — resource cleanup uses `try/finally` (`srv.close()`, restore `globalThis.fetch`, restore `console.error`).

**Error / fallback testing:** assert the *degraded* output rather than throwing — e.g. timeout returns a derived (host-based) title containing `127.0.0.1` (`test/title.test.ts:63-64`).

**XSS / safety testing:** linkify tests explicitly assert escaping — `linkifyHtml('<script>alert(1)</script>')` must contain `&lt;script&gt;` and no raw `<script>` (`test/linkify.test.ts:49-53`); `javascript:` schemes must not produce anchors (`43-47`); quotes in URLs must not break out of the `href` attribute (`55-59`).

**Run hygiene:** every test that opens a server or mutates a global restores it, so the suite is order-independent and parallel-safe by design.

---

*Testing analysis: 2026-08-23*
