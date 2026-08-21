import { format } from 'date-fns';

/**
 * Invisible/zero-width characters that WhatsApp embeds before `[` in real
 * pt-BR exports (U+200E before `[`). Stripping a LEADING run of these before
 * timestamp detection prevents missing messages (D-12). We never strip
 * invisibles *inside* author/text — they carry meaning (bidi phone wrappers).
 */
const INVISIBLE_CHARS =
  '\\uFEFF\\u200E\\u200F\\u200B\\u200C\\u200D\\u2066\\u2067\\u2068\\u2069';

const INVISIBLE_RE = new RegExp(`^[${INVISIBLE_CHARS}]+`, 'u');
const INVISIBLE_TRIM_RE = new RegExp(`^[${INVISIBLE_CHARS}]+|[${INVISIBLE_CHARS}]+$`, 'gu');

export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE_RE, '');
}

/** Strip leading AND trailing invisible runs (used on message bodies). */
export function trimInvisible(s: string): string {
  return s.replace(INVISIBLE_TRIM_RE, '');
}

/**
 * Timestamp regex — per-line auto-detection of iOS `[..]` and Android `..`
 * styles, `/ . -` separators, optional seconds, optional brackets, optional
 * AM/PM (D-03). Anchored `^` + fixed alternation => linear time (no ReDoS,
 * T-01-04).
 *
 * Captures: 1=day 2=month 3=year 4=hour 5=min 6=sec? 7=ampm?
 */
export const TS_RE =
  /^\[?(\d{1,2})[./-](\d{1,2})[./-](\d{2,4}),?\s(\d{1,2}):(\d{2})(?::(\d{2}))?\s?(am|pm|AM|PM)?\]?/;

export interface ParsedTimestamp {
  day: number;
  month: number;
  year: number;
  hour: number;
  min: number;
  sec: number;
  iso: string;
}

export interface TimestampOpts {
  dayFirst?: boolean;
  monthFirst?: boolean;
}

/**
 * Parse a (already-invisible-stripped) line prefix into a normalized timestamp.
 * - 2-digit year sliding window (D-05)
 * - ambiguous day/month defaults to DAY-FIRST (pt-BR); `--month-first` swaps (D-01)
 * - sanity window (D-08) + invalid date (D-04) => return null => caller treats as continuation
 * - local Date + date-fns `format` => no timezone shift (D-06, never `toISOString()`)
 */
export function parseTimestamp(
  line: string,
  opts: TimestampOpts = {},
): ParsedTimestamp | null {
  const m = TS_RE.exec(line);
  if (!m) return null;

  let day = parseInt(m[1], 10);
  let month = parseInt(m[2], 10);
  const yearRaw = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const min = parseInt(m[5], 10);
  const sec = m[6] ? parseInt(m[6], 10) : 0;

  // 2-digit year (D-05)
  let year = yearRaw;
  if (yearRaw < 100) {
    const cur = new Date().getFullYear();
    year = yearRaw <= cur - 2000 + 1 ? 2000 + yearRaw : 1900 + yearRaw;
  }

  // Day/month disambiguation (D-01). Tracer defaults to day-first (pt-BR).
  const ambiguous = day <= 12 && month <= 12;
  if (ambiguous && opts.monthFirst && !opts.dayFirst) {
    [day, month] = [month, day];
  }

  // Sanity window (D-08) — out-of-range => continuation
  const curYear = new Date().getFullYear();
  if (year < 2009 || year > curYear + 1) return null;

  const d = new Date(year, month - 1, day, hour, min, sec);
  if (isNaN(d.getTime())) return null; // invalid date e.g. 31/02 (D-04)

  const iso = format(d, "yyyy-MM-dd'T'HH:mm:ss");
  return { day, month, year, hour, min, sec, iso };
}
