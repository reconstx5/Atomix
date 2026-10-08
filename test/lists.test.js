// Playlists and the Watchlist: kinds, order, sharing, the kids rule, cascade.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { Library } from '../src/library/queries.js';
import { Lists } from '../src/lists.js';

let db, library, lists;
const now = Date.now();
let seq = 0;
const VIDEO = JSON.stringify({ video: { width: 1920, height: 1080 }, audio: [{ index: 0 }] });
function addItem(f) {
  const fields = { library_id: 1, kind: 'movie', title: `T${++seq}`, path: `/m/${seq}`, size: 1, mtime: 1, duration: 100, media: VIDEO, genres: '[]', ...f };
  const cols = Object.keys(fields);
  return Number(db.run(`INSERT INTO items (${cols.join(',')}, added_at, updated_at) VALUES (${cols.map(() => '?').join(',')}, ?, ?)`, ...Object.values(fields), now, now).lastInsertRowid);
}
const viewer = (profileId, extra = {}) => ({ userId: 1, profileId, kids: false, maxAge: null, allowUnrated: true, libraryIds: null, ...extra });
const kidViewer = () => viewer(2, { kids: true, maxAge: 10, allowUnrated: false });
const ids = {};

before(() => {
  db = openDatabase(path.join(tempDir(), 'lists.db'));
  library = new Library(db);
  lists = new Lists({ db, library });
  db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('d', 'Dallas', 'x', 'admin', ?)", now);
  db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('g', 'Guest', 'x', 'user', ?)", now);
  db.run("INSERT INTO profiles (user_id, name, avatar, is_primary, created_at) VALUES (1, 'dallas', 'blue', 1, ?)", now); // 1
  db.run("INSERT INTO profiles (user_id, name, avatar, is_primary, kids, max_age, created_at) VALUES (1, 'Mia', 'green', 0, 1, 10, ?)", now); // 2
  db.run("INSERT INTO profiles (user_id, name, avatar, is_primary, created_at) VALUES (2, 'guest', 'red', 1, ?)", now); // 3
  db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Movies', 'movies', '[]', '{}', ?)", now); // 1
  db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('TV', 'tv', '[]', '{}', ?)", now); // 2
  db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Music', 'music', '[]', '{}', ?)", now); // 3
  ids.kids = addItem({ title: 'Cartoon', min_age: 0 });
  ids.scary = addItem({ title: 'Scary', min_age: 16 });
  ids.plain = addItem({ title: 'Plain', min_age: 8 });
  ids.show = addItem({ library_id: 2, kind: 'show', title: 'Show', min_age: 8 });
  ids.season = addItem({ library_id: 2, kind: 'season', title: 'Season 1', parent_id: ids.show, show_id: ids.show, season: 1 });
  ids.ep1 = addItem({ library_id: 2, kind: 'episode', title: 'E1', parent_id: ids.season, show_id: ids.show, season: 1, episode: 1 });
  ids.ep2 = addItem({ library_id: 2, kind: 'episode', title: 'E2', parent_id: ids.season, show_id: ids.show, season: 1, episode: 2 });
  ids.track = addItem({ library_id: 3, kind: 'track', title: 'Song' });
});

test("every profile gets one Watchlist on demand, which can't be renamed, shared or removed", () => {
  const w = lists.watchlist(1);
  assert.equal(w.kind, 'watchlist');
  assert.equal(lists.watchlist(1).id, w.id);
  assert.throws(() => lists.rename(w.id, 'x'), /Watchlist/);
  assert.throws(() => lists.setShared(w.id, true), /Watchlist/);
  assert.throws(() => lists.remove(w.id), /Watchlist/);
});

test('kinds decide what a list takes; a show adds nothing, a season adds its episodes in order', () => {
  const video = lists.create(1, { kind: 'video', name: 'Friday' });
  const music = lists.create(1, { kind: 'music', name: 'Chill' });
  assert.equal(lists.add(video.id, ids.plain), true);
  assert.equal(lists.add(video.id, ids.show), false);
  assert.equal(lists.add(video.id, ids.track), false);
  assert.equal(lists.add(music.id, ids.plain), false);
  assert.equal(lists.add(music.id, ids.track), true);
  assert.equal(lists.addSeason(video.id, ids.season), 2);
  assert.deepEqual(lists.items(video.id, viewer(1)).map((i) => i.id), [ids.plain, ids.ep1, ids.ep2]);
  assert.equal(lists.add(video.id, ids.plain), false, 'no duplicates');
  const w = lists.watchlist(1);
  assert.equal(lists.add(w.id, ids.show), true);
  assert.equal(lists.add(w.id, ids.ep1), false, 'the Watchlist takes movies and shows');
  ids.video = video.id;
  ids.music = music.id;
});

