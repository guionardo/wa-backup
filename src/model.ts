import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { extractChatTxt, chatNameFromZip } from './extract';
import { parseMessages } from './parse/message';
import { writeCsv } from './csv';
import type { Message } from './parse/types';

export interface RunOptions {
  out?: string;
  dayFirst?: boolean;
  monthFirst?: boolean;
  verbose?: boolean;
}

/**
 * Orchestrate the full vertical path:
 *   extractChatTxt -> parseMessages -> writeCsv
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
  const messages: Message[] = [];
  for await (const m of parseMessages(lines, opts)) {
    messages.push(m);
  }

  await writeCsv(path.join(dir, 'messages.csv'), messages);

  if (opts.verbose) {
    // D-07: detection transparency (minimal tracer reporting).
    // Full verbose locale report arrives in plan 02.
    // eslint-disable-next-line no-console
    console.error(`[wa-backup] chat=${chat} messages=${messages.length}`);
  }
  return messages.length;
}
