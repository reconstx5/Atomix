// IPTV Simple: reading M3U playlists (plugins/iptv-simple/m3u.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseM3u } from '../plugins/iptv-simple/m3u.js';

const text = fs.readFileSync(new URL('./fixtures/iptv/provider.m3u', import.meta.url), 'utf8');
const byName = (r, name) => r.channels.find((c) => c.name === name);

test('header attributes: url-tvg and x-tvg-url lists, catchup, catchup-days, catchup-source, tvg-shift', () => {
  const r = parseM3u(text);
  assert.deepEqual(r.header.guideUrls, ['http://guide.example/epg.xml.gz', 'http://guide.example/backup.xml']);
  assert.equal(r.header.catchup, 'shift');
  assert.equal(r.header.catchupDays, 3);
  assert.equal(r.header.shift, 1);
  const x = parseM3u('#EXTM3U x-tvg-url="http://a/g.xml" catchup-source="?utc={utc}"\n#EXTINF:-1,A\nhttp://a/1.ts\n');
  assert.deepEqual(x.header.guideUrls, ['http://a/g.xml']);
  assert.equal(x.header.catchupSource, '?utc={utc}');
});

test('every #EXTINF attribute, double and single quotes', () => {
  const r = parseM3u(text);
  const one = byName(r, 'TVNZ 1 HD');
  assert.equal(one.tvgId, 'tvnz1.nz');
  assert.equal(one.tvgName, 'TVNZ 1');
  assert.equal(one.logo, 'http://logos.example/tvnz1.png');
  assert.equal(one.number, 1);
  assert.deepEqual(one.groups, ['News', 'Local']);
  assert.equal(one.radio, false);
  assert.equal(one.url, 'http://provider.example/live/u/p/101.ts');
  const three = byName(r, 'Three');
  assert.equal(three.tvgId, 'three.nz');
  assert.equal(three.logo, 'three.png');
  assert.equal(three.number, 3);
  assert.deepEqual(three.groups, ['Entertainment']);
  assert.deepEqual(three.catchup, { mode: 'xc', days: 7 });
  assert.equal(byName(r, 'RNZ National').radio, true);
  const sky = byName(r, 'Sky Sport');
  assert.equal(sky.shift, -2);
  assert.deepEqual(sky.catchup, { mode: 'default', source: 'http://provider.example/arch/{utc}-{duration}.ts', correction: 0.5 });
  assert.equal(one.catchup, undefined, 'no channel catch-up attribute: the header default applies later');
});

test('#EXTGRP adds a group; #EXTVLCOPT sets User-Agent and Referer; url|User-Agent=A%20B&Referer=x sets headers and strips the suffix', () => {
  const r = parseM3u(text);
  const sky = byName(r, 'Sky Sport');
  assert.deepEqual(sky.groups, ['Sport']);
  assert.deepEqual(sky.headers, { 'User-Agent': 'VLC/3.0', Referer: 'http://provider.example/' });
  const free = byName(r, 'Free Channel');
  assert.equal(free.url, 'http://free.example/hls/free.m3u8');
  assert.deepEqual(free.headers, { 'User-Agent': 'Mozilla/5.0 Test', Referer: 'http://free.example/', 'X-Custom': '1' });
  assert.deepEqual(byName(r, 'TVNZ 1 HD').headers, {}, 'options apply to one channel only');
});

test('#KODIPROP mimetype is a hint; other KODIPROP lines are ignored', () => {
  const r = parseM3u(text);
  assert.equal(byName(r, 'Free Channel').mime, 'application/x-mpegURL');
  assert.equal(byName(r, 'TVNZ 1 HD').mime, undefined);
  const m = parseM3u('#EXTM3U\n#KODIPROP:mimetype=video/mp2t\n#EXTINF:-1,A\nhttp://a/1\n');
  assert.equal(m.channels[0].mime, 'video/mp2t');
});

test('numbering: tvg-chno wins, others continue after the highest; numbering=order ignores tvg-chno; startNumber', () => {
  const r = parseM3u(text);
  assert.deepEqual(r.channels.map((c) => c.number), [1, 3, 4, 5, 6, 7]);
  const o = parseM3u(text, { numbering: 'order', startNumber: 100 });
  assert.deepEqual(o.channels.map((c) => c.number), [100, 101, 102, 103, 104, 105]);
});

test('duplicate URLs collapse with a warning; empty names take tvg-name else "Channel N"', () => {
  const r = parseM3u(text);
  assert.equal(r.channels.filter((c) => c.url === 'http://provider.example/live/u/p/103.ts').length, 1);
  assert.ok(r.warnings.some((w) => /1 duplicate channel/.test(w)), r.warnings.join('|'));
  assert.ok(byName(r, 'Free Channel'));
  assert.equal(r.channels.at(-1).name, 'Channel 7');
});

