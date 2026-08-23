# External Integrations

**Analysis Date:** 2026-08-23

All external interaction in this project is **read-only, outgoing, network-or-offline title enrichment** plus **local archive parsing**. There are no inbound webhooks, no auth providers, no databases, no write-back APIs, and no secrets. The single integration surface that touches the network is `src/title.ts`.

## APIs & External Services

### Webpage Title Enrichment (`src/title.ts`)

When the CLI runs WITHOUT `--no-fetch-titles`, it enriches every unique `http(s)` URL found in message text with a human-readable page title. Dispatch is per-platform via `platformOf(url)` (`src/title.ts:61`). Each special method falls back to a generic HTML fetch, which falls back to an offline-derived title (`fetchTitle`, `src/title.ts:181`).

| Platform | Method | Endpoint / Approach | Requires Network | Code |
|----------|--------|---------------------|------------------|------|
| **YouTube** | oEmbed JSON | `https://www.youtube.com/oembed?url=<encoded>&format=json` → `parseYouTubeOembed` | Yes | `youTubeOembedUrl` `src/title.ts:78`; fetch at `src/title.ts:197` |
| **Reddit** | Append `.json` to the listing URL | `url.split('?')[0].replace(/\/$/, '') + '.json'` → `parseRedditJson` (reads `data.children[0].data.title`) | Yes | `redditJsonUrl` `src/title.ts:89`; fetch at `src/title.ts:209` (UA `wa-backup/1.0 (+title-extractor)`) |
| **Stack Overflow** | Stack Exchange API v2.3 | `https://api.stackexchange.com/2.3/questions/<id>?site=stackoverflow` (id from `/\/questions\/(\d+)/`) → `parseStackOverflowJson` (reads `items[0].title`) | Yes | `stackExchangeApiUrl` `src/title.ts:133`; fetch at `src/title.ts:235` |
| **Medium** | HTML GET with browser UA | `fetch(url, { headers: { 'User-Agent': UA } })` then `extractTitle` (prefers `og:title`/`twitter:title`, falls back to `<title>`) | Yes | `fetchMediumTitle` `src/title.ts:120` |
| **LinkedIn** | URL slug derivation | No network — regex out `/in|pub|company/<slug>` or `/jobs/view/<slug>`, spaces from `_`/`-` | **No (offline)** | `deriveLinkedInTitle` `src/title.ts:104` |
| **X / Twitter** | URL slug derivation | No network — `<user> on X` from first path segment | **No (offline)** | `deriveXTitle` `src/title.ts:146` |
| **Generic (default + fallback)** | HTML GET with browser UA | `fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA } })`, then `extractTitle` (`og:title` → `twitter:title` → `<title>`) | Yes | `fetchHtmlTitle` `src/title.ts:161` |

**Shared details:**
- Browser-like User-Agent reduces bot-blocking: `UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'` (`src/title.ts:7`).
- `extractTitle` (`src/title.ts:43`) parses `<meta property|name="og:title|twitter:title" content="…">` (either attribute order via `metaContent`, `src/title.ts:23`) then `<title>` (`TITLE_RE`, `src/title.ts:11`); `cleanTitle` truncates to 300 chars and strips control chars (`src/title.ts:13`).
- `fetchTitle` is guarded by an `AbortController` + `setTimeout` (default `timeoutMs = 5000`) so a slow host never hangs the run (`src/title.ts:185-188`).
- `enrichTitles` (`src/title.ts:260`) collects unique URLs, fetches them **in parallel** with a bounded worker pool (`concurrency` default 8), and maps results back onto each message's `urlTitles` (`Message.urlTitles`, `src/parse/types.ts:22`). When `enabled` is false, every message gets `urlTitles = {}` and no network is touched.

## Data Storage

**Databases:** None. No SQL/NoSQL, no ORM.

**File Storage (local filesystem only):**
- Input: a WhatsApp "Export chat" **ZIP** read from disk (`createReadStream` in `src/extract.ts:52` and `src/media.ts`).
- Output: a folder `output/<slug>/` containing `messages.csv` (source-of-truth), `messages.json`, `messages.md`, `messages.html`, and `media/` (extracted attachments). No cloud storage. With `--inline`, media is base64-embedded into a single `messages.html` (`INLINE_MAX_BYTES = 8*1024*1024` cap, videos excluded — `src/media.ts:13`).

**Caching:** None. URLs are fetched once per run and held only in an in-memory `map` (`src/title.ts:281`).

## Archive / ZIP Handling (fflate)

- **Library:** `fflate` 0.8.3. Imported as `Unzip` + `AsyncUnzipInflate` (`src/extract.ts:1`).
- **Streaming transcript extraction** (`src/extract.ts:extractChatTxt`): files are registered but only the `_chat.txt` entry calls `file.start()`; AppleDouble (`._*`, `__MACOSX`) and all media entries are skipped (never inflated) so large videos are never buffered. The inflated `_chat.txt` stream feeds a `PassThrough` → `node:readline` → an async-iterable line queue (`readLines`, `src/extract.ts:73`) — constant memory.
- **Metadata-only scans** (`chatNameFromZip`, `chatInfoFromZip`, `src/extract.ts:151,177`): register `Unzip` but never call `file.start()`, so entry headers are read without inflating any bytes.
- **Media extraction** (`src/media.ts`): a **separate hand-rolled ZIP central-directory parser** (`readCentralDirectory`, `src/media.ts:76`) reads the EOCD + central records to get each entry's authoritative `localOffset`/`compressedSize` (fflate's streaming inflate mis-handles data-descriptor members on real exports). Each media member is streamed entry-by-entry via `node:zlib` `createInflateRaw()` (method 8) or copied (method 0) — again, no whole-archive buffering.

## Browser View-Time Resources (passive, not CLI network calls)

The generated `messages.html` viewer (`src/render/html.ts` + `src/render/js/transcript.js`) embeds, per link, an `<img class="favicon" src="/favicon.ico">` resolved from the URL host via `faviconFor` (`src/render/js/linkify.js:116`). This loads the target site's favicon **in the viewer's browser at open time** — it is not fetched by the Node CLI. The CLI itself performs no favicon requests.

## Authentication & Identity

**Auth Provider:** None. No login, OAuth, API keys, or tokens anywhere. `src/title.ts` sets only a plain `User-Agent` header (no credentials); LinkedIn/X titles are derived offline without any API access.

## Monitoring & Observability

**Error Tracking:** None (no Sentry/Datadog/telemetry).

**Logs:** `console.error`/`console.log` only, styled with `picocolors`. Verbose mode prints detected format/locale and per-URL title resolution (`src/title.ts:294`).

## CI/CD & Deployment

**Hosting:** Not hosted; distributed as an npm CLI (`bin.wa-backup → dist/index.js`). No Dockerfile, no `.github/` workflows detected.

**CI Pipeline:** None detected in the repo.

## Environment Configuration

**Required env vars:** None.

**Secrets location:** None — the project requires and stores no secrets (no `.env`, `.npmrc`, credential files present).

## Webhooks & Callbacks

**Incoming:** None.

**Outgoing:** None, except the outbound `fetch()` calls enumerated above (YouTube oEmbed, Reddit `.json`, Stack Exchange API, Medium HTML, generic HTML). All are read-only GETs with no callbacks.

---

*Integration audit: 2026-08-23*
