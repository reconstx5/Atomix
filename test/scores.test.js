// Outside scores (v0.23): a metadata provider's IMDb / Rotten Tomatoes / Metacritic scores are checked, stored,
// served and shown; Edit details can clear them (and they stay clear until unlocked).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';
import { cleanScores } from '../src/library/metadata.js';
import { scoresText } from '../public/js/scores.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'score-plugins');

test('cleanScores keeps only known, well-formed scores', () => {
  assert.deepEqual(cleanScores([{ source: 'imdb', value: '7.8/10' }, { source: 'rt', value: '93%' }, { source: 'x', value: '1' }, { source: 'metacritic', value: '81/100' }, { value: '5' }]), [
    { source: 'imdb', value: '7.8/10' },
    { source: 'rt', value: '93%' },
    { source: 'metacritic', value: '81/100' },
  ]);
  assert.equal(cleanScores('7.8'), null);
  assert.equal(cleanScores({}), null);
  assert.equal(cleanScores([]), null);
  assert.equal(cleanScores([{ source: 'imdb', value: 'great' }]), null);
});

test('scoresText reads the three scores in order', () => {
  assert.equal(scoresText([{ source: 'rt', value: '93%' }, { source: 'imdb', value: '7.8/10' }]), 'IMDb 7.8 · Rotten Tomatoes 93%');
  assert.equal(scoresText([{ source: 'metacritic', value: '81/100' }, { source: 'rt', value: '93%' }, { source: 'imdb', value: '7.8/10' }]), 'IMDb 7.8 · Rotten Tomatoes 93% · Metacritic 81');
  assert.equal(scoresText(null), '');
});

let nf;
let admin;
let film;
before(async () => {
  if (!hasFfmpeg) return;
  const media = tempDir();
  makeVideo(path.join(media, 'Movies', 'Scored (2001)', 'Scored (2001).mp4'), { seconds: 2 });
  nf = await startAtomix({ ATOMIX_PLUGINS_DIR: PLUGINS }, { skipLiveRefresh: true });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const lib = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [path.join(media, 'Movies')] })).data.id;
  await waitForScan(admin);
  film = (await admin.get(`/api/libraries/${lib}/items`)).data.items[0].id;
});
after(async () => {
  await nf?.app.stop();
});

test("a provider's scores are stored and served", { skip }, async () => {
  const it = (await admin.get(`/api/items/${film}`)).data.item;
  assert.deepEqual(it.scores, [{ source: 'imdb', value: '7.8/10' }, { source: 'rt', value: '93%' }, { source: 'metacritic', value: '81/100' }]);
});

test('clearing scores in Edit details keeps them clear on the next refresh', { skip }, async () => {
  const r = await admin.patch(`/api/items/${film}/details`, { clearScores: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await admin.get(`/api/items/${film}`)).data.item.scores, null);
  await admin.post(`/api/items/${film}/refresh`, {});
  assert.equal((await admin.get(`/api/items/${film}`)).data.item.scores, null, 'still clear');
  await admin.patch(`/api/items/${film}/details`, { unlock: ['scores'] });
  await admin.post(`/api/items/${film}/refresh`, {});
  assert.equal((await admin.get(`/api/items/${film}`)).data.item.scores.length, 3, 'unlocked: filled again');
});
