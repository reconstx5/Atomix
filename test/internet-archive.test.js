// The Internet Archive plugin, with archive.org replaced by canned responses
// shaped like the real advancedsearch and metadata APIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../plugins/internet-archive/index.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fakeApi(responses) {
  const calls = [];
  let source;
  const api = {
    config: { collections: 'Feature Films = feature_films\nFilm Noir = Film_Noir', pageSize: 12, sort: 'downloads desc' },
    HttpError,
    log: { info() {}, debug() {}, warn() {} },
    registerSource(s) {
      source = s;
    },
    async fetch(url) {
      calls.push(String(url));
      const hit = Object.entries(responses).find(([k]) => String(url).includes(k));
      if (!hit) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => hit[1] };
    },
  };
  setup(api);
  return { source, calls };
}

test('lists collections, pages through results and picks an MP4', async () => {
  const { source, calls } = fakeApi({
    'advancedsearch.php': {
      response: {
        numFound: 30,
        docs: [
          { identifier: 'sex_madness', title: 'Sex Madness', year: '1938', description: ['A <b>1938</b> exploitation film.'] },
          { identifier: 'plan9', title: 'Plan 9 from Outer Space', description: 'Classic.' },
        ],
      },
    },
    'metadata/sex_madness': {
      metadata: { title: 'Sex Madness' },
      files: [
        { name: '__ia_thumb.jpg', format: 'JPEG Thumb', source: 'original' },
        { name: 'sex_madness.mpeg', format: 'MPEG2', source: 'original', height: '720' },
        { name: 'sex_madness.ogv', format: 'Ogg Video', source: 'derivative', height: '304' },
        { name: 'sex_madness.mp4', format: 'h.264', source: 'derivative', height: '480', length: '3117.52' },
      ],
    },
  });
  const root = await source.browse('', { query: {} });
  assert.deepEqual(root.items.map((i) => i.title), ['Feature Films', 'Film Noir']);
  assert.equal(root.items[0].kind, 'folder');

  const page = await source.browse('collection:feature_films', { query: {} });
  assert.equal(page.items[0].title, 'Sex Madness');
  assert.equal(page.items[0].year, 1938);
  assert.equal(page.items[0].overview, 'A 1938 exploitation film.');
  assert.equal(page.next, 'collection:feature_films:page:2');
  const searchUrl = new URL(calls[0]);
  assert.equal(searchUrl.searchParams.get('q'), 'collection:(feature_films) AND mediatype:(movies)');
  assert.equal(searchUrl.searchParams.get('fl[]'), 'identifier,title,year,description');

  const found = await source.browse('', { query: { q: 'plan 9!' } });
  assert.equal(found.title, 'Search: plan 9!');

  const played = await source.resolve('sex_madness');
  assert.equal(played.url, 'https://archive.org/download/sex_madness/sex_madness.mp4');
  assert.equal(played.duration, 3117.52);

  await assert.rejects(() => source.resolve('../etc/passwd'), /Bad identifier/);
  await assert.rejects(() => source.browse('collection:bad id', { query: {} }), /Unknown folder/);
});
