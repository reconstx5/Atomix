# Atomix trailers, extras and lyrics (v0.10.0) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Films and shows get a Trailer button (a local trailer file, else the TMDB/YouTube trailer embedded), an Extras row (featurettes, deleted scenes… from Kodi-style folders and file suffixes), and songs get lyrics (`.lrc` → tags → LRCLIB) on a full-screen Now Playing page.

**Architecture:** Extras are items of `kind = 'extra'` under their film or show, found by the existing scanner walk and hidden by the query layer's kind whitelists. Trailers from TMDB ride on the metadata fetch already made. Lyrics are a small store (`src/lyrics.js`) filled on demand from files, tags and LRCLIB, served by one route; the Now Playing page is a view over the existing `music` object, which gains position/duration getters and a `time` event. Thumbnails for extras are a third job for the background runner.

**Tech Stack:** Node ≥ 22.13 (`node:http`, `node:sqlite`, `node:test`), ffmpeg/ffprobe, plain ES modules in the browser, Playwright for the browser suite (`/home/claude/devtools`, cloud only).

**Spec:** `docs/superpowers/specs/2026-10-01-atomix-trailers-extras-lyrics-design.md`

## Global Constraints

- Node ≥ 22.13; zero npm dependencies; no build step; plain ES-module browser JS.
- Orbit is the default look; a TV remote (arrows, Enter, Back) comes first; laptop text never below 12px.
- Older themes change only where this spec adds content (Trailer button, Extras row); `devtools/oldthemes-compare.mjs` is re-baselined only for those pages after eyeballing.
- Kodi conventions only (folder names, suffixes); no Kodi code.
- Kids profiles: never a YouTube trailer; extras inherit the owner's rating; lyrics only for tracks the viewer may see.
- Online parts have admin switches `onlineTrailers` and `onlineLyrics` (both default `true`); the only data that leaves the server is the LRCLIB query (artist, title, album, duration) and the YouTube embed the browser loads.
- Version `0.10.0`; migration 10.
- No git in the cloud copy: the executor keeps a base snapshot (`.superpowers`-style workspace) and delivers to `D:\Nodeflix` after hash-checking, as in rounds 7–11.

## Review Focus

1. A film folder holding two films plus `Extras/`: those extras must belong to nobody and not be stored (not attached to the wrong film) — Task 2's test covers it.
2. A show's extra when the show is hidden from a kids profile: `/api/items/<extraId>` and playback must 404 for the kid, through `show_id`/`min_age` copy — Task 3's test covers it.
3. A YouTube trailer when `onlineTrailers` is switched off after the item page was loaded: the trailer page must refuse (404-equivalent empty state) rather than embed — Task 6's browser check; Task 4's API test covers the field.
4. An `.lrc` file that is not valid LRC (plain text with brackets in lyrics, e.g. "[Chorus]"): must come back plain, not synced with zero lines — Task 7's `parseLrc` test covers it.
5. LRCLIB unreachable (connection refused) while the song plays: the page shows "No lyrics for this song" within the 10 s timeout and the song keeps playing; the miss is remembered — Task 7's store test covers the error → `none` path.

---

### Task 1: Migration 10, settings, and the extras naming rules

**Files:**
- Modify: `src/db.js` (append `MIGRATIONS[9]`)
- Modify: `src/settings.js` (`SETTING_DEFAULTS`)
- Modify: `src/library/parser.js` (replace `EXTRAS_DIRS` with `EXTRA_DIR_KINDS`, `EXTRA_SUFFIX_KINDS`, `EXTRA_CAPTIONS`, `extraKindOf`)
- Test: `test/migrations.test.js` (add a case), `test/parser.test.js` (add cases)

**Interfaces:**
- Produces: `extraKindOf(filePath: string) → { kind, title } | null`; `EXTRA_CAPTIONS: Record<kind, string>`; `EXTRA_DIR_KINDS: Map<lowerFolderName, kind>`; columns `items.extra_kind`, `items.trailer`; table `lyrics`; settings `onlineTrailers`, `onlineLyrics`.

- [ ] **Step 1: Failing migration test** — append to `test/migrations.test.js`:

```js
test('migration 10 adds extra_kind, trailer and the lyrics table', () => {
  const db = openDatabase(path.join(tempDir(), 'm10.db'));
  const cols = db.all('PRAGMA table_info(items)').map((c) => c.name);
  assert.ok(cols.includes('extra_kind') && cols.includes('trailer'));
  const lyr = db.all('PRAGMA table_info(lyrics)').map((c) => c.name);
  assert.deepEqual(lyr, ['item_id', 'source', 'synced', 'text', 'file_mtime', 'fetched_at']);
  assert.equal(db.get('PRAGMA user_version').user_version, MIGRATIONS.length);
  assert.ok(db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'items_extras'").length === 1);
});
```

(Use the file's existing imports: `openDatabase`, `MIGRATIONS`, `tempDir`, `path`, `assert`, `test`.)

- [ ] **Step 2: Run** `node --test test/migrations.test.js` — Expected: FAIL ("extra_kind" missing).

- [ ] **Step 3: Migration** — append to `MIGRATIONS` in `src/db.js`:

```js
  // 10: extras (trailers, featurettes… under a film or show), the TMDB/YouTube trailer, and lyrics.
  `
  ALTER TABLE items ADD COLUMN extra_kind TEXT;
  ALTER TABLE items ADD COLUMN trailer TEXT;
  CREATE INDEX items_extras ON items(parent_id, extra_kind) WHERE extra_kind IS NOT NULL;
  CREATE TABLE lyrics (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('file', 'tags', 'lrclib', 'none')),
    synced INTEGER NOT NULL DEFAULT 0,
    text TEXT,
    file_mtime INTEGER,
    fetched_at INTEGER NOT NULL
  );
  `,
```

And in `src/settings.js` `SETTING_DEFAULTS` add:

```js
  onlineTrailers: true, // the film's YouTube trailer when there is no local one
  onlineLyrics: true, // ask LRCLIB for lyrics the files don't have
```

- [ ] **Step 4: Run** `node --test test/migrations.test.js test/themes.test.js` — Expected: PASS (themes.test asserts `MIGRATIONS.length`).

- [ ] **Step 5: Failing parser test** — append to `test/parser.test.js`:

```js
import { extraKindOf, EXTRA_CAPTIONS } from '../src/library/parser.js';

test('extraKindOf: Kodi folders and suffixes name the kind; the title loses the suffix', () => {
  const p = (s) => extraKindOf(s.replace(/\//g, path.sep));
  assert.deepEqual(p('/m/Film (2019)/Featurettes/Making Of.mkv'), { kind: 'featurette', title: 'Making Of' });
  assert.deepEqual(p('/m/Film (2019)/Behind The Scenes/on_set.mp4'), { kind: 'behindthescenes', title: 'on set' });
  assert.deepEqual(p('/m/Film (2019)/Extras/Bloopers.mkv'), { kind: 'other', title: 'Bloopers' });
  assert.deepEqual(p('/m/Film (2019)/Film (2019)-trailer.mp4'), { kind: 'trailer', title: 'Film (2019)' });
  assert.deepEqual(p('/m/Film-Deleted.mkv'), { kind: 'deleted', title: 'Film' });
  assert.deepEqual(p('/m/Film.2019.1080p-behindthescenes.mkv'), { kind: 'behindthescenes', title: 'Film 2019 1080p' });
  assert.equal(p('/m/Film (2019)/Film (2019).mkv'), null);
  assert.equal(p('/m/Film (2019)/Samples/x.mkv'), null, 'samples are not extras');
  assert.equal(p('/m/Film (2019)/Featurettes/Nested/Deep.mkv'), null, 'only files directly in the folder count');
  assert.equal(EXTRA_CAPTIONS.behindthescenes, 'Behind the scenes');
});
```

- [ ] **Step 6: Run** `node --test test/parser.test.js` — Expected: FAIL (`extraKindOf` is not exported).

- [ ] **Step 7: Parser** — in `src/library/parser.js` replace the `EXTRAS_DIRS` block with:

```js
// Kodi-style extras: a folder beside the film named for the kind, or a suffix on the file name.
export const EXTRA_DIR_KINDS = new Map([
  ['trailers', 'trailer'], ['featurettes', 'featurette'], ['behind the scenes', 'behindthescenes'],
  ['deleted scenes', 'deleted'], ['interviews', 'interview'], ['scenes', 'scene'], ['shorts', 'short'],
  ['extras', 'other'], ['other', 'other'], ['bonus', 'other'],
]);
export const EXTRA_SUFFIX_KINDS = new Map([
  ['trailer', 'trailer'], ['featurette', 'featurette'], ['behindthescenes', 'behindthescenes'], ['deleted', 'deleted'],
  ['interview', 'interview'], ['scene', 'scene'], ['short', 'short'], ['other', 'other'],
]);
export const EXTRA_CAPTIONS = {
  trailer: 'Trailer', featurette: 'Featurette', behindthescenes: 'Behind the scenes', deleted: 'Deleted scene',
  interview: 'Interview', scene: 'Scene', short: 'Short', other: 'Extra',
};
/** Folders the scanner never looks in (samples are never extras). */
export const SKIP_MEDIA_DIRS = new Set(['sample', 'samples', 'specials features']);
const SUFFIX_RE = new RegExp(`^(.*?)[ ._-](${[...EXTRA_SUFFIX_KINDS.keys()].join('|')})$`, 'i');
const cleanTitle = (s) => s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();

/** `{ kind, title }` when a file is a Kodi-style extra (by its folder name or its name's suffix), else null. */
export function extraKindOf(file) {
  const parsed = path.parse(file);
  const folder = path.basename(parsed.dir).toLowerCase();
  const byDir = EXTRA_DIR_KINDS.get(folder);
  if (byDir) return { kind: byDir, title: cleanTitle(parsed.name) };
  const m = SUFFIX_RE.exec(parsed.name);
  if (m) return { kind: EXTRA_SUFFIX_KINDS.get(m[2].toLowerCase()), title: cleanTitle(m[1]) };
  return null;
}
```

Keep every other export. Update the import in `src/library/scanner.js` from `EXTRAS_DIRS` to `SKIP_MEDIA_DIRS` and change the walk's `if (SKIP_DIRS.has(lower) || EXTRAS_DIRS.has(lower)) continue;` to `if (SKIP_DIRS.has(lower) || SKIP_MEDIA_DIRS.has(lower)) continue;` (extras folders are now walked; Task 2 makes them extras). Note the "Nested" case: `extraKindOf('/Featurettes/Nested/Deep.mkv')` is null because only the file's own folder name counts; the walk still descends into it and Task 2 treats such a file as an ordinary video of the folder it is in — for a movies library that means a stray film titled "Deep" unless Task 2's ownership rule drops it (it does: a file under an extras folder with no kind is skipped — see Task 2 Step 3).

- [ ] **Step 8: Run** `node --test test/parser.test.js` and `npm test` — Expected: parser PASS; the full suite 206/206 (the three new cases). If any older-scan test asserted `-trailer` files are skipped, it still passes: Task 2 handles them before upsertMovie.

- [ ] **Step 9: Ledger** `Task 1: complete`.

---

### Task 2: The scanner finds extras and gives them owners

**Files:**
- Modify: `src/library/scanner.js` (`walk`, `scanLibrary`, new `upsertExtra`, `assignExtras`, `prune`, `probePending`)
- Test: `test/extras-scan.test.js` (new)

**Interfaces:**
- Consumes: `extraKindOf`, `EXTRA_DIR_KINDS` (Task 1).
- Produces: items with `kind = 'extra'`, `extra_kind`, `parent_id` (the movie or show), `show_id` (the show when the owner is a show), `title`, `min_age`/`certification` copied from the owner; `Scanner.copyRatingToExtras(ownerId)`.

