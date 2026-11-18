// Jellyfin API: played and favourite writes land where the web reads them, and a Kids token can't touch grown-up titles.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';
import { jf, signIn } from './helpers-jellyfin-api.js';
import { toGuid } from '../src/jellyfin/ids.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
let nf;
let admin;
let me;
let kid;
let meId;
const ids = {};
const g = {};

before(async () => {
  if (!hasFfmpeg) return;
  const media = tempDir();
  makeVideo(path.join(media, 'Movies', 'Alpha (2001)', 'Alpha (2001).mp4'));
  makeVideo(path.join(media, 'Movies', 'Gamma (2003)', 'Gamma (2003).mp4'));
  makeVideo(path.join(media, 'TV', 'Show', 'Season 01', 'Show - S01E01.mp4'));
  makeVideo(path.join(media, 'TV', 'Show', 'Season 01', 'Show - S01E02.mp4'));
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [path.join(media, 'Movies')] });
  await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [path.join(media, 'TV')] });
  await waitForScan(admin);
  const db = nf.app.core.db;
  const one = (sql, ...a) => db.get(sql, ...a).id;
  ids.alpha = one("SELECT id FROM items WHERE kind = 'movie' AND title = 'Alpha'");
  ids.gamma = one("SELECT id FROM items WHERE kind = 'movie' AND title = 'Gamma'");
  ids.show = one("SELECT id FROM items WHERE kind = 'show'");
  ids.e1 = one("SELECT id FROM items WHERE kind = 'episode' AND episode = 1");
  ids.e2 = one("SELECT id FROM items WHERE kind = 'episode' AND episode = 2");
  db.run("UPDATE items SET certification = 'R16', min_age = 16 WHERE id = ?", ids.gamma);
  db.run("UPDATE items SET certification = 'G', min_age = 0 WHERE id = ?", ids.alpha);
  db.run("UPDATE items SET min_age = 0 WHERE kind IN ('show', 'season', 'episode')");
  for (const [k, v] of Object.entries(ids)) g[k] = toGuid('item', v);
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data;
  const secret = (await admin.post('/api/me/app-passwords', { name: 'Infuse' })).data.secret;
  const c = client(nf.base);
  await c.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await c.post(`/api/profiles/${mia.id}/select`, {});
  const kidSecret = (await c.post('/api/me/app-passwords', { name: 'Infuse iPad' })).data.secret;
  const s = await signIn(nf.base, 'dallas', secret);
  me = jf(nf.base, { token: s.token });
  meId = s.user.Id;
  kid = jf(nf.base, { token: (await signIn(nf.base, 'dallas', kidSecret)).token, deviceId: 'kid-dev' });
});

after(async () => {
  await nf?.app.stop();
});

const web = async (id) => { const i = (await admin.get(`/api/items/${id}`)).data.item; return { ...i, watched: Boolean(i.progress?.watched) }; };

test('marking a film played shows on the web', { skip }, async () => {
  const r = await me.post(`/Users/${meId}/PlayedItems/${g.alpha}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.Played, true);
  assert.equal((await web(ids.alpha)).watched, true);
  const d = await me.del(`/UserPlayedItems/${g.alpha}`);
  assert.equal(d.body.Played, false);
  assert.equal((await web(ids.alpha)).watched, false);
  assert.equal((await me.post(`/UserPlayedItems/${g.alpha}`)).body.Played, true);
  assert.equal((await me.del(`/Users/${meId}/PlayedItems/${g.alpha}`)).body.Played, false);
  assert.equal((await me.post(`/Users/${toGuid('user', 999)}/PlayedItems/${g.alpha}`)).status, 404);
});

test('marking a series played marks every episode', { skip }, async () => {
  const r = await me.post(`/UserPlayedItems/${g.show}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.UnplayedItemCount, 0);
  assert.equal((await web(ids.e1)).watched, true);
  assert.equal((await web(ids.e2)).watched, true);
  const d = await me.del(`/UserPlayedItems/${g.show}`);
  assert.equal(d.body.UnplayedItemCount, 2);
  assert.equal((await web(ids.e1)).watched, false);
});

test("a heart set in Infuse is the web's heart", { skip }, async () => {
  const r = await me.post(`/Users/${meId}/FavoriteItems/${g.alpha}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.IsFavorite, true);
  const ratings = nf.app.core.ratings.get(nf.app.core.db.get('SELECT id FROM profiles ORDER BY id LIMIT 1').id, [ids.alpha]);
  assert.equal(ratings.get(ids.alpha)?.favourite, true);
  assert.equal((await me.get(`/Items/${g.alpha}`)).body.UserData.IsFavorite, true);
  assert.equal((await me.del(`/UserFavoriteItems/${g.alpha}`)).body.IsFavorite, false);
  // the reverse: a heart set on the web shows in Infuse
  assert.equal((await admin.put(`/api/items/${ids.gamma}/rating`, { favourite: true })).status, 200);
  assert.equal((await me.get(`/Items/${g.gamma}`)).body.UserData.IsFavorite, true);
});

test("a Kids token can't mark a grown-up title", { skip }, async () => {
  for (const p of ['/UserPlayedItems', '/UserFavoriteItems']) {
    assert.equal((await kid.post(`${p}/${g.gamma}`)).status, 404, `POST ${p}`);
    assert.equal((await kid.del(`${p}/${g.gamma}`)).status, 404, `DELETE ${p}`);
  }
  assert.equal((await web(ids.gamma)).watched, false, 'nothing changed');
});