test('move puts an item at a position and closes the gap', () => {
  lists.move(ids.video, ids.ep2, 0);
  assert.deepEqual(lists.items(ids.video, viewer(1)).map((i) => i.id), [ids.ep2, ids.plain, ids.ep1]);
  lists.move(ids.video, ids.ep2, 2);
  assert.deepEqual(lists.items(ids.video, viewer(1)).map((i) => i.id), [ids.plain, ids.ep1, ids.ep2]);
  lists.removeItem(ids.video, ids.ep1);
  assert.deepEqual(lists.items(ids.video, viewer(1)).map((i) => i.id), [ids.plain, ids.ep2]);
  assert.deepEqual(db.all('SELECT position FROM list_items WHERE list_id = ? ORDER BY position', ids.video).map((r) => r.position), [0, 1]);
});

test('forProfile: own lists, then shared ones from anyone; kids see a shared list only when all of it is kid-safe', () => {
  const shared = lists.create(3, { kind: 'video', name: 'Guest picks' });
  lists.add(shared.id, ids.kids);
  lists.setShared(shared.id, true);
  const mine = lists.forProfile({ id: 1, name: 'dallas', kids: false }, viewer(1));
  assert.deepEqual(mine.map((l) => l.name), ['Watchlist', 'Friday', 'Chill', 'Guest picks']);
  assert.equal(mine[3].own, false);
  assert.equal(mine[3].ownerName, 'guest');
  assert.equal(mine[1].count, 2);
  const kid = lists.forProfile({ id: 2, name: 'Mia', kids: true }, kidViewer());
  assert.ok(kid.some((l) => l.name === 'Guest picks'), 'all kid-safe: visible');
  lists.add(shared.id, ids.scary);
  const kid2 = lists.forProfile({ id: 2, name: 'Mia', kids: true }, kidViewer());
  assert.ok(!kid2.some((l) => l.name === 'Guest picks'), 'one scary film hides the whole list from a kid');
  assert.equal(lists.visibleTo(lists.get(shared.id), kidViewer()), false);
  ids.shared = shared.id;
});

test('contains and nextIn', () => {
  assert.deepEqual(lists.contains(1, ids.plain), { watchlist: false, lists: [ids.video] });
  assert.deepEqual(lists.contains(1, ids.show), { watchlist: true, lists: [] });
  assert.equal(lists.nextIn(ids.video, ids.plain, viewer(1)).id, ids.ep2);
  assert.equal(lists.nextIn(ids.video, ids.ep2, viewer(1)), null);
  // A hidden item in the middle is skipped for a viewer who can't see it (the list itself is checked by the API).
  lists.add(ids.shared, ids.plain);
  assert.equal(lists.nextIn(ids.shared, ids.kids, kidViewer()).id, ids.plain);
  // A show in the Watchlist is never "next": only films, episodes and songs play.
  const wl = lists.watchlist(1);
  lists.add(wl.id, ids.plain);
  assert.equal(lists.nextIn(wl.id, ids.show, viewer(1)).id, ids.plain, 'from a show, the next film');
  assert.equal(lists.nextIn(wl.id, ids.plain, viewer(1)), null, 'a show after it is not next');
  assert.equal(lists.firstPlayable(wl.id, viewer(1)).id, ids.plain);
  // A title that is not in the list (removed mid-play, or a hand-edited URL) has nothing next: the list never restarts.
  assert.equal(lists.nextIn(ids.video, 999999, viewer(1)), null);
  lists.removeItem(wl.id, ids.plain);
});

test('deleting an item drops it from every list; onChange fires', () => {
  let fired = 0;
  lists.onChange(() => fired++);
  const gone = addItem({ title: 'Gone', min_age: 0 });
  lists.add(ids.video, gone);
  db.run('DELETE FROM items WHERE id = ?', gone);
  assert.ok(!lists.items(ids.video, viewer(1)).some((i) => i.id === gone));
  lists.add(ids.video, ids.ep1);
  assert.ok(fired >= 1);
});