- [ ] **Step 1: Failing test** — create `test/extras-scan.test.js`:

```js
// Extras: Kodi-style folders and suffixes become `extra` items under their film or show; orphans are dropped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';

let nf, admin;
const media = tempDir();
const ids = {};
const m = path.join(media, 'Movies');
const t = path.join(media, 'TV');

before(async () => {
  if (!hasFfmpeg) return;
  // One film per folder, with every kind of extra.
  makeVideo(path.join(m, 'Solo (2020)', 'Solo (2020).mp4'));
  makeVideo(path.join(m, 'Solo (2020)', 'Solo (2020)-trailer.mp4'));
  makeVideo(path.join(m, 'Solo (2020)', 'Featurettes', 'Making Of.mp4'));
  makeVideo(path.join(m, 'Solo (2020)', 'Deleted Scenes', 'Alt Ending.mp4'));
  makeVideo(path.join(m, 'Solo (2020)', 'Extras', 'Bloopers.mp4'));
  makeVideo(path.join(m, 'Solo (2020)', 'Featurettes', 'Nested', 'Deep.mp4')); // not an extra, not a film
  fs.writeFileSync(path.join(m, 'Solo (2020)', 'Solo (2020).nfo'), '<movie><title>Solo</title><mpaa>R16</mpaa></movie>');
  // Two films in one folder: suffix files match by stem prefix; the folder's Extras belong to nobody.
  makeVideo(path.join(m, 'Pair', 'Alpha (2001).mp4'));
  makeVideo(path.join(m, 'Pair', 'Beta (2002).mp4'));
  makeVideo(path.join(m, 'Pair', 'Alpha (2001)-featurette.mp4'));
  makeVideo(path.join(m, 'Pair', 'Extras', 'Whose.mp4'));
  // A show with an extras folder at its root and a suffix file beside an episode.
  makeVideo(path.join(t, 'Show', 'Season 01', 'Show.S01E01.mp4'));
  makeVideo(path.join(t, 'Show', 'Behind The Scenes', 'Set Tour.mp4'));
  makeVideo(path.join(t, 'Show', 'Season 01', 'Show.S01E01-interview.mp4'));
  // A flat TV layout: no owner, no extra.
  makeVideo(path.join(t, 'Loose.S01E01.mp4'));
  makeVideo(path.join(t, 'Loose.S01E01-trailer.mp4'));
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  ids.movies = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [m] })).data.id;
  ids.tv = (await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [t] })).data.id;
  await waitForScan(admin);
});
after(async () => nf?.app.stop());

const rows = (sql, ...p) => nf.app.core.db.all(sql, ...p);

test('a film in its own folder owns every extra beside it, titled without the suffix', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const solo = rows("SELECT * FROM items WHERE kind = 'movie' AND title = 'Solo'")[0];
  const extras = rows("SELECT extra_kind, title, min_age FROM items WHERE kind = 'extra' AND parent_id = ? ORDER BY extra_kind, title", solo.id);
  assert.deepEqual(extras, [
    { extra_kind: 'deleted', title: 'Alt Ending', min_age: 16 },
    { extra_kind: 'featurette', title: 'Making Of', min_age: 16 },
    { extra_kind: 'other', title: 'Bloopers', min_age: 16 },
    { extra_kind: 'trailer', title: 'Solo (2020)', min_age: 16 },
  ]);
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE title = 'Deep'")[0].n, 0, 'a file nested under an extras folder is neither a film nor an extra');
  assert.ok(extras.every((e) => e.min_age === 16), "the owner's rating is copied");
});

test('several films in one folder: suffix files match by stem, folder extras belong to nobody', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const alpha = rows("SELECT id FROM items WHERE kind = 'movie' AND title LIKE 'Alpha%'")[0];
  assert.deepEqual(rows("SELECT title FROM items WHERE kind = 'extra' AND parent_id = ?", alpha.id), [{ title: 'Alpha (2001)' }]);
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE title = 'Whose'")[0].n, 0);
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE kind = 'movie'")[0].n, 3, 'Solo, Alpha, Beta — no extra became a film');
});

test("a show's extras belong to the show (show_id set); a flat TV layout gives no owner", { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const show = rows("SELECT id FROM items WHERE kind = 'show' AND title = 'Show'")[0];
  const ex = rows("SELECT extra_kind, title, show_id FROM items WHERE kind = 'extra' AND parent_id = ? ORDER BY title", show.id);
  assert.deepEqual(ex, [{ extra_kind: 'behindthescenes', title: 'Set Tour', show_id: show.id }, { extra_kind: 'interview', title: 'Show.S01E01', show_id: show.id }].map((e) => ({ ...e, title: e.title.replace(/\./g, ' ') })));
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE kind = 'extra' AND title LIKE 'Loose%'")[0].n, 0);
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE kind = 'episode'")[0].n, 2);
});

test('extras are probed, and a removed extra disappears on the next scan', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const making = rows("SELECT * FROM items WHERE kind = 'extra' AND title = 'Making Of'")[0];
  assert.ok(making.duration > 0 && making.media, 'probed');
  fs.rmSync(path.join(m, 'Solo (2020)', 'Featurettes', 'Making Of.mp4'));
  await admin.post(`/api/libraries/${ids.movies}/scan`, {});
  await waitForScan(admin);
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE kind = 'extra' AND title = 'Making Of'")[0].n, 0);
});
```

Check `nf.app.core.db` exists (the app exposes `core`); if the field is named differently, use what `startAtomix` returns (`app.core` is used by `test/extras-store.test.js` — mirror it).

- [ ] **Step 2: Run** `node --test test/extras-scan.test.js` — Expected: FAIL (no extras; "Deep" and "Whose" stored as films; `-trailer` skipped).

- [ ] **Step 3: Scanner** — in `src/library/scanner.js`:

(a) Import: `VIDEO_EXTS, SKIP_MEDIA_DIRS, EXTRA_DIR_KINDS, extraKindOf, parseMovie, …`.

(b) In `walk`, replace the `-trailer` skip and the push with:

```js
        const extra = exts === VIDEO_EXTS ? extraKindOf(full) : null;
        // A file under an extras folder that isn't itself an extra (nested deeper) is nothing.
        if (!extra && exts === VIDEO_EXTS && underExtrasDir(root, full)) continue;
        out.push({ file: full, size: st.size, mtime: Math.floor(st.mtimeMs), extra });
```

with, at module level:

```js
/** Whether any folder between the library root and the file is an extras folder (Featurettes/… or nested below one). */
function underExtrasDir(root, file) {
  const rel = path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean);
  return rel.some((seg) => EXTRA_DIR_KINDS.has(seg.toLowerCase()));
}
```

`walk` is called with `root` being the current folder as it recurses, so pass the library root through: change the signature to `walk(root, out = [], seen = new Set(), exts = VIDEO_EXTS, top = root)` and recurse with `walk(full, out, seen, exts, top)`; use `underExtrasDir(top, full)`.

(c) In `scanLibrary`, split files before upserting:

```js
    const extrasFound = lib.type === 'music' ? [] : files.filter((f) => f.extra);
    const mainFiles = lib.type === 'music' ? files : files.filter((f) => !f.extra);
```

use `mainFiles` where `files` was used for upserts (the movie/episode loop and `scanMusic`), then after that transaction:

```js
    if (extrasFound.length) {
      this.setPhase('Finding extras', extrasFound.length);
      this.db.transaction(() => {
        for (const f of extrasFound) {
          const owner = this.ownerOf(lib, f, mainFiles);
          if (!owner) {
            log.debug(`No owner for extra ${f.file}`);
            continue;
          }
          const added = this.upsertExtra(lib, f, owner, scanId);
          if (added) newItems.push(added);
          this.status.done++;
        }
      });
    }
```

Keep `files.length` in the final log line.

(d) New methods on `Scanner`:

```js
  /** The movie or show row an extra belongs to (§4.2 of the spec), or null. */
  ownerOf(lib, f, mainFiles) {
    const extraDir = path.dirname(f.file);
    const isFolderExtra = EXTRA_DIR_KINDS.has(path.basename(extraDir).toLowerCase());
    if (lib.type === 'movies') {
      const folder = isFolderExtra ? path.dirname(extraDir) : extraDir;
      const films = mainFiles.filter((m) => path.dirname(m.file) === folder);
      let file = null;
      if (films.length === 1) file = films[0];
      else if (!isFolderExtra && films.length > 1) {
        const stem = path.parse(f.file).name.toLowerCase();
        file = films.find((m) => stem.startsWith(path.parse(m.file).name.toLowerCase())) || null;
      }
      return file ? this.db.get("SELECT * FROM items WHERE library_id = ? AND kind = 'movie' AND path = ?", lib.id, file.file) : null;
    }
    // TV: the show is the first folder under the root.
    const rel = path.relative(f.root, f.file).split(path.sep);
    if (rel.length < 2) return null;
    const showPath = path.join(f.root, rel[0]);
    return this.db.get("SELECT * FROM items WHERE library_id = ? AND kind = 'show' AND path = ?", lib.id, showPath) || null;
  }

  upsertExtra(lib, f, owner, scanId) {
    const now = Date.now();
    const r = this.upsertItem({
      library_id: lib.id,
      kind: 'extra',
      extra_kind: f.extra.kind,
      parent_id: owner.id,
      show_id: owner.kind === 'show' ? owner.id : null,
      path: f.file,
      title: f.extra.title,
      sort_title: sortTitle(f.extra.title),
      size: f.size,
      mtime: f.mtime,
      certification: owner.certification,
      min_age: owner.min_age,
      added_at: now,
      updated_at: now,
      seen_scan: scanId,
    });
    // The owner's rating can change between scans; keep extras in step.
    this.db.run('UPDATE items SET parent_id = ?, show_id = ?, certification = ?, min_age = ? WHERE id = ?', owner.id, owner.kind === 'show' ? owner.id : null, owner.certification, owner.min_age, r.id);
    return r.created ? r.id : null;
  }

  /** Called after an owner's metadata refresh: its extras take the new rating. */
  copyRatingToExtras(ownerId) {
    this.db.run("UPDATE items SET certification = o.certification, min_age = o.min_age FROM (SELECT id, certification, min_age FROM items WHERE id = ?) AS o WHERE items.kind = 'extra' AND items.parent_id = o.id", ownerId);
  }
```

Check whether `upsertItem` matches on `(library_id, kind, path)` — it does; the existing-row branch keeps `extra_kind` as first stored, which is fine (the UPDATE after it refreshes the owner link).

(e) `prune`: change `kind IN ('movie','episode','track')` to `kind IN ('movie','episode','track','extra')`. `probePending`: `kind IN ('movie','episode')` → `kind IN ('movie','episode','extra')`.

(f) The show path: `upsertEpisode` computes `showPath` the same way (`path.join(f.root, parts[0])`) — confirm `items.path` for shows is set to that (`grep "kind: 'show'" src/library/scanner.js`); if the show row's `path` is something else, match on it the same way `upsertEpisode` finds the show.

(g) Hook the rating copy: in `src/library/metadata.js` `refresh()`, after `await this.hooks?.emit('metadata:updated', …)` add `this.db.run("UPDATE items SET certification = ?, min_age = ? WHERE kind = 'extra' AND parent_id = ?", updated.certification, updated.min_age, item.id);` (one line; no scanner dependency).

