# Codebase Concerns

**Analysis Date:** 2026-08-23

This document records technical debt, bugs, security issues, and fragile areas
found while auditing a TypeScript/Node WhatsApp chat-export backup CLI. Files are
referenced in backticks with line numbers where a claim depends on a specific spot.

The tool's headline promise is *"open your WhatsApp history years later, fully
viewable, no account, no server."* Several findings below conflict with that
promise (offline guarantees, data fidelity, and the safety of opening an
untrusted backup in a browser).

---

## Security Considerations

### 1. `unwrapUrl` trusts LinkedIn redirect target as an `href` → stored XSS (HIGH)

`src/render/js/linkify.js:53-68` decodes the `url` query parameter of a
LinkedIn redirect wrapper and returns it verbatim as the "real" destination:

```js
const target = u.searchParams.get('url');
if (!target) return url;
return decodeURIComponent(target);
```

`URL_RE` (`src/render/js/linkify.js:5`) only ever matches `https?://…`, but
`unwrapUrl` **replaces** the matched URL with the decoded redirect target. A
chat message containing
`https://linkedin.com/redir/redirect?url=javascript:alert(document.cookie)`
produces, after unwrapping, `javascript:alert(document.cookie)`.

That value is then placed directly into an `href` in both renderers:

- Node HTML: `src/render/html.ts:129` / `:133` call `linkifyHtml`, which builds
  `` `<a href="${href}" …>` `` (`src/render/js/linkify.js:88`) where
  `href = escapeHtml(url)`. `escapeHtml` (`linkify.js:7-14`) escapes quotes but
  **not** the URL scheme, so `href="javascript:alert(…)"` survives.
- Browser viewer: `src/render/js/transcript.js:85` and `:104` assign
  `linkifyHtml(…)` to `t.innerHTML`, so the malicious anchor is live in the DOM.

Clicking the link executes script in the context of the opened HTML file. For a
backup tool whose whole value is "open untrusted chat history later," this is a
stored-XSS vector delivered through chat content.

**Fix:** After decoding in `unwrapUrl`, validate the scheme and host; reject
anything not `http(s)` and re-encode. e.g. only return the target if
`new URL(target)` succeeds and `protocol` is `http:`/`https:`. Also consider
enforcing `escapeHtml` to drop non-`http(s)` schemes defensively.

### 2. Markdown renderer can emit non-`http(s)` link targets (MEDIUM)

`linkifyMarkdown` (`src/render/js/linkify.js:96-113`) builds
`` `[${title}](${safeUrl})` ``. `safeUrl` only escapes `\` and `)`; a
`javascript:` scheme from the same `unwrapUrl` path passes through. Many Markdown
viewers (and any HTML-rendered Markdown) will turn this into a clickable,
executable link. Same root cause as #1.

### 3. Fetched page titles are trusted into HTML after only length/control-char cleaning (LOW, currently mitigated)

`extractTitle` (`src/title.ts:43-49`) runs `cleanTitle` (`src/title.ts:13-19`)
which strips control chars and truncates to 300 chars but does **not** HTML-escape.
The title is later escaped by `linkifyHtml` (`src/render/js/linkify.js:83`), so
the current pipeline is safe. **Risk:** this safety depends on every call site
passing the title through `escapeHtml`. Any future call site that interpolates
a fetched title directly would reintroduce XSS. Recommend centralizing title
escaping inside `extractTitle` or documenting the invariant loudly.

### 4. External favicon loads defeat the "standalone / offline" guarantee (MEDIUM, privacy)

The HTML viewer and the Node renderer both inject a favicon `<img>` per link:

- `src/render/js/linkify.js:86` → `<img class="favicon" src="${escapeHtml(fav)}" …>`
- `src/render/html.ts:127` passes `icon = (u) => faviconFor(u)`, and
  `faviconFor` (`src/render/js/linkify.js:116-122`) returns
  `https://<host>/favicon.ico`.

Every link in the backup thus triggers a network request to the linked site
when the HTML is opened — leaking the viewer's IP to third parties and breaking
offline viewing. There is no `<meta http-equiv="Content-Security-Policy">` to
block it, and no opt-out flag. For a tool marketed as self-contained, this is a
privacy/design conflict.

