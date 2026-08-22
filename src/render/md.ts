import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readCsv } from '../csv';
import { buildMediaMap } from '../media';
import type { MediaEntry } from '../media';
import type { Message } from '../parse/types';
import { dayOf, timeOf } from './json';
import { linkifyMarkdown } from './js/linkify.js';

const PT_BR_DATE = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

function fullPtBrDate(day: string): string {
  // day = yyyy-mm-dd (local ISO). Anchor at noon UTC to avoid TZ/DST drift.
  const d = new Date(day + 'T12:00:00Z');
  return PT_BR_DATE.format(d);
}

const MEDIA_ICON: Record<string, string> = {
  photo: '📷 photo',
  sticker: '📷 photo',
  video: '🎬 video',
  document: '📄 document',
  audio: '🎧 audio',
};

function escapeMd(s: string): string {
  // Markdown viewers can execute raw HTML; escape to keep content inert (OUT-05).
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function mediaLabel(m: Message, media: Map<string, MediaEntry>): string {
  const label = MEDIA_ICON[m.type] ?? `📎 ${m.type}`;
  const entry = media.get(m.media);
  if (entry) {
    // Resolved -> a real markdown link to the relative media path (MEDIA-02).
    return `[${label}: ${escapeMd(m.media)}](${escapeMd(entry.relPath)})`;
  }
  // Unresolved -> keep the bracket placeholder (no broken link).
  return `[${label}: ${escapeMd(m.media)}]`;
}

/**
 * Render the chat as a day-sectioned Markdown log (D-45/D-46/D-47).
 * - `## <pt-BR full date>` per day
 * - `**Sender** · HH:mm — text` per message
 * - media -> `[📷 photo: FILENAME]` link
 * - system/deleted/omitted -> italic `*text*` line
 */
export async function renderMarkdown(
  csvPath: string,
  outDir: string,
  _opts: { inline?: boolean } = {},
): Promise<string> {
  const messages = readCsv(csvPath);
  const media = buildMediaMap(outDir, messages);
  const groups = new Map<string, Message[]>();
  for (const m of messages) {
    const day = dayOf(m.timestamp_iso);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(m);
  }

  const sortedDays = [...groups.keys()].sort();

  const lines: string[] = [];
  for (const day of sortedDays) {
    lines.push(`## ${fullPtBrDate(day)}`);
    lines.push('');
    for (const m of groups.get(day)!) {
      if (m.type === 'system' || m.type === 'deleted' || m.type === 'omitted') {
        lines.push(`*${linkifyMarkdown(m.text)}*`);
      } else {
        const time = timeOf(m.timestamp_iso).slice(0, 5); // HH:mm
        const body = m.media ? mediaLabel(m, media) : linkifyMarkdown(m.text);
        lines.push(`**${escapeMd(m.author)}** · ${time} — ${body}`);
      }
    }
    lines.push('');
  }

  const outPath = path.join(outDir, 'messages.md');
  await fs.writeFile(outPath, lines.join('\n').replace(/\n+$/, '\n'), 'utf8');
  return outPath;
}
