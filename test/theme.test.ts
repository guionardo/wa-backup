import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'path';
import { runParser } from '../src/model';
import { slugifyChatName } from '../src/extract';

const ROOT = process.cwd();
const NOTAS = 'WhatsApp Chat - Notas pessoais';

test('html: theme toggle handled by a classic (non-module) script', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-theme-'));
  await runParser(path.join(ROOT, 'data', `${NOTAS}.zip`), { out });
  const dir = path.join(out, slugifyChatName(NOTAS));
  const html = fs.readFileSync(path.join(dir, 'messages.html'), 'utf8');

  assert.ok(html.includes('id="theme-toggle"'), 'toggle button present');
  assert.ok(html.includes('data-theme="light"'), 'default theme set');

  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  const theme = scripts.find(
    (s) => s[1].trim() === '' && s[2].includes("getElementById('theme-toggle')"),
  );
  assert.ok(theme, 'classic theme script found');
  assert.ok(!/type="module"/.test(theme[1]), 'theme script is NOT a module');
  assert.ok(html.includes('.lightbox'), 'existing lightbox unaffected');
});

test('transcript.js: theme toggle not double-bound in the module', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/render/js/transcript.js'), 'utf8');
  assert.ok(
    !/toggle\?\.addEventListener/.test(src),
    'module does not bind theme-toggle (classic script owns it)',
  );
});
