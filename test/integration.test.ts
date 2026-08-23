import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync } from 'fflate';
import { runParser } from '../src/model';
import { slugifyChatName } from '../src/extract';

const ROOT = process.cwd();
const WK = 'WhatsApp Chat - Plataforma WK';
const NOTAS = 'WhatsApp Chat - Notas pessoais';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/** Minimal RFC-4180 reader (records of fields). */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { record.push(field); field = ''; }
    else if (c === '\n') {
      record.push(field); field = '';
      if (record.length > 1 || record[0] !== '') records.push(record);
      record = [];
    } else if (c !== '\r') field += c;
  }
  return records;
}

async function run(chat: string, out: string): Promise<string[][]> {
  const txt = fs.readFileSync(path.join(ROOT, 'data', chat, '_chat.txt'));
  const zipped = zipSync({ [`${chat}/_chat.txt`]: txt });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-int-'));
  const zipPath = path.join(tmp, 'export.zip');
  fs.writeFileSync(zipPath, Buffer.from(zipped));
  await runParser(zipPath, { out });
  return parseCsv(
    fs.readFileSync(path.join(out, slugifyChatName(chat), 'messages.csv'), 'utf8'),
  ).slice(1);
}

function csvPathFor(out: string, chat: string): string {
  return path.join(out, slugifyChatName(chat), 'messages.csv');
}

function assertNoBom(out: string, chat: string) {
  const raw = fs.readFileSync(csvPathFor(out, chat));
  assert.equal(raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
  assert.equal(raw.toString('utf8').split('\n')[0], 'timestamp_iso,type,author,text,media,url_titles');
}

test('Plataforma WK: authoritative end-to-end assertions', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-int-out-'));
  const records = await run(WK, out);

  assertNoBom(out, WK);

  // First row.
  assert.equal(records[0][0], '2026-07-23T09:47:18');
  assert.equal(records[0][2], 'Plataforma WK');
  assert.ok(records[0][3].startsWith('Messages and calls are end-to-end encrypted'));

  // Line 10 sticker; lines 20-21 continuation join.
  assert.ok(records.some((r) => r[1] === 'sticker' && r[4] === '00003010-STICKER-2026-07-23-12-41-49.webp'));
  const cont = records.find((r) => r[3].includes('Senha: TIMEWK2026'));
  assert.ok(cont && cont[3].includes('Rede: Conexão WK - Staff'));
  assert.ok(!records.some((r) => r[3] === 'Senha: TIMEWK2026'));

  // Lines 36-37 merged single photo row, no phantom.
  assert.ok(records.some((r) => r[4] === '00003036-PHOTO-2026-07-23-23-31-30.jpg' && r[1] === 'photo'));
  assert.ok(!records.some((r) => r[0] === '2026-07-23T23:31:29' && r[3] === '' && r[4] === ''));

  // Lines 46-51 five distinct photo rows.
  const burst = records.filter((r) => r[1] === 'photo' && r[0].startsWith('2026-07-24T10:41') && r[4].startsWith('000030'));
  assert.ok(burst.length >= 5, `expected >=5 burst rows, got ${burst.length}`);
  assert.equal(new Set(burst.map((r) => r[4])).size, burst.length);

  // Line 57 omitted; line 100 deleted; line 9 raw bidi author.
  assert.ok(records.some((r) => r[1] === 'omitted' && r[3].includes('sticker omitted')));
  assert.ok(records.some((r) => r[1] === 'deleted' && r[3] === 'Mensagem apagada'));
  const src9 = fs.readFileSync(path.join(ROOT, 'data', WK, '_chat.txt'), 'utf8')
    .split('\n').find((l) => l.includes('99951'))!;
  const rawAuthor = src9.match(/\] (.+?): /)![1];
  assert.ok(records.some((r) => r[0] === '2026-07-23T12:15:28' && r[2] === rawAuthor));

  // Every timestamp is local ISO.
  for (const r of records) assert.match(r[0], ISO_RE);
});