- [ ] **Step 4: Run** `node --test test/extras-scan.test.js` — Expected: PASS 4/4. Then `npm test` — Expected: all pass (the `api.test.js` scan counts don't include extras: it uses no extras folders).

- [ ] **Step 5: Ledger** `Task 2: complete`.

---

### Task 3: Extras are hidden everywhere but the title page; the API and player accept them

**Files:**
- Modify: `src/api/library.js` (`/api/items/:id`: `extras` for movies/shows, `parent` for extras; `requireItem` unchanged), `src/api/serialize.js` (`extraKind`, `caption`), `src/api/playback.js` (accept `extra`; no `next`), `src/lists.js` (`TAKES` unchanged — a test proves `add` returns false), `src/collections.js` (`create`/`setItems` skip non movie/show — already; test proves it)
- Test: `test/extras-api.test.js` (add a section; the file exists for previews/intros — append a new `describe`-less group with its own server, or create `test/extras-items-api.test.js`). Create `test/extras-items-api.test.js` to keep the old file untouched.

**Interfaces:**
- Produces: `GET /api/items/:id` → `extras: [{ id, title, extraKind, caption, duration, poster, progress }]` on movies/shows; for an extra: `item.extraKind`, `item.caption`, `parent: { id, title, kind }`; `POST /api/items/:id/playback` works for extras and returns `next: null`.

- [ ] **Step 1: Failing test** — create `test/extras-items-api.test.js` with the same `before` as Task 2's test (copy it; add a kids profile `Mia` with `maxAge: 10` like `test/lists-api.test.js` does, and `Solo`'s nfo rating `R16`), then:

```js
test('a film page lists its extras in kind order with captions; an extra knows its parent', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const solo = (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items.find((i) => i.title === 'Solo');
  const page = (await admin.get(`/api/items/${solo.id}`)).data;
  assert.deepEqual(page.extras.map((e) => [e.extraKind, e.caption, e.title]), [
    ['trailer', 'Trailer', 'Solo (2020)'], ['featurette', 'Featurette', 'Making Of'], ['deleted', 'Deleted scene', 'Alt Ending'], ['other', 'Extra', 'Bloopers'],
  ]);
  const ex = (await admin.get(`/api/items/${page.extras[1].id}`)).data;
  assert.equal(ex.item.kind, 'extra');
  assert.deepEqual(ex.parent, { id: solo.id, title: 'Solo', kind: 'movie' });
});

test('extras never show in the library grid, Home, search, picks, playlists or collections', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const grid = (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items;
  assert.ok(grid.every((i) => i.kind !== 'extra'));
  const home = (await admin.get('/api/home')).data;
  assert.ok(home.rows.every((r) => r.items.every((i) => i.kind !== 'extra')));
  const search = (await admin.get('/api/search?q=Making')).data;
  assert.ok(!JSON.stringify(search).includes('Making Of'));
  const solo = grid.find((i) => i.title === 'Solo');
  const extraId = (await admin.get(`/api/items/${solo.id}`)).data.extras[0].id;
  const list = (await admin.post('/api/lists', { kind: 'video', name: 'X' })).data;
  assert.equal((await admin.post(`/api/lists/${list.id}/items`, { itemId: extraId })).status, 400);
  const col = (await admin.post('/api/collections', { name: 'C', itemIds: [extraId, solo.id] })).data;
  assert.deepEqual((await admin.get(`/api/collections/${col.id}?all=1`)).data.items.map((i) => i.id), [solo.id]);
});

test("a kid can't reach a hidden film's extras, by page or by playback", { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const solo = (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items.find((i) => i.title === 'Solo');
  const extraId = (await admin.get(`/api/items/${solo.id}`)).data.extras[0].id;
  assert.equal((await kid.get(`/api/items/${extraId}`)).status, 404);
  assert.equal((await kid.post(`/api/items/${extraId}/playback`, {})).status, 404);
  const play = (await admin.post(`/api/items/${extraId}/playback`, {})).data;
  assert.equal(play.next, null, 'no Up next after an extra');
  assert.ok(play.sessionId);
});
```

- [ ] **Step 2: Run** `node --test test/extras-items-api.test.js` — Expected: FAIL (`page.extras` undefined; playback 404 for the admin).

- [ ] **Step 3: Implement**

`src/api/serialize.js`, inside `serializeItem` after `addedAt`: 

```js
  if (row.extra_kind) {
    out.extraKind = row.extra_kind;
    out.caption = EXTRA_CAPTIONS[row.extra_kind] || 'Extra';
  }
```

(import `EXTRA_CAPTIONS` from `../library/parser.js`).

`src/api/library.js` `/api/items/:id`: in the `movie || show` block add

```js
      out.extras = library.withProgress(core.library.extrasOf(row.id, viewer), viewer);
```

and before the final `return out`:

```js
    if (row.kind === 'extra') {
      const parent = library.get(row.parent_id);
      out.parent = parent ? { id: parent.id, title: parent.title, kind: parent.kind } : null;
    }
```

`src/library/queries.js`: add

```js
  /** A film's or show's extras the viewer may see, in kind order then title. */
  extrasOf(ownerId, viewer) {
    const vis = this.visibility(viewer);
    const order = Object.keys(EXTRA_CAPTIONS).map((k, i) => `WHEN '${k}' THEN ${i}`).join(' ');
    return this.db.all(`SELECT i.* FROM items i WHERE i.kind = 'extra' AND i.parent_id = ? AND ${vis.sql} ORDER BY CASE i.extra_kind ${order} ELSE 99 END, i.sort_title COLLATE NOCASE`, ownerId, ...vis.params);
  }
```

