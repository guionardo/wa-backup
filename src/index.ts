#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import { runParser } from './model';

export function buildCli() {
  const program = new Command();
  program
    .name('wa-backup')
    .description(
      'Read a WhatsApp "Export chat" ZIP and produce a normalized CSV backup.',
    )
    .argument('<zip>', 'path to a WhatsApp "Export chat" ZIP')
    .option('--out <dir>', 'output directory (default: <chat-name>/ under cwd)')
    .option('--day-first', 'force day/month date order')
    .option('--month-first', 'force month/day date order')
    .option('--verbose', 'report detected format, locale guess, overrides')
    .action(async (zip: string, opts: Record<string, unknown>) => {
      try {
        const count = await runParser(zip, {
          out: opts.out as string | undefined,
          dayFirst: Boolean(opts.dayFirst),
          monthFirst: Boolean(opts.monthFirst),
          verbose: Boolean(opts.verbose),
        });
        // eslint-disable-next-line no-console
        console.log(
          pc.green(`✓ Wrote ${count} messages`) +
            pc.dim(` to ${opts.out ?? 'out/'} (see <chat>/messages.csv)`),
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(pc.red('✗ ' + (err instanceof Error ? err.message : String(err))));
        process.exitCode = 1;
      }
    });
  return program;
}

buildCli().parseAsync(process.argv);
