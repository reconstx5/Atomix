// IPTV Simple: reading XMLTV guides as a stream (plugins/iptv-simple/xmltv.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { parseXmltv, parseXmltvTime, decodeGuide } from '../plugins/iptv-simple/xmltv.js';

const xml = fs.readFileSync(new URL('./fixtures/iptv/guide.xml', import.meta.url));
const T = Date.UTC(2026, 9, 10, 6, 0, 0); // 19:00 NZDT
const chunks = (buf, size) => (async function* () {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
})();
const collect = async (it) => {
  const out = [];
  for await (const c of it) out.push(c);
  return Buffer.concat(out);
};

test('parseXmltvTime: +1300, -0500, no offset is UTC, shift adds hours once', () => {
  assert.equal(parseXmltvTime('20261010190000 +1300'), T);
  assert.equal(parseXmltvTime('20261010010000 -0500'), T);
  assert.equal(parseXmltvTime('20261010060000'), T);
  assert.equal(parseXmltvTime('20261010060000', 2), T + 2 * 3600_000);
  assert.equal(parseXmltvTime('202610100600'), T, 'seconds optional');
  assert.equal(parseXmltvTime('nonsense'), null);
});

test('channels with several display-names; programmes with title, sub-title, desc, categories, icon', async () => {
  const g = await parseXmltv(xml);
  assert.deepEqual(g.channels.get('tvnz1.nz'), ['TVNZ 1', 'TVNZ1']);
  assert.deepEqual(g.channels.get('three.nz'), ['Three']);
  const p = g.programmes.find((x) => x.guideId === 'tvnz1.nz' && x.start === T);
  assert.equal(p.end, T + 30 * 60_000);
  assert.equal(p.title, '1 News at Six & Seven');
  assert.equal(p.subtitle, "Tonight's headlines");
  assert.equal(p.description, "The day's <news>, weather & sport.");
  assert.deepEqual(p.categories, ['News', 'Current affairs']);
  assert.equal(p.image, 'http://img.example/news.jpg');
});

test('episode-num: xmltv_ns "1.4." → "S2 E5", ".4." → "E5", onscreen preferred when present', async () => {
  const g = await parseXmltv(xml);
  assert.equal(g.programmes.find((x) => x.title.startsWith('1 News')).episode, 'S2 E5');
  assert.equal(g.programmes.find((x) => x.title === 'Seven Sharp').episode, 'S12E80');
  const only = await parseXmltv('<tv><programme start="20261010060000" stop="20261010070000" channel="a"><title>X</title><episode-num system="xmltv_ns">.4/10.</episode-num></programme></tv>');
  assert.equal(only.programmes[0].episode, 'E5');
});

test('a programme without stop ends at the next one on its channel; the last one without stop is dropped', async () => {
  const g = await parseXmltv(xml);
  const three = g.programmes.filter((x) => x.guideId === 'three.nz');
  assert.deepEqual(three.map((x) => x.title), ['The Chase', 'Hope Street']);
  assert.equal(three[0].end, T + 3600_000);
});

test('entities, numeric references and CDATA in titles', async () => {
  const g = await parseXmltv('<tv><programme start="20261010060000" stop="20261010070000" channel="a"><title>Tom &amp; Jerry &#x2014; &lt;Live&gt; &quot;Q&quot; &#233;</title></programme></tv>');
  assert.equal(g.programmes[0].title, 'Tom & Jerry — <Live> "Q" é');
});

test('gzip by magic bytes (file named .xml); xz and zip refused with the sentence', async () => {
  const gz = zlib.gzipSync(xml);
  const g = await parseXmltv(decodeGuide(chunks(gz, 100)));
  assert.equal(g.programmes.length, 4);
  assert.deepEqual(await collect(decodeGuide(chunks(xml, 64))), xml, 'plain passes through');
  const xz = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 1, 2, 3]);
  await assert.rejects(collect(decodeGuide(chunks(xz, 4))), /^Error: This guide is compressed as \.xz\/\.zip — Atomix can read plain or \.gz XMLTV$/);
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 9, 9]);
  await assert.rejects(collect(decodeGuide(chunks(zip, 2))), /compressed as \.xz\/\.zip/);
});

test('streamed in 1 KB chunks gives the same result as one string', async () => {
  const whole = await parseXmltv(xml.toString('utf8'));
  const streamed = await parseXmltv(chunks(xml, 1024));
  const tiny = await parseXmltv(chunks(xml, 7));
  assert.deepEqual(streamed, whole);
  assert.deepEqual(tiny, whole);
});