test('key is the tvg-id (for its first channel), else a 16-hex hash of the URL', () => {
  const r = parseM3u(text);
  assert.equal(byName(r, 'TVNZ 1 HD').key, 'tvnz1.nz');
  assert.match(byName(r, 'Free Channel').key, /^[0-9a-f]{16}$/);
  const shared = parseM3u('#EXTM3U\n#EXTINF:-1 tvg-id="x",A\nhttp://a/1\n#EXTINF:-1 tvg-id="x",B\nhttp://a/2\n');
  assert.equal(shared.channels[0].key, 'x', 'the first keeps its tvg-id');
  assert.match(shared.channels[1].key, /^[0-9a-f]{16}$/, 'a later duplicate is keyed by its address');
  assert.notEqual(shared.channels[0].key, shared.channels[1].key);
  assert.equal(parseM3u(text).channels.map((c) => c.key).join(), r.channels.map((c) => c.key).join(), 'stable');
});

test('BOM, CRLF, blank lines, missing #EXTM3U (warning)', () => {
  const r = parseM3u('﻿#EXTINF:-1 tvg-id="a",A\r\n\r\nhttp://a/1\r\n\r\n#EXTINF:-1,B\r\nhttp://a/2\r\n');
  assert.deepEqual(r.channels.map((c) => [c.name, c.url]), [['A', 'http://a/1'], ['B', 'http://a/2']]);
  assert.ok(r.warnings.some((w) => /#EXTM3U/.test(w)));
});

test('an HTML page throws "The playlist isn\'t an M3U file"', () => {
  assert.throws(() => parseM3u('<!doctype html><html><body>Please log in</body></html>'), /^Error: The playlist isn't an M3U file$/);
  assert.throws(() => parseM3u('  \n\n'), /The playlist isn't an M3U file/);
});

test('20 000 channels parse in under 1 s', () => {
  const lines = ['#EXTM3U'];
  for (let i = 0; i < 20000; i++) lines.push(`#EXTINF:-1 tvg-id="c${i}" tvg-logo="http://l/${i}.png" group-title="G${i % 50}",Channel ${i}`, `http://p/live/u/p/${i}.ts`);
  const big = lines.join('\n');
  const t = performance.now();
  const r = parseM3u(big);
  const ms = performance.now() - t;
  assert.equal(r.channels.length, 20000);
  assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
});

test('a malformed %-escape in a header suffix keeps the channel (the header is taken as written)', () => {
  const r = parseM3u('#EXTM3U\n#EXTINF:-1,A\nhttp://a/1.ts|Referer%ZZ=1&User-Agent=Box%E0\n#EXTINF:-1,B\nhttp://a/2.ts\n');
  assert.deepEqual(r.channels.map((c) => c.name), ['A', 'B']);
  assert.equal(r.channels[0].url, 'http://a/1.ts');
  assert.equal(r.channels[0].headers['Referer%ZZ'], '1');
  assert.equal(r.channels[0].headers['User-Agent'], 'Box%E0');
});

test('stream_params, manifest_params, license_data and server_certificate are read', () => {
  const r = parseM3u(`#EXTM3U
#EXTINF:-1 tvg-id="x.nz",X
#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha
#KODIPROP:inputstream.adaptive.license_key=https://lic.example/wv
#KODIPROP:inputstream.adaptive.server_certificate=Q0VSVA==
#KODIPROP:inputstream.adaptive.license_data=SU5JVA==
#KODIPROP:inputstream.adaptive.manifest_params=a=1
#KODIPROP:inputstream.adaptive.stream_params=b=2
https://cdn.example/x.mpd
`);
  const c = r.channels[0];
  assert.equal(c.drm.systems[0].serverCertificate, 'Q0VSVA==');
  assert.equal(c.drm.systems[0].initData, 'SU5JVA==');
  assert.equal(c.manifestParams, 'a=1');
  assert.equal(c.streamParams, 'b=2');
});

test('a second channel with the same tvg-id doesn\'t take the first one\'s key', () => {
  const r = parseM3u('#EXTM3U\n#EXTINF:-1 tvg-id="dup.nz",One\nhttp://a.example/1.ts\n#EXTINF:-1 tvg-id="dup.nz",Two\nhttp://a.example/2.ts\n');
  assert.equal(r.channels[0].key, 'dup.nz', 'the first keeps its key (favourites stay with it)');
  assert.notEqual(r.channels[1].key, 'dup.nz');
});
