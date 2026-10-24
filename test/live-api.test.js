// Live TV routes (src/api/live.js) against a canned live source (test/fixtures/live-plugins/live-test).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAtomix, client, fakeServer } from './helpers.js';

const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-plugins');
const KEY = 'live-test/canned';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201e0a3c73b0000000049454e44ae426082', 'hex');
let nf, admin, kid, guest, upstream, logoHits = 0, kidId;

before(async () => {
  upstream = await fakeServer((req, res) => {
    if (req.url.startsWith('/logo/') || req.url.startsWith('/img/')) {
      logoHits++;
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    res.writeHead(404);
    res.end();
  });
  process.env.LIVE_TEST_BASE = upstream.url;
  nf = await startAtomix({ ATOMIX_PLUGINS_DIR: PLUGINS }, { skipLiveRefresh: true });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  kidId = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data.id;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${kidId}/select`, {});
  await admin.post('/api/users', { username: 'guest', password: 'guestpass1' });
  guest = client(nf.base);
  await guest.post('/api/auth/login', { username: 'guest', password: 'guestpass1' });
});
after(async () => {
  await nf?.app.stop();
  await upstream?.close();
});

const refresh = () => admin.post(`/api/live/sources/${encodeURIComponent(KEY)}/refresh`, {});

test('status is disabled until a source has channels; enabled after the first refresh', async () => {
  const before = (await admin.get('/api/live/status')).data;
  assert.equal(before.enabled, false);
  assert.deepEqual(before.sources.map((s) => s.id), [KEY]);
  const r = await refresh();
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  const st = (await admin.get('/api/live/status')).data;
  assert.equal(st.enabled, true);
  assert.equal(st.sources[0].channels, 4);
  assert.equal(st.sources[0].summary, '4 channels in 4 groups');
  assert.ok(Array.isArray(st.sources[0].unmatched));
});

test('channels carry now/next, favourite and logo URLs; groups in playlist order', async () => {
  const list = (await admin.get('/api/live/channels')).data;
  assert.deepEqual(list.map((c) => c.name), ['One', 'Two', 'Three', 'Radio Waves']);
  const one = list[0];
  assert.equal(one.number, 1);
  assert.equal(one.logo, `/api/live/channels/${one.id}/logo`);
  assert.equal(one.catchup, true);
  assert.equal(one.catchupDays, 2);
  assert.equal(one.drm, null, 'a plain channel');
  assert.equal(list[1].catchupDays, 0);
  assert.equal(one.favourite, false);
  assert.equal(one.now.title, 'One 0');
  assert.equal(one.next.title, 'One 1');
  assert.equal(one.now.image, `/api/live/programmes/${one.now.id}/image`);
  assert.equal(list[1].logo, null);
  assert.equal(list[3].radio, true);
  assert.deepEqual((await admin.get('/api/live/groups')).data, ['News', 'Kids', 'Movies', 'Radio']);
  assert.deepEqual((await admin.get('/api/live/channels?group=Movies')).data.map((c) => c.name), ['Two', 'Three']);
});

test('favourites: toggle, order with PUT, favourites=1 filter', async () => {
  const list = (await admin.get('/api/live/channels')).data;
  const [one, two, three] = list;
  assert.equal((await admin.post(`/api/live/favourites/${three.id}`, {})).status, 200);
  await admin.post(`/api/live/favourites/${one.id}`, {});
  assert.deepEqual((await admin.get('/api/live/channels?favourites=1')).data.map((c) => c.name), ['Three', 'One']);
  await admin.put('/api/live/favourites', { channelIds: [one.id, two.id, three.id] });
  assert.deepEqual((await admin.get('/api/live/channels?favourites=1')).data.map((c) => c.name), ['One', 'Two', 'Three']);
  await admin.del(`/api/live/favourites/${two.id}`);
  const after = (await admin.get('/api/live/channels')).data;
  assert.deepEqual(after.filter((c) => c.favourite).map((c) => c.name), ['One', 'Three']);
  assert.deepEqual((await guest.get('/api/live/channels?favourites=1')).data, [], "another profile's favourites are its own");
});

test('reordering favourites while a favourite channel is missing keeps it for when it comes back', async () => {
  const [one, two] = (await admin.get('/api/live/channels')).data;
  await admin.put('/api/live/favourites', { channelIds: [one.id, two.id] });
  const db = nf.app.core.db;
  db.run('UPDATE live_channels SET missing_since = ? WHERE id = ?', Date.now(), one.id);
  try {
    await admin.put('/api/live/favourites', { channelIds: [two.id] });
  } finally {
    db.run('UPDATE live_channels SET missing_since = NULL WHERE id = ?', one.id);
  }
  const favs = (await admin.get('/api/live/channels?favourites=1')).data.map((c) => c.id);
  assert.ok(favs.includes(one.id), JSON.stringify(favs));
  await admin.put('/api/live/favourites', { channelIds: [] });
});

test('guide window: overlapping programmes; more than 6 h is clamped; bad input is 400', async () => {
  const list = (await admin.get('/api/live/channels')).data;
  const now = Date.now();
  const g = (await admin.get(`/api/live/guide?from=${now}&to=${now + 3600_000}&channels=${list[0].id},${list[1].id}`)).data;
  assert.deepEqual(g.channels.map((c) => c.name), ['One', 'Two']);
  const progs = g.programmes[list[0].id];
  assert.ok(progs.length >= 2 && progs.length <= 3, String(progs.length));
  assert.ok(progs[0].start <= now && progs[0].end > now);
  const wide = (await admin.get(`/api/live/guide?from=${now}&to=${now + 24 * 3600_000}&channels=${list[0].id}`)).data;
  assert.ok(wide.programmes[list[0].id].every((p) => p.start < now + 6 * 3600_000 + 1));
  const all = (await admin.get(`/api/live/guide?from=${now}&to=${now + 3600_000}`)).data;
  assert.equal(all.channels.length, 4, 'no channels= means every visible channel');
  assert.equal((await admin.get('/api/live/guide?from=abc&to=1')).status, 400);
  assert.equal((await admin.get(`/api/live/guide?from=${now}&to=${now - 1}`)).data.error, 'Choose a time window');
});

test('programme details include canWatchLive/canStartOver/canCatchup by time and catch-up days', async () => {
  const list = (await admin.get('/api/live/channels')).data;
  const now = Date.now();
  const g = (await admin.get(`/api/live/guide?from=${now - 2 * 3600_000}&to=${now + 2 * 3600_000}&channels=${list[0].id},${list[1].id}`)).data;
  const one = g.programmes[list[0].id];
  const aired = one.find((p) => p.end <= now);
  const onNow = one.find((p) => p.start <= now && p.end > now);
  const later = one.find((p) => p.start > now);
  const d = async (p) => (await admin.get(`/api/live/programmes/${p.id}`)).data;
  assert.deepEqual(pick(await d(onNow)), { canWatchLive: true, canStartOver: true, canCatchup: false });
  assert.deepEqual(pick(await d(aired)), { canWatchLive: false, canStartOver: false, canCatchup: true });
  assert.deepEqual(pick(await d(later)), { canWatchLive: false, canStartOver: false, canCatchup: false });
  const twoNow = g.programmes[list[1].id].find((p) => p.start <= now && p.end > now);
  assert.deepEqual(pick(await d(twoNow)), { canWatchLive: true, canStartOver: false, canCatchup: false }, 'no catch-up on Two');
  const full = await d(onNow);
  assert.equal(full.channel.name, 'One');
  assert.equal(full.description, `About ${full.title}`);
  assert.equal((await admin.get('/api/live/programmes/999999')).status, 404);
});
const pick = (p) => ({ canWatchLive: p.canWatchLive, canStartOver: p.canStartOver, canCatchup: p.canCatchup });

test('Kids: nothing until groups are ticked; then only those channels and their programmes; a channel in two groups shows once', async () => {
  assert.equal((await kid.get('/api/live/status')).data.enabled, false);
  assert.deepEqual((await kid.get('/api/live/channels')).data, []);
  const r = await admin.put(`/api/profiles/${kidId}/live-groups`, [{ source: KEY, group: 'Kids' }, { source: KEY, group: 'Movies' }]);
  assert.equal(r.status, 200);
  assert.deepEqual((await admin.get(`/api/profiles/${kidId}/live-groups`)).data, [{ source: KEY, group: 'Kids' }, { source: KEY, group: 'Movies' }]);
  assert.equal((await kid.get('/api/live/status')).data.enabled, true);
  const list = (await kid.get('/api/live/channels')).data;
  assert.deepEqual(list.map((c) => c.name), ['Two', 'Three']);
  assert.deepEqual((await kid.get('/api/live/groups')).data, ['Kids', 'Movies']);
  const all = (await admin.get('/api/live/channels')).data;
  const one = all[0];
  const now = Date.now();
  const g = (await kid.get(`/api/live/guide?from=${now}&to=${now + 3600_000}&channels=${one.id},${list[0].id}`)).data;
  assert.deepEqual(g.channels.map((c) => c.name), ['Two'], 'a channel id outside the allow-list is dropped');
  const oneProg = (await admin.get(`/api/live/guide?from=${now}&to=${now + 3600_000}&channels=${one.id}`)).data.programmes[one.id][0];
  assert.equal((await kid.get(`/api/live/programmes/${oneProg.id}`)).status, 404);
  assert.equal((await kid.get(`/api/live/channels/${one.id}/logo`)).status, 404);
  const own = (await admin.get('/api/profiles')).data.find((p) => !p.kids);
  assert.equal((await admin.put(`/api/profiles/${own.id}/live-groups`, [])).status, 400, 'only Kids profiles');
  const guestProfile = (await guest.get('/api/profiles')).data[0];
  assert.equal((await admin.put(`/api/profiles/${guestProfile.id}/live-groups`, [])).status, 404, "another account's profile");
});

test("saving a Kids profile's ticks for one source keeps another source's", async () => {
  const before = (await admin.get(`/api/profiles/${kidId}/live-groups`)).data;
  await admin.put(`/api/profiles/${kidId}/live-groups`, [{ source: 'other/src', group: 'Cartoons' }, { source: KEY, group: 'Kids' }]);
  const r = await admin.put(`/api/profiles/${kidId}/live-groups`, { sources: [KEY], groups: [{ source: KEY, group: 'Movies' }] });
  assert.equal(r.status, 200);
  const after = (await admin.get(`/api/profiles/${kidId}/live-groups`)).data;
  assert.ok(after.some((g) => g.source === 'other/src' && g.group === 'Cartoons'), JSON.stringify(after));
  assert.ok(after.some((g) => g.source === KEY && g.group === 'Movies'));
  assert.ok(!after.some((g) => g.source === KEY && g.group === 'Kids'), 'the sent source is replaced');
  await admin.put(`/api/profiles/${kidId}/live-groups`, before);
});

test('a Kids profile\'s status counts only the channels it can see', async () => {
  const kidStatus = (await kid.get('/api/live/status')).data;
  const adminStatus = (await admin.get('/api/live/status')).data;
  assert.equal(kidStatus.sources[0].channels, 2, 'Two and Three (its ticked groups)');
  assert.ok(adminStatus.sources[0].channels > 2);
});

test('admin-only: refresh, live-groups and source errors are refused or absent for a viewer', async () => {
  assert.equal((await guest.post(`/api/live/sources/${encodeURIComponent(KEY)}/refresh`, {})).status, 403);
  assert.equal((await kid.post(`/api/live/sources/${encodeURIComponent(KEY)}/refresh`, {})).status, 403);
  assert.equal((await guest.get(`/api/profiles/${kidId}/live-groups`)).status, 403);
  const st = (await guest.get('/api/live/status')).data;
  assert.equal(st.enabled, true);
  assert.equal('error' in st.sources[0], false);
  assert.equal('unmatched' in st.sources[0], false);
  assert.equal('summary' in st.sources[0], false);
});

test('no response contains the provider URL, a header value or the logo\'s host', async () => {
  const list = (await admin.get('/api/live/channels')).data;
  const now = Date.now();
  const bodies = [
    await admin.get('/api/live/status'),
    { data: list },
    await admin.get('/api/live/groups'),
    await admin.get(`/api/live/guide?from=${now - 3600_000}&to=${now + 3600_000}`),
    await admin.get(`/api/live/programmes/${list[0].now.id}`),
    await guest.get('/api/live/channels'),
  ].map((r) => JSON.stringify(r.data));
  const host = new URL(upstream.url).host;
  for (const b of bodies) {
    assert.ok(!b.includes(host), 'upstream host');
    assert.ok(!b.includes('secretpw'), 'stream login');
    assert.ok(!b.includes('hdrsecret'), 'header value');
    assert.ok(!b.includes('provider.invalid'));
  }
});

test('the logo route proxies and caches the image (one upstream request for two calls)', async () => {
  const one = (await admin.get('/api/live/channels')).data[0];
  logoHits = 0;
  const a = await admin.raw(one.logo);
  assert.equal(a.status, 200);
  assert.equal(a.headers.get('content-type'), 'image/png');
  const b = await admin.raw(one.logo);
  assert.equal(b.status, 200);
  assert.equal(logoHits, 1);
  const two = (await admin.get('/api/live/channels')).data[1];
  assert.equal((await admin.raw(`/api/live/channels/${two.id}/logo`)).status, 404);
  const img = await admin.raw(one.now.image);
  assert.equal(img.status, 200);
});

test('search finds channels by name and upcoming programmes by title', async () => {
  const r = (await admin.get('/api/live/search?q=three')).data;
  assert.deepEqual(r.channels.map((c) => c.name), ['Three']);
  assert.ok(r.programmes.length > 0 && r.programmes.every((p) => /^Three \d+$/.test(p.title) && p.end > Date.now() && p.start < Date.now() + 24 * 3600_000));
  assert.ok(r.programmes.every((p) => p.channel?.name === 'Three'));
  assert.deepEqual((await kid.get('/api/live/search?q=one')).data, { channels: [], programmes: [] });
});

test('a failed logo download is logged without the address path or query', async () => {
  const { ImageCache } = await import('../src/library/images.js');
  const { tempDir } = await import('./helpers.js');
  const cache = new ImageCache({ imagesDir: tempDir(), cacheDir: tempDir() });
  const { setLogLevel } = await import('../src/log.js');
  const lines = [];
  const warn = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  setLogLevel('warn');
  try {
    await cache.download(`${upstream.url}/nope/u/secretpw/logo.png?token=abc`);
  } finally {
    console.warn = warn;
    setLogLevel('error');
  }
  assert.ok(lines.length >= 1);
  assert.ok(lines.every((l) => !/secretpw|token=abc/.test(l)), lines.join('\n'));
});

test('a logo or picture path from the playlist is served only from a declared image folder, and only as an image', async () => {
  const fs = await import('node:fs');
  const { tempDir } = await import('./helpers.js');
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'two.png'), PNG);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'secret');
  const outside = path.join(tempDir(), 'outside.png');
  fs.writeFileSync(outside, PNG);
  process.env.LIVE_TEST_ROOT = root;
  const logoOf = async (logo) => {
    process.env.LIVE_TEST_TWO_LOGO = logo;
    await refresh();
    const two = (await admin.get('/api/live/channels')).data.find((c) => c.name === 'Two');
    return (await admin.raw(`/api/live/channels/${two.id}/logo`)).status;
  };
  try {
    assert.equal(await logoOf('/etc/hostname'), 404, 'a system file');
    assert.equal(await logoOf('/etc/passwd'), 404);
    assert.equal(await logoOf(outside), 404, 'an image outside the declared folder');
    assert.equal(await logoOf(path.join(root, 'notes.txt')), 404, 'not an image');
    assert.equal(await logoOf(`${root}/../${path.basename(root)}/two.png`), 200, 'a path that resolves inside is fine');
    assert.equal(await logoOf(path.join(root, 'two.png')), 200);
  } finally {
    delete process.env.LIVE_TEST_TWO_LOGO;
    delete process.env.LIVE_TEST_ROOT;
    await refresh();
  }
});

test('an image download that redirects to a refused address (0.0.0.0, link-local) is not followed', async () => {
  const { ImageCache } = await import('../src/library/images.js');
  const { tempDir } = await import('./helpers.js');
  let reached = 0;
  const target = await fakeServer((req, res) => {
    reached++;
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
  const port = new URL(target.url).port;
  const hop = await fakeServer((req, res) => {
    res.writeHead(302, { location: `http://0.0.0.0:${port}/logo.png` });
    res.end();
  });
  try {
    const cache = new ImageCache({ imagesDir: tempDir() });
    assert.equal(await cache.download(`${hop.url}/logo.png`), null);
    assert.equal(reached, 0, 'the refused address was never asked');
  } finally {
    await hop.close();
    await target.close();
  }
});
