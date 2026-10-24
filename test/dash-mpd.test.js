// The browser DASH player's pure pieces: a small XML reader (public/js/dash/xml.js) and the manifest reader
// (public/js/dash/mpd.js), on manifests shaped like real live and on-demand streams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseXml, serializeXml } from '../public/js/dash/xml.js';
import { parseMpd, parseDuration, systemOf } from '../public/js/dash/mpd.js';

const fx = (name) => fs.readFileSync(new URL(`./fixtures/dash/${name}`, import.meta.url), 'utf8');
const KID = 'a7e61c373e219033c21091fa607bf3b8';

test('parseXml reads elements, attributes, text, entities, CDATA and skips comments and the declaration', () => {
  const root = parseXml('<?xml version="1.0"?><!-- c --><a x="1" y=\'two &amp; &quot;3&quot;\'><b>t &lt;&#65;&#x42;&gt;</b><c/><d><![CDATA[<raw>]]></d></a>');
  assert.equal(root.name, 'a');
  assert.deepEqual(root.attrs, { x: '1', y: 'two & "3"' });
  assert.deepEqual(root.children.map((c) => c.name), ['b', 'c', 'd']);
  assert.equal(root.children[0].text, 't <AB>');
  assert.equal(root.children[2].text, '<raw>');
});

test('serializeXml round-trips the fixtures\' elements and attributes', () => {
  for (const f of ['live-number.mpd', 'live-timeline.mpd', 'baseurls.mpd']) {
    const a = parseXml(fx(f));
    const b = parseXml(serializeXml(a));
    assert.deepEqual(b, a, f);
  }
  assert.match(serializeXml(parseXml('<a v="&lt;&amp;&quot;"/>')), /v="&lt;&amp;&quot;"/);
});

test('hostile XML is refused, never expanded or hung on', () => {
  assert.throws(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'), /bad xml/);
  assert.throws(() => parseXml('<a><b></a>'), /bad xml/);
  assert.throws(() => parseXml('<a>'), /bad xml/);
  assert.throws(() => parseXml('<a>&unknown;</a>'), /bad xml/);
  assert.throws(() => parseXml('<a>'.repeat(65) + '</a>'.repeat(65)), /bad xml/, 'too deep');
  assert.throws(() => parseXml(`<a>${'<b/>'.repeat(20_001)}</a>`), /bad xml/, 'too many nodes');
  assert.throws(() => parseXml(`<a>${'x'.repeat(2_000_001)}</a>`), /bad xml/, 'too big');
  assert.doesNotThrow(() => parseXml('<a>'.repeat(64) + '</a>'.repeat(64)));
});

test('parseDuration reads ISO 8601 durations into seconds', () => {
  assert.equal(parseDuration('PT1H2M3.5S'), 3723.5);
  assert.equal(parseDuration('P1DT1S'), 86401);
  assert.equal(parseDuration('PT0S'), 0);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration(undefined), null);
});

test('systemOf names the protection schemes', () => {
  assert.equal(systemOf('urn:uuid:EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED'), 'widevine');
  assert.equal(systemOf('urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e'), 'clearkey');
  assert.equal(systemOf('urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b'), 'clearkey');
  assert.equal(systemOf('urn:mpeg:dash:mp4protection:2011'), 'cenc');
  assert.equal(systemOf('urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95'), 'playready');
  assert.equal(systemOf('urn:example'), null);
});

