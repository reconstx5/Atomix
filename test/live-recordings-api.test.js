// The recordings routes (src/api/recordings.js): record a programme or a series, list, stop, delete, rules, the
// guide's recording marks, Kids kept out, and the Recording settings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAtomix, client, tempDir, hasFfmpeg, makeVideo } from './helpers.js';

const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-plugins');
const KEY = 'live-test/canned';
let nf, admin, kid, guest, ids, core;

before(async () => {
  process.env.LIVE_TEST_DRM = '1';
  process.env.LIVE_TEST_MAX = '1';
  nf = await startAtomix({ ATOMIX_PLUGINS_DIR: PLUGINS }, { skipLiveRefresh: true });
  core = nf.app.core;
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const me = (await admin.get('/api/profiles')).data[0].id;
  await admin.post(`/api/profiles/${me}/select`, {});
  const kidId = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data.id;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${kidId}/select`, {});
  await admin.put(`/api/profiles/${kidId}/live-groups`, [{ source: KEY, group: 'Kids' }]);
  await admin.post('/api/users', { username: 'guest', password: 'guestpass1' });
  guest = client(nf.base);
  await guest.post('/api/auth/login', { username: 'guest', password: 'guestpass1' });
  await admin.post(`/api/live/sources/${encodeURIComponent(KEY)}/refresh`, {});
  ids = Object.fromEntries((await admin.get('/api/live/channels')).data.map((c) => [c.name, c.id]));
});
after(async () => {
  delete process.env.LIVE_TEST_DRM;
  delete process.env.LIVE_TEST_MAX;
  await nf?.app.stop();
});

/** A programme on a channel starting `inHalfHours` half-hours from now (the canned guide is in half hours). */
async function programmeOn(name, inHalfHours) {
  const from = Date.now();
  const g = (await admin.get(`/api/live/guide?from=${from}&to=${from + 6 * 3600_000}&channels=${ids[name]}`)).data;
  return g.programmes[ids[name]].filter((p) => p.start > from)[inHalfHours - 1];
}

test('record a programme, list it as scheduled, cancel it', async () => {
  const p = await programmeOn('One', 2);
  const r = await admin.post(`/api/live/programmes/${p.id}/record`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.recording.status, 'scheduled');
  assert.equal(r.data.recording.title, p.title);
  assert.equal(r.data.rule, null);
  assert.equal(r.data.clash, null);
  const again = await admin.post(`/api/live/programmes/${p.id}/record`, {});
  assert.equal(again.data.recording.id, r.data.recording.id, 'the same airing once');
  const list = (await admin.get('/api/live/recordings')).data;
  assert.deepEqual(Object.keys(list).sort(), ['done', 'failed', 'recording', 'rules', 'scheduled']);
  const row = list.scheduled.find((x) => x.id === r.data.recording.id);
  assert.equal(row.profile, 'dallas');
  assert.equal(row.channel, 'One');
  assert.ok(!JSON.stringify(list).includes('secretpw'), 'no provider address');
  // Another grown-up on the household sees it too (the page shows everyone's).
  assert.ok((await guest.get('/api/live/recordings')).data.scheduled.some((x) => x.id === r.data.recording.id));
  const del = await admin.del(`/api/live/recordings/${r.data.recording.id}`);
  assert.equal(del.status, 200);
  assert.ok(!(await admin.get('/api/live/recordings')).data.scheduled.some((x) => x.id === r.data.recording.id));
  assert.equal(core.live.recordings.get(r.data.recording.id).status, 'cancelled');
});

test('a clash with another recording is warned about, and still scheduled', async () => {
  const a = await programmeOn('One', 3);
  const b = await programmeOn('Two', 3);
  await admin.post(`/api/live/programmes/${a.id}/record`, {});
  const r = await admin.post(`/api/live/programmes/${b.id}/record`, {});
  assert.equal(r.data.recording.status, 'scheduled');
  assert.equal(r.data.clash, 'Your provider allows 1 stream at a time — this overlaps 1 other recording');
  const row = (await admin.get('/api/live/recordings')).data.scheduled.find((x) => x.id === r.data.recording.id);
  assert.equal(row.clash, r.data.clash);
  for (const x of (await admin.get('/api/live/recordings')).data.scheduled) await admin.del(`/api/live/recordings/${x.id}`);
});

test('record series makes a rule and schedules its episodes', async () => {
  // The canned guide names programmes "<Channel> <n>": make two airings share a title.
  const chan = core.live.store.channel(ids.Three);
  const now = Date.now();
  const half = 30 * 60_000;
  const at = Math.floor(now / half) * half;
  core.db.run("UPDATE live_programmes SET title = 'Quiz Night' WHERE channel_id = ? AND start IN (?, ?)", chan.id, at + 2 * half, at + 6 * half);
  const p = core.db.get('SELECT id FROM live_programmes WHERE channel_id = ? AND start = ?', chan.id, at + 2 * half);
  const r = await admin.post(`/api/live/programmes/${p.id}/record`, { series: true, keep: 5 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.rule);
  assert.equal(r.data.rule.keep, 5);
  assert.equal(r.data.rule.newOnly, true);
  assert.equal(r.data.rule.channel, 'Three');
  const list = (await admin.get('/api/live/recordings')).data;
  assert.equal(list.scheduled.filter((x) => x.title === 'Quiz Night').length, 2);
  assert.equal(list.rules.length, 1);
  // Edit the rule, then stop the series: its future recordings are cancelled.
  const patched = await admin.patch(`/api/live/rules/${r.data.rule.id}`, { keep: 10, newOnly: false, channelKey: null });
  assert.equal(patched.status, 200);
  assert.deepEqual([patched.data.keep, patched.data.newOnly, patched.data.channel], [10, false, null]);
  assert.equal((await admin.patch(`/api/live/rules/${r.data.rule.id}`, { keep: 7 })).status, 400);
  assert.equal((await admin.del(`/api/live/rules/${r.data.rule.id}`)).status, 200);
  const after = (await admin.get('/api/live/recordings')).data;
  assert.equal(after.rules.length, 0);
  assert.equal(after.scheduled.filter((x) => x.title === 'Quiz Night').length, 0);
});

test('encrypted and radio channels can\'t be recorded; Kids get 403; a programme that ended can\'t be', async () => {
  const enc = await programmeOn('Five', 1);
  assert.deepEqual([(await admin.post(`/api/live/programmes/${enc.id}/record`, {})).status, (await admin.post(`/api/live/programmes/${enc.id}/record`, {})).data.error], [400, "Encrypted channels can't be recorded"]);
  const radio = await programmeOn('Radio Waves', 1);
  const rr = await admin.post(`/api/live/programmes/${radio.id}/record`, {});
  assert.deepEqual([rr.status, rr.data.error], [400, "Radio can't be recorded"]);
  const p = await programmeOn('Two', 1);
  const k = await kid.post(`/api/live/programmes/${p.id}/record`, {});
  assert.deepEqual([k.status, k.data.error], [403, "Kids profiles can't record"]);
  assert.equal((await kid.get('/api/live/recordings')).status, 403);
  const past = core.db.get('SELECT id FROM live_programmes WHERE channel_id = ? AND end < ? ORDER BY end DESC LIMIT 1', ids.One, Date.now());
  const pr = await admin.post(`/api/live/programmes/${past.id}/record`, {});
  assert.deepEqual([pr.status, pr.data.error], [400, 'This programme has ended']);
  assert.equal((await admin.post('/api/live/programmes/999999/record', {})).status, 404);
});

test('the guide marks scheduled programmes (not for Kids); the programme sheet says what can be recorded', async () => {
  const p = await programmeOn('One', 4);
  const r = await admin.post(`/api/live/programmes/${p.id}/record`, {});
  const from = Date.now();
  const g = (await admin.get(`/api/live/guide?from=${from}&to=${from + 6 * 3600_000}&channels=${ids.One}`)).data;
  assert.equal(g.programmes[ids.One].find((x) => x.id === p.id).recording, 'scheduled');
  assert.equal(g.programmes[ids.One].find((x) => x.id !== p.id).recording, null);
  assert.equal(g.programmes[ids.One][0].repeat, false);
  const sheet = (await admin.get(`/api/live/programmes/${p.id}`)).data;
  assert.equal(sheet.recording, 'scheduled');
  assert.equal(sheet.canRecord, true);
  const enc = await programmeOn('Five', 1);
  assert.equal((await admin.get(`/api/live/programmes/${enc.id}`)).data.canRecord, false);
  // Kids: no marks, no Record.
  const kp = await programmeOn('Two', 1);
  const kidSheet = (await kid.get(`/api/live/programmes/${kp.id}`)).data;
  assert.equal(kidSheet.canRecord, false);
  assert.equal(kidSheet.recording, null);
  await admin.del(`/api/live/recordings/${r.data.recording.id}`);
});

test('deleting a done recording removes its file and item', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = core.config.recordingsDir;
  const file = path.join(dir, 'Old Show', 'Old Show - S01E01.mkv');
  makeVideo(file, { seconds: 1 });
  fs.writeFileSync(file.replace(/\.mkv$/, '.nfo'), '<episodedetails/>');
  const profileId = core.db.get('SELECT id FROM profiles WHERE kids = 0 LIMIT 1').id;
  const id = core.live.recordings.add({ profileId, source: KEY, channelKey: 'one', channelName: 'One', title: 'Old Show', season: 1, episode: 1, start: Date.now() - 7200_000, end: Date.now() - 5400_000, status: 'done', path: file });
  await core.live.scheduler.addToLibrary(id, file);
  const itemId = core.live.recordings.get(id).itemId;
  assert.ok(itemId, 'it was in the library');
  const listed = (await admin.get('/api/live/recordings')).data.done.find((x) => x.id === id);
  assert.equal(listed.itemId, itemId);
  const del = await admin.del(`/api/live/recordings/${id}`);
  assert.equal(del.status, 200);
  assert.ok(!fs.existsSync(file) && !fs.existsSync(file.replace(/\.mkv$/, '.nfo')));
  assert.equal(core.db.get('SELECT 1 AS x FROM items WHERE id = ?', itemId), undefined);
  assert.equal(core.db.get("SELECT COUNT(*) AS n FROM items WHERE kind = 'show' AND title LIKE 'Old Show%'").n, 0, 'the emptied show goes too');
  assert.equal(core.live.recordings.get(id), null);
});

test('the Recording settings: an unwritable recordings folder is refused; padding is kept in range', async () => {
  const bad = await admin.put('/api/admin/settings', { recordingsDir: 'relative/folder' });
  assert.deepEqual([bad.status, bad.data.error], [400, "Atomix can't write to that folder"]);
  const file = path.join(tempDir(), 'a-file');
  fs.writeFileSync(file, 'x');
  const notDir = await admin.put('/api/admin/settings', { recordingsDir: path.join(file, 'sub') });
  assert.deepEqual([notDir.status, notDir.data.error], [400, "Atomix can't write to that folder"]);
  const good = path.join(tempDir(), 'recs');
  const ok = await admin.put('/api/admin/settings', { recordingsDir: good, recordPre: 99, recordPost: -4 });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual([ok.data.recordingsDir, ok.data.recordPre, ok.data.recordPost], [good, 30, 0]);
  assert.ok(fs.statSync(good).isDirectory());
  assert.equal((await admin.put('/api/admin/settings', { recordingsDir: '' })).data.recordingsDir, '', 'back to the default');
  // v0.21: not the data folder (or inside it, except the default recordings folder), not a drive's top level
  const SENT = "Pick a folder that isn't the Atomix data folder or a drive's top level";
  for (const dir of [core.config.dataDir, path.join(core.config.dataDir, 'elsewhere'), path.parse(core.config.dataDir).root]) {
    const r = await admin.put('/api/admin/settings', { recordingsDir: dir });
    assert.deepEqual([r.status, r.data.error], [400, SENT], dir);
  }
  assert.equal((await admin.put('/api/admin/settings', { recordingsDir: core.config.recordingsDir })).status, 200, 'the default folder itself is fine');
  await admin.put('/api/admin/settings', { recordingsDir: '' });
});

test('the Dashboard lists the next 3 recordings', async () => {
  const made = [];
  for (const n of [2, 3, 4, 5]) made.push((await admin.post(`/api/live/programmes/${(await programmeOn('Two', n)).id}/record`, {})).data.recording);
  const dash = (await admin.get('/api/admin/dashboard')).data;
  assert.deepEqual(dash.nextRecordings.map((x) => x.id), made.slice(0, 3).map((x) => x.id));
  assert.equal(dash.nextRecordings[0].channel, 'Two');
  for (const x of made) await admin.del(`/api/live/recordings/${x.id}`);
});

test('Kids see a recording in the library only when its channel is in one of their groups', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = core.config.recordingsDir;
  const profileId = core.db.get('SELECT id FROM profiles WHERE kids = 0 LIMIT 1').id;
  const make = async (show, channelName) => {
    const file = path.join(dir, show, `${show} - S01E01.mkv`);
    makeVideo(file, { seconds: 1 });
    const id = core.live.recordings.add({ profileId, source: KEY, channelKey: channelName.toLowerCase(), channelId: ids[channelName], channelName, title: show, season: 1, episode: 1, start: Date.now() - 7200_000, end: Date.now() - 5400_000, status: 'done', path: file });
    await core.live.scheduler.addToLibrary(id, file);
    return core.live.recordings.get(id).itemId;
  };
  const news = await make('Grown Up News', 'One'); // group News: not ticked for Mia
  const cartoons = await make('Cartoons', 'Two'); // group Kids: ticked
  core.db.run('UPDATE items SET min_age = 0'); // rated for everyone: only the channel group decides
  assert.equal((await kid.get(`/api/items/${news}`)).status, 404);
  assert.equal((await kid.get(`/api/items/${cartoons}`)).status, 200);
  const lib = core.db.get("SELECT id FROM libraries WHERE name = 'Recordings'").id;
  const shows = (await kid.get(`/api/libraries/${lib}/items`)).data;
  const titles = JSON.stringify(shows);
  assert.ok(titles.includes('Cartoons') && !titles.includes('Grown Up News'), titles.slice(0, 300));
  assert.equal((await admin.get(`/api/items/${news}`)).status, 200, 'grown-ups see it');
});

test('the programme sheet names its recording and its series; marks survive a guide refresh; Cancel recording leaves the series', async () => {
  const chan = core.live.store.channel(ids.Three);
  const half = 30 * 60_000;
  const at = Math.floor(Date.now() / half) * half;
  const [s2, s6] = [at + 8 * half, at + 10 * half]; // not the airings an earlier test cancelled
  core.db.run("UPDATE live_programmes SET title = 'Film Club' WHERE channel_id = ? AND start IN (?, ?)", chan.id, s2, s6);
  const idAt = (start) => core.db.get('SELECT id FROM live_programmes WHERE channel_id = ? AND start = ?', chan.id, start).id;
  const r = (await admin.post(`/api/live/programmes/${idAt(s2)}/record`, { series: true })).data;
  const sheet = (await admin.get(`/api/live/programmes/${idAt(s2)}`)).data;
  assert.equal(sheet.recordingId, r.recording.id);
  assert.equal(sheet.ruleId, r.rule.id);
  const other = (await admin.get(`/api/live/programmes/${idAt(s6)}`)).data;
  assert.ok(other.recordingId && other.recordingId !== r.recording.id);
  assert.equal(other.ruleId, r.rule.id);
  const plain = (await admin.get(`/api/live/programmes/${idAt(at + 9 * half)}`)).data;
  assert.deepEqual([plain.recordingId, plain.ruleId], [null, null]);
  assert.equal((await kid.get(`/api/live/programmes/${(await programmeOn('Two', 1)).id}`)).data.ruleId, null);
  // Cancel this airing: the rule and its other airing stay.
  await admin.del(`/api/live/recordings/${r.recording.id}`);
  const list = (await admin.get('/api/live/recordings')).data;
  assert.ok(list.rules.some((x) => x.id === r.rule.id));
  assert.ok(list.scheduled.some((x) => x.id === other.recordingId));
  // A guide refresh gives programmes new ids: the mark stays on the airing.
  const oldId = idAt(s6);
  await admin.post(`/api/live/sources/${encodeURIComponent(KEY)}/refresh`, {});
  const newId = idAt(s6);
  assert.notEqual(newId, oldId);
  const after = (await admin.get(`/api/live/programmes/${newId}`)).data;
  assert.deepEqual([after.recording, after.recordingId], ['scheduled', other.recordingId]);
  await admin.del(`/api/live/rules/${r.rule.id}`);
});

test('the settings say where recordings go by default', async () => {
  const s = (await admin.get('/api/admin/settings')).data;
  assert.equal(s.recordingsDirDefault, path.join(core.config.dataDir, 'recordings'));
  assert.equal(s.recordingsDir, '');
});

test('review fixes: a sheet\'s Cancel never deletes a finished recording; rules list the channels they can move to', async () => {
  const profileId = core.db.get('SELECT id FROM profiles WHERE kids = 0 LIMIT 1').id;
  const id = core.live.recordings.add({ profileId, source: KEY, channelKey: 'one', channelName: 'One', title: 'Finished Show', start: Date.now() - 7200_000, end: Date.now() - 5400_000, status: 'done', path: path.join(tempDir(), 'x.mkv') });
  const r = await admin.del(`/api/live/recordings/${id}?only=active`);
  assert.deepEqual([r.status, r.data.error], [409, 'This recording has finished']);
  assert.equal(core.live.recordings.get(id).status, 'done', 'kept');
  core.live.recordings.remove(id);
  const p = await programmeOn('One', 6);
  const made = (await admin.post(`/api/live/programmes/${p.id}/record`, { series: true })).data;
  const rule = (await admin.get('/api/live/recordings')).data.rules.find((x) => x.id === made.rule.id);
  assert.deepEqual(rule.channelOptions.map((c) => c.name).sort(), ['One', 'Three', 'Two'], 'TV channels only: not radio, not encrypted');
  assert.ok(rule.channelOptions.every((c) => typeof c.key === 'string'));
  assert.equal((await admin.del(`/api/live/recordings/${made.recording.id}?only=active`)).status, 200, 'a scheduled one is cancelled');
  await admin.del(`/api/live/rules/${made.rule.id}`);
});

test('the programme sheet\'s Stop series is the rule its airing came from (not just the first that matches)', async () => {
  const chan = core.live.store.channel(ids.Two);
  const p = await programmeOn('Two', 12);
  core.db.run("UPDATE live_programmes SET title = 'Twin Rule' WHERE id = ?", p.id);
  const profileId = core.db.get('SELECT id FROM profiles WHERE kids = 0 LIMIT 1').id;
  const anyChannel = core.live.recordings.addRule({ profileId, source: KEY, channelKey: null, title: 'Twin Rule', newOnly: false, keep: 0 });
  const thisChannel = core.live.recordings.addRule({ profileId, source: KEY, channelKey: chan.key, title: 'Twin Rule', newOnly: false, keep: 0 });
  const programme = core.live.store.programme(p.id);
  const { recording } = core.live.scheduler.schedule({ profile: { id: profileId, kids: false }, programme, channel: chan, ruleId: thisChannel });
  const sheet = (await admin.get(`/api/live/programmes/${p.id}`)).data;
  assert.equal(sheet.recordingId, recording.id);
  assert.equal(sheet.ruleId, thisChannel);
  await admin.del(`/api/live/recordings/${recording.id}`);
  for (const id of [anyChannel, thisChannel]) await admin.del(`/api/live/rules/${id}`);
});

test('Try again answers at once and the row says it is saving (v0.22)', async () => {
  const p = await programmeOn('One', 5);
  const rec = (await admin.post(`/api/live/programmes/${p.id}/record`, {})).data.recording;
  const sched = core.live.scheduler;
  const work = sched.workDir(core.live.recordings.get(rec.id));
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'piece'), 'x');
  core.live.recordings.update(rec.id, { status: 'failed', error: "Couldn't save the recording", workDir: work });
  let release;
  const realLeftover = sched.finishLeftover;
  sched.finishLeftover = async (w, out) => {
    await new Promise((r) => (release = r));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'mkv');
    return { file: out, gapSeconds: 0 };
  };
  try {
    const r = await admin.post(`/api/live/recordings/${rec.id}/retry`, {});
    assert.equal(r.status, 202, JSON.stringify(r.data));
    assert.equal(r.data.saving, true);
    const list = (await admin.get('/api/live/recordings')).data;
    assert.ok(!list.recording.some((x) => x.id === rec.id), 'not under Recording now');
    const row = list.failed.find((x) => x.id === rec.id);
    assert.equal(row?.saving, true, JSON.stringify(row));
    assert.equal((await admin.post(`/api/live/recordings/${rec.id}/retry`, {})).status, 409, 'once at a time');
    const del = await admin.del(`/api/live/recordings/${rec.id}`);
    assert.equal(del.status, 409, 'not removed while its pieces are being joined');
    assert.equal(del.data.error, "This recording is being saved. Try again when it's done.");
    assert.ok(fs.existsSync(work), 'its pieces are still there');
    while (!release) await new Promise((x) => setTimeout(x, 10));
    release();
    await sched.settled();
    const done = (await admin.get('/api/live/recordings')).data.done.find((x) => x.id === rec.id);
    assert.ok(done, 'done after the join');
    assert.equal(done.saving, false);
  } finally {
    sched.finishLeftover = realLeftover;
  }
});
