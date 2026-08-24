import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MediaEntry } from './media';
import { mimeFromExt, normalizeMediaName, isInlineable } from './media';

/**
 * One row per ORIGINAL media ref (Message.media). Byte-identical refs repeat
 * `hash`/`relPath`/`size`/`mime`, differing only in `ref` (D-05.2).
 */
export interface MediaManifestEntry {
  /** Original referenced filename (one entry per original ref). */
  ref: string;
  /** Full 64-hex SHA-256 of the content (D-05.1). */
  hash: string;
  /** Content-addressed path: `media/<sha256[:16]>.<ext>`. */
  relPath: string;
  /** Bytes. */
  size: number;
  /** MIME type derived from the extension. */
  mime: string;
}

export interface MediaManifest {
  version: number;
  /** ISO timestamp (non-substantive metadata). */
  generatedAt: string;
  entries: MediaManifestEntry[];
  /** Refs with no matching zip entry. */
  unresolved: string[];
  /** Refs mapped onto an already-committed hash. */
  duplicatesRemoved: number;
  /** Approx sum of sizes of deduped refs. */
  bytesSaved: number;
}

/**
 * Atomically write the manifest: emit to `media/.tmp-<uuid>.json` then rename
 * into place so a crashed run never leaves a half-written manifest that a later
 * `buildMediaMap` would trust (T-05-01 / write policy).
 */
export function writeManifest(mediaDir: string, manifest: MediaManifest): void {
  const tmp = path.join(mediaDir, '.tmp-' + randomUUID() + '.json');
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, path.join(mediaDir, 'manifest.json'));
}

/**
 * Parse a manifest written by {@link writeManifest}. Defensively validates the
 * shape and never executes any manifest content (T-05-01).
 */
export function readManifest(manifestPath: string): MediaManifest {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<MediaManifest>;
  if (!Array.isArray(parsed.entries)) {
    throw new Error('Invalid media manifest: entries is not an array');
  }
  return {
    version: parsed.version ?? 1,
    generatedAt: parsed.generatedAt ?? '',
    entries: parsed.entries,
    unresolved: parsed.unresolved ?? [],
    duplicatesRemoved: parsed.duplicatesRemoved ?? 0,
    bytesSaved: parsed.bytesSaved ?? 0,
  };
}

/**
 * Legacy directory-scan fallback for pre-v1.1 backup folders that have no
 * `manifest.json`. Reproduces the original `buildMediaMap` scan but excludes
 * the manifest and temp files (P7). Keyed by normalized media name.
 */
export function legacyScan(mediaDir: string): Map<string, MediaEntry> {
  const map = new Map<string, MediaEntry>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(mediaDir, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const e of entries) {
    if (e.isDirectory()) continue;
    if (e.name === 'manifest.json') continue;
    if (e.name.startsWith('._')) continue;
    if (e.name.startsWith('.tmp-')) continue;
    const ext = path.extname(e.name);
    const mime = mimeFromExt(ext);
    const full = path.join(mediaDir, e.name);
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }
    map.set(normalizeMediaName(e.name), {
      relPath: `media/${e.name}`,
      mime,
      size,
      inlineable: isInlineable(mime, size),
    });
  }
  return map;
}
