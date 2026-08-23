import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { extractTitle, fetchTitle, enrichTitles } from '../src/title';
import type { Message } from './parse/types';

function startServer(
  body: string,
  { contentType = 'text/html; charset=utf-8', delayMs = 0 } = {},
) {
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const srv = createServer((_req, res) => {
      const send = () => {
        res.writeHead(200, { 'content-type': contentType });
        res.end(body);
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => srv.close() });
    });
  });
}

test('extractTitle: pulls and sanitizes <title>', () => {
  const t = extractTitle('<html><head><title>  Hello\n\tWorld  </title></head></html>');
  assert.equal(t, 'Hello World');
});

test('extractTitle: null when absent', () => {
  assert.equal(extractTitle('<html></html>'), null);
});

test('fetchTitle: returns fetched title for html', async () => {
  const srv = await startServer('<title>My Page</title>');
  try {
    assert.equal(await fetchTitle(srv.url), 'My Page');
  } finally {
    srv.close();
  }
});

test('fetchTitle: falls back to derived title on timeout', async () => {
  const srv = await startServer('<title>Slow</title>', { delayMs: 200 });
  try {
    const r = await fetchTitle(srv.url, { timeoutMs: 40 });
    assert.ok(r.includes('127.0.0.1'), 'fell back to derived (host) title');
  } finally {
    srv.close();
  }
});

test('fetchTitle: falls back on non-html content', async () => {
  const srv = await startServer('plain text', { contentType: 'text/plain' });
  try {
    const r = await fetchTitle(srv.url);
    assert.ok(r.includes('127.0.0.1'), 'non-html -> derived title');
  } finally {
    srv.close();
  }
});

test('enrichTitles: maps each URL to a title and dedupes fetches', async () => {
  const srv = await startServer('<title>Shared Title</title>');
  try {
    const urlA = srv.url + 'a';
    const urlB = srv.url + 'b';
    const msgs: Message[] = [
      { timestamp_iso: '2026-07-23T09:47:18', type: 'text', author: 'a', text: `one ${urlA}`, media: '' },
      { timestamp_iso: '2026-07-23T09:47:19', type: 'text', author: 'b', text: `two ${urlA} and ${urlB}`, media: '' },
    ];
    await enrichTitles(msgs, { enabled: true, timeoutMs: 2000 });
    assert.equal(msgs[0].urlTitles?.[urlA], 'Shared Title');
    assert.equal(msgs[1].urlTitles?.[urlA], 'Shared Title');
    assert.equal(msgs[1].urlTitles?.[urlB], 'Shared Title');
  } finally {
    srv.close();
  }
});

test('enrichTitles: disabled leaves urlTitles empty', async () => {
  const msgs: Message[] = [
    { timestamp_iso: '2026-07-23T09:47:18', type: 'text', author: 'a', text: 'one https://example.com/a', media: '' },
  ];
  await enrichTitles(msgs, { enabled: false });
  assert.deepEqual(msgs[0].urlTitles, {});
});
