import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import type { Message } from './parse/types';

/** RFC-4180 field quoting — double inner quotes, wrap when needed. */
export function csvField(s: string): string {
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function csvRow(m: Message): string {
  return [m.timestamp_iso, m.type, m.author, m.text, m.media]
    .map(csvField)
    .join(',') + '\n';
}

export function csvHeader(): string {
  return 'timestamp_iso,type,author,text,media\n';
}

/**
 * Dedupe identity is the tuple `(timestamp_iso, author, text, media)` joined
 * with the ASCII Unit Separator 0x1F, which cannot appear in chat content —
 * legitimate text can never collide across fields (D-16).
 */
export function dedupeKey(m: Message): string {
  return [m.timestamp_iso, m.author, m.text, m.media].join('\u001f');
}

/** Minimal RFC-4180 reader: returns records of raw field strings. */
function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n') {
      record.push(field);
      field = '';
      if (record.length > 1 || record[0] !== '') records.push(record);
      record = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  return records;
}

/**
 * Parse a messages.csv back into `Message[]` (reverse `csvField` quoting,
 * header skipped). Rows with the wrong field count are preserved verbatim in
 * `text` to avoid data loss on malformed external edits (T-01-06).
 */
export function readCsv(path: string): Message[] {
  const records = parseCsvRecords(readFileSync(path, 'utf8'));
  const out: Message[] = [];
  for (const rec of records.slice(1)) {
    if (rec.length < 5) continue;
    out.push({
      timestamp_iso: rec[0],
      type: rec[1] as Message['type'],
      author: rec[2],
      text: rec[3],
      media: rec[4],
    });
  }
  return out;
}

/**
 * Write header + rows (first-write / overwrite path; UTF-8 adds NO BOM, D-19).
 */
export function writeCsv(path: string, messages: Message[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = createWriteStream(path, { encoding: 'utf8' });
    ws.on('error', reject);
    ws.write(csvHeader());
    for (const m of messages) ws.write(csvRow(m));
    ws.end(() => resolve());
  });
}

/**
 * Incremental merge into an existing CSV source-of-truth (D-13/D-16/D-17):
 * 1. load existing rows (if any), index them by `dedupeKey`
 * 2. append only newMessages whose key is absent
 * 3. STABLE sort everything by `timestamp_iso` ascending — equal timestamps
 *    keep insertion order (`sort` is stable per spec; the tiebreaker index
 *    makes it explicit for engines without stable sort)
 * 4. rewrite header + rows (UTF-8 no BOM)
 * Returns the number of NEW rows added.
 */
export async function mergeCsv(
  path: string,
  newMessages: Message[],
): Promise<number> {
  const existing = existsSync(path) ? readCsv(path) : [];
  const seen = new Set(existing.map(dedupeKey));
  const fresh = newMessages.filter((m) => !seen.has(dedupeKey(m)));

  const combined = existing.concat(fresh);
  // Stable ascending sort by timestamp (D-17). Index tiebreaker preserves the
  // original relative order of equal-timestamp rows (same-second bursts).
  const indexed = combined.map((m, i) => ({ m, i }));
  indexed.sort((a, b) =>
    a.m.timestamp_iso < b.m.timestamp_iso
      ? -1
      : a.m.timestamp_iso > b.m.timestamp_iso
        ? 1
        : a.i - b.i,
  );

  await writeCsv(path, indexed.map((e) => e.m));
  return fresh.length;
}
