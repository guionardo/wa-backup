import * as fs from 'node:fs';
import { open } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import * as zlib from 'node:zlib';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import type { Message } from './parse/types';
import {
  writeManifest,
  readManifest,
  legacyScan,
  type MediaManifestEntry,
} from './media-manifest';

export const MEDIA_HASH_PREFIX_LEN = 16;

export function canonicalMediaName(hash: string, ext: string): string {
  return `${hash.slice(0, MEDIA_HASH_PREFIX_LEN)}${ext.toLowerCase()}`;
}

/**
 * Maximum byte size for a media file to be eligible for `--inline` base64
 * embedding (D-M6). Files larger than this, or any video, are skipped by
 * default and fall back to a relative link / placeholder.
 */
export const INLINE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Canonicalize a media filename for tolerant matching (D-M2 / MEDIA-01):
 * lower-case, drop a trailing parenthesized duplicate marker (`(1)`), and
 * collapse runs of whitespace / `-` / `_` to nothing. Digits are preserved so
 * real date-stamped names stay distinct.
 *
 *   normalizeMediaName('Photo (1).JPG') === normalizeMediaName('photo.jpg')
 *   normalizeMediaName('IMG 20190424 WA0003.jpg') === normalizeMediaName('IMG-20190424-WA0003.jpg')
 */
export function normalizeMediaName(s: string): string {
  return s.toLowerCase().replace(/\(\d+\)/g, '').replace(/[\s_-]+/g, '');
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
};

/** Resolve a file extension to a MIME type (no dependency). D-M4. */
export function mimeFromExt(ext: string): string {
  const e = ext.replace(/^\./, '').toLowerCase();
  return MIME_BY_EXT[e] ?? 'application/octet-stream';
}

/** True when a file may be inlined as a `data:` URI (D-M6 / MEDIA-03). */
export function isInlineable(mime: string, size: number): boolean {
  return size <= INLINE_MAX_BYTES && !mime.startsWith('video/');
}

function isAppleDouble(name: string): boolean {
  const base = name.split('/').pop() ?? '';
  return name.includes('__MACOSX') || base.startsWith('._');
}

interface ZipEntryMeta {
  name: string;
  localOffset: number;
  compressedSize: number;
  compression: number;
}

/**
 * Read only the ZIP central directory (EOCD + central records) to recover each
 * entry's exact name, local-header offset and **authoritative** compressed
 * size. The central directory always carries correct sizes even for members
 * stored with a data descriptor (local-header `csize = 0`, flag bit 3) — a
 * layout fflate's streaming inflate mis-handles on real WhatsApp exports
 * (e.g. an attached inner `.zip`). This pass reads metadata only; no entry
 * bytes are buffered (PARSE-02).
 */