**Fix:** Make favicons opt-in (`--favicons`), default off, and/or inline a
neutral placeholder. Add a CSP `img-src 'self' data:` meta tag to the HTML.

### 5. `mediaPath` assigned to `img.src` without validation (LOW)

`src/render/js/transcript.js:91` sets `img.src = m.mediaPath` directly from the
JSON island. `mediaPath` is built by the renderer from on-disk filenames, so it
is not attacker-controlled today, but it is assigned without escaping/validation
and would break (or behave oddly) if a media filename ever contained characters
that need encoding in a URI.

---

## Performance Bottlenecks

### 6. Full HTTP response body buffered into memory during title fetch (HIGH vs. project's memory-safety mandate)

The project explicitly mandates streaming/memory-safe parsing (PARSE-02). Title
fetching violates this:

- `fetchHtmlTitle` (`src/title.ts:161-167`) and `fetchMediumTitle`
  (`src/title.ts:120-129`) call `await res.text()` with **no** size cap,
  `Content-Length` check, or truncation. A linked page that returns a 200 MB HTML
  body (or an infinite/streaming response) is fully buffered in RAM.
- `youTubeOembedUrl`/`parseYouTubeOembed`, `redditJsonUrl`/`parseRedditJson`,
  `stackExchangeApiUrl`/`parseStackOverflowJson` all `await res.json()` — again
  unbounded.

A single oversized or malicious page can OOM the process, which is especially
bad because the CLI's default is to fetch titles (see #8).

**Fix:** Cap `Content-Length` (e.g. reject >1–2 MB), stream-truncate the body,
and/or abort on size. At minimum, check `res.headers.get('content-length')`
before reading.

### 7. `reconcileMedia` extracts all media with unbounded concurrency (MEDIUM)

`src/media.ts:197-211` pushes one `extractEntry` promise per matched ref and
`await Promise.all(writes)`. `extractEntry` (`src/media.ts:123-151`) opens a file
handle + read stream per call. For an export with hundreds of media files this
opens that many simultaneous handles and read streams, risking `EMFILE`/resource
exhaustion. Bounded worker pool (like `enrichTitles` already uses, concurrency 8)
would be consistent and safer.

### 8. Title fetching is the default and re-fetches every run (MEDIUM)

`src/model.ts:113-121` calls `enrichTitles(merged, { enabled: !opts.noFetchTitles, … })`
with **no caching of previously fetched titles**. `merged` is read back from the
CSV (which *does* store `urlTitles`), but `enrichTitles`
(`src/title.ts:260-316`) ignores any existing `urlTitles` in the messages and
re-fetches every unique URL each run (8-way parallel, 5 s timeout each,
`src/title.ts:185`/`:282`). Re-running the tool re-hits the network for the same
links every time — slow, and a hard failure mode when offline or behind a
firewall (the tool is positioned as an offline archive). The persisted CSV is
effectively not reused for titles.

**Fix:** Skip re-fetch when `m.urlTitles[u]` already exists; only fetch missing
keys. Make `--no-fetch-titles` the safe default, or at least cache.

---

## Known Bugs

### 9. Duplicate media filenames are silently conflated (HIGH, data loss)

`normalizeMediaName` (`src/media.ts:24-26`) lowercases, drops a trailing
`(N)` duplicate marker, and collapses whitespace/`-`/`_`:

```ts
return s.toLowerCase().replace(/\(\d+\)/g, '').replace(/[\s_-]+/g, '');
```

Two genuinely distinct WhatsApp files `photo.jpg` and `photo (1).jpg` both
normalize to `photojpg`. In `readCentralDirectory`'s index
(`src/media.ts:186-193`) the later entry **overwrites** the earlier
(`index.set(normalizeMediaName(base), e)`), so one of the two files is lost and
the surviving file is written for both refs. The same collision happens for the
very common `IMG-2020-WA0001.jpg` vs `IMG_2020_WA0001.jpg` style variants.

Impact: media silently missing or wrong in the backup. The `(1)` marker is
exactly how WhatsApp disambiguates duplicate exports.

