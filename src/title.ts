import type { Message } from './parse/types';
import { URL_RE, deriveTitle } from './render/js/linkify.js';

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

/** Pull and sanitize the <title> from an HTML string. */
export function extractTitle(html: string): string | null {
  const m = html.match(TITLE_RE);
  if (!m) return null;
  return m[1]
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 300);
}

/**
 * Fetch the page title for a single URL. On any failure (network error,
 * non-OK status, non-HTML content-type, missing/empty title) returns the
 * offline-derived title so callers always get a usable label.
 */
export async function fetchTitle(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) return deriveTitle(url);
    const ct = res.headers.get('content-type') ?? '';
    if (ct && !/html/i.test(ct)) return deriveTitle(url);
    const html = await res.text();
    return extractTitle(html) ?? deriveTitle(url);
  } catch {
    return deriveTitle(url);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Enrich messages with a URL→title map. Unique http(s) URLs are fetched once
 * (bounded concurrency), then mapped back onto each message. When `enabled`
 * is false, every message gets `urlTitles = {}` and no network is touched.
 */
export async function enrichTitles(
  messages: Message[],
  opts: { enabled: boolean; concurrency?: number; timeoutMs?: number } = { enabled: true },
): Promise<Message[]> {
  const enabled = opts.enabled;
  if (!enabled) {
    for (const m of messages) m.urlTitles = {};
    return messages;
  }
  const urls = [
    ...new Set(messages.flatMap((m) => (m.text ?? '').match(URL_RE) ?? [])),
  ];
  const map: Record<string, string> = {};
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  let cursor = 0;
  async function worker() {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      map[url] = await fetchTitle(url, { timeoutMs: opts.timeoutMs });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length || 1) }, worker),
  );
  for (const m of messages) {
    if (!m.text) {
      m.urlTitles = {};
      continue;
    }
    const titles: Record<string, string> = {};
    for (const u of m.text.match(URL_RE) ?? []) {
      titles[u] = map[u] ?? deriveTitle(u);
    }
    m.urlTitles = titles;
  }
  return messages;
}
