import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  extractTitle,
  fetchTitle,
  enrichTitles,
  platformOf,
  youTubeOembedUrl,
  parseYouTubeOembed,
  redditJsonUrl,
  parseRedditJson,
  deriveLinkedInTitle,
} from '../src/title';
import type { Message } from '../src/parse/types';

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

// ---- platform classification + pure parsers ----

test('platformOf: classifies youtube/reddit/linkedin/generic', () => {
  assert.equal(platformOf('https://www.youtube.com/watch?v=1'), 'youtube');
  assert.equal(platformOf('https://youtu.be/abc'), 'youtube');
  assert.equal(platformOf('https://old.reddit.com/r/x'), 'reddit');
  assert.equal(platformOf('https://www.linkedin.com/in/john-doe'), 'linkedin');
  assert.equal(platformOf('https://example.com/post'), 'generic');
});

test('youtube: oembed url + parser', () => {
  assert.equal(
    youTubeOembedUrl('https://youtube.com/watch?v=1'),
    'https://www.youtube.com/oembed?url=' +
      encodeURIComponent('https://youtube.com/watch?v=1') +
      '&format=json',
  );
  assert.equal(parseYouTubeOembed({ title: 'Cool Video' }), 'Cool Video');
  assert.equal(parseYouTubeOembed({}), null);
});

test('reddit: json url + parser', () => {
  assert.equal(redditJsonUrl('https://reddit.com/r/x/'), 'https://reddit.com/r/x.json');
  assert.equal(
    parseRedditJson([{ data: { children: [{ data: { title: 'Top Post' } }] } }]),
    'Top Post',
  );
  assert.equal(parseRedditJson({}), null);
});

test('linkedin: title derived from URL slug (offline)', () => {
  assert.equal(deriveLinkedInTitle('https://www.linkedin.com/in/john-doe'), 'john doe');
  assert.equal(
    deriveLinkedInTitle('https://linkedin.com/jobs/view/software-engineer-at-acme'),
    'software engineer at acme',
  );
  assert.equal(deriveLinkedInTitle('https://linkedin.com/company/acme-corp'), 'acme corp');
  assert.equal(deriveLinkedInTitle('https://linkedin.com/feed/'), null);
});

// ---- network dispatch via mocked global fetch ----

test('fetchTitle: youtube uses oEmbed endpoint', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (u: any) => {
    if (String(u).includes('/oembed')) {
      return new Response(JSON.stringify({ title: 'My Video' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('<title>ignored</title>', { status: 200 });
  }) as any;
  try {
    assert.equal(await fetchTitle('https://youtube.com/watch?v=1'), 'My Video');
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchTitle: reddit uses .json listing', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (u: any) => {
    if (String(u).endsWith('.json')) {
      return new Response(
        JSON.stringify([{ data: { children: [{ data: { title: 'Sub Post' } }] } }]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('<title>ignored</title>', { status: 200 });
  }) as any;
  try {
    assert.equal(await fetchTitle('https://reddit.com/r/x/'), 'Sub Post');
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchTitle: linkedin is offline (no network)', async () => {
  let networkCalled = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkCalled = true;
    return new Response('<title>x</title>');
  }) as any;
  try {
    assert.equal(
      await fetchTitle('https://www.linkedin.com/in/jane-doe'),
      'jane doe',
    );
    assert.equal(networkCalled, false, 'linkedin must not hit the network');
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchTitle: youtube falls back to generic title on oEmbed failure', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (u: any) => {
    if (String(u).includes('/oembed')) {
      return new Response('nope', { status: 404 });
    }
    return new Response('<title>Generic Fallback</title>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }) as any;
  try {
    assert.equal(await fetchTitle('https://youtube.com/watch?v=9'), 'Generic Fallback');
  } finally {
    globalThis.fetch = original;
  }
});
