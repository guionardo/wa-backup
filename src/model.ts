import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import pc from 'picocolors';
import { extractChatTxt, chatInfoFromZip } from './extract';
import { parseMessages } from './parse/message';
import { mergeCsv } from './csv';
import { renderJson } from './render/json';
import { renderMarkdown } from './render/md';
import { renderHtml } from './render/html';
import type { Detection } from './parse/timestamp';
import type { Message } from './parse/types';

export interface RunOptions {
  out?: string;
  dayFirst?: boolean;
  monthFirst?: boolean;
  verbose?: boolean;
}

/** D-07 — transparency report for the detected file format. */
export function verboseReport(
  detection: Detection,
  warnings: string[],
  count: number,
): void {
  const order = detection.dayFirst ? 'DAY/MM (dd/mm)' : 'MM/DAY (mm/dd)';
  // eslint-disable-next-line no-console
  console.error(
    pc.dim(`[wa-backup] format detection:`) +
      `\n  order : ${pc.cyan(order)}${detection.overridden ? pc.yellow(' (CLI override)') : ''}` +
      `\n  clock : ${pc.cyan(detection.is12h ? '12h (AM/PM)' : '24h')}` +
      (detection.example ? `\n  sample: ${pc.dim(detection.example)}` : ''),
  );
  if (warnings.length) {
    // eslint-disable-next-line no-console
    console.error(
      pc.yellow(`  warnings (${warnings.length}):`) +
        '\n    ' +
        warnings.slice(0, 10).join('\n    ') +
        (warnings.length > 10 ? `\n    … and ${warnings.length - 10} more` : ''),
    );
  }
  // eslint-disable-next-line no-console
  console.error(pc.dim(`  parsed: ${count} messages`));
}

/**
 * Orchestrate the full vertical path:
 *   extractChatTxt -> detectFormat -> parseMessages -> writeCsv
 * writes `${out}/<chat>/messages.csv` and returns the message count.
 */
export interface RenderResult {
  json?: string;
  md?: string;
  html?: string;
}

/**
 * Render the three synchronized outputs (JSON / Markdown / HTML) from the
 * messages.csv source-of-truth in `dir` (D-20/D-21/D-22). Renderers re-read
 * the CSV from disk so old backups can be re-rendered without the original ZIP.
 */
export async function renderOutputs(
  dir: string,
  chatName: string,
): Promise<RenderResult> {
  const csvPath = path.join(dir, 'messages.csv');
  if (!existsSync(csvPath)) return {};
  const result: RenderResult = {};
  result.json = await renderJson(csvPath, dir, chatName);
  result.md = await renderMarkdown(csvPath, dir);
  result.html = await renderHtml(csvPath, dir, chatName);
  return result;
}

export async function runParser(
  zipPath: string,
  opts: RunOptions = {},
): Promise<number> {
  const { slug, name } = await chatInfoFromZip(zipPath);
  const out = opts.out ?? 'output';
  const dir = path.join(out, slug);
  await fs.mkdir(dir, { recursive: true });

  const lines = await extractChatTxt(zipPath);
  const warnings: string[] = [];
  let detection: Detection | undefined;
  const messages: Message[] = [];
  for await (const m of parseMessages(lines, {
    dayFirst: opts.dayFirst,
    monthFirst: opts.monthFirst,
    warnings,
    onDetection: (d) => {
      detection = d;
    },
  })) {
    messages.push(m);
  }

  // Incremental merge into the CSV source-of-truth (D-13/D-16/D-17):
  // re-runs dedupe against existing rows and keep the file sorted ascending.
  const added = await mergeCsv(path.join(dir, 'messages.csv'), messages);

  // Single run ALWAYS emits all four formats (D-22). The render pipeline reads
  // the freshly merged CSV back from disk.
  await renderOutputs(dir, name);

  if (opts.verbose) {
    verboseReport(
      detection ?? { dayFirst: Boolean(opts.dayFirst), is12h: false },
      warnings,
      messages.length,
    );
  }
  return added;
}
