// Atomix's Jellyfin API (/jellyfin) for Infuse: browsing film and TV libraries, shows, seasons and episodes, with
// paging, sorting and filters; Resume, Next Up and Latest from Atomix's own rows; and the viewer's rules everywhere
// (a Kids profile's age limit, a profile without a library): a hidden title is 404 and absent from every list.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, makeAudio, startAtomix, client, waitForScan } from './helpers.js';
import { jf, signIn } from './helpers-jellyfin-api.js';
import { toGuid } from '../src/jellyfin/ids.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
let nf;
let admin;
const ids = {};
const g = {}; // the same ids as Jellyfin GUIDs
let me; // the grown-up's Jellyfin client
let meId;
let kid;
let guest;
let miaId;

before(async () => {
  if (!hasFfmpeg) return;
  const media = tempDir();
  const m = path.join(media, 'Movies');
  const t = path.join(media, 'TV');
  makeVideo(path.join(m, 'Alpha (2001)', 'Alpha (2001).mp4'));
  makeVideo(path.join(m, 'Beta (2002)', 'Beta (2002).mp4'));
  makeVideo(path.join(m, 'Gamma (2003)', 'Gamma (2003).mp4'));
  makeVideo(path.join(t, 'Show', 'Season 01', 'Show - S01E01.mp4'));
  makeVideo(path.join(t, 'Show', 'Season 01', 'Show - S01E02.mp4'));
  makeVideo(path.join(t, 'Show', 'Season 02', 'Show - S02E01.mp4'));
  makeAudio(path.join(media, 'Music', 'Band', 'Record', '01 - One.mp3'), { tags: { title: 'One', artist: 'Band', album: 'Record', track: '1' } });
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  ids.movies = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [m] })).data.id;
  ids.tv = (await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [t] })).data.id;
  ids.music = (await admin.post('/api/libraries', { name: 'Music', type: 'music', paths: [path.join(media, 'Music')] })).data.id;
  await waitForScan(admin);
  const db = nf.app.core.db;
  const one = (sql, ...a) => db.get(sql, ...a).id;
  ids.alpha = one("SELECT id FROM items WHERE kind = 'movie' AND title = 'Alpha'");
  ids.beta = one("SELECT id FROM items WHERE kind = 'movie' AND title = 'Beta'");
  ids.gamma = one("SELECT id FROM items WHERE kind = 'movie' AND title = 'Gamma'");
  ids.show = one("SELECT id FROM items WHERE kind = 'show'");
  ids.s1 = one("SELECT id FROM items WHERE kind = 'season' AND season = 1");
  ids.s2 = one("SELECT id FROM items WHERE kind = 'season' AND season = 2");
  ids.e1 = one("SELECT id FROM items WHERE kind = 'episode' AND season = 1 AND episode = 1");
  ids.e2 = one("SELECT id FROM items WHERE kind = 'episode' AND season = 1 AND episode = 2");
  ids.e3 = one("SELECT id FROM items WHERE kind = 'episode' AND season = 2 AND episode = 1");
  db.run("UPDATE items SET certification = 'R16', min_age = 16 WHERE id = ?", ids.gamma);
  db.run("UPDATE items SET certification = 'G', min_age = 0 WHERE id IN (?, ?)", ids.alpha, ids.beta);
  db.run("UPDATE items SET min_age = 0 WHERE kind IN ('show', 'season', 'episode')");
  // Added in a known order: Alpha oldest, Gamma newest; the episodes after the films.
  const base = Date.now() - 100_000;
  [ids.alpha, ids.beta, ids.gamma, ids.e1, ids.e2, ids.e3].forEach((id, i) => db.run('UPDATE items SET added_at = ? WHERE id = ?', base + i * 1000, id));
  for (const [k, v] of Object.entries(ids)) g[k] = toGuid(['movies', 'tv', 'music'].includes(k) ? 'library' : 'item', v);

  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data;
  miaId = mia.id;
  const guestProfile = (await admin.post('/api/profiles', { name: 'Guest', avatar: 'blue' })).data;
  await admin.patch(`/api/profiles/${guestProfile.id}`, { libraries: [ids.movies] });
  const secret = (await admin.post('/api/me/app-passwords', { name: 'Infuse' })).data.secret;
  const as = async (profileId, name) => {
    const c = client(nf.base);
    await c.post('/api/auth/login', { username: 'dallas', password: 'password123' });
    await c.post(`/api/profiles/${profileId}/select`, {});
    return (await c.post('/api/me/app-passwords', { name })).data.secret;
  };
  const kidSecret = await as(mia.id, 'Infuse on the iPad');
  const guestSecret = await as(guestProfile.id, 'Infuse for guests');
  const s = await signIn(nf.base, 'dallas', secret);
  me = jf(nf.base, { token: s.token });
  meId = s.user.Id;
  kid = jf(nf.base, { token: (await signIn(nf.base, 'dallas', kidSecret)).token, deviceId: 'kid-dev' });
  guest = jf(nf.base, { token: (await signIn(nf.base, 'dallas', guestSecret)).token, deviceId: 'guest-dev' });
});

