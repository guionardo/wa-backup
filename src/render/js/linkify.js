// linkify.js — turn URLs in message text into safe, offline-derived links.
// Shared by the Node renderers (html.ts, md.ts) and the browser viewer
// (transcript.js). No network access: titles are derived from the URL only.

const URL_RE = /(https?:\/\/[^\s<>"'`]+)/gi;

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeMd(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Drop sentence punctuation that is almost never part of the URL. Deliberately
// excludes `)`/`]`/`}` so URLs like wikipedia disambiguation links stay intact.
function trimTrailingPunct(url) {
  return url.replace(/[.,;:!?]+$/, '');
}

/**
 * Offline page "title": host (www. stripped) + non-root path. Falls back to the
 * raw URL if it cannot be parsed.
 */
export function deriveTitle(url) {
  try {
    const u = new URL(url);
    let host = u.hostname;
    if (host.startsWith('www.')) host = host.slice(4);
    const path = u.pathname.replace(/\/+$/, '');
    if (!path || path === '/') return host;
    return host + path;
  } catch (e) {
    return url;
  }
}

/** Escape text and wrap http(s) URLs in safe <a> anchors. */
export function linkifyHtml(text) {
  if (!text) return '';
  const re = new RegExp(URL_RE.source, 'gi');
  let result = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    result += escapeHtml(text.slice(last, m.index));
    const url = trimTrailingPunct(m[0]);
    const href = escapeHtml(url);
    const title = escapeHtml(deriveTitle(url));
    result += `<a href="${href}" target="_blank" rel="noopener noreferrer">${title}</a>`;
    last = m.index + m[0].length;
  }
  result += escapeHtml(text.slice(last));
  return result;
}

/** Escape text and wrap http(s) URLs in Markdown `[title](url)` links. */
export function linkifyMarkdown(text) {
  if (!text) return '';
  const re = new RegExp(URL_RE.source, 'gi');
  let result = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    result += escapeMd(text.slice(last, m.index));
    const url = trimTrailingPunct(m[0]);
    const title = deriveTitle(url).replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
    const safeUrl = url.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
    result += `[${title}](${safeUrl})`;
    last = m.index + m[0].length;
  }
  result += escapeMd(text.slice(last));
  return result;
}