(import `EXTRA_CAPTIONS`). Check `requireItem` in `src/api/library.js` already applies `canSee` (it does for lists: a kid's 404 comes from `min_age` 16 copied onto the extra).

`src/api/playback.js` line ~26: `['movie', 'episode', 'track']` → `['movie', 'episode', 'track', 'extra']`; where `next` is computed: `const next = item.kind === 'track' || item.kind === 'extra' ? null : …`. Check `src/stream/playback.js` for kind checks (`grep kind src/stream/playback.js`): if it switches on `episode` vs other, an extra takes the movie path. The progress route (`/api/items/:id/progress`) must accept extras — check its kind list and add `'extra'`. `continueWatching` filters `kind IN ('movie','episode')` already, so extras' progress never surfaces there.

`src/lists.js` `TAKES`: unchanged (`video: ['movie','episode']`), so `add` returns false → the route answers 400 (confirm the route maps false to 400; the lists-api test "a show can't join a video playlist" shows the status).

`src/collections.js` `setItems`: already keeps only movie/show (`if (!it || !['movie','show'].includes(it.kind)) continue;`).

`/api/search`: uses `library.list({ kind })` per kind → extras excluded by construction. `Library.list()` with no `kind` is used by the library grid with explicit kinds (`grep "library.list(" src/api/library.js` to confirm every call passes `kind`); where one doesn't, add `kind: ['movie','show','artist','album']` or the existing default — note it in the ledger.

- [ ] **Step 4: Run** `node --test test/extras-items-api.test.js` — Expected: PASS 3/3; `npm test` all green.

- [ ] **Step 5: Ledger** `Task 3: complete`.

---

### Task 4: TMDB trailers — `pickTrailer`, `items.trailer`, the `trailer` field and the CSP

**Files:**
- Modify: `src/library/metadata.js` (`FIELDS` + `trailer`; `pickTrailer` export; movie/show fetch `append_to_response` + `videos`; `refresh()` writes `trailer`; `enrichMissing` fills it), `src/api/library.js` (`trailer` field on items and the Home hero), `src/app.js` (CSP `frame-src`)
- Test: `test/trailers.test.js` (new: `pickTrailer` unit cases + a server test for the field), `test/enrich.test.js` (extend the fake TMDB with `videos`)

**Interfaces:**
- Produces: `pickTrailer(videos: TmdbVideo[], language: string) → { site: 'youtube', key, name } | null`; `items.trailer` JSON; `GET /api/items/:id` → `trailer: { kind: 'local', itemId } | { kind: 'youtube', key, name } | null` on movies/shows; `GET /api/home` → `hero.trailer` the same shape.

- [ ] **Step 1: Failing unit test** — `test/trailers.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickTrailer } from '../src/library/metadata.js';

const v = (o) => ({ site: 'YouTube', type: 'Trailer', official: true, iso_639_1: 'en', published_at: '2020-01-01T00:00:00Z', key: 'k', name: 'n', ...o });

test('pickTrailer: YouTube trailers only; official, then the metadata language, then English, then newest', () => {
  assert.equal(pickTrailer([v({ site: 'Vimeo' })], 'en-US'), null);
  assert.equal(pickTrailer([v({ type: 'Clip' })], 'en-US'), null);
  assert.deepEqual(pickTrailer([v({ type: 'Teaser', key: 't' })], 'en-US'), { site: 'youtube', key: 't', name: 'n' }, 'a teaser when there is no trailer');
  assert.equal(pickTrailer([v({ official: false, key: 'fan' }), v({ key: 'off' })], 'en-US').key, 'off');
  assert.equal(pickTrailer([v({ iso_639_1: 'en', key: 'en' }), v({ iso_639_1: 'fr', key: 'fr' })], 'fr-FR').key, 'fr');
  assert.equal(pickTrailer([v({ iso_639_1: 'de', key: 'de' }), v({ iso_639_1: 'en', key: 'en' })], 'fr-FR').key, 'en');
  assert.equal(pickTrailer([v({ key: 'old', published_at: '2019-01-01T00:00:00Z' }), v({ key: 'new', published_at: '2021-01-01T00:00:00Z' })], 'en-US').key, 'new');
  assert.equal(pickTrailer(undefined, 'en-US'), null);
});
```

- [ ] **Step 2: Run** `node --test test/trailers.test.js` — Expected: FAIL (not exported).

- [ ] **Step 3: `pickTrailer`** — in `src/library/metadata.js` near `keywordNames`:

```js
/** The YouTube trailer to offer: official first, the metadata language, then English, then the newest. */
export function pickTrailer(videos, language = 'en-US') {
  const lang = String(language || 'en').slice(0, 2).toLowerCase();
  const yt = (videos || []).filter((x) => x.site === 'YouTube' && x.key);
  const pool = yt.filter((x) => x.type === 'Trailer').length ? yt.filter((x) => x.type === 'Trailer') : yt.filter((x) => x.type === 'Teaser');
  if (!pool.length) return null;
  const rank = (x) => (x.official ? 0 : 4) + (x.iso_639_1 === lang ? 0 : x.iso_639_1 === 'en' ? 1 : 2);
  pool.sort((a, b) => rank(a) - rank(b) || String(b.published_at || '').localeCompare(String(a.published_at || '')));
  return { site: 'youtube', key: pool[0].key, name: pool[0].name || 'Trailer' };
}
```

Add `'trailer'` to `FIELDS`. In the movie fetch: `append_to_response: 'release_dates,images,keywords,credits,videos'` and `trailer: pickTrailer(m.videos?.results, this.settings.get('metadataLanguage'))` in the returned object; the show fetch: `…,aggregate_credits,videos` and the same line with `s.videos?.results`. In `refresh()`'s UPDATE add `trailer = ?` with `JSON.stringify(pick(m.trailer, parseJson(item.trailer, null)))` — when the provider gives none and `keepOld`, the old value stays; with `opts.clear` it becomes null. In `enrichMissing`, after `applyEnrichment(...)` add `if (result.trailer) this.db.run('UPDATE items SET trailer = ? WHERE id = ?', JSON.stringify(result.trailer), item.id);` and widen its SELECT so titles with people but no trailer are also visited once: `WHERE kind IN ('movie','show') AND tmdb_id IS NOT NULL AND ((keywords = '[]' AND people = '[]') OR trailer IS NULL)` — and mark a title TMDB has no trailer for with `trailer = '{"site":"none"}'` so it isn't re-asked (`pickTrailer` null → store `{ site: 'none' }`). The API treats `site !== 'youtube'` as no trailer.

- [ ] **Step 4: Run** `node --test test/trailers.test.js test/enrich.test.js test/metadata.test.js` — Expected: PASS. Extend `test/enrich.test.js`'s fake `/3/movie/348` with `videos: { results: [{ site: 'YouTube', type: 'Trailer', official: true, iso_639_1: 'en', key: 'abc123', name: 'Official' }] }` and assert in the existing first test `assert.deepEqual(JSON.parse(row(ids.alien).trailer), { site: 'youtube', key: 'abc123', name: 'Official' })`; in the `enrichMissing` test assert the "quiet" film ends with `trailer = '{"site":"none"}'`.

- [ ] **Step 5: Failing API test** — append to `test/trailers.test.js` a server section (`startAtomix` with a fake TMDB that answers `/3/search/movie` for "Solo" and `/3/movie/77` with `videos`), a film `Solo (2020)` with a `-trailer.mp4` and a film `Bare (2021)` with none, a kids profile, then:

```js
test('the trailer field: local wins, YouTube is the fallback, kids get local only, the switch turns YouTube off', async () => {
  const solo = (await admin.get(`/api/items/${ids.solo}`)).data;
  assert.equal(solo.trailer.kind, 'local');
  assert.equal(solo.trailer.itemId, solo.extras.find((e) => e.extraKind === 'trailer').id);
  assert.deepEqual((await admin.get(`/api/items/${ids.bare}`)).data.trailer, { kind: 'youtube', key: 'abc123', name: 'Official' });
  assert.equal((await kid.get(`/api/items/${ids.bare}`)).data.trailer, null, 'no YouTube for kids');
  assert.equal((await kid.get(`/api/items/${ids.solo}`)).data.trailer, null, 'Solo is R16: hidden entirely (404 on the page)');
  await admin.patch('/api/settings', { onlineTrailers: false });
  assert.equal((await admin.get(`/api/items/${ids.bare}`)).data.trailer, null);
  await admin.patch('/api/settings', { onlineTrailers: true });
  const home = (await admin.get('/api/home')).data;
  assert.ok(home.hero === null || 'trailer' in home.hero);
});
```

(Give both films `NZ:G` nfo ratings except keep Solo at `R16` to prove the hidden case: then the kid's `GET /api/items/solo` is a 404 — assert `status === 404` instead of `trailer === null`.) Check the settings route path (`src/api/admin.js` — `PATCH /api/settings` or `PUT`); use the real one.

- [ ] **Step 6: Run** — Expected: FAIL (`trailer` undefined).

- [ ] **Step 7: The field** — `src/api/library.js`, a helper above the routes:

```js
  /** What the Trailer button plays: a local trailer the viewer may see, else the YouTube one (not for kids, and only with the switch on). */
  function trailerFor(row, ctx) {
    const local = db.get(`SELECT id, min_age, library_id, show_id, kind FROM items WHERE kind = 'extra' AND extra_kind = 'trailer' AND parent_id = ? ORDER BY sort_title COLLATE NOCASE LIMIT 1`, row.id);
    if (local && library.canSee(ctx.viewer, local)) return { kind: 'local', itemId: local.id };
    const t = parseJson(row.trailer, null);
    if (t?.site === 'youtube' && settings.get('onlineTrailers') && !ctx.profile?.kids) return { kind: 'youtube', key: t.key, name: t.name || 'Trailer' };
    return null;
  }
```

Use it in `/api/items/:id` (`out.trailer = trailerFor(row, ctx)` in the movie/show block) and on the Home hero (`if (hero) hero.trailer = trailerFor(heroRow, ctx)`). Confirm `settings` and `db` are in scope in that module (they are used for the hero query); import `parseJson`.

CSP: in `src/app.js` append `frame-src https://www.youtube-nocookie.com;` to the CSP string (`default-src 'self'` otherwise blocks frames). Add a line to `test/rebrand.test.js` or `test/api.test.js`'s existing header check if one asserts the exact CSP — grep `Content-Security-Policy` in `test/`; update the expectation if needed.

- [ ] **Step 8: Run** `node --test test/trailers.test.js` then `npm test` — Expected: PASS.

- [ ] **Step 9: Mock TMDB** — `devtools/mock-tmdb.mjs`: `/3/movie/:id` adds `videos: { results: [{ site: 'YouTube', type: 'Trailer', official: true, iso_639_1: 'en', key: 'dQw4w9WgXcQ', name: 'Official Trailer', published_at: '2020-01-01T00:00:00Z' }] }` for `102` and `103` only (The Test Movie, 101, has none — so one dev film has no trailer at all). Restart the mock (kill by PID, never `pkill -f`).

- [ ] **Step 10: Ledger** `Task 4: complete`.

---

### Task 5: Extra thumbnails — the `thumb` background job

**Files:**
- Modify: `src/extras/store.js` (`nextThumbItem`, `THUMBABLE`), `src/extras/jobs.js` (`thumb`), `src/tasks.js` (`next()`, `run`, `recordFailure`, the dashboard label), `src/extras/previews.js` or new `src/extras/thumbs.js` (`makeThumb`)
- Test: `test/thumbs.test.js` (new), `test/tasks.test.js` (one case: `thumb` comes after previews)

**Interfaces:**
- Produces: `makeThumb({ ffmpegPath, imagesDir, item }) → 'cache:<file>'`; `store.nextThumbItem(onlyIds)`; job `'thumb'` in `media_jobs`.

- [ ] **Step 1: Failing test** — `test/thumbs.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo } from './helpers.js';
import { makeThumb } from '../src/extras/thumbs.js';

test('makeThumb writes one JPEG a tenth of the way in and returns a cache: reference', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = tempDir();
  const file = path.join(dir, 'clip.mp4');
  makeVideo(file, { seconds: 5 });
  const imagesDir = path.join(dir, 'images');
  fs.mkdirSync(imagesDir);
  const ref = await makeThumb({ ffmpegPath: 'ffmpeg', imagesDir, item: { id: 7, path: file, duration: 5, size: 1, mtime: 2 } });
  assert.match(ref, /^cache:thumb-7-1-2\.jpg$/);
  const st = fs.statSync(path.join(imagesDir, ref.slice(6)));
  assert.ok(st.size > 500);
});
```

- [ ] **Step 2: Run** — Expected: FAIL (module missing).

- [ ] **Step 3: `src/extras/thumbs.js`**:

```js
// One still frame for an extra (a tenth of the way in), kept with the other artwork in data/images.
import path from 'node:path';
import { run } from '../library/probe.js';

export async function makeThumb({ ffmpegPath, imagesDir, item, onSpawn, timeout = 2 * 60 * 1000 }) {
  const name = `thumb-${item.id}-${item.size ?? 0}-${item.mtime ?? 0}.jpg`;
  const at = Math.max(0, Math.min((item.duration || 0) * 0.1, 600));
  await run(
    ffmpegPath,
    ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(at.toFixed(2)), '-i', item.path, '-map', '0:V:0', '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', path.join(imagesDir, name)],
    { timeout, onSpawn },
  );
  return `cache:${name}`;
}
```

(`run` from `probe.js` takes `(bin, args, { timeout, onSpawn })` — confirm by reading `previews.js`'s import; if `run` lives elsewhere, import from there.)

`src/extras/store.js`: add `const THUMBABLE = "i.kind = 'extra' AND i.path IS NOT NULL AND i.duration > 0 AND i.poster IS NULL";` and

```js
  /** Oldest extra still without a picture. */
  nextThumbItem(onlyIds = null) {
    return this.db.get(`SELECT i.* FROM items i LEFT JOIN media_jobs j ON j.item_id = i.id AND j.job = 'thumb' WHERE ${THUMBABLE} AND ${STALE} ${onlyIds ? ONLY : ''} ORDER BY i.id LIMIT 1`, ...(onlyIds ? [JSON.stringify(onlyIds)] : [])) || null;
  }
```

`src/extras/jobs.js`: add

```js
    async thumb(item, { signal, onSpawn }) {
      const ref = await makeThumb({ ffmpegPath: config.ffmpegPath, imagesDir: config.imagesDir, item, onSpawn });
      signal?.throwIfAborted();
      if (store.saveJob(item, 'thumb', { status: 'done' })) store.db.run('UPDATE items SET poster = ? WHERE id = ?', ref, item.id);
    },
```

`src/tasks.js` `next()`'s `pick`: after the previews branch, `if (s.previewsEnabled) { const item = this.store.nextThumbItem(only); if (item) return { key: \`thumb:${item.id}:${item.size}:${item.mtime}\`, job: 'thumb', item, itemId: item.id, title: this.store.itemLabel(item) }; }`. In the run switch: `if (task.job === 'previews') … else if (task.job === 'thumb') await this.jobs.thumb(task.item, ctx); else …`; `recordFailure`: `if (task.job === 'previews' || task.job === 'thumb') this.store.saveJob(task.item, task.job, …)`; the warn label: `{ previews: 'Previews', thumb: 'Thumbnail', intros: 'Intro check' }[task.job]`. Check `itemLabel` handles an `extra` row (it likely formats `title (year)` — fine). Check the dashboard's waiting counts (`store.counts()` or similar) and add thumbs to the previews count with the copy "previews and extra thumbnails" in `public/js/views/settings.js`'s Background tasks copy.

- [ ] **Step 4: Run** `node --test test/thumbs.test.js test/tasks.test.js test/extras-store.test.js` — Expected: PASS. Add to `test/tasks.test.js` one case if its fixture allows: an extra with no poster is picked after a pending previews item (`store.nextThumbItem()` returns it; `runner.next().job === 'previews'` first). If the fixture makes that awkward, a store-level test in `test/extras-store.test.js` that `nextThumbItem` returns only `extra` rows with null poster is the minimum.

- [ ] **Step 5: Ledger** `Task 5: complete`.

---

### Task 6: Client — Trailer button, the trailer page, the Extras row, player return, settings switches

**Files:**
- Create: `public/js/views/trailer.js`
- Modify: `public/js/app.js` (route `#/trailer/:id`), `public/js/views/item.js` (Trailer button, Extras row), `public/js/components.js` (spotlight Trailer button; `landscapeCard` caption for extras), `public/js/views/player.js` (`?from=`, title line, no Up next for extras, return), `public/js/views/settings.js` (two toggles), `public/css/app.css`, `public/css/orbit.css`, `themes/orbit/theme.css` (`.trailer-view`)
- Harness: `devtools/extras-lyrics-ui.mjs` (new; sections `trailer|extras`)

- [ ] **Step 1: Dev data** — extend `devtools/make-extras-media.mjs` (or a new `devtools/make-v010-media.mjs`): with `makeVideo` from `test/helpers.js` (VP9/Opus so Chromium plays them: pass `{ vcodec: 'libvpx-vp9', acodec: 'libopus' }` and `.webm` names) create `/home/claude/testmedia/Movies/Another.Film.2019.720p.BluRay.x264-trailer.webm` (flat layout: prefix match), `/home/claude/testmedia/Movies/The Test Movie (2020)/Featurettes/Making Of.webm`, `/home/claude/testmedia/Movies/The Test Movie (2020)/Deleted Scenes/Alt Ending.webm`. Run it, restart the dev server, scan (`POST /api/scan`), confirm with `/api/items/<Test Movie>` that `extras.length === 2` and Another Film's `trailer.kind === 'local'`; HEVC Sample Movie should get `trailer.kind === 'youtube'` from the mock; The Test Movie none (mock 101 has no videos).

- [ ] **Step 2: Failing browser checks** — `devtools/extras-lyrics-ui.mjs` (same shape as `lists-ui.mjs`: `open`, `signIn`, `go`, `check`, `api`, cleanup, `check('no console errors', …)`):

```js
if (run('trailer')) {
  const films = (await api(page, 'GET', '/api/libraries/1/items')).items;
  const another = films.find((f) => f.title === 'Another Film');
  const hevc = films.find((f) => f.title === 'HEVC Sample Movie');
  const testMovie = films.find((f) => f.title === 'The Test Movie');
  await go(page, `#/item/${another.id}`, '.detail-info');
  check('a film with a local trailer has a Trailer button', (await page.$('.detail-info .btn:has-text("Trailer")')) !== null);
  await page.click('.detail-info .btn:has-text("Trailer")');
  await page.waitForSelector('.player video');
  check('…which plays in the normal player', location === location); // the selector wait is the check
  await page.evaluate(() => { const v = document.querySelector('.player video'); v.pause(); v.dispatchEvent(new Event('ended')); });
  await page.waitForFunction((id) => location.hash === `#/item/${id}`, another.id, { timeout: 10000 });
  check('…and returns to the film when it ends (no Up next)', true);
  await go(page, `#/item/${hevc.id}`, '.detail-info');
  await page.click('.detail-info .btn:has-text("Trailer")');
  await page.waitForSelector('.trailer-view iframe');
  check('a YouTube trailer opens the trailer page with the frame and a focused Back', await page.evaluate(() => document.activeElement?.textContent?.trim() === 'Back' && document.querySelector('.trailer-view iframe').src.startsWith('https://www.youtube-nocookie.com/embed/')));
  await page.keyboard.press('Escape');
  await page.waitForFunction((id) => location.hash === `#/item/${id}`, hevc.id);
  check('Back leaves the trailer page', true);
  await go(page, `#/item/${testMovie.id}`, '.detail-info');
  check('a film with no trailer has no button', (await page.$('.detail-info .btn:has-text("Trailer")')) === null);
  // The switch off: the page refuses rather than embeds.
  await api(page, 'PATCH', '/api/settings', { onlineTrailers: false });
  await go(page, `#/trailer/${hevc.id}`, '.trailer-view');
  check('with online trailers off the trailer page shows the empty state', (await page.$('.trailer-view iframe')) === null && (await page.textContent('.trailer-view')).includes('Nothing to play'));
  await api(page, 'PATCH', '/api/settings', { onlineTrailers: true });
  await go(page, '#/', '.home-view');
  await page.waitForTimeout(800);
  const hero = await api(page, 'GET', '/api/home');
  check('the spotlight has a Trailer button exactly when the hero has one', Boolean(await page.$('.spot-actions .btn:has-text("Trailer")')) === Boolean(hero.hero?.trailer));
}
if (run('extras')) {
  const testMovie = (await api(page, 'GET', '/api/libraries/1/items')).items.find((f) => f.title === 'The Test Movie');
  await go(page, `#/item/${testMovie.id}`, '.detail-info');
  check('the film page has an Extras row with captions', (await page.$$eval('.row[data-row="extras"] .card-sub', (els) => els.map((e) => e.textContent))).join('|').includes('Featurette'));
  check('extras come before Part of / More like this', await page.evaluate(() => { const rows = [...document.querySelectorAll('.row')].map((r) => r.dataset.row); return rows.indexOf('extras') < Math.max(rows.indexOf('collection'), rows.indexOf('similar'), 0) || rows.indexOf('extras') === rows.length - 1; }));
  await page.click('.row[data-row="extras"] .card');
  await page.waitForSelector('.player video');
  check('an extra plays with the kind and film in the title line', (await page.textContent('.player-top')).includes('Featurette') || (await page.textContent('.player-top')).includes('Deleted'));
  await page.evaluate(() => { const v = document.querySelector('.player video'); v.pause(); v.dispatchEvent(new Event('ended')); });
  await page.waitForFunction((id) => location.hash === `#/item/${id}`, testMovie.id, { timeout: 10000 });
  check('…and returns to the film', true);
  await go(page, '#/library/1', '.library-results');
  check('extras are not in the library grid', (await page.$$('.library-results .card')).length === 3);
}
```

Fix the one silly line (`location === location`) to `true` after the wait. Run `node /home/claude/devtools/extras-lyrics-ui.mjs trailer` — Expected: FAIL at the first Trailer button.

- [ ] **Step 3: Item page** — `public/js/views/item.js`, in the movie/show action block after the Play/Resume buttons:

```js
    if (data.trailer) {
      const t = data.trailer;
      actions.push(button('Trailer', { icon: 'film', variant: 'ghost', href: t.kind === 'local' ? `#/play/${t.itemId}?from=${item.id}` : `#/trailer/${item.id}` }));
    }
```

(Check `film` is an icon in `dom.js`; it is used by `pickList` in `lists.js`.) After the details block / seasons and before the `collection` row: `if (data.extras?.length) body.append(row({ id: 'extras', title: 'Extras', items: data.extras.map((e) => ({ ...e, href: \`#/play/${e.id}?from=${item.id}\` })), style: 'landscape' }));` — `landscapeCard` builds its `href` from the item (`#/play/<id>`); add support for an `item.href` override and show `item.caption` as the `card-sub` when `item.extraKind` (and the length `formatRuntime(duration/60)` after it). Read `landscapeCard`'s caption code (`cap.sub`) and add: `if (item.extraKind) return { title: item.title, sub: [item.caption, item.duration ? formatRuntime(item.duration / 60) : null].filter(Boolean).join(' · '), left: null };` at the top of the caption helper.

Spotlight (`components.js` `spotlight`): add a third button `const trailerBtn = h('a', { class: 'btn btn-ghost', hidden: true }, icon('film'), h('span', {}, 'Trailer'));` in `spot-actions`; in `show(item)`: `trailerBtn.hidden = !item.trailer; if (item.trailer) trailerBtn.href = item.trailer.kind === 'local' ? \`#/play/${item.trailer.itemId}?from=${item.id}\` : \`#/trailer/${item.id}\`;`.

- [ ] **Step 4: Trailer view** — `public/js/views/trailer.js`:

```js
// A YouTube trailer, embedded. Dark page, the frame as big as the screen allows, Back under it with focus.
import { h, icon } from '../dom.js';
import { api } from '../api.js';
import { setTitle, goBack } from '../app.js';
import { button, emptyState } from '../components.js';
import { music } from '../music.js';

export async function render(el, params) {
  el.classList.add('trailer-view');
  const data = await api.get(`/api/items/${params.id}`).catch(() => null);
  const t = data?.trailer;
  if (!t || t.kind !== 'youtube') {
    setTitle('Trailer');
    el.append(emptyState({ title: 'Nothing to play here', text: 'This title has no trailer to show.' }), button('Back', { icon: 'back', autofocus: true, onClick: () => goBack(`#/item/${params.id}`) }));
    return;
  }
  setTitle(`${data.item.title} — Trailer`);
  if (music.playing) music.pause();
  const frame = h('iframe', { src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(t.key)}?autoplay=1&rel=0&modestbranding=1`, title: `${data.item.title} trailer`, allow: 'autoplay; encrypted-media; fullscreen', allowfullscreen: '', referrerpolicy: 'strict-origin-when-cross-origin' });
  const note = h('p', { class: 'muted trailer-note', hidden: true }, 'The trailer didn’t load — this TV may not reach YouTube.');
  const back = button('Back', { icon: 'back', autofocus: true, onClick: () => goBack(`#/item/${params.id}`) });
  let loaded = false;
  frame.addEventListener('load', () => (loaded = true));
  const timer = setTimeout(() => { if (!loaded) note.hidden = false; }, 6000);
  el.append(h('h1', {}, data.item.title), h('div', { class: 'trailer-frame' }, frame), note, h('div', { class: 'actions' }, back));
  return () => clearTimeout(timer);
}
```

Confirm views may return a cleanup function (player.js returns `cleanupFn`) and that `goBack` is exported from `app.js` (it is). Route in `app.js`: `{ pattern: /^\/trailer\/(\d+)$/, keys: ['id'], view: () => import('./views/trailer.js'), fullscreen: true }` — check what `fullscreen` does (hides the shell for the player); use it so the menu rail doesn't sit beside the frame; if `fullscreen` also hides the clock cluster and that looks wrong, drop it and style instead. Back/Escape: the app's `onBackKey` runs `goBack()` for normal pages — fine.

- [ ] **Step 5: Player** — `public/js/views/player.js`: read `query.from`; in `leave()` and in the `ended` handler for `item.kind === 'extra'` (the API gives `session.next === null` already, so `ended` → `showControls(true)`; add: `if (item.kind === 'extra') { leave(); return; }` before it). `leave()`: `goBack(query.from ? \`#/item/${query.from}\` : …)`. `state.playingItemHash` for extras: `#/item/${item.parentId}`. Title line for an extra: `titleEl.append(h('h1', {}, item.title), h('p', {}, \`${item.caption} · ${data.parent?.title || ''}\`))` (the `/api/items/:id` call the player already makes returns `parent`). The dev clips end via `ended` dispatch in the harness, as in `lists-ui`.

- [ ] **Step 6: Settings** — `serverTab`: `const trailersOn = h('input', { type: 'checkbox', checked: s.onlineTrailers });` and `lyricsOn` likewise; a new section `section('Online extras', h('label', { class: 'check' }, trailersOn, h('span', {}, "Online trailers: play the film's YouTube trailer when there is no local one (not for kids profiles)")), h('label', { class: 'check' }, lyricsOn, h('span', {}, 'Online lyrics: ask LRCLIB for lyrics your files don’t have')))` after Background tasks; save `onlineTrailers: trailersOn.checked, onlineLyrics: lyricsOn.checked`. The Background tasks previews label becomes 'Seek-bar previews and extra thumbnails: small pictures above the seek bar and for extras (a few MB per film)'.

- [ ] **Step 7: Styles** — `app.css`: `.trailer-view { padding: 24px var(--gutter); display: flex; flex-direction: column; gap: 18px; align-items: flex-start; } .trailer-view h1 { margin: 0; } .trailer-frame { width: 100%; max-width: calc((100vh - 220px) * 16 / 9); aspect-ratio: 16 / 9; background: #000; border-radius: var(--radius); overflow: hidden; } .trailer-frame iframe { width: 100%; height: 100%; border: 0; display: block; }`. `orbit.css`: `body[data-layout="orbit"] .trailer-view { padding-top: calc(60 * var(--px)); gap: calc(20 * var(--px)); }` and on wide screens the frame `max-width: calc((100dvh - 260 * var(--px)) * 16 / 9)`. `theme.css`: `.trailer-view { background: #05050c; } .trailer-frame { border-radius: calc(18 * var(--px)); box-shadow: var(--lift); }`.

- [ ] **Step 8: Run** `node /home/claude/devtools/extras-lyrics-ui.mjs trailer extras` — Expected: all PASS, no console errors (the YouTube frame itself may log a blocked-resource warning from inside the frame — the harness ignores "Failed to load resource" already; if YouTube is unreachable from the sandbox the `load` event still fires for the error page, so the 6 s note stays hidden — accept either and assert only on the frame's presence).

- [ ] **Step 9: Ledger** `Task 6: complete` (also run `orbit-ui.mjs`: the film page's action row gained a button; fix any check that counted buttons, in the ledger).

---

### Task 7: Lyrics — LRC parsing, tags at scan, the store with LRCLIB, the route

**Files:**
- Create: `public/js/lrc.js`, `src/lyrics.js`
- Modify: `src/library/probe.js` (keep `tags.lyrics`), `src/app.js` (`core.lyrics`), `src/api/library.js` (`GET /api/items/:id/lyrics`)
- Test: `test/lrc.test.js`, `test/lyrics.test.js`

**Interfaces:**
- Produces: `parseLrc(text) → { synced: boolean, lines: [{ at: number | null, text: string }], offset: number }`; `class Lyrics({ db, settings, fetchFn = fetch, version })` with `async get(track) → { synced, lines, source } | null`; route `GET /api/items/:id/lyrics` → that object or `204`.

- [ ] **Step 1: Failing parser test** — `test/lrc.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc } from '../public/js/lrc.js';

test('parseLrc: stamps, several stamps per line, offset, metadata tags dropped, sorted', () => {
  const r = parseLrc('[ar:Band]\n[offset:+500]\n[00:12.00]Line one\n[00:01.5][00:20.250]Twice\n[01:00]Minute\n\n[00:05.00]');
  assert.equal(r.synced, true);
  assert.equal(r.offset, 0.5);
  assert.deepEqual(r.lines.map((l) => [Number(l.at.toFixed(2)), l.text]), [[2, 'Twice'], [5.5, ''], [12.5, 'Line one'], [20.75, 'Twice'], [60.5, 'Minute']]);
});

test('parseLrc: fewer than three timed lines is plain text; brackets in lyrics are not stamps', () => {
  const r = parseLrc('[Chorus]\nLa la la\n[00:10.00]only one stamp\n');
  assert.equal(r.synced, false);
  assert.deepEqual(r.lines, [{ at: null, text: '[Chorus]' }, { at: null, text: 'La la la' }, { at: null, text: 'only one stamp' }]);
});

test('parseLrc: inline word stamps <mm:ss.xx> are stripped to the line; CRLF and BOM are fine', () => {
  const r = parseLrc('\uFEFF[00:01.00]<00:01.00>Hello <00:01.50>there\r\n[00:02.00]B\r\n[00:03.00]C');
  assert.deepEqual(r.lines.map((l) => l.text), ['Hello there', 'B', 'C']);
});
```

- [ ] **Step 2: Run** — Expected: FAIL (module missing).

- [ ] **Step 3: `public/js/lrc.js`**:

```js
// LRC lyrics: "[mm:ss.xx] line" per line, several stamps per line, an [offset:] tag. Shared by the server and the browser.
const STAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const META = /^\[(ar|ti|al|au|by|re|ve|length|offset|la|lr):(.*)\]\s*$/i;

/** @returns {{ synced: boolean, lines: { at: number | null, text: string }[], offset: number }} */
export function parseLrc(text) {
  let offset = 0;
  const timed = [];
  const plain = [];
  for (const raw of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const meta = META.exec(raw);
    if (meta) {
      if (meta[1].toLowerCase() === 'offset') offset = (Number(meta[2]) || 0) / 1000;
      continue;
    }
    const stamps = [...raw.matchAll(STAMP)];
    const body = raw.replace(STAMP, '').replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim();
    if (stamps.length && stamps.every((s) => raw.indexOf(s[0]) < raw.indexOf(body || '\u0000') || !body)) {
      for (const s of stamps) {
        const frac = s[3] ? Number(`0.${s[3]}`) : 0;
        timed.push({ at: Number(s[1]) * 60 + Number(s[2]) + frac, text: body });
      }
    } else plain.push({ at: null, text: raw.trim() });
  }
  if (timed.length >= 3) {
    timed.sort((a, b) => a.at - b.at);
    return { synced: true, lines: timed.map((l) => ({ at: l.at + offset, text: l.text })), offset };
  }
  const all = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => !META.test(l)).map((l) => ({ at: null, text: l.replace(STAMP, '').replace(/\s+/g, ' ').trim() }));
  while (all.length && !all[all.length - 1].text) all.pop();
  return { synced: false, lines: all, offset };
}
```

Make the first test's expectations and this code agree exactly: the empty-text stamped line `[00:05.00]` is kept as a timed empty line (breathing room). `[Chorus]` is not a stamp (the regex needs digits).

- [ ] **Step 4: Run** `node --test test/lrc.test.js` — Expected: PASS (adjust the parser, not the tests, until the three cases hold).

- [ ] **Step 5: Failing store test** — `test/lyrics.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir, fakeServer } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { Lyrics } from '../src/lyrics.js';

let db, lrclib, lyrics, calls = 0, answer = null;
const now = Date.now();
const dir = tempDir();
const track = (id, file, extra = {}) => {
  db.run("INSERT INTO items (id, library_id, kind, title, artist, path, size, mtime, duration, media, genres, added_at, updated_at) VALUES (?, 1, 'track', ?, 'Band', ?, 1, 1, 180, ?, '[]', ?, ?)", id, `Song ${id}`, file, JSON.stringify(extra.media || {}), now, now);
  return db.get('SELECT * FROM items WHERE id = ?', id);
};
const SYNC = '[00:01.00]one\n[00:02.00]two\n[00:03.00]three';

before(async () => {
  db = openDatabase(path.join(dir, 'l.db'));
  db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Music', 'music', '[]', '{}', ?)", now);
  lrclib = await fakeServer((req, res) => {
    calls++;
    const u = new URL(req.url, 'http://x');
    assert.equal(u.pathname, '/api/get');
    assert.ok(req.headers['user-agent'].startsWith('Atomix/'));
    if (!answer) { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
  const settings = { get: (k) => ({ onlineLyrics: true })[k] };
  lyrics = new Lyrics({ db, settings, version: '0.10.0', base: `${lrclib.url}/api` });
});
after(() => lrclib?.close());

test('a .lrc beside the song wins and is re-read when it changes', async () => {
  const file = path.join(dir, 'a.mp3');
  fs.writeFileSync(file, '');
  fs.writeFileSync(path.join(dir, 'a.lrc'), SYNC);
  const t = track(1, file);
  const r = await lyrics.get(t);
  assert.equal(r.source, 'file');
  assert.equal(r.synced, true);
  assert.equal(r.lines.length, 3);
  fs.writeFileSync(path.join(dir, 'a.lrc'), 'just words');
  fs.utimesSync(path.join(dir, 'a.lrc'), new Date(now + 5000), new Date(now + 5000));
  const r2 = await lyrics.get(t);
  assert.equal(r2.synced, false);
  assert.equal(calls, 0, 'never asked LRCLIB');
});

test('tags are used when there is no file; a plain tag is plain', async () => {
  const t = track(2, path.join(dir, 'b.mp3'), { media: { tags: { lyrics: 'row one\nrow two' } } });
  const r = await lyrics.get(t);
  assert.deepEqual([r.source, r.synced, r.lines.map((l) => l.text)], ['tags', false, ['row one', 'row two']]);
});

test('LRCLIB: synced when offered, plain otherwise; 404 is remembered; one request in flight', async () => {
  answer = { syncedLyrics: SYNC, plainLyrics: 'one\ntwo\nthree' };
  const t = track(3, path.join(dir, 'c.mp3'));
  const [a, b] = await Promise.all([lyrics.get(t), lyrics.get(t)]);
  assert.equal(a.source, 'lrclib');
  assert.equal(a.synced, true);
  assert.equal(calls, 1, 'two callers, one request');
  assert.equal(b.lines.length, 3);
  answer = { plainLyrics: 'only words' };
  const p = track(4, path.join(dir, 'd.mp3'));
  assert.equal((await lyrics.get(p)).synced, false);
  answer = null;
  const n = track(5, path.join(dir, 'e.mp3'));
  assert.equal(await lyrics.get(n), null);
  const before = calls;
  assert.equal(await lyrics.get(n), null);
  assert.equal(calls, before, 'a miss is remembered');
  db.run('UPDATE lyrics SET fetched_at = ? WHERE item_id = 5', now - 31 * 24 * 3600 * 1000);
  await lyrics.get(n);
  assert.equal(calls, before + 1, 'retried after 30 days');
});

test('an unreachable LRCLIB is a miss, not an error; the switch off means no request', async () => {
  const off = new Lyrics({ db, settings: { get: () => false }, version: '0.10.0', base: `${lrclib.url}/api` });
  const t = track(6, path.join(dir, 'f.mp3'));
  const before = calls;
  assert.equal(await off.get(t), null);
  assert.equal(calls, before);
  const dead = new Lyrics({ db, settings: { get: () => true }, version: '0.10.0', base: 'http://127.0.0.1:1/api', timeoutMs: 500 });
  assert.equal(await dead.get(track(7, path.join(dir, 'g.mp3'))), null);
  assert.equal(db.get('SELECT source FROM lyrics WHERE item_id = 7').source, 'none');
});
```

- [ ] **Step 6: Run** — Expected: FAIL (module missing).

- [ ] **Step 7: `src/lyrics.js`**:

```js
// Lyrics for a song: a .lrc (or .txt) beside it, then the tags, then LRCLIB (free, no key), remembered per song.
import fs from 'node:fs';
import path from 'node:path';
import { parseJson } from './db.js';
import { parseLrc } from '../public/js/lrc.js';
import { logger } from './log.js';

const log = logger('lyrics');
const MONTH = 30 * 24 * 3600 * 1000;

export class Lyrics {
  constructor({ db, settings, version = '0', base = 'https://lrclib.net/api', timeoutMs = 10000, fetchFn = fetch }) {
    Object.assign(this, { db, settings, version, base, timeoutMs, fetchFn });
    this.inflight = new Map();
  }
  shape(row) {
    if (!row || row.source === 'none' || !row.text) return null;
    const p = parseLrc(row.text);
    return { synced: Boolean(row.synced) && p.synced, lines: p.lines, source: row.source };
  }
  save(itemId, source, text, { synced = false, fileMtime = null } = {}) {
    this.db.run('INSERT INTO lyrics (item_id, source, synced, text, file_mtime, fetched_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET source = excluded.source, synced = excluded.synced, text = excluded.text, file_mtime = excluded.file_mtime, fetched_at = excluded.fetched_at', itemId, source, synced ? 1 : 0, text, fileMtime, Date.now());
    return this.db.get('SELECT * FROM lyrics WHERE item_id = ?', itemId);
  }
  fileBeside(track) {
    if (!track.path) return null;
    const stem = track.path.replace(/\.[^.]+$/, '');
    for (const ext of ['.lrc', '.txt']) {
      try {
        const st = fs.statSync(stem + ext);
        return { file: stem + ext, mtime: Math.floor(st.mtimeMs) };
      } catch { /* next */ }
    }
    return null;
  }
  async get(track) {
    const stored = this.db.get('SELECT * FROM lyrics WHERE item_id = ?', track.id);
    const f = this.fileBeside(track);
    if (f) {
      if (stored?.source === 'file' && stored.file_mtime === f.mtime) return this.shape(stored);
      const text = fs.readFileSync(f.file, 'utf8');
      return this.shape(this.save(track.id, 'file', text, { synced: parseLrc(text).synced, fileMtime: f.mtime }));
    }
    if (stored && stored.source !== 'file' && !(stored.source === 'none' && Date.now() - stored.fetched_at > MONTH)) return this.shape(stored);
    const tagText = parseJson(track.media, null)?.tags?.lyrics;
    if (tagText) return this.shape(this.save(track.id, 'tags', String(tagText), { synced: parseLrc(tagText).synced }));
    if (!this.settings.get('onlineLyrics')) return null;
    if (!this.inflight.has(track.id)) this.inflight.set(track.id, this.fromLrclib(track).finally(() => this.inflight.delete(track.id)));
    return this.inflight.get(track.id);
  }
  async fromLrclib(track) {
    const album = track.parent_id ? this.db.get('SELECT title FROM items WHERE id = ?', track.parent_id)?.title : null;
    const q = new URLSearchParams({ artist_name: track.artist || '', track_name: track.title || '', ...(album ? { album_name: album } : {}), ...(track.duration ? { duration: String(Math.round(track.duration)) } : {}) });
    try {
      const res = await this.fetchFn(`${this.base}/get?${q}`, { headers: { 'user-agent': `Atomix/${this.version} (https://github.com/reconstx5/Atomix)` }, signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.status === 200) {
        const body = await res.json();
        if (body.syncedLyrics) return this.shape(this.save(track.id, 'lrclib', body.syncedLyrics, { synced: true }));
        if (body.plainLyrics) return this.shape(this.save(track.id, 'lrclib', body.plainLyrics, { synced: false }));
      } else if (res.status !== 404) log.warn(`LRCLIB answered ${res.status} for "${track.title}"`);
    } catch (err) {
      log.warn(`LRCLIB unreachable for "${track.title}": ${err.message}`);
    }
    this.save(track.id, 'none', null);
    return null;
  }
}
```

`src/library/probe.js`: in the returned object's `tags`, keep lyrics: after `normaliseTags(...)` compute `const lyricsTag = pickLyrics(format.tags, firstAudio?.tags)` with

```js
function pickLyrics(...sources) {
  for (const tags of sources) {
    for (const [k, v] of Object.entries(tags || {})) {
      if (/^(lyrics|unsyncedlyrics|uslt|lyrics-[a-z]{3})$/i.test(k) && typeof v === 'string' && v.trim()) return v.slice(0, 64 * 1024);
    }
  }
  return null;
}
```

and `tags: { ...normaliseTags(format.tags, firstAudio?.tags), ...(lyricsTag ? { lyrics: lyricsTag } : {}) }`. Check `normaliseTags`'s `KEEP` set in `music.js` drops unknown keys — that is why the lyrics key is added after it. Check the scanner stores `info` (the probe result) as `media` for tracks (line ~323: `parseTrack(normaliseTags(info?.tags)…)` — and where `media` is written for tracks); if tracks' `media` doesn't include `tags`, store `info` there as for videos.

`src/app.js`: `import { Lyrics } from './lyrics.js'; core.lyrics = new Lyrics({ db, settings, version: pkg.version });` (find how the version is read — `rebrand` uses `package.json`; reuse). Route in `src/api/library.js`:

```js
  r.get('/api/items/:id/lyrics', async (ctx) => {
    const row = requireItem(core, ctx.params.id, ctx.viewer);
    if (row.kind !== 'track') throw new HttpError(404, 'Only songs have lyrics');
    const r = await core.lyrics.get(row);
    if (!r) { ctx.res.statusCode = 204; return null; }
    return r;
  });
```

Check how other routes answer 204 (the router may treat `null` as 204 — `api.js` client handles `res.status === 204`); match the router's convention.

- [ ] **Step 8: Run** `node --test test/lyrics.test.js` then `npm test` — Expected: PASS. Add one route case to `test/lists-api.test.js`'s server (it has music and a kid): `assert.equal((await kid.get(\`/api/items/${trackId}/lyrics\`)).status, 404)` after restricting the kid's libraries to movies only via `PATCH /api/profiles/:id { libraries: [movies] }` — or if that fixture is awkward, add it to `test/extras-items-api.test.js` with one generated song and a kid whose `libraries` exclude music.

- [ ] **Step 9: Ledger** `Task 7: complete`.

---

### Task 8: Now Playing

**Files:**
- Create: `public/js/views/nowplaying.js`
- Modify: `public/js/music.js` (`position`, `duration`, `repeat`, `shuffle` getters; `time` event on `timeupdate`; mini-player art/title links → `#/now-playing`; `musicTrackMenu` entry 'Lyrics'), `public/js/app.js` (route), `public/css/app.css`, `public/css/orbit.css`, `themes/orbit/theme.css`
- Harness: `devtools/extras-lyrics-ui.mjs` section `lyrics`

- [ ] **Step 1: Dev `.lrc`** — write `/home/claude/testmedia/Music/Harbour Lights/Night Ferry (2023)/<first track stem>.lrc` with 12 lines, stamps every 10 s from `[00:00.50]` (the dev songs are short clips: check their durations with `/api/items/<album>` and use stamps within the length, e.g. every 0.4 s if the clip is 5 s). The mock LRCLIB is not needed: the dev server's `onlineLyrics` request would go to the real lrclib.net; set `ATOMIX_LRCLIB_BASE=http://127.0.0.1:9913/api` in `run-dev.sh` and add a tiny `devtools/mock-lrclib.mjs` (answers 200 with `plainLyrics: 'Dev words\nMore dev words'` for one known title and 404 otherwise) started by `restart-dev.sh` like `mock-os.mjs`; `src/lyrics.js` reads `config.lrclibBase` (add to `src/config.js` from `ATOMIX_LRCLIB_BASE`, default `https://lrclib.net/api`).

- [ ] **Step 2: Failing browser checks** — append to `devtools/extras-lyrics-ui.mjs`:

```js
if (run('lyrics')) {
  const musicLib = (await api(page, 'GET', '/api/libraries')).find((l) => l.type === 'music').id;
  const tracks = (await api(page, 'GET', `/api/libraries/${musicLib}/items?view=tracks`)).items;
  const withLrc = tracks.find((t) => t.title === '<the track you gave an .lrc>');
  await go(page, `#/item/${withLrc.parentId}`, '.tracks');
  await page.click(`.track-row[data-id="${withLrc.id}"] .track-main`);
  await page.waitForSelector('.mini:not([hidden])');
  await page.click('.mini .mini-title');
  await page.waitForSelector('.nowplaying-view .lyric-line.is-current', { timeout: 10000 });
  check('Now Playing opens from the mini-player with synced lyrics and a current line', true);
  check('the queue is beside the lyrics on a wide screen', (await page.$('.nowplaying-view .np-queue .track-row')) !== null);
  const first = await page.textContent('.nowplaying-view .lyric-line.is-current');
  await page.waitForFunction((t) => document.querySelector('.nowplaying-view .lyric-line.is-current')?.textContent !== t, first, { timeout: 15000 });
  check('the highlight moves with the song', true);
  // Remote: Down from the transport reaches the lines; Enter seeks.
  await page.focus('.nowplaying-view .np-transport .btn-primary');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(300);
  check('Up from the transport lands on a lyric line', await page.evaluate(() => document.activeElement?.classList.contains('lyric-line')));
  const at = await page.evaluate(() => Number(document.activeElement.dataset.at));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const pos = await page.evaluate(async () => (await import('/js/music.js')).music.position);
  check('Enter on a line seeks the song there', Math.abs(pos - at) < 1.5, `${pos} vs ${at}`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !location.hash.startsWith('#/now-playing'));
  check('Back leaves Now Playing', true);
  const plain = tracks.find((t) => t.title === '<the mock-lrclib title>');
  await page.evaluate(async (id) => { const { music } = await import('/js/music.js'); const t = (await (await fetch(`/api/items/${id}`)).json()).item; music.playTracks([t], 0); }, plain.id);
  await go(page, '#/now-playing', '.nowplaying-view');
  await page.waitForSelector('.nowplaying-view .lyrics-plain');
  check('plain lyrics from LRCLIB show as text', (await page.textContent('.nowplaying-view .lyrics-plain')).includes('Dev words'));
  await page.evaluate(async () => (await import('/js/music.js')).music.stop());
  await go(page, '#/now-playing', '.nowplaying-view');
  check('nothing playing: the empty state', (await page.textContent('.nowplaying-view')).includes('Nothing playing'));
  // Phone: the queue is behind a button.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async (id) => { const { music } = await import('/js/music.js'); const t = (await (await fetch(`/api/items/${id}`)).json()).item; music.playTracks([t], 0); }, withLrc.id);
  await go(page, '#/now-playing', '.nowplaying-view');
  check('phone: no queue column, a Queue button, no sideways overflow', (await page.$('.nowplaying-view .np-queue')) === null && (await page.$('.nowplaying-view .btn:has-text("Queue")')) !== null && (await page.evaluate(() => document.documentElement.scrollWidth <= 390)));
  await page.evaluate(async () => (await import('/js/music.js')).music.stop());
  await page.setViewportSize({ width: 1920, height: 1080 });
}
```

Fill the two placeholder titles with the real dev track titles once Step 1 is done. Run `node /home/claude/devtools/extras-lyrics-ui.mjs lyrics` — Expected: FAIL (no `.nowplaying-view`).

- [ ] **Step 3: `music.js` additions** — in the `music` object: `get position() { return currentTime(); }`, `get duration() { return totalDuration(); }`, `get shuffle() { return queue.shuffle; }`, `get repeat() { return queue.repeat; }` (read the real field names in `queue.js`); in the `timeupdate` listener add `emit('time')`. `artLink.href` and `titleEl.href` in `changed()` become `#/now-playing` (keep `t.albumId` for the eyebrow text). Add `musicTrackMenu` entry `{ label: 'Lyrics', icon: 'list', onSelect: () => { music.playTracks([track], 0); navigate('#/now-playing'); } }` where the track "…" sheet is built (`grep "Add to queue" public/js/music.js`). Route in `app.js`: `{ pattern: /^\/now-playing$/, view: () => import('./views/nowplaying.js') }`.

- [ ] **Step 4: The view** — `public/js/views/nowplaying.js` (≈200 lines; the structure):

```js
// Now Playing: cover, the song, synced lyrics with the current line in the middle, the queue, the transport.
import { h, icon, clear, formatClock } from '../dom.js';
import { api } from '../api.js';
import { setTitle, goBack, isOrbit } from '../app.js';
import { button, emptyState, art } from '../components.js';
import { music, trackList, openQueue } from '../music.js';
import { setBackdrop } from '../backdrop.js';

export async function render(el) {
  el.classList.add('nowplaying-view');
  setTitle('Now playing');
  if (!music.current) {
    el.append(emptyState({ title: 'Nothing playing', text: 'Pick a song and it will show up here.' }), button('Back', { icon: 'back', autofocus: true, onClick: () => goBack('#/') }));
    return;
  }
  const cover = h('div', { class: 'np-cover' });
  const title = h('h1', { class: 'np-title' });
  const sub = h('p', { class: 'np-sub muted' });
  const lyricsEl = h('div', { class: 'np-lyrics', tabindex: '-1' });
  const queueEl = h('aside', { class: 'np-queue' });
  const play = button('', { icon: 'pause', variant: 'primary', title: 'Pause', autofocus: true, onClick: () => music.toggle() });
  const seek = h('input', { type: 'range', min: '0', max: '1000', value: '0', 'aria-label': 'Seek' });
  const cur = h('span', { class: 'np-time' }, '0:00');
  const left = h('span', { class: 'np-time' }, '-0:00');
  const transport = h('div', { class: 'np-transport' },
    h('div', { class: 'np-buttons' },
      button('', { icon: 'shuffle', variant: 'ghost', title: 'Shuffle', onClick: () => music.setShuffle(!music.shuffle) }),
      button('', { icon: 'prev', variant: 'ghost', title: 'Previous', onClick: () => music.prev() }),
      play,
      button('', { icon: 'next', variant: 'ghost', title: 'Next', onClick: () => music.next() }),
      button('', { icon: 'repeat', variant: 'ghost', title: 'Repeat', onClick: () => music.cycleRepeat() }),
      h('span', { class: 'np-phone-only' }, button('Queue', { icon: 'queue', variant: 'ghost', onClick: () => openQueue() })),
    ),
    h('div', { class: 'np-seek' }, cur, seek, left),
  );
  el.append(h('div', { class: 'np-main' }, h('div', { class: 'np-side' }, cover, title, sub), lyricsEl, queueEl), transport);

  let lines = [];
  let synced = false;
  let lineEls = [];
  let userHold = 0;
  let token = 0;
  async function load() {
    const t = music.current;
    const mine = ++token;
    clear(cover).append(art(t.poster || t.albumPoster, t.title, { kind: 'square', eager: true }));
    title.textContent = t.title;
    sub.textContent = [t.artist, t.albumTitle].filter(Boolean).join(' · ');
    setBackdrop(t.poster || t.albumPoster);
    clear(lyricsEl).append(h('p', { class: 'muted' }, 'Looking for lyrics…'));
    const r = await api.get(`/api/items/${t.id}/lyrics`).catch(() => null);
    if (mine !== token) return;
    clear(lyricsEl);
    lines = r?.lines || [];
    synced = Boolean(r?.synced);
    lineEls = [];
    if (!r) lyricsEl.append(h('p', { class: 'muted np-none' }, 'No lyrics for this song'));
    else if (!synced) lyricsEl.append(h('div', { class: 'lyrics-plain' }, lines.map((l) => h('p', {}, l.text || '\u00a0'))));
    else {
      const list = h('ol', { class: 'lyrics-synced', role: 'list' });
      lines.forEach((l, i) => {
        const li = h('li', { class: 'lyric-line', tabindex: l.text ? '0' : '-1', dataset: { at: String(l.at), i: String(i) }, onClick: () => music.seek(l.at) }, l.text || '\u00a0');
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); music.seek(l.at); } });
        li.addEventListener('focus', () => (userHold = Date.now() + 4000));
        lineEls.push(li);
        list.append(li);
      });
      lyricsEl.append(list);
      tick();
    }
    drawQueue();
  }
  function drawQueue() {
    clear(queueEl).append(h('h2', {}, 'Up next'), trackList(music.queue.items, { numbers: false, showAlbum: true }));
  }
  function tick() {
    const pos = music.position;
    const dur = music.duration || 0;
    cur.textContent = formatClock(pos);
    left.textContent = `-${formatClock(Math.max(0, dur - pos))}`;
    if (dur) seek.value = String(Math.round((pos / dur) * 1000));
    if (!synced || !lineEls.length) return;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i].at <= pos + 0.3) idx = i; else break;
    lineEls.forEach((li, i) => li.classList.toggle('is-current', i === idx));
    if (idx >= 0 && Date.now() > userHold) {
      const li = lineEls[idx];
      const offset = li.offsetTop + li.offsetHeight / 2 - lyricsEl.clientHeight / 2;
      lyricsEl.querySelector('.lyrics-synced').style.transform = `translateY(${-Math.max(0, offset)}px)`;
    }
  }
  seek.addEventListener('input', () => music.seek((Number(seek.value) / 1000) * (music.duration || 0)));
  const onTime = () => tick();
  const onState = () => { clear(play).append(icon(music.playing ? 'pause' : 'play', { size: 22 })); play.title = music.playing ? 'Pause' : 'Play'; };
  const onChange = () => { if (!music.current) { goBack('#/'); return; } load(); };
  const onKey = (e) => { if (e.key === ' ' && !/INPUT|TEXTAREA/.test(e.target.tagName)) { e.preventDefault(); music.toggle(); } };
  music.events.addEventListener('time', onTime);
  music.events.addEventListener('state', onState);
  music.events.addEventListener('change', onChange);
  window.addEventListener('keydown', onKey);
  lyricsEl.addEventListener('wheel', () => (userHold = Date.now() + 4000), { passive: true });
  onState();
  await load();
  document.documentElement.classList.add('nowplaying-open');
  return () => {
    music.events.removeEventListener('time', onTime);
    music.events.removeEventListener('state', onState);
    music.events.removeEventListener('change', onChange);
    window.removeEventListener('keydown', onKey);
    document.documentElement.classList.remove('nowplaying-open');
  };
}
```

Check: `trackList` and `openQueue` exports (export `openQueue` from music.js), `art(..., { kind: 'square' })`, `formatClock` in `dom.js`, `setBackdrop` import path (`lists.js` uses `../backdrop.js`), `isOrbit` not needed (drop it). The mini-player hides while open: `html.nowplaying-open .mini { display: none; }` in `app.css`. Reduce motion: the `transform` transition is set in CSS under `@media (prefers-reduced-motion: no-preference)` only.

- [ ] **Step 5: Styles** — `app.css`:

```css
/* ---------- Now Playing ---------- */
html.nowplaying-open .mini { display: none; }
.nowplaying-view { display: flex; flex-direction: column; min-height: calc(100dvh - var(--header-h)); padding: 24px var(--gutter) 16px; gap: 16px; }
.np-main { display: grid; grid-template-columns: minmax(200px, 320px) minmax(0, 1fr) minmax(220px, 360px); gap: 32px; flex: 1; min-height: 0; }
.np-side { display: flex; flex-direction: column; gap: 10px; }
.np-cover .art { aspect-ratio: 1; border-radius: var(--radius); overflow: hidden; }
.np-title { margin: 0; font-size: 1.6rem; line-height: 1.15; }
.np-lyrics { position: relative; overflow: hidden; min-height: 40vh; max-height: 62vh; mask-image: linear-gradient(transparent, #000 15%, #000 85%, transparent); }
.lyrics-synced { list-style: none; margin: 0; padding: 30vh 0; display: flex; flex-direction: column; gap: 0.5em; }
@media (prefers-reduced-motion: no-preference) { .lyrics-synced { transition: transform 0.45s var(--ease); } }
.lyric-line { font-size: 1.35rem; line-height: 1.35; color: var(--text-dim); border-radius: 8px; padding: 2px 8px; cursor: pointer; }
.lyric-line.is-current { color: var(--text); font-size: 1.7rem; font-weight: 650; }
.lyric-line:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent); }
.lyrics-plain { overflow: auto; max-height: 62vh; white-space: pre-wrap; line-height: 1.6; }
.lyrics-plain p { margin: 0; }
.np-queue h2 { font-size: 1rem; margin: 0 0 8px; }
.np-queue { overflow: auto; max-height: 62vh; }
.np-transport { display: flex; flex-direction: column; gap: 8px; }
.np-buttons { display: flex; gap: 8px; justify-content: center; align-items: center; }
.np-seek { display: flex; align-items: center; gap: 12px; }
.np-seek input { flex: 1; }
.np-time { font-variant-numeric: tabular-nums; color: var(--text-dim); min-width: 4ch; }
.np-phone-only { display: none; }
@media (max-width: 999px), (orientation: portrait) {
  .np-main { grid-template-columns: 1fr; gap: 16px; }
  .np-side { flex-direction: row; align-items: center; gap: 14px; }
  .np-cover { width: 96px; flex: 0 0 auto; }
  .np-queue { display: none; }
  .np-phone-only { display: inline; }
  .np-lyrics { min-height: 50vh; }
}
```

`orbit.css`: sizes in `--px` (`.np-main { grid-template-columns: calc(360 * var(--px)) minmax(0, 1fr) calc(420 * var(--px)); gap: calc(48 * var(--px)); } .lyric-line { font-size: max(14px, calc(30 * var(--px))); } .lyric-line.is-current { font-size: max(16px, calc(40 * var(--px))); }` on wide screens) and the page keeps the environment: `body[data-layout="orbit"] .nowplaying-view` is listed with the music pages that keep `.environment` (find the album-page rule from v0.8.0: `:is(.album-view, …)`, add `.nowplaying-view`). `theme.css`: `.lyric-line.is-current { color: #fff; text-shadow: 0 2px 20px rgba(0,0,0,0.5); } .lyric-line:focus-visible { box-shadow: var(--ring); } .np-queue { background: var(--glass-panel); border-radius: calc(18 * var(--px)); padding: calc(16 * var(--px)); }`.

- [ ] **Step 6: Run** `node /home/claude/devtools/extras-lyrics-ui.mjs lyrics` — Expected: all PASS. Then `orbit-a11y.mjs` with two added contrast checks (`.lyric-line` dim text and `.lyric-line.is-current` on the environment wash; the dim line needs 4.5:1 — raise `--text-dim` usage to `rgba(226,230,255,0.72)` in theme.css for `.lyric-line` if it fails) — add them to the a11y suite's SCREENS with a song playing (start one via `music.playTracks` in `page.evaluate` before `go`).

- [ ] **Step 7: Ledger** `Task 8: complete`.

---

### Task 9: Pictures, older themes, docs, version, full verification, delivery

**Files:**
- Modify: `README.md` (three bullets: Trailers, Extras, Lyrics & Now Playing; the Using it table: "Enter on the mini-player → Now Playing"), `docs/ARCHITECTURE.md` (migration 10, extras in the data model and scanner, trailers in metadata, `src/lyrics.js`, the `thumb` job, the Now Playing view), `package.json` (`0.10.0`), `devtools/oldthemes-compare.mjs` baselines, `devtools/lists-shots.mjs` → copy as `devtools/v010-shots.mjs`

- [ ] **Step 1: Pictures** — `devtools/v010-shots.mjs` (desktop 1917×992 and phone 390×844, `ORBIT_GPU=1`): a film page with the Trailer button and Extras row, the YouTube trailer page, Now Playing with synced lyrics (wide: three columns; phone: stacked). Contact sheets to `/mnt/user-data/outputs/orbit-progress/v0100-desktop.png` and `v0100-phone.png`; look at them; fix what looks wrong (ledger each fix).
- [ ] **Step 2: Older themes** — `node devtools/oldthemes-compare.mjs compare`; movie/show pages differ by the Trailer button and (The Test Movie) the Extras row; eyeball the diff pictures, then `save`; `compare` → all pages match.
- [ ] **Step 3: Docs and version** — README bullets after "Because you watched":

  - **Trailers** — a `Film-trailer.mp4` or `Trailers/` folder beside a film plays in Atomix's own player; without one, the film's TMDB trailer plays from YouTube inside the app (an admin switch; never on kids profiles). One **Trailer** button on the film's page and the Home spotlight.
  - **Extras** — Kodi-style `Featurettes/`, `Behind The Scenes/`, `Deleted Scenes/`, `Interviews/`, `Scenes/`, `Shorts/`, `Extras/` folders and `-featurette`, `-deleted`… file suffixes show as an **Extras** row on the film's or show's page (and nowhere else), with thumbnails made in the background.
  - **Lyrics and Now Playing** — press the mini-player to open a full-screen **Now Playing** page: cover, the queue, and lyrics that scroll in time from a `.lrc` beside the song, the song's tags, or LRCLIB (free, no key; an admin switch).

  ARCHITECTURE: the data-model rows (`items.extra_kind`, `items.trailer`, `lyrics`), migration 10, the scanner's extras pass (`ownerOf`), `pickTrailer`, `src/lyrics.js`, the `thumb` job, the `/api/items/:id/lyrics` route and `GET /api/items/:id` additions, the `trailer` and `nowplaying` views, the CSP `frame-src`. `package.json` → `0.10.0`; grep for `0.9.0` in `src/`/docs and update where it names the current version (`rebrand-ui.mjs` asserts the dashboard version string — the dev server must restart after the bump).
- [ ] **Step 4: Full verification** — `npm test` (expect ≥ 225); `extras-lyrics-ui.mjs` ×2 clean; `lists-ui.mjs` 24; `orbit-ui.mjs` 158 (or the adjusted count, ledgered); `orbit-sizes.mjs` 79 (+ Now Playing at the five sizes: add a check that `.nowplaying-view` has no sideways overflow at each size — 5 checks → 84); `orbit-a11y.mjs` 57 (+2 lyric lines → 59); `gate-ui.mjs` 60; `oldthemes-compare.mjs compare` all match; `extras-ui`, `rebrand-ui`, `music-kbd`, `profiles-ui`, `dialogs` clean.
- [ ] **Step 5: Delivery** — hash the PC copies of every file to be overwritten against the pre-task base snapshot; deliver changed and new files (src, public, themes, test, docs incl. this plan and the spec, README, package.json) to `D:\Nodeflix`; `npm test` on the PC; update the project note `claude/build-status.md` (Round 12 / v0.10.0; what to check with a real library: a real `-trailer` file, a real TMDB trailer on a TV that reaches YouTube, extras thumbnails appearing after the backlog, LRCLIB hits for real songs and the User-Agent line in the log).
- [ ] **Step 6: Ledger** `Task 9: complete`; then the final whole-branch review (fresh reviewer, plain prompt as in v0.9.0; the Review Focus above verbatim; the ledger's rulings), its one fix pass, the final message with every ruling and deferred minor, delete the plan workspace (keep a ledger copy under `scratchpad/note/`).