after(async () => {
  await nf?.app.stop();
});

const names = (r) => r.body.Items.map((i) => i.Name);
const itemIds = (r) => r.body.Items.map((i) => i.Id);

test('views list film and TV libraries only', { skip }, async () => {
  for (const p of [`/Users/${meId}/Views`, '/UserViews']) {
    const r = await me.get(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.body.TotalRecordCount, 2);
    assert.deepEqual(r.body.Items.map((v) => [v.Id, v.CollectionType]).sort(), [[g.movies, 'movies'], [g.tv, 'tvshows']].sort());
    assert.ok(r.body.Items.every((v) => v.Type === 'CollectionFolder'));
  }
  assert.equal((await me.get(`/Users/${toGuid('user', 999)}/Views`)).status, 404, "another profile's views");
  assert.equal((await jf(nf.base).get('/UserViews')).status, 401);
});

test('a library lists its films, paged', { skip }, async () => {
  const r = await me.get(`/Users/${meId}/Items`, { ParentId: g.movies, StartIndex: 1, Limit: 1, SortBy: 'SortName' });
  assert.equal(r.status, 200);
  assert.equal(r.body.TotalRecordCount, 3);
  assert.equal(r.body.StartIndex, 1);
  assert.deepEqual(names(r), ['Beta']);
  assert.equal(r.body.Items[0].Type, 'Movie');
  const all = await me.get('/Items', { ParentId: g.movies, SortBy: 'DateCreated,SortName', SortOrder: 'Descending' });
  assert.deepEqual(names(all), ['Gamma', 'Beta', 'Alpha']);
  const top = await me.get('/Items', { ParentId: g.tv });
  assert.deepEqual(top.body.Items.map((i) => i.Type), ['Series'], "a TV library's top level is its shows");
  assert.equal(top.body.Items[0].ChildCount, 3);
  assert.equal(top.body.Items[0].UserData.UnplayedItemCount, 3);
});

test('recursive episodes of a library', { skip }, async () => {
  const r = await me.get('/Items', { ParentId: g.tv, Recursive: 'true', IncludeItemTypes: 'Episode' });
  assert.equal(r.status, 200);
  assert.equal(r.body.TotalRecordCount, 3);
  assert.ok(r.body.Items.every((i) => i.Type === 'Episode' && i.SeriesId === g.show && i.SeriesName === 'Show'));
  const movies = await me.get('/Items', { Recursive: 'true', IncludeItemTypes: 'Movie,Series' });
  assert.deepEqual(names(movies).sort(), ['Alpha', 'Beta', 'Gamma', 'Show']);
  const seasons = await me.get('/Items', { ParentId: g.show });
  assert.deepEqual(itemIds(seasons), [g.s1, g.s2], "a show's children are its seasons");
  const episodes = await me.get('/Items', { ParentId: g.s1 });
  assert.deepEqual(itemIds(episodes), [g.e1, g.e2], "a season's children are its episodes");
});