test('a multi-byte character split across chunks survives', async () => {
  const buf = Buffer.from('<tv><programme start="20261010060000" stop="20261010070000" channel="a"><title>Māori TV — ā</title></programme></tv>');
  const g = await parseXmltv(chunks(buf, 3));
  assert.equal(g.programmes[0].title, 'Māori TV — ā');
});

test('a 50 MB synthetic guide streams with heap growth under 64 MB', async () => {
  const one = (i) => `<programme start="2026101${i % 10}060000 +0000" stop="2026101${i % 10}063000 +0000" channel="c${i % 500}"><title>Programme number ${i}</title><desc>${'A fairly long description of what happens. '.repeat(4)}</desc><category>Drama</category></programme>\n`;
  const per = Buffer.byteLength(one(1));
  const count = Math.ceil((50 * 1024 * 1024) / per);
  async function* gen() {
    yield Buffer.from('<tv>');
    let batch = '';
    for (let i = 0; i < count; i++) {
      batch += one(i);
      if (batch.length > 256 * 1024) {
        yield Buffer.from(batch);
        batch = '';
      }
    }
    yield Buffer.from(batch + '</tv>');
  }
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  let seen = 0;
  let peak = 0;
  const g = await parseXmltv(gen(), {
    onProgramme: () => {
      seen++;
      if (seen % 20000 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed - before);
    },
  });
  assert.equal(seen, count);
  assert.equal(g.programmes.length, 0, 'not accumulated when onProgramme is given');
  assert.ok(peak < 64 * 1024 * 1024, `${(peak / 1048576).toFixed(1)} MB`);
});

test('malformed XML reports the line; a non-XMLTV root says "The guide file isn\'t XMLTV"', async () => {
  await assert.rejects(parseXmltv('<tv>\n<programme start="1" channel="a">\n<title>X</titel>\n</programme></tv>'), /^Error: The guide file isn't valid XMLTV \(line 3\)$/);
  await assert.rejects(parseXmltv('<html><body>Not found</body></html>'), /^Error: The guide file isn't XMLTV$/);
  await assert.rejects(parseXmltv(''), /The guide file isn't XMLTV/);
});

test('a hostile guide fails fast: an unterminated comment, tag or text run over 4 MB is invalid', async () => {
  let pulled = 0;
  const flood = (head) => (async function* () {
    pulled = 0;
    yield Buffer.from(head);
    const block = Buffer.alloc(256 * 1024, 'a');
    for (let i = 0; i < 400; i++) {
      pulled++;
      yield block; // up to 100 MB
    }
  })();
  for (const head of ['<tv>\n<!-- ', '<tv>\n<programme start="', '<tv>\n<![CDATA[', '<tv>\n<programme start="20261010060000" stop="20261010070000" channel="a"><title>', '<tv>\n<channel id="a"><display-name>']) {
    await assert.rejects(parseXmltv(flood(head)), /^Error: The guide file isn't valid XMLTV \(line 2\)$/, head);
    assert.ok(pulled < 40, `${head}: read ${pulled} × 256 KB before giving up`);
  }
});

test('decodeGuide caps the unpacked size (a gzip bomb)', async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, ' '));
  await assert.rejects(collect(decodeGuide(chunks(bomb, 4096), { maxBytes: 1024 * 1024 })), /^Error: The guide is larger than 1 MB unpacked$/);
  assert.equal((await collect(decodeGuide(chunks(zlib.gzipSync(xml), 512), { maxBytes: 1024 * 1024 }))).length, xml.length);
});

test('onProgramme is told the channels read so far (so a caller can drop programmes it has no channel for)', async () => {
  const xml = '<tv><channel id="a"><display-name>A</display-name></channel><channel id="b"><display-name>B</display-name></channel><programme start="20261010060000 +0000" stop="20261010070000 +0000" channel="a"><title>X</title></programme></tv>';
  const seenChannels = [];
  await parseXmltv([Buffer.from(xml)], { onProgramme: (p, channels) => seenChannels.push([...(channels?.keys() || [])]) });
  assert.deepEqual(seenChannels, [['a', 'b']]);
});

test('xmltv: <previously-shown/> marks a programme as a repeat', async () => {
  const g = await parseXmltv(Buffer.from(`<tv><channel id="a"><display-name>A</display-name></channel>
    <programme start="20261010060000" stop="20261010070000" channel="a"><title>Old</title><previously-shown start="20200101000000"/></programme>
    <programme start="20261010070000" stop="20261010080000" channel="a"><title>Again</title><previously-shown></previously-shown></programme>
    <programme start="20261010080000" stop="20261010090000" channel="a"><title>New</title><new/></programme></tv>`));
  assert.deepEqual(g.programmes.map((p) => [p.title, Boolean(p.repeat)]), [['Old', true], ['Again', true], ['New', false]]);
});
