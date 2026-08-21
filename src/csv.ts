import { createWriteStream } from 'node:fs';
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
 * Write the CSV source-of-truth (D-13/D-14/D-19). Streaming write; Node's utf8
 * encoding adds NO BOM.
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
