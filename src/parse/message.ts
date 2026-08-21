import type { Message, MessageType } from './types';
import { stripInvisible, trimInvisible, TS_RE, parseTimestamp } from './timestamp';
import { readLines } from '../extract';

/** Sender separator (D-09): optional ` - ` wrapper, then `Name: body`.
 * The separator is `:` + whitespace, or `:` at end-of-line (empty-body
 * messages like `[..] Camilla:`). Requiring `\s|$` keeps URLs (`https://…`)
 * from being mistaken for senders. */
const SENDER_RE = /^(?:\s*-\s*)?(.+?):(?:\s|$)([\s\S]*)$/;
/** `<attached: FILENAME>` media marker. */
const ATTACHED_RE = /<attached:\s*([^>]+?)>/;
/** `* omitted` / `<Media omitted>` style placeholders (MEDIA-04). */
const OMITTED_RE = /<?(?:media|image|video|sticker|document|audio|gif)\s+omitted>/i;
/** Deleted-message markers (pt-BR + EN). */
const DELETED_MARKERS = ['Mensagem apagada', 'Message deleted', 'This message was deleted'];

function classifyFromFilename(filename: string): MessageType {
  const f = filename.toUpperCase();
  if (f.includes('STICKER')) return 'sticker';
  if (f.includes('PHOTO') || f.includes('IMG')) return 'photo';
  if (f.includes('VIDEO')) return 'video';
  // No `audio` type exists in the locked 8; fallback to document (A1).
  if (
    f.includes('AUDIO') ||
    f.includes('DOCUMENT') ||
    f.endsWith('.PDF') ||
    f.endsWith('.DOC') ||
    f.endsWith('.DOCX')
  ) {
    return 'document';
  }
  return 'document';
}

export interface ParseOptions {
  dayFirst?: boolean;
  monthFirst?: boolean;
}

/**
 * Streaming line state-machine parser (RESEARCH §3).
 *
 * - Non-timestamp line => append to open message's `text` (continuation, PARSE-04).
 * - Timestamp that fails to parse (D-04/D-08) => treated as continuation.
 * - Empty-body timestamped line is HELD; if the next line is a same-author
 *   attachment it merges into ONE media row (no phantom empty row, §3.4).
 * - Each `<attached>` line is its own row; dedupe key (in plan 03) keeps
 *   same-second bursts distinct (D-16).
 * - author preserved RAW (incl. bidi wrappers, ~ prefix); body leading/trailing
 *   invisible runs trimmed only.
 */
export async function* parseMessages(
  lines: AsyncIterable<string>,
  opts: ParseOptions = {},
): AsyncGenerator<Message> {
  let current: Message | null = null;
  let heldEmpty: Message | null = null;

  const appendContinuation = (line: string) => {
    const target = current ?? heldEmpty;
    if (!target) return;
    target.text = target.text ? target.text + '\n' + line : line;
    // If the held-empty message gained text, it is no longer "empty" => promote.
    if (target === heldEmpty && target.text) {
      current = heldEmpty;
      heldEmpty = null;
    }
  };

  for await (const line of lines) {
    const stripped = stripInvisible(line);
    const tsMatch = TS_RE.exec(stripped);

    if (!tsMatch) {
      appendContinuation(line);
      continue;
    }

    const parsed = parseTimestamp(stripped, opts);
    if (!parsed) {
      // D-04 / D-08: a line that matched the shape but not the date => continuation.
      appendContinuation(line);
      continue;
    }

    const afterTs = stripped.slice(tsMatch[0].length);
    const senderMatch = SENDER_RE.exec(afterTs);
    let author = '';
    let body = afterTs;
    let type: MessageType = 'text';

    if (senderMatch) {
      author = senderMatch[1].trim();
      body = senderMatch[2];
    } else {
      type = 'system';
    }

    body = trimInvisible(body).trim();

    const msg: Message = {
      timestamp_iso: parsed.iso,
      type,
      author,
      text: body,
      media: '',
    };

    const attached = body.match(ATTACHED_RE);
    if (attached) {
      msg.media = attached[1].trim();
      msg.text = trimInvisible(body.replace(ATTACHED_RE, '')).trim();
      msg.type = classifyFromFilename(msg.media);
    } else if (OMITTED_RE.test(msg.text)) {
      msg.type = 'omitted';
    } else if (DELETED_MARKERS.includes(msg.text.trim())) {
      msg.type = 'deleted';
    } else if (msg.type !== 'system') {
      msg.type = 'text';
    }

    // Merge held-empty with an incoming same-author attachment (§3.4).
    if (heldEmpty && msg.media && msg.author === heldEmpty.author) {
      heldEmpty = null; // discard empty holder; msg becomes the merged media row
    } else if (heldEmpty) {
      yield heldEmpty;
      heldEmpty = null;
    }

    if (current) {
      yield current;
      current = null;
    }

    if (msg.text === '' && !msg.media) {
      heldEmpty = msg;
    } else {
      current = msg;
    }
  }

  if (heldEmpty) yield heldEmpty;
  if (current) yield current;
}
