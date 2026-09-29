import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNfo } from '../plugins/nfo-metadata/index.js';
import { srtToVtt } from '../src/stream/subtitles.js';
import { parseVtt, cueHtml } from '../public/js/vtt.js';

test('Kodi movie.nfo', () => {
  const xml = `<?xml version="1.0"?>
  <movie>
    <title>Heat</title><originaltitle>Heat</originaltitle><year>1995</year>
    <plot>Cops &amp; robbers.</plot><runtime>170</runtime>
    <ratings><rating name="imdb" max="10" default="true"><value>8.3</value><votes>700000</votes></rating></ratings>
    <genre>Crime</genre><genre>Drama / Thriller</genre>
    <uniqueid type="imdb">tt0113277</uniqueid><uniqueid type="tmdb" default="true">949</uniqueid>
    <thumb aspect="poster">https://image.example/poster.jpg</thumb>
    <fanart><thumb>https://image.example/fanart.jpg</thumb></fanart>
    <actor><name>Al Pacino</name><thumb>https://image.example/al.jpg</thumb></actor>
  </movie>`;
  const r = parseNfo(xml);
  assert.equal(r.title, 'Heat');
  assert.equal(r.year, 1995);
  assert.equal(r.overview, 'Cops & robbers.');
  assert.equal(r.rating, 8.3);
  assert.deepEqual(r.genres, ['Crime', 'Drama', 'Thriller']);
  assert.equal(r.tmdbId, 949);
  assert.equal(r.imdbId, 'tt0113277');
  assert.equal(r.poster, 'https://image.example/poster.jpg');
  assert.equal(r.backdrop, 'https://image.example/fanart.jpg');
  assert.equal(r.runtime, 170);
});

test('URL-only nfo', () => {
  assert.deepEqual(parseNfo('https://www.themoviedb.org/movie/603-the-matrix'), { tmdbId: 603 });
  assert.deepEqual(parseNfo('https://www.imdb.com/title/tt0133093/'), { imdbId: 'tt0133093' });
});

test('SRT → VTT', () => {
  const vtt = srtToVtt('1\r\n00:00:01,500 --> 00:00:03,000\r\nHello, world\r\n');
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.match(vtt, /00:00:01\.500 --> 00:00:03\.000/);
});

test('VTT parsing and safe cue HTML', () => {
  const cues = parseVtt('WEBVTT\n\nNOTE hi\n\n00:01.000 --> 00:02.500 align:start\n<v Bob>Hi <i>there</i>\n\n1\n00:00:03.000 --> 00:00:04.000\nLine &amp; two\n');
  assert.equal(cues.length, 2);
  assert.deepEqual([cues[0].start, cues[0].end], [1, 2.5]);
  assert.equal(cueHtml(cues[0].text), 'Hi <i>there</i>');
  assert.equal(cueHtml(cues[1].text), 'Line &amp; two');
  assert.equal(cueHtml('<img src=x onerror=alert(1)>boo'), 'boo');
  assert.equal(cueHtml('&lt;script&gt;'), '&lt;script&gt;');
  assert.equal(cueHtml('<i onclick="x">a</i>'), 'a</i>');
});