**Fix:** Do not strip `(N)`; keep it as a distinguisher, or key the index by the
*original* filename and match refs case/separator-insensitively only when no
exact match exists.

### 10. `unwrapUrl` scheme confusion also enables `data:` URIs in href (see #1)

Already covered as the primary XSS, but worth noting it is a *bug* in trust
modeling, not just a hardening gap: the function assumes a LinkedIn redirect
target is a safe outbound link.

### 11. Lab example scripts contain copy-paste bugs and unused deps (LOW, but misleading)

The `lab/` folder holds throwaway prototypes that diverge from `src/title.ts`
and are **not** wired into the build:

- `lab/title_stackoverflow.js:7` builds
  `` `https://stackexchange.com{questionId}?site=stackoverflow` `` — literal
  `{questionId}` braces, never interpolated. Would 404.
- `lab/title_youtube.js:4` builds
  `` `https://youtube.com{encodeURIComponent(videoUrl)}` `` — same literal-brace
  bug.
- `lab/title_medium.js:1-2` `require('axios')` / `require('cheerio')` — **neither
  is a dependency** (`package.json` lists only `commander`, `date-fns`,
  `fflate`, `picocolors`). These scripts cannot run as-is and misrepresent the
  real, dependency-free implementation in `src/title.ts`.
- `lab/title_x.js` `parseTwitterUrl('https://x.com')` returns
  `{ username: 'NASA', type: 'tweet', id: '…' }` for a bare domain — wrong, and
  does not match `deriveXTitle` in `src/title.ts:146-158`.

Risk: a maintainer copying from `lab/` reintroduces these bugs. Recommend
deleting `lab/` or moving it clearly out of the shipped tree.

---

## Tech Debt

### 12. `escapeHtml` is duplicated in three places (MEDIUM, drift risk)

- `src/render/js/linkify.js:7-14`
- `src/render/html.ts:11-18`
- `escapeMd` (different — only `& < >`) at `src/render/md.ts:31-37` and
  `src/render/js/linkify.js:16-21`

The two full `escapeHtml` copies must be kept byte-identical. A fix applied to
one (e.g. adding quote handling) and not the other reopens XSS. Extract a single
shared escaper.

### 13. Self-author / "most frequent author" logic duplicated (LOW)

- `src/render/html.ts:82-97` `pickSelfAuthor`
- `src/render/js/transcript.js:178-193` `mostFrequent`

Identical algorithm, two implementations. Keep one.

### 14. Accent-color / initials duplicated across Node and browser (LOW)

`getAccentColor`/`initials` in `src/render/colors.ts` + `src/render/html.ts` vs
`accentColor`/`initials` in `src/render/js/transcript.js:16-34`. The browser
variant uses `crypto.subtle` (async) while the Node variant presumably uses a
hash; divergence in hue assignment between the static HTML and the viewer is
possible.

### 15. `chatNameFromZip` and `chatInfoFromZip` are near-identical (LOW)

`src/extract.ts:151-170` and `src/extract.ts:177-199` repeat the same
"stream ZIP, collect entry names, resolve name/slug" logic. Consolidate.

### 16. `enrichTitles` re-implements URL extraction that `linkify` already owns (LOW)

`src/title.ts:274-280` re-runs `URL_RE` and `unwrapUrl` to build the unique-URL
list, duplicating logic in `src/render/js/linkify.js`. If `URL_RE` or
`unwrapUrl` semantics change, the two can drift (e.g. a title fetched for a URL
that the renderer later splits differently).

---

## Fragile Areas

### 17. Locale / date-order detection is a heuristic with a hard pt-BR bias (HIGH for non-BR exports)

`detectFormat` (`src/parse/timestamp.ts:92-131`) decides day/month order by a
majority vote over the first ~50 ambiguous timestamped lines, **defaulting to
day-first on a tie** (the pt-BR assumption, "A2"). Problems on real-world
exports:

- A US (`mm/dd`) export whose first 50 ambiguous lines happen to balance or skew
  toward day-first will be misparsed → wrong dates, silent.
- The vote only counts lines where *both* parts are ≤ 12; an export that starts
  with unambiguous dates (e.g. `13/05`) contributes nothing, so detection leans
  on a small sample.