test('Notas pessoais: authoritative end-to-end assertions', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-int-out-'));
  const records = await run(NOTAS, out);

  assertNoBom(out, NOTAS);

  // Line 1 text; line 18 document omitted w/ full marker; line 37 sticker.
  assert.ok(records.some((r) => r[0] === '2026-03-17T13:17:59' && r[3] === 'https://lefthook.dev/'));
  assert.ok(records.some((r) => r[1] === 'omitted' && r[3].includes('autorizacao_atividade.pdf') && r[3].includes('document omitted')));
  assert.ok(records.some((r) => r[0] === '2026-04-03T15:17:12' && r[1] === 'sticker' && r[4] === '00000008-STICKER-2026-04-03-15-17-12.webp'));

  // Line 124 caption+attachment photo; line 196 IRPF document attach.
  assert.ok(records.some((r) => r[0] === '2026-05-29T17:23:37' && r[1] === 'photo' && r[3] === 'Taxa João Furlan'));
  assert.ok(records.some((r) => r[1] === 'document' && r[4].startsWith('00000152-96980389904-IRPF')));

  // Lines 14/15 deleted/omitted respectively.
  assert.ok(records.some((r) => r[0] === '2026-03-25T19:52:16' && r[1] === 'deleted'));
  assert.ok(records.some((r) => r[0] === '2026-03-25T19:52:29' && r[1] === 'omitted'));

  // All types within the locked 8.
  const allowed = new Set(['text','photo','video','sticker','document','system','deleted','omitted']);
  for (const r of records) assert.ok(allowed.has(r[1]), r.join('|'));
});

test('dedupe on re-run: second run adds 0 rows, count unchanged (D-16)', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-int-dup-'));
  const first = await run(WK, out);
  const csvPath = csvPathFor(out, WK);
  const countAfterFirst = parseCsv(fs.readFileSync(csvPath, 'utf8')).length - 1;
  assert.equal(first.length, countAfterFirst);

  const addedSecond = await (async () => {
    const txt = fs.readFileSync(path.join(ROOT, 'data', WK, '_chat.txt'));
    const zipped = zipSync({ [`${WK}/_chat.txt`]: txt });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-int-zip-'));
    const zipPath = path.join(tmp, 'export.zip');
    fs.writeFileSync(zipPath, Buffer.from(zipped));
    return runParser(zipPath, { out });
  })();

  assert.equal(addedSecond, 0, 'second run must add zero new rows');
  const after = parseCsv(fs.readFileSync(csvPath, 'utf8')).length - 1;
  assert.equal(after, countAfterFirst, 'row count unchanged after re-run');
});

test('ordering: every CSV sorted ascending by timestamp (D-17)', async () => {
  for (const chat of [WK, NOTAS]) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-int-ord-'));
    const records = await run(chat, out);
    for (let i = 1; i < records.length; i++) {
      assert.ok(
        records[i - 1][0] <= records[i][0],
        `${chat}: row ${i} out of order: ${records[i - 1][0]} > ${records[i][0]}`,
      );
    }
  }
});

test('no phantom empty rows before media rows (both samples)', async () => {
  for (const chat of [WK, NOTAS]) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-int-pha-'));
    const records = await run(chat, out);
    for (let i = 0; i < records.length; i++) {
      const [, , author, text, media] = records[i];
      if (text === '' && media === '') {
        const next = records[i + 1];
        assert.ok(
          !(next && next[2] === author && next[4] !== ''),
          `phantom empty row at ${records[i][0]} (${author})`,
        );
      }
    }
  }
});

test('G-01-16: root-level _chat.txt derives chat name from ZIP basename', async () => {
  const txt = fs.readFileSync(path.join(ROOT, 'data', WK, '_chat.txt'));
  const zipped = zipSync({ '_chat.txt': txt }); // NO folder — real-export layout
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-root-'));
  const zipPath = path.join(tmp, 'WhatsApp Chat - Root Level.zip');
  fs.writeFileSync(zipPath, Buffer.from(zipped));

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-root-out-'));
  await runParser(zipPath, { out });

  const csvPath = path.join(out, 'root-level', 'messages.csv');
  assert.ok(fs.existsSync(csvPath), `expected CSV at ${csvPath}`);
  const records = parseCsv(fs.readFileSync(csvPath, 'utf8')).slice(1);
  assert.ok(records.length > 0);
});
