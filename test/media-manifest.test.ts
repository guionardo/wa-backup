import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { reconcileMedia, buildMediaMap } from '../src/media';
import { readManifest } from '../src/media-manifest';
import type { Message } from '../src/parse/types';

const ROOT = process.cwd();
const NOTAS_ZIP = path.join(ROOT, 'fixtures', 'WhatsApp Chat - Notas pessoais.zip');

const REFS = [
  '00000008-STICKER-2026-04-03-15-17-12.webp',
  '00000021-STICKER-2026-04-10-21-58-01.webp',
  '00000023-STICKER-2026-04-11-13-24-21.webp',
  '00000040-STICKER-2026-04-20-15-16-33.webp',
  '00000045-STICKER-2026-04-23-23-19-31.webp',
  '00000068-Conversa do WhatsApp com Notas pessoais.zip',
  '00000088-STICKER-2026-05-27-08-45-13.webp',
  '00000089-VIDEO-2026-05-27-17-26-38.mp4',
  '00000091-PHOTO-2026-05-29-17-23-37.jpg',
  '00000098-PHOTO-2026-06-10-13-55-47.jpg',
  '00000099-STICKER-2026-06-10-13-55-59.webp',
  '00000134-PHOTO-2026-07-18-22-34-29.jpg',
  '00000147-PHOTO-2026-07-26-19-23-49.jpg',
  '00000148-PHOTO-2026-07-28-07-48-08.jpg',
  '00000149-PHOTO-2026-07-28-07-48-50.jpg',
  '00000152-96980389904-IRPF-D-0-0211-31-07-2026-08-03.pdf',
  '00000153-raw.pdf',
];

test('manifest bridge: reconcileMedia writes manifest.json; buildMediaMap reads it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mm-'));
  const slug = 'notas-pessoais';
  const outDir = path.join(dir, slug);
  fs.mkdirSync(outDir, { recursive: true });

  await reconcileMedia(NOTAS_ZIP, outDir, REFS);

  // Manifest was written.
  const manifestPath = path.join(outDir, 'media', 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'media/manifest.json exists');
  const manifest = readManifest(manifestPath);
  assert.equal(manifest.version, 1, 'version === 1');
  assert.equal(manifest.entries.length, 17, 'one entry per original ref');

  for (const e of manifest.entries) {
    assert.equal(e.hash.length, 64, `full 64-hex sha256 (${e.ref})`);
    assert.ok(
      /^media\/[0-9a-f]{16}\.[a-z0-9]+$/.test(e.relPath),
      `CAS relPath (${e.ref} -> ${e.relPath})`,
    );
    assert.ok(e.size > 0, `size > 0 (${e.ref})`);
    assert.ok(e.mime.length > 0, `mime non-empty (${e.ref})`);
  }

  // buildMediaMap resolves refs by reading the manifest (manifest-first).
  const messages = REFS.map((r) => ({ media: r })) as unknown as Message[];
  const m = buildMediaMap(outDir, messages);
  const videoRef = '00000089-VIDEO-2026-05-27-17-26-38.mp4';
  const entry = m.get(videoRef);
  assert.ok(entry, 'video ref resolved via manifest');
  const manifestVideo = manifest.entries.find((e) => e.ref === videoRef)!;
  assert.equal(
    entry!.relPath,
    manifestVideo.relPath,
    'relPath matches the manifest entry',
  );
  assert.equal(entry!.hash, manifestVideo.hash, 'hash carried from manifest');
});