test('a live manifest: times, periods, video/audio split, templates merged down, protection and KIDs', () => {
  const m = parseMpd(fx('live-number.mpd'), 'https://cdn.example/live/channel.mpd');
  assert.equal(m.type, 'dynamic');
  assert.equal(m.availabilityStartTime, Date.UTC(2026, 9, 10, 0, 0, 0));
  assert.equal(m.publishTime, Date.UTC(2026, 9, 10, 6, 0, 0));
  assert.deepEqual([m.minimumUpdatePeriod, m.timeShiftBufferDepth, m.suggestedPresentationDelay, m.maxSegmentDuration, m.minBufferTime], [2, 60, 6, 2, 4]);
  assert.deepEqual(m.utcTiming, [{ scheme: 'urn:mpeg:dash:utc:http-iso:2014', value: 'https://time.example/iso' }]);
  assert.equal(m.periods.length, 1);
  const p = m.periods[0];
  assert.equal(p.start, 0);
  assert.deepEqual(p.adaptationSets.map((a) => a.type), ['video', 'audio', 'text']);
  const [video, audio] = p.adaptationSets;
  assert.deepEqual(video.representations.map((r) => [r.id, r.bandwidth, r.codecs, r.width, r.height, r.mimeType]), [
    ['v720', 3000000, 'avc1.4d401f', 1280, 720, 'video/mp4'],
    ['v1080', 6000000, 'avc1.640028', 1920, 1080, 'video/mp4'],
  ]);
  assert.deepEqual(video.representations[0].template, { media: '$RepresentationID$/seg-$Number%05d$.m4s', initialization: '$RepresentationID$/init.mp4', startNumber: 100, timescale: 1, duration: 2, presentationTimeOffset: 0, timeline: null });
  assert.equal(video.representations[0].baseUrl, 'https://cdn.example/live/');
  assert.deepEqual(video.contentProtection.map((c) => c.system), ['cenc', 'widevine']);
  assert.equal(video.contentProtection[0].kid, KID);
  assert.match(video.contentProtection[1].pssh, /^AAAAQnBzc2g/);
  assert.equal(audio.lang, 'en');
  assert.deepEqual(audio.contentProtection.map((c) => [c.system, c.kid]), [['cenc', KID], ['clearkey', null]]);
  assert.equal(audio.representations[0].codecs, 'mp4a.40.2');
  assert.deepEqual(audio.representations[0].contentProtection, audio.contentProtection, 'a representation carries its set\'s protection');
});

test('a timeline manifest keeps S entries with t, d and r (including r=-1) and the presentation time offset', () => {
  const m = parseMpd(fx('live-timeline.mpd'), 'https://cdn.example/x.mpd');
  const rep = m.periods[0].adaptationSets[0].representations[0];
  assert.equal(rep.codecs, 'avc1.4d401f', 'codecs from the adaptation set');
  assert.equal(rep.template.timescale, 90000);
  assert.equal(rep.template.presentationTimeOffset, 900000);
  assert.equal(rep.template.startNumber, 1, 'startNumber defaults to 1');
  assert.deepEqual(rep.template.timeline, [{ t: 900000, d: 180000, r: 2 }, { t: null, d: 90000, r: 0 }, { t: 1800000, d: 180000, r: -1 }]);
});

test('on demand: static type, duration, and a template given on the representation', () => {
  const m = parseMpd(fx('vod.mpd'), 'http://127.0.0.1:9919/drm/vod/manifest.mpd');
  assert.equal(m.type, 'static');
  assert.equal(m.mediaPresentationDuration, 10);
  const rep = m.periods[0].adaptationSets[0].representations[0];
  assert.equal(rep.template.duration, 2000);
  assert.equal(rep.template.timescale, 1000);
  assert.equal(rep.baseUrl, 'http://127.0.0.1:9919/drm/vod/');
});

test('periods: a start from the previous period\'s end, or its own start', () => {
  const m = parseMpd(fx('multi-period.mpd'), 'https://x.example/m.mpd');
  assert.deepEqual(m.periods.map((p) => [p.id, p.start, p.duration]), [['ad', 0, 15], ['show', 15, null], ['later', 40.5, null]]);
});

test('BaseURL nesting resolves through MPD, period, adaptation set and representation; an absolute one replaces', () => {
  const m = parseMpd(fx('baseurls.mpd'), 'https://origin.example/manifests/live.mpd');
  const [video, audio] = m.periods[0].adaptationSets;
  assert.equal(video.representations[0].baseUrl, 'https://cdn1.example/root/p1/video/hd/');
  assert.equal(video.representations[1].baseUrl, 'https://cdn1.example/root/p1/video/');
  assert.equal(audio.representations[0].baseUrl, 'https://cdn2.example/audio/');
  assert.equal(audio.representations[0].template.media, 'a$Number$.m4s');
  assert.equal(video.representations[0].template.media, '$Number$.m4s', 'inherited from the adaptation set');
});

test('a manifest that isn\'t an MPD, or has no period, is refused', () => {
  assert.throws(() => parseMpd('<html></html>', 'https://x/'), /not a DASH manifest/);
  assert.throws(() => parseMpd('<MPD type="static"></MPD>', 'https://x/'), /not a DASH manifest/);
  assert.throws(() => parseMpd('not xml', 'https://x/'), /bad xml|not a DASH manifest/);
});
