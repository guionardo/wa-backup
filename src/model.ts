import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import pc from 'picocolors';
import { extractChatTxt, chatNameFromZip } from './extract';
import { parseMessages } from './parse/message';
import { writeCsv } from './csv';
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
export async function runParser(
  zipPath: string,
  opts: RunOptions = {},
): Promise<number> {
  const chat = await chatNameFromZip(zipPath);
  const out = opts.out ?? 'out';
  const dir = path.join(out, chat);
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

  await writeCsv(path.join(dir, 'messages.csv'), messages);

  if (opts.verbose) {
    verboseReport(
      detection ?? { dayFirst: Boolean(opts.dayFirst), is12h: false },
      warnings,
      messages.length,
    );
  }
  return messages.length;
}
