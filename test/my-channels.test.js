// Your own channels (v0.28): 24/7 Live TV channels made from your own films and shows, in the guide beside your
// provider's. A channel is a line in the plugin's settings ("Movie Night = library Movies"); its schedule repeats
// through the titles it picks, so the guide knows what is on at any time, and watching joins the title part-way.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';
import { parseChannels, buildCycle, programmesFor, nowPlaying, concatList, EPOCH } from '../plugins/my-channels/schedule.js';

test('channels are lines: a name, what they show, and optionally "in order"', () => {
  const text = 'Movie Night = library Movies\n\n# a note\nComedy = genre Comedy\nBay 24/7 = show Harbour Lights, in order\nbroken line\nNights = collection Night Films\nFriday = playlist Friday night';
  const { channels, problems } = parseChannels(text);
  assert.deepEqual(channels.map((c) => [c.name, c.rule.type, c.rule.value, c.order]), [
    ['Movie Night', 'library', 'Movies', 'shuffle'],
    ['Comedy', 'genre', 'Comedy', 'shuffle'],
    ['Bay 24/7', 'show', 'Harbour Lights', 'order'],
    ['Nights', 'collection', 'Night Films', 'shuffle'],
    ['Friday', 'playlist', 'Friday night', 'shuffle'],
  ]);
  assert.equal(new Set(channels.map((c) => c.key)).size, 5, 'each has its own key');
  assert.deepEqual(problems, ['Line 6 isn’t a channel: write it as “Name = library Movies”.']);
});

const items = [1, 2, 3, 4, 5].map((id) => ({ id, title: `T${id}`, duration: 600 + id * 60 }));

test('the cycle: in order, or shuffled the same way every time for a channel', () => {
  assert.deepEqual(buildCycle(items, 'order', 'k').map((i) => i.id), [1, 2, 3, 4, 5]);
  const a = buildCycle(items, 'shuffle', 'movies');
  assert.deepEqual(buildCycle(items, 'shuffle', 'movies').map((i) => i.id), a.map((i) => i.id), 'same channel, same order');
  assert.notDeepEqual(buildCycle(items, 'shuffle', 'other').map((i) => i.id), a.map((i) => i.id), 'another channel, another order');
  assert.equal(new Set(a.map((i) => i.id)).size, 5);
});

test('what is on now, and how far in', () => {
  const cycle = buildCycle(items, 'order', 'k'); // 660 + 720 + 780 + 840 + 900 = 3900 s
  const at = (s) => EPOCH + s * 1000;
  assert.deepEqual(nowPlaying(cycle, at(0)), { index: 0, item: cycle[0], offset: 0 });
  assert.deepEqual(nowPlaying(cycle, at(700)), { index: 1, item: cycle[1], offset: 40 });
  assert.deepEqual(nowPlaying(cycle, at(3900 + 10)), { index: 0, item: cycle[0], offset: 10 }, 'it repeats');
  assert.equal(nowPlaying([], at(5)), null);
});

test('the guide: back to back, covering the window asked', () => {
  const cycle = buildCycle(items, 'order', 'k');
  const from = EPOCH + 700 * 1000;
  const progs = programmesFor(cycle, from, from + 2 * 3600 * 1000);
  assert.equal(progs[0].start, EPOCH + 660 * 1000, 'the one on now, from its real start');
  for (let i = 1; i < progs.length; i++) assert.equal(progs[i].start, progs[i - 1].end);
  assert.ok(progs.at(-1).end >= from + 2 * 3600 * 1000);
  assert.equal(progs[0].itemId, 2);
});

test('the playout list for ffmpeg: the title on now from its point, then the next ones; quotes escaped', () => {
  const txt = concatList([{ path: "/m/It's.mp4", inpoint: 40 }, { path: '/m/B.mkv' }]);
  assert.equal(txt, "ffconcat version 1.0\nfile '/m/It'\\''s.mp4'\ninpoint 40\nfile '/m/B.mkv'\n");
});

let nf, admin;
const skip = !hasFfmpeg && 'ffmpeg not installed';
before(async () => {
  if (!hasFfmpeg) return;
  const media = tempDir();
  for (const t of ['Alpha (2001)', 'Beta (2002)']) makeVideo(path.join(media, 'Movies', t, `${t}.mp4`), { seconds: 6 });
  nf = await startAtomix({}, { skipLiveRefresh: false });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [path.join(media, 'Movies')] });
  await waitForScan(admin);
});
after(async () => nf?.app.stop());

test('turned on with a channel: it is in Live TV with a guide, and its stream is real video', { skip, timeout: 60000 }, async () => {
  assert.equal((await admin.put('/api/admin/plugins/my-channels/config', { channels: 'Movie Night = library Movies' })).status, 200);
  assert.equal((await admin.post('/api/admin/plugins/my-channels/enabled', { enabled: true })).status, 200);
  let chans = [];
  for (let i = 0; i < 50 && !chans.length; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const r = (await admin.get('/api/live/channels')).data;
    chans = Array.isArray(r) ? r : [];
  }
  const ch = chans.find((c) => c.name === 'Movie Night');
  assert.ok(ch, JSON.stringify(chans).slice(0, 300));
  assert.ok(ch.now?.title === 'Alpha' || ch.now?.title === 'Beta', JSON.stringify(ch.now));
  // The playout itself (what the tuner reads): MPEG-TS packets, only from this machine with the plugin's key.
  const row = nf.app.core.db.get('SELECT source, key FROM live_channels WHERE id = ?', ch.id);
  const source = nf.app.core.plugins.getLiveSource(row.source);
  const { url } = await source.stream(row.key, {});
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/api\/plugins\/my-channels\/live\//);
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  reader.cancel();
  assert.equal(value[0], 0x47, 'an MPEG-TS sync byte');
  const wrong = await fetch(url.replace(/key=[^&]+/, 'key=nope'));
  assert.equal(wrong.status, 401);
});