- `dayPill`/`renderDayPill` and `src/render/md.ts:10-21` hard-code
  `Intl.DateTimeFormat('pt-BR', …)`. Non-Brazilian exports get Portuguese day
  labels regardless of detected locale.
- `--day-first` / `--month-first` opt-outs exist (`src/index.ts:18-19`) but are
  not auto-applied; a wrong automatic guess has no auto-correction.

**Fix:** Persist the detected format alongside the CSV (it already stores
per-message ISO, so re-renders can't fix a bad parse). Surface detection
confidence in the verbose report and fail loudly / prompt when the sample is
too small.

### 18. `TS_RE` is rigid about timestamp placement and separators (MEDIUM)

`src/parse/timestamp.ts:32-33`:

```ts
/^\[?(\d{1,2})[./-](\d{1,2})[./-](\d{2,4}),?\s(\d{1,2}):(\d{2})(?::(\d{2}))?\s?(am|pm|AM|PM)?\]?/
```

- Requires the timestamp at the very start of the line after invisible-stripping.
  Any export variant with a leading space, a different bracketing, or
  locale-specific separators (e.g. `。` or spaces around `/`) will not match and
  the line becomes a continuation, **silently dropping the message's timestamp**
  (it merges into the previous message's text).
- Anchored `^` means a timestamp appearing after other prefix text is missed.
- Only `am|pm` is recognized for 12h; localized "a.m."/"p.m." or other languages
  are not.
- Two-digit years resolved by `resolveYear`
  (`src/parse/timestamp.ts:70-74`): `yy <= cur-2000+1 ? 2000+yy : 1900+yy`. With
  `cur=2026`, `yy=28` → `1928`, and `yy=00` → `2000`. A genuinely old export
  (pre-2009) is clipped by `SANITY_MIN_YEAR = 2009`
  (`src/parse/timestamp.ts:66`) and dropped as a continuation.

### 19. `tryParseTimestamp` drops out-of-range/invalid dates as continuations (MEDIUM)

`src/parse/timestamp.ts:167-175` returns `null` for `year < 2009`,
`year > cur+1`, or non-existent calendar dates (`31/02`). Those lines are then
treated as continuations of the prior message (`src/parse/message.ts:112-117`),
so the text gets silently appended to the wrong message and the real message row
is lost. For a backup tool, silent data loss on edge-case dates is high-impact.
A wrong system clock alone can swallow an entire day.

### 20. Parser state machine buffers the sample window before emitting (LOW)

`src/parse/message.ts:164-184` holds up to `SAMPLE_LINES = 200`
(`src/parse/message.ts:65`) lines in `buffer` until detection resolves, then
re-processes. This is a small bounded buffer (fine for memory) but means the
first 200 lines are parsed twice and any continuation logic must stay consistent
across the two passes — a subtle place for bugs if the state machine evolves.

---

## Scaling Limits

### 21. Manual ZIP central-directory parse is 32-bit only (ZIP64 unsupported) (HIGH for large exports)

`readCentralDirectory` (`src/media.ts:76-114`) reads offsets/sizes/counts with
`readUInt32LE` (`src/media.ts:91-105`) and `readUInt16LE`
(`src/media.ts:92-93`). It does **not** consult the ZIP64 extra field or the
ZIP64 EOCD locator. Consequences:

- Exports where the central directory offset, any entry compressed size, or the
  entry count exceeds 32-bit / 65535 limits will be misread → wrong media
  extracted or `ENOENT`/truncation.
- Long-lived chats with many videos routinely exceed 4 GB; this is a real ceiling
  for the tool's stated use case.

**Fix:** Either detect ZIP64 and bail with a clear error, or use a ZIP library
that supports it for the central-directory pass.

### 22. `extractEntry` assumes `compressedSize` from central dir is authoritative (MEDIUM)

`src/media.ts:135-138` opens `createReadStream(zipPath, { start, end })` using
`entry.compressedSize` from the central directory. This is usually correct, but
if an entry was written with a *streaming data descriptor* where some
implementations store `0` in the central `csize`, the read window is empty/wrong.
The code's own comment (`src/media.ts:67-75`) acknowledges fflate mis-handles
this, which is why the manual pass exists — but nothing validates that the
central `csize` is non-zero before slicing the stream. A zero `compressedSize`
yields `end < start` and a broken read.

### 23. `INLINE_MAX_BYTES = 8 MB` cap is per-file but total HTML can balloon (LOW)

`src/media.ts:13` caps each inlined file, but `--inline` embeds *every*
inlineable media as a `data:` URI directly in `messages.html`
(`src/render/html.ts:64-79`). A chat with 200 photos inlines ~1.6 GB into one
HTML file — opens slowly or not at all in browsers. The "single self-contained
file" promise collides with practical browser limits.

---

## Dependencies at Risk

### 24. `fflate` streaming is worked around, not relied upon, for media (LOW)

`src/extract.ts:16-62` uses fflate's `Unzip` for the chat text (correct,
streaming), but `src/media.ts` bypasses fflate entirely with a hand-rolled
central-directory reader + raw `zlib.createInflateRaw`. This split means media
extraction depends on fragile manual parsing (see #21/#22) while fflate — the
chosen "memory-safe" dependency — is only used for the text path. The stated
rationale (fflate mis-handles data-descriptor members) is sound but leaves the
most failure-prone code as custom parsing.

### 25. `date-fns` used only for `format` (LOW)

`src/parse/timestamp.ts:1` imports `format` from `date-fns` solely to render the
ISO string (`src/parse/timestamp.ts:178`). The whole `date-fns` dependency could
be replaced with a tiny hand-rolled formatter, reducing the dependency surface —
or expanded to actually localize output (currently pt-BR is hard-coded, #17).

---

## Missing Critical Features

### 26. No re-render safety / format persistence (MEDIUM)

Renderers read `messages.csv` and re-derive everything, but the *detected date
format* and *locale* are not stored. If detection guessed wrong (#17), every
future re-render reproduces the wrong dates with no way to correct without
re-parsing the ZIP. Persisting `Detection` (dayFirst/is12h) next to the CSV would
make corrections sticky.

### 27. No validation that the opened HTML is safe to view (LOW)

Beyond the CSP gap (#4), there is no integrity/sandboxing. The HTML is a
`file://` document with embedded third-party `<img>` favicons and, via #1,
potentially `javascript:` links. A "view your backup" tool should at minimum ship
with a strict CSP meta tag.

---

## Test Coverage Gaps

### 28. `unwrapUrl` scheme-validation is untested (HIGH)

`test/linkify.test.ts` (183 lines) exercises `linkifyHtml`/`linkifyMarkdown`/
`deriveTitle`/`faviconFor` but there is **no test** asserting that a LinkedIn
redirect wrapping `javascript:`/`data:` is rejected. The XSS in #1 would pass
today's suite. Add tests proving non-`http(s)` unwrapped targets are dropped.

### 29. Media duplicate-collision untested (HIGH)

`test/media.test.ts` (190 lines) likely tests happy-path reconciliation but not
the `photo.jpg` vs `photo (1).jpg` collision from #9. Add a case with two
distinct files that normalize to the same key and assert both survive distinctly.

### 30. Title fetch size/abort behavior untested (MEDIUM)

`test/title.test.ts` (386 lines) is the largest suite and covers platform
dispatch, but there is no test for: (a) a response larger than a size cap,
(b) a non-HTML `content-type` being rejected (covered by `ct` check but worth an
explicit case), or (c) `res.text()` memory growth. Given #6, add a streaming/size
guard test.

### 31. Locale detection on non-pt-BR / ambiguous samples untested (MEDIUM)

No test asserts behavior when the first 50 ambiguous lines tie, or when an
export is `mm/dd` but the sample skews day-first. Given #17/#18, add
`detectFormat` edge-case tests (including the tie→day-first default and a
US-style export that should be month-first).

### 32. ZIP64 / >65535 entries untested (MEDIUM)

`test/media.test.ts` uses small fixtures; the 32-bit ceiling (#21) is unexercised.
Add a generated large/sparse ZIP or a unit test on `readCentralDirectory` with a
ZIP64-flagged entry asserting a clear error rather than silent misread.

---

*Concerns audit: 2026-08-23*
