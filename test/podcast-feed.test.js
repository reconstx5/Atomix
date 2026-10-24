// Reading podcast feeds (v0.22 Plan B Task 2): RSS with iTunes tags, Atom, the episode key, refusals, and fetching
// with the validators, a size cap and the address rule.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, episodeKey, fetchFeed } from '../src/podcasts/feed.js';
import { fakeServer } from './helpers.js';

const servers = [];
after(async () => {
  for (const s of servers) await s.close();
});

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title>The Daily Thing</title>
  <link>https://example.com/</link>
  <description><![CDATA[A show about <b>things</b>.]]></description>
  <itunes:author>Jo Host</itunes:author>
  <itunes:image href="https://example.com/cover.jpg"/>
  <itunes:explicit>yes</itunes:explicit>
  <itunes:category text="Society &amp; Culture"><itunes:category text="Documentary"/></itunes:category>
  <item>
    <title>Older one</title>
    <guid isPermaLink="false">ep-1</guid>
    <pubDate>Mon, 06 Oct 2025 10:00:00 +0000</pubDate>
    <enclosure url="https://cdn.example.com/1.mp3" type="audio/mpeg" length="1234"/>
    <itunes:duration>95</itunes:duration>
  </item>
  <item>
    <title>Newer one&nbsp;— part 2</title>
    <guid>ep-2</guid>
    <pubDate>Tue, 07 Oct 2025 10:00:00 GMT</pubDate>
    <description>Notes &amp; links</description>
    <enclosure url="https://cdn.example.com/2.mp3" type="audio/mpeg" length="5678"/>
    <itunes:duration>1:02:03</itunes:duration>
    <itunes:episode>2</itunes:episode>
    <itunes:season>1</itunes:season>
  </item>
</channel>
</rss>`;

test('an RSS feed with iTunes tags', () => {
  const f = parseFeed(RSS);
  assert.equal(f.title, 'The Daily Thing');
  assert.equal(f.author, 'Jo Host');
  assert.equal(f.image, 'https://example.com/cover.jpg');
  assert.equal(f.explicit, true);
  assert.deepEqual(f.categories, ['Society & Culture', 'Documentary']);
  assert.equal(f.description, 'A show about <b>things</b>.');
  assert.deepEqual(f.episodes.map((e) => e.guid), ['ep-2', 'ep-1'], 'newest first');
  const [n, o] = f.episodes;
  assert.equal(n.title, 'Newer one — part 2');
  assert.equal(n.duration, 3723);
  assert.equal(o.duration, 95);
  assert.equal(n.publishedAt, Date.UTC(2025, 9, 7, 10));
  assert.deepEqual(n.enclosure, { url: 'https://cdn.example.com/2.mp3', type: 'audio/mpeg', length: 5678 });
  assert.deepEqual([n.season, n.episode], [1, 2]);
  assert.equal(n.description, 'Notes & links');
});

test('an Atom feed', () => {
  const f = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Show</title><author><name>Ana</name></author>
    <entry><id>urn:a1</id><title>First</title><updated>2025-10-01T00:00:00Z</updated>
      <link rel="enclosure" href="https://cdn.example.com/a1.m4a" type="audio/mp4" length="10"/></entry></feed>`);
  assert.equal(f.title, 'Atom Show');
  assert.equal(f.author, 'Ana');
  assert.equal(f.episodes.length, 1);
  assert.equal(f.episodes[0].guid, 'urn:a1');
  assert.equal(f.episodes[0].enclosure.url, 'https://cdn.example.com/a1.m4a');
});

test('episodeKey falls back: enclosure address, then title and date', () => {
  assert.equal(episodeKey({ guid: 'g', enclosure: { url: 'u' }, title: 't', publishedAt: 1 }), 'g');
  assert.equal(episodeKey({ guid: null, enclosure: { url: 'u' }, title: 't', publishedAt: 1 }), 'u');
  assert.equal(episodeKey({ guid: null, enclosure: null, title: 't', publishedAt: 1 }), 't|1');
});

test('at most 500 episodes are read', () => {
  const items = Array.from({ length: 600 }, (_, i) => `<item><guid>g${i}</guid><title>E${i}</title><pubDate>${new Date(Date.UTC(2020, 0, 1) + i * 86400000).toUTCString()}</pubDate></item>`).join('');
  const f = parseFeed(`<rss><channel><title>Big</title>${items}</channel></rss>`);
  assert.equal(f.episodes.length, 500);
  assert.equal(f.episodes[0].guid, 'g599', 'the newest 500');
});

test("not a feed is refused with a sentence; entity tricks are refused", () => {
  assert.throws(() => parseFeed('<html><body>hi</body></html>'), (e) => e.status === 400 && e.message === "That isn't a podcast feed.");
  assert.throws(() => parseFeed('<!DOCTYPE rss [<!ENTITY a "aaaa">]><rss><channel><title>&a;</title></channel></rss>'), (e) => e.status === 400);
  assert.throws(() => parseFeed('not xml at all'), (e) => e.status === 400 && e.message === "That isn't a podcast feed.");
});

test('fetchFeed sends the validators and reads a 304', async () => {
  const seen = [];
  const s = await fakeServer((req, res) => {
    seen.push({ inm: req.headers['if-none-match'], ims: req.headers['if-modified-since'] });
    if (req.headers['if-none-match'] === '"v1"') return res.writeHead(304), res.end();
    res.writeHead(200, { 'content-type': 'application/rss+xml', etag: '"v1"', 'last-modified': 'Tue, 07 Oct 2025 10:00:00 GMT' });
    res.end(RSS);
  });
  servers.push(s);
  const first = await fetchFeed(`${s.url}/feed`, {});
  assert.equal(first.status, 200);
  assert.equal(first.etag, '"v1"');
  assert.equal(first.lastModified, 'Tue, 07 Oct 2025 10:00:00 GMT');
  assert.match(first.xml, /The Daily Thing/);
  const again = await fetchFeed(`${s.url}/feed`, { etag: first.etag, lastModified: first.lastModified });
  assert.equal(again.status, 304);
  assert.deepEqual(seen[1], { inm: '"v1"', ims: 'Tue, 07 Oct 2025 10:00:00 GMT' });
});

test('a feed over 5 MB is refused', async () => {
  const s = await fakeServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    const chunk = Buffer.alloc(1024 * 1024, 'a');
    let n = 0;
    const send = () => {
      while (n < 6 && res.write(chunk)) n++;
      if (n >= 6) res.end();
      else res.once('drain', () => (n++, send()));
    };
    send();
  });
  servers.push(s);
  await assert.rejects(fetchFeed(`${s.url}/big`, {}), (e) => e.status === 400 && e.message === 'That feed is too big (over 5 MB).');
});

test('a link-local feed address is refused before any request', async () => {
  await assert.rejects(fetchFeed('http://169.254.169.254/feed', {}), (e) => e.status === 400 && e.message === "That address can't be used.");
});