test('seasons and episodes', { skip }, async () => {
  const seasons = await me.get(`/Shows/${g.show}/Seasons`, { UserId: meId });
  assert.equal(seasons.status, 200);
  assert.equal(seasons.body.TotalRecordCount, 2);
  assert.deepEqual(itemIds(seasons), [g.s1, g.s2]);
  assert.deepEqual(seasons.body.Items.map((s) => [s.Type, s.IndexNumber, s.SeriesId]), [['Season', 1, g.show], ['Season', 2, g.show]]);
  const eps = await me.get(`/Shows/${g.show}/Episodes`, { SeasonId: g.s1 });
  assert.equal(eps.status, 200);
  assert.deepEqual(itemIds(eps), [g.e1, g.e2]);
  assert.deepEqual(eps.body.Items.map((e) => [e.ParentIndexNumber, e.IndexNumber, e.SeasonId]), [[1, 1, g.s1], [1, 2, g.s1]]);
  assert.deepEqual(itemIds(await me.get(`/Shows/${g.show}/Episodes`, { Season: 2 })), [g.e3]);
  assert.deepEqual(itemIds(await me.get(`/Shows/${g.show}/Episodes`)), [g.e1, g.e2, g.e3]);
  const one = await me.get(`/Users/${meId}/Items/${g.s1}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.ChildCount, 2);
  assert.equal(one.body.UserData.UnplayedItemCount, 2);
  const show = await me.get(`/Items/${g.show}`);
  assert.equal(show.body.Type, 'Series');
  assert.equal(show.body.ChildCount, 3);
  const film = await me.get(`/Items/${g.gamma}`);
  assert.equal(film.status, 200);
  assert.equal(film.body.OfficialRating, 'R16');
  assert.ok(Array.isArray(film.body.MediaSources));
  assert.equal((await me.get(`/Items/${toGuid('item', 999999)}`)).status, 404, 'an unknown id');
  assert.equal((await me.get('/Items/not-a-guid')).status, 404);
  assert.equal((await me.get(`/Shows/${toGuid('item', 999999)}/Seasons`)).status, 404);
});

test('filters', { skip }, async () => {
  assert.equal((await admin.post(`/api/items/${ids.alpha}/progress`, { position: 30, duration: 600 })).status, 200);
  const q = (Filters) => me.get('/Items', { ParentId: g.movies, Filters, SortBy: 'SortName' });
  assert.deepEqual(names(await q('IsResumable')), ['Alpha']);
  const alpha = (await q('IsResumable')).body.Items[0];
  assert.equal(alpha.UserData.PlaybackPositionTicks, 30 * 10_000_000);
  assert.equal(alpha.UserData.Played, false);
  assert.equal((await admin.post(`/api/items/${ids.beta}/watched`, { watched: true })).status, 200);
  assert.deepEqual(names(await q('IsPlayed')), ['Beta']);
  assert.deepEqual(names(await q('IsUnplayed')), ['Alpha', 'Gamma']);
  assert.equal((await q('IsPlayed')).body.Items[0].UserData.Played, true);
  assert.equal((await admin.put(`/api/items/${ids.gamma}/rating`, { favourite: true })).status, 200);
  assert.deepEqual(names(await q('IsFavorite')), ['Gamma']);
  assert.deepEqual(names(await me.get('/Items', { Recursive: 'true', IsFavorite: 'true' })), ['Gamma']);
  assert.equal((await q('IsFavorite')).body.Items[0].UserData.IsFavorite, true);
  const searched = await me.get('/Items', { Recursive: 'true', SearchTerm: 'gam', IncludeItemTypes: 'Movie' });
  assert.deepEqual(names(searched), ['Gamma']);
  const byIds = await me.get('/Items', { Ids: `${g.beta},${g.alpha}`, SortBy: 'SortName' });
  assert.deepEqual(names(byIds), ['Alpha', 'Beta']);
  const later = new Date(Date.now() + 60_000).toISOString();
  assert.equal((await me.get('/Items', { Recursive: 'true', MinDateLastSaved: later })).body.TotalRecordCount, 0);
  const sinceUser = await me.get('/Items', { Recursive: 'true', IncludeItemTypes: 'Movie', MinDateLastSavedForUser: new Date(Date.now() - 600_000).toISOString(), SortBy: 'SortName' });
  assert.deepEqual(names(sinceUser), ['Alpha', 'Beta', 'Gamma'], 'progress, watched and a heart all count as saved for the user');
  const played = await me.get('/Items', { ParentId: g.movies, SortBy: 'DatePlayed', SortOrder: 'Descending', Filters: 'IsPlayed' });
  assert.deepEqual(names(played), ['Beta']);
});

test('Resume, NextUp and Latest match the web', { skip }, async () => {
  await admin.post(`/api/items/${ids.alpha}/progress`, { position: 120, duration: 600 });
  await new Promise((r) => setTimeout(r, 20));
  await admin.post(`/api/items/${ids.e3}/progress`, { position: 100, duration: 600 });
  const core = nf.app.core;
  const user = core.db.get("SELECT * FROM users WHERE username = 'dallas'");
  const profile = core.db.get("SELECT * FROM profiles WHERE user_id = ? AND name = 'dallas'", user.id);
  const web = core.library.continueWatching(core.profiles.viewer(user, profile), 20).map((r) => toGuid('item', r.id));
  assert.deepEqual(web, [g.e3, g.alpha]);
  for (const p of [`/Users/${meId}/Items/Resume`, '/UserItems/Resume']) {
    const r = await me.get(p);
    assert.equal(r.status, 200, p);
    assert.deepEqual(itemIds(r), web, p);
  }
  assert.equal((await me.get(`/Users/${meId}/Items/Resume`)).body.Items[0].SeriesName, 'Show');

  assert.deepEqual(itemIds(await me.get('/Shows/NextUp')), []);
  await admin.post(`/api/items/${ids.e1}/watched`, { watched: true });
  const next = await me.get('/Shows/NextUp', { UserId: meId });
  assert.equal(next.status, 200);
  assert.deepEqual(itemIds(next), [g.e2]);
  assert.deepEqual(itemIds(await me.get('/Shows/NextUp', { SeriesId: g.show })), [g.e2]);

  for (const p of [`/Users/${meId}/Items/Latest`, '/Items/Latest']) {
    const films = await me.get(p, { ParentId: g.movies });
    assert.equal(films.status, 200);
    assert.ok(Array.isArray(films.body), 'Latest is a plain array');
    assert.deepEqual(films.body.map((i) => i.Name), ['Gamma', 'Beta', 'Alpha']);
  }
  const tv = await me.get('/Items/Latest', { ParentId: g.tv });
  assert.deepEqual(tv.body.map((i) => [i.Type, i.Id]), [['Series', g.show]], "TV's latest episodes are grouped to their show");
  const limited = await me.get('/Items/Latest', { Limit: 2 });
  assert.deepEqual(limited.body.map((i) => i.Name), ['Show', 'Gamma'], 'newest first across both libraries');
  const loose = await me.get('/Items/Latest', { ParentId: g.tv, GroupItems: 'false' });
  assert.deepEqual(loose.body.map((i) => i.Id), [g.e3, g.e2, g.e1]);
});

test("a Kids token can't reach a grown-up title by id", { skip }, async () => {
  assert.equal((await kid.get(`/Items/${g.gamma}`)).status, 404);
  assert.equal((await kid.get(`/Users/${toGuid('user', 1)}/Items/${g.gamma}`)).status, 404);
  assert.equal((await kid.get(`/Items/${g.alpha}`)).status, 200, 'a title for her age opens');
  const lib = await kid.get('/Items', { ParentId: g.movies });
  assert.equal(lib.body.TotalRecordCount, 2);
  assert.ok(!itemIds(lib).includes(g.gamma));
  assert.ok(!itemIds(await kid.get('/Items', { Recursive: 'true', IncludeItemTypes: 'Movie' })).includes(g.gamma));
  assert.equal((await kid.get('/Items', { Recursive: 'true', SearchTerm: 'Gamma' })).body.TotalRecordCount, 0);
  assert.equal((await kid.get('/Items', { Ids: g.gamma })).body.TotalRecordCount, 0);
  const latest = await kid.get('/Items/Latest', { ParentId: g.movies });
  assert.deepEqual(latest.body.map((i) => i.Name), ['Beta', 'Alpha']);
  assert.ok(!(await kid.get('/Items/Latest')).body.some((i) => i.Id === g.gamma));
  assert.ok(!itemIds(await kid.get('/UserItems/Resume')).includes(g.gamma));
  // Next Up: episode 1 is hers and watched; episode 2 is above her age, so it is never her next episode.
  const core = nf.app.core;
  core.db.run('UPDATE items SET min_age = 16 WHERE id = ?', ids.e2);
  try {
    core.library.setWatched(miaId, core.library.get(ids.e1), true);
    assert.equal((await kid.get(`/Items/${g.e2}`)).status, 404);
    assert.ok(!itemIds(await kid.get('/Shows/NextUp')).includes(g.e2), "Mia's Next Up hides an episode above her age");
    assert.ok(!itemIds(await kid.get('/Shows/NextUp', { SeriesId: g.show })).includes(g.e2), 'and so does her Next Up for the show');
    assert.deepEqual(itemIds(await me.get('/Shows/NextUp')), [g.e2], "Dallas's Next Up still lists it");
  } finally {
    core.db.run('UPDATE items SET min_age = 0 WHERE id = ?', ids.e2);
  }
});

test('a profile without the TV library can\'t list it', { skip }, async () => {
  assert.equal((await guest.get('/Items', { ParentId: g.tv })).status, 404);
  assert.equal((await guest.get(`/Items/${g.show}`)).status, 404);
  assert.equal((await guest.get(`/Items/${g.tv}`)).status, 404);
  assert.equal((await guest.get(`/Shows/${g.show}/Episodes`)).status, 404);
  const views = await guest.get('/UserViews');
  assert.deepEqual(views.body.Items.map((v) => v.Id), [g.movies]);
  assert.equal((await guest.get('/Items', { Recursive: 'true', IncludeItemTypes: 'Episode' })).body.TotalRecordCount, 0);
  assert.ok((await guest.get('/Items/Latest')).body.every((i) => i.Type === 'Movie'));
  assert.equal((await guest.get(`/Items/${g.movies}`)).status, 200, 'its own library opens as a folder');
});

test('unknown query parameters are ignored', { skip }, async () => {
  const r = await me.get('/Items', { ParentId: g.movies, EnableImageTypes: 'Primary', EnableTotalRecordCount: 'true', Foo: '1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.TotalRecordCount, 3);
  assert.equal((await me.get('/Items', { ParentId: g.music })).status, 404, 'a music library is not a Jellyfin view here');
});