function readCentralDirectory(zipPath: string): ZipEntryMeta[] {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const maxBack = Math.min(stat.size, 22 + 0xffff);
    const tail = Buffer.alloc(maxBack);
    fs.readSync(fd, tail, 0, maxBack, stat.size - maxBack);
    let eocd = -1;
    for (let i = maxBack - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('ZIP end-of-central-directory record not found');
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cdCount = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdBuf = Buffer.alloc(cdSize);
    fs.readSync(fd, cdBuf, 0, cdSize, cdOffset);
    const entries: ZipEntryMeta[] = [];
    let p = 0;
    for (let n = 0; n < cdCount; n++) {
      if (cdBuf.readUInt32LE(p) !== 0x02014b50) break; // central-file signature
      const compression = cdBuf.readUInt16LE(p + 10);
      const compressedSize = cdBuf.readUInt32LE(p + 20);
      const nlen = cdBuf.readUInt16LE(p + 28);
      const elen = cdBuf.readUInt16LE(p + 30);
      const clen = cdBuf.readUInt16LE(p + 32);
      const localOffset = cdBuf.readUInt32LE(p + 42);
      const name = cdBuf.toString('utf8', p + 46, p + 46 + nlen);
      entries.push({ name, localOffset, compressedSize, compression });
      p += 46 + nlen + elen + clen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Stream a single zip member's bytes from disk into `outPath`, inflating raw
 * DEFLATE (method 8) on the fly, or copying stored bytes (method 0). The input
 * `ReadStream` is bounded to exactly one entry via `start`/`end`, so a large
 * video/inner-zip is streamed entry-by-entry — the whole archive is never
 * buffered (PARSE-02).
 */
async function extractEntry(
  zipPath: string,
  entry: ZipEntryMeta,
  outPath: string,
): Promise<{ hash: string; size: number }> {
  const fh = await open(zipPath, 'r');
  try {
    const lh = Buffer.alloc(30);
    await fh.read(lh, 0, 30, entry.localOffset);
    const nlen = lh.readUInt16LE(26);
    const elen = lh.readUInt16LE(28);
    const dataStart = entry.localOffset + 30 + nlen + elen;
    const rs = createReadStream(zipPath, {
      start: dataStart,
      end: dataStart + entry.compressedSize - 1,
    });
    const ws = createWriteStream(outPath);
    const hash = createHash('sha256');
    let size = 0;
    const hashTransform = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    const source =
      entry.compression === 0 ? rs : rs.pipe(zlib.createInflateRaw());
    await new Promise<void>((res, rej) => {
      source.on('error', rej);
      hashTransform.on('error', rej);
      ws.on('error', rej);
      ws.on('close', res);
      source.pipe(hashTransform).pipe(ws);
    });
    return { hash: hash.digest('hex'), size };
  } finally {
    await fh.close();
  }
}

export interface ReconcileResult {
  /** Distinct refs that matched an actual zip entry. */
  resolved: string[];
  /** Distinct refs with no matching entry. */
  unresolved: string[];
  /** Every resolved ref -> its canonical content-addressed MediaEntry. */
  mediaMap: Map<string, MediaEntry>;
  /** Refs mapped onto an already-committed hash during this run. */
  duplicatesRemoved: number;
  /** Approx sum of sizes of deduped refs. */
  bytesSaved: number;
}

let activeReconcileMap: Map<string, MediaEntry> | null = null;

export function setActiveReconcileMap(m: Map<string, MediaEntry> | null): void {
  activeReconcileMap = m;
}

/**
 * Locate media referenced by `_chat.txt` and copy the matched zip entries into
 * `<dir>/media/`, streaming each per-entry from the central-directory index
 * (PARSE-02 / D-M3 — the whole archive is never buffered). Returns the resolved
 * and unresolved refs.
 *
 * @param zipPath  Path to the WhatsApp export ZIP.
 * @param dir      Output directory (the `<slug>` folder). `media/` is created
 *                underneath it.
 * @param refs     Distinct media filenames referenced by messages.
 */
export async function reconcileMedia(
  zipPath: string,
  dir: string,
  refs: string[],
): Promise<ReconcileResult> {
  const refsByNorm = new Map<string, string[]>(); // normalized -> every original ref
  for (const r of refs) {
    const n = normalizeMediaName(r);
    if (!n) continue;
    const list = refsByNorm.get(n) ?? [];
    list.push(r);
    refsByNorm.set(n, list);
  }

  const mediaDir = path.join(dir, 'media');
  await fs.promises.mkdir(mediaDir, { recursive: true });

  const entries = readCentralDirectory(zipPath);
  const index = new Map<string, ZipEntryMeta>(); // normalized base -> meta
  for (const e of entries) {
    const base = e.name.split('/').pop()!;
    if (isAppleDouble(e.name) || base.endsWith('_chat.txt')) {
      continue;
    }
    index.set(normalizeMediaName(base), e);
  }

  const resolvedSet = new Set<string>();
  const resolved: string[] = [];
  const mediaMap = new Map<string, MediaEntry>();

  // Dedup bookkeeping + the persisted manifest (D-05.1 / D-05.2).
  // Keyed on the canonical on-disk name (hash[:16]+ext), so byte-identical
  // refs sharing an extension collapse to one file, while same-content
  // different-extension files each keep a resolvable file (P4 edge case).
  const committedNames = new Set<string>();
  let duplicatesRemoved = 0;
  let bytesSaved = 0;
  const manifestEntries: MediaManifestEntry[] = [];

  const writes: Promise<void>[] = [];
  for (const [norm, refList] of refsByNorm) {
    const meta = index.get(norm);
    if (!meta) continue; // unreferenced / missing -> unresolved
    const base = meta.name.split('/').pop()!;
    const ext = path.extname(base);
    writes.push(
      (async () => {
        const tmp = path.join(mediaDir, '.tmp-' + randomUUID());
        try {
          const { hash, size } = await extractEntry(zipPath, meta, tmp);
          const canonicalName = canonicalMediaName(hash, ext);
          const canonicalPath = path.join(mediaDir, canonicalName);
          const alreadyCommitted = committedNames.has(canonicalName);
          if (alreadyCommitted) {
            // Byte-identical content already on disk: discard temp, count every
            // ref in this group as a duplicate (D-05.2: still recorded below).
            fs.unlinkSync(tmp);
            duplicatesRemoved += refList.length;
            bytesSaved += refList.length * size;
          } else {
            if (fs.existsSync(canonicalPath)) {
              fs.unlinkSync(tmp); // D-04 trust-stream: no rewrite
            } else {
              fs.renameSync(tmp, canonicalPath);
            }
            committedNames.add(canonicalName);
            // Within-norm redundancy: multiple distinct original refs that
            // normalize equal (e.g. photo.jpg + photo (1).jpg).
            duplicatesRemoved += Math.max(0, refList.length - 1);
            bytesSaved += Math.max(0, refList.length - 1) * size;
          }
          const mime = mimeFromExt(ext);
          const entry: MediaEntry = {
            relPath: `media/${canonicalName}`,
            mime,
            size,
            inlineable: isInlineable(mime, size),
            hash,
          };
          for (const ref of refList) {
            mediaMap.set(ref, entry);
            if (!resolvedSet.has(ref)) {
              resolvedSet.add(ref);
              resolved.push(ref);
            }
            // One manifest entry per original ref (D-05.2).
            manifestEntries.push({
              ref,
              hash,
              relPath: `media/${canonicalName}`,
              size,
              mime,
            });
          }
        } catch (err) {
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* ignore */
          }
          throw err;
        }
      })(),
    );
  }
  await Promise.all(writes);

  const unresolved = [...refsByNorm.values()].flat().filter(
    (r) => !resolvedSet.has(r),
  );

  // Persist the ref -> canonical-file bridge (always write, atomic).
  writeManifest(mediaDir, {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: manifestEntries,
    unresolved,
    duplicatesRemoved,
    bytesSaved,
  });

  setActiveReconcileMap(mediaMap);
  return { resolved, unresolved, mediaMap, duplicatesRemoved, bytesSaved };
}

export interface MediaEntry {
  /** Relative path as referenced by renderers: `media/<file>`. */
  relPath: string;
  mime: string;
  /** Whether this file may be inlined as a `data:` URI (D-M6). */
  inlineable: boolean;
  size: number;
  /** Full 64-hex SHA-256 carried from the manifest; renderers ignore it. */
  hash?: string;
}

/**
 * Build a disk-resident media map (D-M5): scan `<dir>/media/*` once and resolve
 * each message's `media` ref to its on-disk file. Refs with no file on disk are
 * **absent** from the map (renderers treat them as missing-but-expected).
 *
 * @param dir      Output directory containing `media/`.
 * @param messages The parsed/merged messages (CSV source-of-truth).
 */
export function buildMediaMap(
  dir: string,
  messages: Message[],
): Map<string, MediaEntry> {
  const mediaDir = path.join(dir, 'media');
  const manifestPath = path.join(mediaDir, 'manifest.json');

  // --- Manifest-first (authoritative / exclusive) -------------------------
  // If a manifest exists, it is the source of truth: a ref present in the
  // manifest but whose file is missing on disk is treated as absent
  // (placeholder), never re-scanned (D-05.2 carry-over).
  if (fs.existsSync(manifestPath)) {
    let manifest: ReturnType<typeof readManifest> | null = null;
    try {
      manifest = readManifest(manifestPath);
    } catch {
      manifest = null; // corrupt manifest -> fall through to legacy scan
    }
    if (manifest) {
      const byRef = new Map(manifest.entries.map((e) => [e.ref, e]));
      const map = new Map<string, MediaEntry>();
      for (const m of messages) {
        if (!m.media) continue;
        const e = byRef.get(m.media);
        if (!e) continue; // absent-but-expected: placeholder
        if (!fs.existsSync(path.join(mediaDir, path.basename(e.relPath)))) {
          continue; // file missing on disk -> absent (exclusive)
        }
        map.set(m.media, {
          relPath: e.relPath,
          mime: e.mime,
          size: e.size,
          inlineable: isInlineable(e.mime, e.size),
          hash: e.hash,
        });
      }
      return map;
    }
  }

  // --- In-run bridge (Phase 4 activeReconcileMap) -------------------------
  if (activeReconcileMap) {
    const map = new Map<string, MediaEntry>();
    for (const m of messages) {
      if (!m.media) continue;
      const e = activeReconcileMap.get(m.media);
      if (e) map.set(m.media, e);
    }
    return map;
  }

  // --- Legacy directory-scan fallback (pre-v1.1 folders, no manifest) -----
  const legacy = legacyScan(mediaDir);
  const map = new Map<string, MediaEntry>();
  for (const m of messages) {
    if (!m.media) continue;
    const e = legacy.get(normalizeMediaName(m.media));
    if (e) map.set(m.media, e);
  }
  return map;
}
