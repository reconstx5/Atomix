# Seek-bar Previews and Skip Intro Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add NodeFlix v0.5.0's seek-bar preview pictures and a "Skip intro" button, both produced by a low-priority background job runner, with admin corrections.

**Architecture:** A `TaskRunner` (`src/tasks.js`) picks one job at a time from the database (titles needing previews, seasons needing an intro check), runs ffmpeg at low CPU priority, and pauses while a conversion is playing. Previews are JPEG tile sheets made in one keyframe-only ffmpeg pass. Intros come from chapter names, or else from the longest stretch of audio that episodes share, found with a pure-JS fingerprint. The player reads the layout and markers from the playback response it already fetches.

**Tech Stack:** Node.js ≥ 22.13 (node:http, node:sqlite, node:test), ffmpeg/ffprobe, plain ES-module browser JS and CSS, and Playwright for browser checks (dev machine only).

**Spec:** `docs/superpowers/specs/2026-09-29-previews-and-intro-skip-design.md`

## Global Constraints

- Zero npm dependencies. Plain ES modules and no build step, in both the server (`src/`) and the browser (`public/js/`).
- Works with any ffmpeg ≥ 4.4 on Windows, Linux and Docker. Do not require chromaprint or any other optional ffmpeg library. `zscale`/`tonemap` are used only when present.
- Every ffmpeg/ffprobe call passes arguments as an array to `spawn` (through `run()` in `src/library/probe.js`), never through a shell.
- Access rules: every item-scoped route checks `library.canSee(ctx.viewer, item)` and answers **404** (never 403) for titles the viewer can't see. Admin routes use `{ auth: 'admin' }`, which also blocks Kids profiles.
- Numbers, copied exactly from the spec:
  - Previews:
    - interval: 5 s for videos under 20 minutes (`duration < 1200`), otherwise 10 s
    - tiles 320 px wide; the height follows the picture shape, rounded to an even number
    - 10 × 10 tiles per sheet
    - ffmpeg timeout: 30 minutes
  - Intro search:
    - audio window: `min(600, 0.4 × duration)` seconds
    - decoded as 8 kHz mono s16le
  - Fingerprint: 1024-sample Hann frames, hop 512 (64 ms), 33 log bands from 300 to 2000 Hz, giving 32 bits per frame.
  - A match counts when it is 15 to 150 s long, has a smoothed error of 16 frames at ≤ 11 bits, and has gaps of no more than 16 frames.
  - Scrubbing: steps of 10/30/60 s after holding for 0/1.5/4 s. The jump happens 1 s after the last press.
  - The Skip intro button hides 2 s before the intro ends.
- User-facing copy is in sentence case, exactly as written:
  - Player: "Skip intro", "Skipped intro", "Watch it"
  - Server settings: "Seek-bar previews", "Find TV intros"
  - Library dialog: "Make seek-bar previews"
  - Profile: "Skip intros automatically"
  - Dashboard: "Background tasks", "Try again"
  - Error message: "The intro must end after it starts."
- Marker precedence: `manual` (3) > `chapter` (2) > `audio` (1). A marker is only replaced by one of equal or higher rank. "No intro" is a `manual` marker whose start and end are both NULL.
- The project is **not a git repository**. Where a step would commit, run the full suite instead: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/*.test.js`. The suite must stay green; it is 86 tests before this plan.
- ffmpeg-dependent tests skip themselves when ffmpeg is missing (`{ skip: !hasFfmpeg && 'ffmpeg not installed' }`), like the existing ones.
- Dev environment:
  - Start the dev server with `/home/claude/devtools/run-dev.sh` (port 8787, data in `/tmp/nf-dev`).
  - Stop processes by numeric PID. **Never** `pkill -f`: it kills the shell.
- **Deviation from the spec (flagged to Dallas):** matching tries every alignment of the two fingerprints (a diagonal scan, about 0.5 s for two 10-minute clips) instead of inverted-index voting. On 29 Sep a throwaway prototype showed exact 32-bit hash votes are too rare after re-encoding. The full scan found a shared tune within 0.2 s, AAC against MP3 at −6 dB with a low-pass filter.

## Review Focus

These are inputs the spec implies but never spells out, most likely first. Each has a test in the task that owns the code.

1. **Media paths with spaces, apostrophes and macrons** (e.g. `Bob's Whānau Film (2020) [1080p].mp4`) must still produce previews and fingerprints, because ffmpeg gets an argument array with no shell quoting. Tested in Task 2 (preview generation) and Task 6 (end-to-end).
2. **Titles with no video stream, an unknown duration, or shorter than one interval** are never queued, or produce a single tile, instead of failing forever. Tested in Task 1 (`nextPreviewItem`) and Task 2 (`planPreviews(3, …)`).
3. **Duplicate episodes** (the same file twice in a season) must produce no intro rather than a 10-minute one. The shared stretch is longer than 150 s, so it's rejected. Tested in Task 3.
4. **Unknown duration in the player** (a converted stream before its duration is known), or an intro whose end is past the end of the file, must not break the Skip button, auto-skip or Up next. Tested in Task 9 (`introRange`, `upNextAt`).
5. **A title removed or replaced while its job is running** must have its result thrown away, leave no preview folder behind, and not crash the runner. Tested in Task 1 (writes return `false`) and Task 5 (preview job cleanup).

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/db.js` | modify | Migration 6: `libraries.options`, `media_jobs`, `markers` |
| `src/config.js` | modify | `previewsDir` |
| `src/settings.js` | modify | `previewsEnabled`, `introDetection` |
| `src/extras/store.js` | create | `ExtrasStore`: job state, pending-work queries, markers with precedence, preview manifest |
| `src/library/probe.js` | modify | `run()` gains `onSpawn`; `detectTools()` reports `filters` |
| `src/extras/previews.js` | create | `planPreviews`, `generatePreviews`, `removePreviews` |
| `public/js/previews.js` | create | `tileFor(manifest, t)` (pure, shared with tests) |
| `src/extras/fingerprint.js` | create | `fft`, `fingerprint`, `popcount`, `findSharedSegment` (pure) |
| `src/extras/intros.js` | create | `markersFromChapters`, `readChapters`, `searchWindow`, `audioFingerprint`, `partnersFor`, `runIntroJob` |
| `src/extras/jobs.js` | create | `makeJobs()` wires both jobs to ffmpeg, the store and the previews folder |
| `src/tasks.js` | create | `TaskRunner`: one job at a time, priority, pause/interrupt, sweep, status |
| `src/api/extras.js` | create | Preview image route, marker admin routes, task status and retry |
| `src/app.js` | modify | Create store and runner, hooks, routes, start/stop |
| `src/api/playback.js` | modify | Playback response gains `previews` and `markers` |
| `src/api/library.js` | modify | Admin episode detail gains `markers`; libraries accept `options` |
| `src/api/serialize.js` | modify | `serializeLibrary` includes `options` |
| `src/api/account.js` | modify | `skipIntros` profile pref |
| `public/js/scrub.js` | create | `Scrubber` (pure remote-scrubbing state machine) |
| `public/js/seekpreview.js` | create | The preview bubble above the seek bar |
| `public/js/markers.js` | create | `introRange`, `inIntro`, `introLeft`, `upNextAt`, `parseClock` (pure) |
| `public/js/views/player.js` | modify | Bubble, scrubber, Skip intro, auto-skip, credits Up next |
| `public/js/views/item.js` | modify | Admin intro line and Edit dialog on episode pages |
| `public/js/views/settings.js` | modify | Server toggles, library checkbox, dashboard card, profile toggle |
| `public/css/app.css` | modify | `.seek-preview*`, `.skip-intro*`, `.intro-line` |
| `test/helpers.js` | modify | `makeEpisode()` (shared-theme episodes, chapters) |
| `test/extras-store.test.js`, `test/previews.test.js`, `test/fingerprint.test.js`, `test/intros.test.js`, `test/tasks.test.js`, `test/extras-api.test.js`, `test/extras-settings.test.js`, `test/scrub.test.js`, `test/markers.test.js` | create | Tests |
| `/home/claude/devtools/extras-ui.mjs` | create (dev only) | Playwright browser checks |
| `README.md`, `docs/ARCHITECTURE.md`, `docs/THEMES.md`, `package.json` | modify | Docs and version 0.5.0 |

---

### Task 1: Database migration and the extras store

**Files:**
- Modify: `src/db.js` (append to `MIGRATIONS`, after the migration 5 entry)
- Modify: `src/config.js` (the lines that set `cfg.transcodeDir` and the `mkdirSync` loop)
- Modify: `src/settings.js` (`SETTING_DEFAULTS`)
- Create: `src/extras/store.js`
- Test: `test/extras-store.test.js`

**Interfaces:**
- Consumes: `openDatabase(file, { upTo })` and `parseJson` from `src/db.js`.
- Produces: `class ExtrasStore(db)` with these methods (later tasks use exactly these names):
  - `job(itemId, job) → row|null` (with `data` parsed)
  - `saveJob(itemRow, job, { status, data?, error? }) → boolean` (false when the item is gone)
  - `nextPreviewItem(onlyIds = null) → itemRow|null`
  - `nextIntroSeason(onlyIds = null) → seasonId|null`
  - `pendingIntroEpisodes(seasonId) → itemRow[]`
  - `seasonEpisodes(seasonId) → itemRow[]`
  - `otherSeasonEpisode(seasonId) → itemRow|null`
  - `resetSeasonNone(seasonId)`, `clearIntroJobs(seasonId)`
  - `retryFailed() → number`
  - `failed(limit = 20) → [{ itemId, job, error, title }]`
  - `pendingCounts() → { previews, intros }`
  - `previewIds() → Set<number>`
  - `previewManifest(itemRow) → { interval, width, height, columns, rows, count, sheets, url } | null`, where `url` contains `{n}`
  - `markers(itemId) → { intro, credits }`, each `{ start, end, source } | { none: true, source } | null`
  - `playbackMarkers(itemId) → { intro: {start,end}|null, credits: {start,end}|null }`
  - `setMarker(itemId, kind, { start, end, source }) → boolean`
  - `deleteMarker(itemId, kind, { sources? })`
  - `itemLabel(itemRow) → string`, `seasonLabel(seasonId) → string`
- Produces: `config.previewsDir`; settings `previewsEnabled` and `introDetection` (both default `true`).

- [ ] **Step 1: Write the failing tests**

Create `test/extras-store.test.js`:

```js
// The background jobs' bookkeeping: which titles still need previews or an intro
// check, and the intro/credits markers with their "who wins" rules.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { ExtrasStore } from '../src/extras/store.js';

let db;
let store;
const now = Date.now();
const VIDEO = JSON.stringify({ video: { width: 1920, height: 1080 }, audio: [{ index: 0 }] });
let seq = 0;

function addLibrary(type, options = '{}') {
  return Number(db.run('INSERT INTO libraries (name, type, paths, options, created_at) VALUES (?, ?, ?, ?, ?)', type, type, '[]', options, now).lastInsertRowid);
}
function addItem(fields) {
  const f = { title: 'x', path: `/media/${++seq}`, size: 100, mtime: 1, duration: 600, media: VIDEO, ...fields };
  const cols = Object.keys(f);
  const sql = `INSERT INTO items (${cols.join(', ')}, added_at, updated_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`;
  return Number(db.run(sql, ...Object.values(f), now, now).lastInsertRowid);
}
const row = (id) => db.get('SELECT * FROM items WHERE id = ?', id);

before(() => {
  db = openDatabase(path.join(tempDir(), 'test.db'));
  store = new ExtrasStore(db);
});

test('migration 6 upgrades a version 5 database', () => {
  const file = path.join(tempDir(), 'old.db');
  const old = openDatabase(file, { upTo: 5 });
  old.run('INSERT INTO libraries (name, type, paths, created_at) VALUES (?, ?, ?, ?)', 'Films', 'movies', '[]', now);
  old.close();
  const upgraded = openDatabase(file);
  assert.equal(upgraded.get('PRAGMA user_version').user_version, 6);
  assert.equal(upgraded.get('SELECT options FROM libraries').options, '{}');
  const tables = upgraded.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
  assert.ok(tables.includes('media_jobs') && tables.includes('markers'));
  upgraded.close();
});

test('previews are wanted for new or changed videos only', () => {
  const movies = addLibrary('movies');
  const skipped = addLibrary('movies', '{"previews":false}');
  const music = addLibrary('music');
  const film = addItem({ library_id: movies, kind: 'movie', title: 'Film' });
  addItem({ library_id: movies, kind: 'movie', title: 'Sound only', media: JSON.stringify({ video: null, audio: [{ index: 0 }] }) });
  addItem({ library_id: movies, kind: 'movie', title: 'Not probed yet', duration: null, media: null });
  addItem({ library_id: skipped, kind: 'movie', title: 'Opted out' });
  addItem({ library_id: music, kind: 'track', title: 'Song' });

  assert.equal(store.nextPreviewItem().id, film);
  assert.ok(store.saveJob(row(film), 'previews', { status: 'done', data: { interval: 10, width: 320, height: 180, columns: 10, rows: 10, count: 60, sheets: 1 } }));
  assert.equal(store.nextPreviewItem(), null, 'audio-only, unprobed, opted-out and music never qualify');
  assert.deepEqual(store.pendingCounts().previews, 0);

  const manifest = store.previewManifest(row(film));
  assert.equal(manifest.sheets, 1);
  assert.match(manifest.url, new RegExp(`^/api/items/${film}/previews/\\{n\\}\\?v=\\d+$`));
  assert.deepEqual(store.previewIds(), new Set([film]));

  db.run('UPDATE items SET size = 200 WHERE id = ?', film); // the file was replaced
  assert.equal(store.previewManifest(row(film)), null, 'old previews are not shown for a new file');
  assert.equal(store.nextPreviewItem().id, film, 'and it is queued again');
  store.saveJob(row(film), 'previews', { status: 'done', data: { sheets: 1 } });
});

test('new titles can be picked before the backlog', () => {
  const lib = addLibrary('movies');
  const older = addItem({ library_id: lib, kind: 'movie' });
  const newer = addItem({ library_id: lib, kind: 'movie' });
  assert.equal(store.nextPreviewItem([newer]).id, newer);
  assert.equal(store.nextPreviewItem().id, older, 'the backlog goes oldest first');
  store.saveJob(row(older), 'previews', { status: 'done', data: { sheets: 1 } });
  store.saveJob(row(newer), 'previews', { status: 'done', data: { sheets: 1 } });
});

test('failed jobs wait for a changed file or a retry', () => {
  const lib = addLibrary('movies');
  const bad = addItem({ library_id: lib, kind: 'movie', title: 'Broken' });
  store.saveJob(row(bad), 'previews', { status: 'failed', error: 'moov atom not found' });
  assert.equal(store.nextPreviewItem(), null);
  assert.deepEqual(store.failed().map((f) => [f.itemId, f.job, f.error, f.title]), [[bad, 'previews', 'moov atom not found', 'Broken']]);
  assert.equal(store.retryFailed(), 1);
  assert.equal(store.nextPreviewItem().id, bad);
  store.saveJob(row(bad), 'previews', { status: 'done', data: { sheets: 1 } });
});

test('intro checks go a season at a time, and a new episode reopens "none"', () => {
  const tv = addLibrary('tv');
  const show = addItem({ library_id: tv, kind: 'show', title: 'Demo Show', duration: null, media: null });
  const s1 = addItem({ library_id: tv, kind: 'season', title: 'Season 1', parent_id: show, show_id: show, season: 1, duration: null, media: null });
  const s2 = addItem({ library_id: tv, kind: 'season', title: 'Season 2', parent_id: show, show_id: show, season: 2, duration: null, media: null });
  const e1 = addItem({ library_id: tv, kind: 'episode', title: 'Pilot', parent_id: s1, show_id: show, season: 1, episode: 1 });
  const e2 = addItem({ library_id: tv, kind: 'episode', title: 'Two', parent_id: s1, show_id: show, season: 1, episode: 2 });
  const e3 = addItem({ library_id: tv, kind: 'episode', title: 'Three', parent_id: s2, show_id: show, season: 2, episode: 1 });

  assert.equal(store.nextIntroSeason(), s1);
  assert.deepEqual(store.pendingIntroEpisodes(s1).map((e) => e.id), [e1, e2]);
  assert.deepEqual(store.seasonEpisodes(s1).map((e) => e.id), [e1, e2]);
  assert.equal(store.otherSeasonEpisode(s1).id, e3);
  assert.equal(store.seasonLabel(s1), 'Demo Show season 1');
  assert.equal(store.itemLabel(row(e2)), 'Demo Show S01E02');
  assert.equal(store.nextIntroSeason([e3]), s2, 'new episodes first');

  store.saveJob(row(e1), 'intros', { status: 'none' });
  store.saveJob(row(e2), 'intros', { status: 'done' });
  store.saveJob(row(e3), 'intros', { status: 'done' });
  assert.equal(store.nextIntroSeason(), null);
  assert.equal(store.pendingCounts().intros, 0);
  store.resetSeasonNone(s1);
  assert.deepEqual(store.pendingIntroEpisodes(s1).map((e) => e.id), [e1]);
  store.clearIntroJobs(s1);
  assert.deepEqual(store.pendingIntroEpisodes(s1).map((e) => e.id), [e1, e2]);
});

test('markers: set by hand beats chapters beats audio, and "no intro" sticks', () => {
  const tv = addLibrary('tv');
  const ep = addItem({ library_id: tv, kind: 'episode', title: 'Ep' });
  assert.equal(store.setMarker(ep, 'intro', { start: 10.123, end: 40, source: 'audio' }), true);
  assert.deepEqual(store.markers(ep).intro, { start: 10.12, end: 40, source: 'audio' });
  assert.equal(store.setMarker(ep, 'intro', { start: 5, end: 20, source: 'chapter' }), true);
  assert.equal(store.setMarker(ep, 'intro', { start: 11, end: 41, source: 'audio' }), false);
  assert.equal(store.setMarker(ep, 'intro', { start: null, end: null, source: 'manual' }), true);
  assert.equal(store.setMarker(ep, 'intro', { start: 5, end: 20, source: 'chapter' }), false);
  assert.deepEqual(store.markers(ep).intro, { none: true, source: 'manual' });
  assert.deepEqual(store.playbackMarkers(ep), { intro: null, credits: null });

  store.setMarker(ep, 'credits', { start: 1300, end: 1390, source: 'chapter' });
  assert.deepEqual(store.playbackMarkers(ep).credits, { start: 1300, end: 1390 });

  store.deleteMarker(ep, 'intro', { sources: ['audio'] });
  assert.equal(store.markers(ep).intro.none, true, 'only audio markers were asked to go');
  store.deleteMarker(ep, 'intro');
  assert.equal(store.markers(ep).intro, null);
});

test('results for a title that was removed mid-job are ignored', () => {
  const lib = addLibrary('movies');
  const id = addItem({ library_id: lib, kind: 'movie' });
  const item = row(id);
  db.run('DELETE FROM items WHERE id = ?', id);
  assert.equal(store.saveJob(item, 'previews', { status: 'done', data: { sheets: 1 } }), false);
  assert.equal(store.setMarker(id, 'intro', { start: 1, end: 20, source: 'audio' }), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/extras-store.test.js`
Expected: FAIL with `Cannot find module '.../src/extras/store.js'`.

- [ ] **Step 3: Add migration 6**

In `src/db.js`, append this entry to `MIGRATIONS`, directly after the migration 5 string (`ALTER TABLE items ADD COLUMN logo TEXT;`):

```js
  // 6: seek-bar previews and intro/credits markers, made by the background job runner.
  //    media_jobs remembers what each job did for which file (size/mtime), so a
  //    replaced file is done again. markers: start/end both NULL = "there isn't one".
  `
  ALTER TABLE libraries ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
  CREATE TABLE media_jobs (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    job TEXT NOT NULL CHECK (job IN ('previews', 'intros')),
    status TEXT NOT NULL CHECK (status IN ('done', 'none', 'failed')),
    data TEXT,
    error TEXT,
    source_size INTEGER,
    source_mtime INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (item_id, job)
  );
  CREATE TABLE markers (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('intro', 'credits')),
    start_time REAL,
    end_time REAL,
    source TEXT NOT NULL CHECK (source IN ('chapter', 'audio', 'manual')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (item_id, kind)
  );
  `,
```

- [ ] **Step 4: Add `previewsDir` and the two settings**

In `src/config.js`, after `cfg.transcodeDir = path.join(cfg.dataDir, 'transcode');` add:

```js
  cfg.previewsDir = path.join(cfg.dataDir, 'previews');
```

and change the directory loop to include it:

```js
  for (const dir of [cfg.dataDir, cfg.imagesDir, cfg.cacheDir, cfg.transcodeDir, cfg.pluginDataDir, cfg.previewsDir]) {
```

In `src/settings.js`, add to `SETTING_DEFAULTS` after `defaultQuality`:

```js
  previewsEnabled: true, // background job: seek-bar preview pictures
  introDetection: true, // background job: find TV intros (and credits chapters)
```

- [ ] **Step 5: Write the store**

Create `src/extras/store.js`:

```js
// What the background jobs have done: seek-bar preview layouts, which episodes
// have been checked for intros, and the intro/credits markers themselves.
import { parseJson } from '../db.js';

// Who wins when sources disagree: an admin, then the file's chapters, then audio matching.
const RANK = { audio: 1, chapter: 2, manual: 3 };
// A job is needed when it never ran for this file, or the file changed since.
const STALE = '(j.item_id IS NULL OR j.source_size IS NOT i.size OR j.source_mtime IS NOT i.mtime)';
const PREVIEWABLE = `i.kind IN ('movie', 'episode') AND i.path IS NOT NULL AND i.duration > 0
  AND json_extract(i.media, '$.video') IS NOT NULL
  AND COALESCE(json_extract(l.options, '$.previews'), 1) != 0`;
const CHECKABLE = "i.kind = 'episode' AND i.path IS NOT NULL AND i.duration > 0";
const ONLY = 'AND i.id IN (SELECT value FROM json_each(?))';

const pad = (n) => String(n ?? 0).padStart(2, '0');
function label({ kind, title, season, episode }, showTitle) {
  return kind === 'episode' && showTitle ? `${showTitle} S${pad(season)}E${pad(episode)}` : title;
}

/** Run a write; false if the item has been deleted in the meantime. */
function unlessGone(fn) {
  try {
    fn();
    return true;
  } catch (err) {
    if (/FOREIGN KEY/i.test(err.message)) return false;
    throw err;
  }
}

export class ExtrasStore {
  constructor(db) {
    this.db = db;
  }

  job(itemId, job) {
    const row = this.db.get('SELECT * FROM media_jobs WHERE item_id = ? AND job = ?', itemId, job);
    return row ? { ...row, data: parseJson(row.data, null) } : null;
  }

  /** Record what a job did for the file `item` describes (its size/mtime at the time). */
  saveJob(item, job, { status, data = null, error = null }) {
    return unlessGone(() =>
      this.db.run(
        `INSERT INTO media_jobs (item_id, job, status, data, error, source_size, source_mtime, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id, job) DO UPDATE SET status = excluded.status, data = excluded.data, error = excluded.error,
           source_size = excluded.source_size, source_mtime = excluded.source_mtime, updated_at = excluded.updated_at`,
        item.id,
        job,
        status,
        data == null ? null : JSON.stringify(data),
        error ? String(error).slice(0, 500) : null,
        item.size ?? null,
        item.mtime ?? null,
        Date.now(),
      ),
    );
  }

  // ---- Work still to do ----
  /** Oldest movie/episode still needing previews (only among `onlyIds` if given). */
  nextPreviewItem(onlyIds = null) {
    return (
      this.db.get(
        `SELECT i.* FROM items i JOIN libraries l ON l.id = i.library_id
         LEFT JOIN media_jobs j ON j.item_id = i.id AND j.job = 'previews'
         WHERE ${PREVIEWABLE} AND ${STALE} ${onlyIds ? ONLY : ''}
         ORDER BY i.id LIMIT 1`,
        ...(onlyIds ? [JSON.stringify(onlyIds)] : []),
      ) || null
    );
  }

  /** The season of the oldest episode still needing an intro check. */
  nextIntroSeason(onlyIds = null) {
    const row = this.db.get(
      `SELECT i.parent_id AS season_id FROM items i
       LEFT JOIN media_jobs j ON j.item_id = i.id AND j.job = 'intros'
       WHERE ${CHECKABLE} AND ${STALE} ${onlyIds ? ONLY : ''}
       ORDER BY i.id LIMIT 1`,
      ...(onlyIds ? [JSON.stringify(onlyIds)] : []),
    );
    return row ? row.season_id : null;
  }

  pendingIntroEpisodes(seasonId) {
    return this.db.all(
      `SELECT i.* FROM items i LEFT JOIN media_jobs j ON j.item_id = i.id AND j.job = 'intros'
       WHERE i.parent_id = ? AND ${CHECKABLE} AND ${STALE} ORDER BY i.episode, i.id`,
      seasonId,
    );
  }

  seasonEpisodes(seasonId) {
    return this.db.all(`SELECT i.* FROM items i WHERE i.parent_id = ? AND ${CHECKABLE} ORDER BY i.episode, i.id`, seasonId);
  }

  /** An episode from the same show's nearest other season (for one-episode seasons). */
  otherSeasonEpisode(seasonId) {
    const season = this.db.get('SELECT COALESCE(show_id, parent_id) AS show_id, season FROM items WHERE id = ?', seasonId);
    if (!season) return null;
    return (
      this.db.get(
        `SELECT i.* FROM items i WHERE i.show_id = ? AND i.parent_id != ? AND ${CHECKABLE}
         ORDER BY ABS(COALESCE(i.season, 0) - ?), i.season, i.episode LIMIT 1`,
        season.show_id,
        seasonId,
        season.season ?? 0,
      ) || null
    );
  }

  /** A new episode arrived: episodes where nothing was found get another go. */
  resetSeasonNone(seasonId) {
    this.db.run("DELETE FROM media_jobs WHERE job = 'intros' AND status = 'none' AND item_id IN (SELECT id FROM items WHERE parent_id = ?)", seasonId);
  }

  clearIntroJobs(seasonId) {
    this.db.run("DELETE FROM media_jobs WHERE job = 'intros' AND item_id IN (SELECT id FROM items WHERE parent_id = ?)", seasonId);
  }

  retryFailed() {
    return Number(this.db.run("DELETE FROM media_jobs WHERE status = 'failed'").changes);
  }

  failed(limit = 20) {
    return this.db
      .all(
        `SELECT j.item_id, j.job, j.error, i.kind, i.title, i.season, i.episode, s.title AS show_title
         FROM media_jobs j JOIN items i ON i.id = j.item_id LEFT JOIN items s ON s.id = i.show_id
         WHERE j.status = 'failed' ORDER BY j.updated_at DESC LIMIT ?`,
        limit,
      )
      .map((r) => ({ itemId: r.item_id, job: r.job, error: r.error, title: label(r, r.show_title) }));
  }

  pendingCounts() {
    const previews = this.db.get(
      `SELECT COUNT(*) AS n FROM items i JOIN libraries l ON l.id = i.library_id
       LEFT JOIN media_jobs j ON j.item_id = i.id AND j.job = 'previews' WHERE ${PREVIEWABLE} AND ${STALE}`,
    ).n;
    const intros = this.db.get(
      `SELECT COUNT(DISTINCT i.parent_id) AS n FROM items i
       LEFT JOIN media_jobs j ON j.item_id = i.id AND j.job = 'intros' WHERE ${CHECKABLE} AND ${STALE}`,
    ).n;
    return { previews, intros };
  }

  // ---- Previews ----
  previewIds() {
    return new Set(this.db.all("SELECT item_id FROM media_jobs WHERE job = 'previews' AND status = 'done'").map((r) => r.item_id));
  }

  /** The layout the player needs, or null (none yet, or made from a file that has since changed). */
  previewManifest(item) {
    const j = this.db.get("SELECT * FROM media_jobs WHERE item_id = ? AND job = 'previews' AND status = 'done'", item.id);
    if (!j || j.source_size !== (item.size ?? null) || j.source_mtime !== (item.mtime ?? null)) return null;
    const data = parseJson(j.data, null);
    if (!data?.sheets) return null;
    return { ...data, url: `/api/items/${item.id}/previews/{n}?v=${j.updated_at}` };
  }

  // ---- Markers ----
  markers(itemId) {
    const out = { intro: null, credits: null };
    for (const r of this.db.all('SELECT * FROM markers WHERE item_id = ?', itemId)) {
      out[r.kind] = r.start_time == null ? { none: true, source: r.source } : { start: r.start_time, end: r.end_time, source: r.source };
    }
    return out;
  }

  playbackMarkers(itemId) {
    const m = this.markers(itemId);
    const plain = (x) => (x && !x.none ? { start: x.start, end: x.end } : null);
    return { intro: plain(m.intro), credits: plain(m.credits) };
  }

  /** Save a marker unless a more trusted one is already there. Returns true if saved. */
  setMarker(itemId, kind, { start = null, end = null, source }) {
    const existing = this.db.get('SELECT source FROM markers WHERE item_id = ? AND kind = ?', itemId, kind);
    if (existing && RANK[existing.source] > RANK[source]) return false;
    const round = (v) => (v == null ? null : Math.round(v * 100) / 100);
    return unlessGone(() =>
      this.db.run(
        `INSERT INTO markers (item_id, kind, start_time, end_time, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id, kind) DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time,
           source = excluded.source, updated_at = excluded.updated_at`,
        itemId,
        kind,
        round(start),
        round(end),
        source,
        Date.now(),
      ),
    );
  }

  deleteMarker(itemId, kind, { sources = null } = {}) {
    if (sources) this.db.run('DELETE FROM markers WHERE item_id = ? AND kind = ? AND source IN (SELECT value FROM json_each(?))', itemId, kind, JSON.stringify(sources));
    else this.db.run('DELETE FROM markers WHERE item_id = ? AND kind = ?', itemId, kind);
  }

  // ---- Labels for the dashboard ----
  itemLabel(item) {
    const show = item.kind === 'episode' && item.show_id ? this.db.get('SELECT title FROM items WHERE id = ?', item.show_id) : null;
    return label(item, show?.title);
  }

  seasonLabel(seasonId) {
    const r = this.db.get('SELECT se.season, s.title AS show_title FROM items se LEFT JOIN items s ON s.id = COALESCE(se.show_id, se.parent_id) WHERE se.id = ?', seasonId);
    return r ? `${r.show_title} season ${r.season ?? 0}` : `Season ${seasonId}`;
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/extras-store.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 7: Checkpoint (instead of a commit)**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/*.test.js`
Expected: all pass (86 existing + 7 new).

---

### Task 2: Making preview sheets, and picking the right tile

**Files:**
- Modify: `src/library/probe.js`: `run()` (lines 5–36) gains an `onSpawn` option
- Create: `src/extras/previews.js`
- Create: `public/js/previews.js`
- Test: `test/previews.test.js`

**Interfaces:**
- Consumes: `run(bin, args, { timeout, maxBuffer, onSpawn })` from `src/library/probe.js` (this task adds `onSpawn`).
- Produces:
  - `planPreviews(duration, video) → { interval, width, height, columns, rows, count, sheets } | null`
  - `generatePreviews({ ffmpegPath, dir, item, media, hdrFilters?, onSpawn?, timeout? }) → Promise<layout>`, which writes `<dir>/<item.id>/1.jpg…`
  - `removePreviews(dir, itemId)`
  - `export const GRID = 10`, `export const TILE_WIDTH = 320`
  - `public/js/previews.js`: `tileFor(manifest, seconds) → { url, x, y, width, height, sheetWidth, sheetHeight } | null`

- [ ] **Step 1: Write the failing tests**

Create `test/previews.test.js`:

```js
// Seek-bar previews: the layout maths, which tile shows which moment, and a real
// ffmpeg run (with a file name that would break shell quoting).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasFfmpeg, tempDir } from './helpers.js';
import { planPreviews, generatePreviews, removePreviews } from '../src/extras/previews.js';
import { tileFor } from '../public/js/previews.js';

test('5-second steps under 20 minutes, 10 after, and the tile keeps the picture shape', () => {
  assert.deepEqual(planPreviews(130, { width: 1920, height: 1080 }), { interval: 5, width: 320, height: 180, columns: 10, rows: 10, count: 26, sheets: 1 });
  const film = planPreviews(7200, { width: 3840, height: 1600 });
  assert.deepEqual([film.interval, film.height, film.count, film.sheets], [10, 134, 720, 8]);
  assert.equal(planPreviews(1200, { width: 1280, height: 720 }).interval, 10);
});

test('very short or picture-less titles', () => {
  assert.deepEqual(planPreviews(3, { width: 640, height: 480 }), { interval: 5, width: 320, height: 240, columns: 10, rows: 10, count: 1, sheets: 1 });
  assert.equal(planPreviews(0, { width: 640, height: 480 }), null);
  assert.equal(planPreviews(null, { width: 640, height: 480 }), null);
  assert.equal(planPreviews(100, null), null);
  assert.equal(planPreviews(100, { width: 0, height: 0 }), null);
});

test('the tile for a moment in time', () => {
  const m = { interval: 10, width: 320, height: 180, columns: 10, rows: 10, count: 250, sheets: 3, url: '/api/items/7/previews/{n}?v=1' };
  assert.deepEqual(tileFor(m, 0), { url: '/api/items/7/previews/1?v=1', x: 0, y: 0, width: 320, height: 180, sheetWidth: 3200, sheetHeight: 1800 });
  assert.equal(tileFor(m, 14).x, 320, 'nearest tile');
  const lastOfFirst = tileFor(m, 994);
  assert.deepEqual([lastOfFirst.url.slice(-6), lastOfFirst.x, lastOfFirst.y], ['/1?v=1', 2880, 1620]);
  const firstOfSecond = tileFor(m, 995);
  assert.deepEqual([firstOfSecond.url.slice(-6), firstOfSecond.x, firstOfSecond.y], ['/2?v=1', 0, 0]);
  const end = tileFor(m, 99999);
  assert.deepEqual([end.url.slice(-6), end.x, end.y], ['/3?v=1', 2880, 720], 'clamped to the last tile');
  assert.equal(tileFor(m, -5).x, 0);
  assert.equal(tileFor(null, 5), null);
});

test('makes sheets for a real video with an awkward file name', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = tempDir();
  const file = path.join(tempDir(), "Bob's Whānau Film (2020) [1080p].mp4");
  // 20 minutes 10 seconds at 2 fps with a keyframe every 5 s: quick to make, 121 tiles → 2 sheets.
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=2:duration=1210', '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', file]);
  const spawned = [];
  const layout = await generatePreviews({ ffmpegPath: 'ffmpeg', dir, item: { id: 42, path: file, duration: 1210 }, media: { video: { width: 160, height: 90, hdr: false } }, onSpawn: (p) => spawned.push(p.pid) });
  assert.deepEqual(layout, { interval: 10, width: 320, height: 180, columns: 10, rows: 10, count: 121, sheets: 2 });
  assert.equal(spawned.length, 1, 'onSpawn saw the ffmpeg process');
  assert.deepEqual(fs.readdirSync(path.join(dir, '42')).sort(), ['1.jpg', '2.jpg']);
  assert.ok(!fs.existsSync(path.join(dir, '42.tmp')), 'temp folder swapped in');
  const size = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path.join(dir, '42', '1.jpg')]).toString().trim();
  assert.equal(size, '3200,1800');
  removePreviews(dir, 42);
  assert.ok(!fs.existsSync(path.join(dir, '42')));
});

test('a broken file fails cleanly', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = tempDir();
  const file = path.join(tempDir(), 'broken.mp4');
  fs.writeFileSync(file, 'not a video');
  await assert.rejects(generatePreviews({ ffmpegPath: 'ffmpeg', dir, item: { id: 5, path: file, duration: 60 }, media: { video: { width: 160, height: 90 } } }), /ffmpeg exited/);
  assert.deepEqual(fs.readdirSync(dir), [], 'no half-written folders left behind');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/previews.test.js`
Expected: FAIL with `Cannot find module '.../src/extras/previews.js'`.

- [ ] **Step 3: Let `run()` hand out the child process**

In `src/library/probe.js`, change `run`'s signature and add one line after the `try { proc = spawn(...) }` block:

```js
export function run(bin, args, { timeout = 60000, maxBuffer = 20 * 1024 * 1024, onSpawn } = {}) {
```

```js
    // The background job runner lowers ffmpeg's priority and kills it when playback needs the CPU.
    onSpawn?.(proc);
```

Place the `onSpawn?.(proc);` line directly after the closing `}` of the `try { proc = spawn(bin, args, { windowsHide: true }); } catch …` block, before `const out = [];`.

- [ ] **Step 4: Write the server module**

Create `src/extras/previews.js`:

```js
// Seek-bar previews: one fast ffmpeg pass that decodes only keyframes and tiles a
// small frame every few seconds into JPEG sheets (10 × 10 tiles per sheet).
// Files with few keyframes give repeated tiles, which is fine for a preview.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../library/probe.js';

export const TILE_WIDTH = 320;
export const GRID = 10;
// HDR → normal colours, only used when this ffmpeg has zscale and tonemap.
const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,';

/** The layout for a title's previews, or null when it can't have any. */
export function planPreviews(duration, video) {
  if (!(duration > 0) || !(video?.width > 0) || !(video?.height > 0)) return null;
  const interval = duration < 1200 ? 5 : 10;
  const height = Math.max(2, Math.round((TILE_WIDTH * video.height) / video.width / 2) * 2);
  const count = Math.max(1, Math.ceil(duration / interval));
  return { interval, width: TILE_WIDTH, height, columns: GRID, rows: GRID, count, sheets: Math.ceil(count / (GRID * GRID)) };
}

/**
 * Make `<dir>/<item.id>/1.jpg, 2.jpg…`. Writes into `<id>.tmp` first and swaps it
 * in at the end, so a half-finished run never shows. Resolves to the layout.
 */
export async function generatePreviews({ ffmpegPath, dir, item, media, hdrFilters = false, onSpawn, timeout = 30 * 60 * 1000 }) {
  const plan = planPreviews(item.duration, media?.video);
  if (!plan) throw new Error('There is no video to make previews from.');
  const final = path.join(dir, String(item.id));
  const tmp = `${final}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const tonemap = media.video.hdr && hdrFilters ? TONEMAP : '';
  const vf = `fps=1/${plan.interval},${tonemap}scale=${plan.width}:${plan.height},tile=${GRID}x${GRID}`;
  try {
    await run(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-skip_frame', 'nokey', '-i', item.path, '-map', '0:V:0', '-an', '-sn', '-dn', '-vf', vf, '-q:v', '5', '-f', 'image2', path.join(tmp, '%d.jpg')],
      { timeout, onSpawn },
    );
    const sheets = fs.readdirSync(tmp).filter((f) => /^\d+\.jpg$/.test(f)).length;
    if (!sheets) throw new Error('ffmpeg made no pictures.');
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(tmp, final);
    return { ...plan, sheets, count: Math.min(plan.count, sheets * GRID * GRID) };
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

export function removePreviews(dir, itemId) {
  fs.rmSync(path.join(dir, String(itemId)), { recursive: true, force: true });
}
```

- [ ] **Step 5: Write the browser helper**

Create `public/js/previews.js`:

```js
// Which tile of the seek-bar preview sheets shows moment `t` (seconds). Pure, so
// it runs in the browser and in the Node tests.
export function tileFor(p, t) {
  if (!p || !(p.count > 0)) return null;
  const index = Math.min(p.count - 1, Math.max(0, Math.round((Number(t) || 0) / p.interval)));
  const perSheet = p.columns * p.rows;
  const inSheet = index % perSheet;
  return {
    url: p.url.replace('{n}', String(Math.floor(index / perSheet) + 1)),
    x: (inSheet % p.columns) * p.width,
    y: Math.floor(inSheet / p.columns) * p.height,
    width: p.width,
    height: p.height,
    sheetWidth: p.columns * p.width,
    sheetHeight: p.rows * p.height,
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/previews.test.js`
Expected: PASS, 5 tests. The real-video test takes about 4 s.

- [ ] **Step 7: Checkpoint**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/*.test.js`
Expected: all pass.

---
### Task 3: Audio fingerprint and shared-stretch matcher

**Files:**
- Create: `src/extras/fingerprint.js`
- Test: `test/fingerprint.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `SAMPLE_RATE = 8000`, `HOP_SECONDS = 0.064`
  - `fft(re: Float64Array, im: Float64Array)`, which transforms in place
  - `fingerprint(samples: Int16Array) → Uint32Array`, one code per hop
  - `popcount(x) → number`
  - `findSharedSegment(a: Uint32Array, b: Uint32Array, opts?) → { aStart, aEnd, bStart, bEnd } | null`, in seconds rounded to 0.01. The options default to `{ maxBitErrors: 11, smoothFrames: 16, gapFrames: 16, minSeconds: 15, maxSeconds: 150 }`.

- [ ] **Step 1: Write the failing tests**

Create `test/fingerprint.test.js`:

```js
// The audio fingerprint that finds a TV intro: two recordings of the same tune
// must match even when one is quieter and muffled; noise and duplicates must not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fft, fingerprint, popcount, findSharedSegment, SAMPLE_RATE, HOP_SECONDS } from '../src/extras/fingerprint.js';

const SR = SAMPLE_RATE;
function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}
/** A made-up theme tune: two melodies over 20 s. */
function theme(seconds = 20) {
  const out = new Float64Array(seconds * SR);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const f1 = [262, 330, 392, 349, 294][Math.floor(t * 2) % 5];
    const f2 = [523, 659, 587, 784][Math.floor(t * 3) % 4];
    out[i] = 0.35 * Math.sin(2 * Math.PI * f1 * t) + 0.2 * Math.sin(2 * Math.PI * f2 * t);
  }
  return out;
}
const noise = (seconds, seed, amp = 0.3) => {
  const r = rng(seed);
  return Float64Array.from({ length: seconds * SR }, () => (r() * 2 - 1) * amp);
};
/** Join parts into 16-bit PCM, optionally quieter and through a simple low-pass filter. */
function clip(parts, { gain = 1, lowpass = 0 } = {}) {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  const alpha = lowpass ? 1 - Math.exp((-2 * Math.PI * lowpass) / SR) : 1;
  let k = 0;
  let y = 0;
  for (const p of parts) {
    for (const v of p) {
      y += alpha * (v * gain - y);
      out[k++] = Math.max(-32768, Math.min(32767, Math.round(y * 32767)));
    }
  }
  return out;
}

test('fft finds a pure tone', () => {
  const n = 64;
  const re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 8 * i) / n));
  const im = new Float64Array(n);
  fft(re, im);
  const mag = [...re].map((r, i) => Math.hypot(r, im[i]));
  const peaks = mag.map((m, i) => [m, i]).filter(([m]) => m > 1).map(([, i]) => i);
  assert.deepEqual(peaks, [8, 56]);
});

test('popcount counts bits', () => {
  assert.deepEqual([0, 1, 0xff, 0xffffffff, 0x80000001].map(popcount), [0, 1, 8, 32, 2]);
});

test('fingerprint: one 32-bit code per 64 ms', () => {
  assert.equal(HOP_SECONDS, 0.064);
  const fp = fingerprint(clip([noise(10, 1)]));
  assert.ok(fp instanceof Uint32Array);
  assert.equal(fp.length, Math.floor((10 * SR - 1024) / 512)); // frames − 1 (the first has nothing to compare with)
  assert.equal(fingerprint(new Int16Array(500)).length, 0, 'too short for one frame');
});

test('finds the shared tune in a quieter, muffled copy', () => {
  const tune = theme();
  const a = fingerprint(clip([noise(12, 1), tune, noise(28, 2)]));
  const b = fingerprint(clip([noise(47, 3), tune, noise(23, 4)], { gain: 0.5, lowpass: 3000 }));
  const m = findSharedSegment(a, b);
  assert.ok(m, 'found a match');
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 0.3, `${actual} vs ${expected}`);
  near(m.aStart, 12);
  near(m.aEnd, 32);
  near(m.bStart, 47);
  near(m.bEnd, 67);
});

test('different sounds, or too little in common, give no intro', () => {
  const a = fingerprint(clip([noise(12, 1), theme(), noise(28, 2)]));
  assert.equal(findSharedSegment(a, fingerprint(clip([noise(70, 5)]))), null, 'nothing shared');
  const short = fingerprint(clip([noise(12, 6), theme(10), noise(30, 7)]));
  assert.equal(findSharedSegment(short, a), null, '10 s is too short to be an intro');
});

test('duplicate episodes are not one long "intro"', () => {
  const same = clip([noise(40, 8), theme(), noise(140, 9)]);
  assert.equal(findSharedSegment(fingerprint(same), fingerprint(same)), null, '200 s in common is longer than any intro');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/fingerprint.test.js`
Expected: FAIL with `Cannot find module '.../src/extras/fingerprint.js'`.

- [ ] **Step 3: Write the module**

Create `src/extras/fingerprint.js`:

```js
// Audio fingerprints for finding a TV show's intro: the theme tune is the longest
// stretch of sound that episodes of a season share. Pure functions, no I/O.
//
// Method (after Haitsma & Kalker, "A Highly Robust Audio Fingerprinting System",
// 2002): 8 kHz mono audio is cut into 128 ms frames every 64 ms. Each frame gives a
// 32-bit code: for each pair of neighbouring frequency bands (33 bands, 300–2000
// Hz), did their energy difference go up or down since the previous frame? Two
// recordings of the same tune differ in only a few bits, even after different lossy
// encoding or a volume change.

export const SAMPLE_RATE = 8000;
const FRAME = 1024;
const HOP = 512;
const BANDS = 33;
const LOW_HZ = 300;
const HIGH_HZ = 2000;
export const HOP_SECONDS = HOP / SAMPLE_RATE;

const HANN = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
// FFT bin where each band starts (log-spaced), plus the end of the last band.
const EDGES = Array.from({ length: BANDS + 1 }, (_, m) => Math.round((LOW_HZ * (HIGH_HZ / LOW_HZ) ** (m / BANDS)) / (SAMPLE_RATE / FRAME)));

/** In-place radix-2 FFT; `re` and `im` have the same power-of-two length. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

/** 16-bit PCM at SAMPLE_RATE → one 32-bit code per 64 ms. */
export function fingerprint(samples) {
  const frames = samples.length >= FRAME ? Math.floor((samples.length - FRAME) / HOP) + 1 : 0;
  const out = new Uint32Array(Math.max(0, frames - 1));
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  let prev = null;
  for (let f = 0; f < frames; f++) {
    const base = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = (samples[base + i] / 32768) * HANN[i];
      im[i] = 0;
    }
    fft(re, im);
    const energy = new Float64Array(BANDS);
    for (let m = 0; m < BANDS; m++) {
      let sum = 0;
      const to = Math.max(EDGES[m + 1], EDGES[m] + 1);
      for (let k = EDGES[m]; k < to; k++) sum += re[k] * re[k] + im[k] * im[k];
      energy[m] = sum;
    }
    if (prev) {
      let code = 0;
      for (let m = 0; m < 32; m++) if (energy[m] - energy[m + 1] - (prev[m] - prev[m + 1]) > 0) code |= 1 << m;
      out[f - 1] = code >>> 0;
    }
    prev = energy;
  }
  return out;
}

export function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * The longest stretch where `a` and `b` sound the same, as seconds into each:
 * { aStart, aEnd, bStart, bEnd }, or null when no stretch between minSeconds and
 * maxSeconds matches. Tries every alignment (about 0.5 s for two 10-minute clips).
 */
export function findSharedSegment(a, b, { maxBitErrors = 11, smoothFrames = 16, gapFrames = 16, minSeconds = 15, maxSeconds = 150 } = {}) {
  const minFrames = Math.ceil(minSeconds / HOP_SECONDS);
  const limit = maxBitErrors * smoothFrames;
  const errs = new Uint8Array(Math.max(a.length, b.length));
  let best = null; // frames in `a`; the same moment in `b` is frame + shift
  for (let shift = -(a.length - 1); shift < b.length; shift++) {
    const from = Math.max(0, -shift);
    const n = Math.min(a.length, b.length - shift) - from;
    if (n < minFrames || (best && n <= best.len)) continue; // this alignment can't beat what we have
    for (let k = 0; k < n; k++) errs[k] = popcount(a[from + k] ^ b[from + k + shift]);
    let sum = 0;
    let runStart = -1;
    let lastGood = -1;
    for (let k = 0; k < n; k++) {
      sum += errs[k];
      if (k >= smoothFrames) sum -= errs[k - smoothFrames];
      if (k < smoothFrames - 1 || sum > limit) continue;
      const windowStart = k - smoothFrames + 1;
      if (runStart < 0 || windowStart - lastGood > gapFrames) runStart = windowStart;
      lastGood = k;
      const len = lastGood - runStart + 1;
      if (!best || len > best.len) best = { len, shift, start: from + runStart, end: from + lastGood + 1 };
    }
  }
  if (!best) return null;
  // The smoothing window reaches past the real edges; drop edge frames that don't match on their own.
  const err = (i) => popcount(a[i] ^ b[i + best.shift]);
  for (let s = 0; s < smoothFrames && best.end - best.start > 1 && err(best.start) > maxBitErrors; s++) best.start++;
  for (let s = 0; s < smoothFrames && best.end - best.start > 1 && err(best.end - 1) > maxBitErrors; s++) best.end--;
  const seconds = (best.end - best.start) * HOP_SECONDS;
  if (seconds < minSeconds || seconds > maxSeconds) return null;
  const t = (frame) => Math.round(frame * HOP_SECONDS * 100) / 100;
  return { aStart: t(best.start), aEnd: t(best.end), bStart: t(best.start + best.shift), bEnd: t(best.end + best.shift) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/fingerprint.test.js`
Expected: PASS, 6 tests in under 2 s. If "finds the shared tune" misses by more than 0.3 s, **don't loosen the test**: print `m`, compare it with the prototype result (12.1–31.94 / 47.1–66.94), and check the edge-trimming loops first.

- [ ] **Step 5: Checkpoint**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/*.test.js`
Expected: all pass.

---

### Task 4: Finding intros in a season (chapters, then audio)

**Files:**
- Modify: `test/helpers.js`: add `makeEpisode()` after `makeVideo()`
- Create: `src/extras/intros.js`
- Test: `test/intros.test.js`

**Interfaces:**
- Consumes:
  - `run()` with `onSpawn` (Task 2)
  - `fingerprint`, `findSharedSegment`, `SAMPLE_RATE` (Task 3)
  - `ExtrasStore` methods: `pendingIntroEpisodes`, `seasonEpisodes`, `otherSeasonEpisode`, `markers`, `setMarker`, `saveJob` (Task 1)
- Produces:
  - `markersFromChapters(chapters) → { intro: {start,end}|null, credits: {start,end}|null }`
  - `readChapters(ffprobePath, file, { onSpawn }?) → Promise<ffprobe chapters[]>`
  - `searchWindow(duration) → seconds`
  - `audioFingerprint(ffmpegPath, file, duration, { onSpawn }?) → Promise<Uint32Array>`
  - `partnersFor(ep, seasonEpisodes, otherSeasonEpisode|null) → episode[]`
  - `runIntroJob({ seasonId, store, ffmpegPath, ffprobePath, signal, onSpawn }) → Promise<void>`. It rejects with an `AbortError` when `signal` aborts, and writes nothing for the episode it was working on.
  - `test/helpers.js`: `makeEpisode(file, { seconds = 100, themeAt = null, seed = 1, audioCodec = 'aac'|'mp3'|'opus', videoCodec = 'libx264', gain = 1, lowpass = 0, chapters = null })`, where chapters are `[[start, end, title], …]`. It builds the audio as noise + the shared 20 s `THEME` at `themeAt` + more noise.

- [ ] **Step 1: Add the episode maker to the test helpers**

In `test/helpers.js`, add after `makeVideo()`:

```js
/** The same made-up 20-second theme tune in every episode that asks for it. */
export const THEME = "aevalsrc='0.3*sin(2*PI*(220+110*mod(floor(t*2),5))*t)+0.2*sin(2*PI*(330+55*mod(floor(t*3),7))*t)+0.1*sin(2*PI*660*t)*gt(mod(t,1),0.5)':s=44100:d=20";

/**
 * A TV episode for intro tests: noise, the shared THEME at `themeAt` seconds (if
 * given), then more noise. `chapters` = [[start, end, title], …]. Video is a 2 fps
 * test pattern so it's quick to make.
 */
export function makeEpisode(file, { seconds = 100, themeAt = null, seed = 1, audioCodec = 'aac', videoCodec = 'libx264', gain = 1, lowpass = 0, chapters = null } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=2:duration=${seconds}`];
  let chain;
  if (themeAt != null) {
    args.push('-f', 'lavfi', '-i', `anoisesrc=d=${themeAt}:c=pink:r=44100:a=0.3:seed=${seed}`, '-f', 'lavfi', '-i', THEME, '-f', 'lavfi', '-i', `anoisesrc=d=${seconds - themeAt - 20}:c=brown:r=44100:a=0.4:seed=${seed + 1}`);
    chain = '[1:a][2:a][3:a]concat=n=3:v=0:a=1';
  } else {
    args.push('-f', 'lavfi', '-i', `anoisesrc=d=${seconds}:c=pink:r=44100:a=0.3:seed=${seed}`);
    chain = '[1:a]anull';
  }
  if (gain !== 1) chain += `,volume=${gain}`;
  if (lowpass) chain += `,lowpass=f=${lowpass}`;
  args.push('-filter_complex', `${chain}[a]`);
  const meta = `${file}.chapters.txt`;
  const metaIndex = themeAt != null ? 4 : 2;
  if (chapters) {
    fs.writeFileSync(meta, ';FFMETADATA1\n' + chapters.map(([start, end, title]) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(start * 1000)}\nEND=${Math.round(end * 1000)}\ntitle=${title}\n`).join(''));
    args.push('-i', meta);
  }
  args.push('-map', '0:v', '-map', '[a]');
  if (chapters) args.push('-map_metadata', String(metaIndex), '-map_chapters', String(metaIndex));
  const audio = { aac: ['aac'], mp3: ['libmp3lame'], opus: ['libopus', '-ar', '48000'] }[audioCodec];
  args.push('-c:v', videoCodec, '-g', '10', '-pix_fmt', 'yuv420p', '-c:a', ...audio, '-shortest', file);
  execFileSync('ffmpeg', args);
  if (chapters) fs.rmSync(meta);
}
```

(These arguments were checked on 29 Sep. The episodes come out at 100.0 s, with codecs h264+aac, h264+mp3 or vp9+opus, and chapters where asked for.)

- [ ] **Step 2: Write the failing tests**

Create `test/intros.test.js`:

```js
// Intro finding: chapter names, who is compared with whom, and a real season with
// a shared theme tune (AAC vs a quieter, muffled MP3), a chapter-marked episode and
// a clip too short to check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeEpisode } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { ExtrasStore } from '../src/extras/store.js';
import { markersFromChapters, partnersFor, searchWindow, runIntroJob } from '../src/extras/intros.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';

function seasonDb(files, durations = {}) {
  const db = openDatabase(path.join(tempDir(), 't.db'));
  const t = Date.now();
  const lib = Number(db.run("INSERT INTO libraries (name, type, paths, created_at) VALUES ('TV', 'tv', '[]', ?)", t).lastInsertRowid);
  const add = (f) => {
    const cols = Object.keys(f);
    return Number(db.run(`INSERT INTO items (${cols.join(', ')}, library_id, added_at, updated_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?, ?)`, ...Object.values(f), lib, t, t).lastInsertRowid);
  };
  const show = add({ kind: 'show', title: 'Theme Show', path: '/tv/Theme Show' });
  const season = add({ kind: 'season', title: 'Season 1', parent_id: show, show_id: show, season: 1 });
  const media = JSON.stringify({ video: { width: 160, height: 90 }, audio: [{ index: 0 }] });
  const ids = {};
  Object.entries(files).forEach(([key, file], i) => {
    ids[key] = add({ kind: 'episode', title: key, parent_id: season, show_id: show, season: 1, episode: i + 1, path: file, size: 1, mtime: 1, duration: durations[key] ?? 100, media });
  });
  return { db, store: new ExtrasStore(db), season, ids };
}

test('intro and credits chapters are recognised by name', () => {
  const ch = (start, end, title) => ({ start_time: String(start), end_time: String(end), tags: title == null ? {} : { title } });
  assert.deepEqual(markersFromChapters([ch(0, 5, 'Recap'), ch(5, 20, ' OPENING '), ch(20, 50, 'Chapter 2'), ch(50, 60, 'End Credits')]), { intro: { start: 5, end: 20 }, credits: { start: 50, end: 60 } });
  assert.deepEqual(markersFromChapters([ch(0, 30, 'Intro Song'), ch(30, 30, 'Intro'), ch(40, 60, null)]), { intro: null, credits: null }, 'near misses and empty chapters are ignored');
  assert.deepEqual(markersFromChapters(undefined), { intro: null, credits: null });
});

test('each episode is compared with the next, the one after, the previous, then another season', () => {
  const eps = [1, 2, 3, 4, 5].map((id) => ({ id }));
  assert.deepEqual(partnersFor(eps[2], eps, { id: 99 }).map((e) => e.id), [4, 5, 2, 99]);
  assert.deepEqual(partnersFor(eps[4], eps, { id: 99 }).map((e) => e.id), [4, 99]);
  assert.deepEqual(partnersFor(eps[0], [eps[0]], null), []);
});

test('only the start of an episode is searched', () => {
  assert.equal(searchWindow(100), 40);
  assert.equal(searchWindow(3600), 600);
});

test('a real season: shared theme, chapters, and a clip too short to check', { skip }, async () => {
  const dir = tempDir();
  const files = {
    e1: path.join(dir, "Theme Show - S01E01 - Kia ora, Whānau.mp4"),
    e2: path.join(dir, 'Theme Show - S01E02.mkv'),
    e3: path.join(dir, 'Theme Show - S01E03.mkv'),
    e4: path.join(dir, 'Theme Show - S01E04.mp4'),
  };
  makeEpisode(files.e1, { themeAt: 6, seed: 1 });
  makeEpisode(files.e2, { themeAt: 17, seed: 3, audioCodec: 'mp3', gain: 0.5, lowpass: 3000 });
  makeEpisode(files.e3, { seed: 5, chapters: [[0, 5, 'Recap'], [5, 20, 'Opening'], [20, 80, 'Part 1'], [80, 100, 'End Credits']] });
  makeEpisode(files.e4, { seconds: 30, seed: 7 });
  const { db, store, season, ids } = seasonDb(files, { e4: 30 });

  await runIntroJob({ seasonId: season, store, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', signal: new AbortController().signal });

  const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) <= 0.5, `${what}: ${actual} is not within 0.5 s of ${expected}`);
  const m1 = store.markers(ids.e1).intro;
  const m2 = store.markers(ids.e2).intro;
  assert.equal(m1.source, 'audio');
  near(m1.start, 6, 'E01 start');
  near(m1.end, 26, 'E01 end');
  near(m2.start, 17, 'E02 start');
  near(m2.end, 37, 'E02 end');
  assert.deepEqual(store.markers(ids.e3), { intro: { start: 5, end: 20, source: 'chapter' }, credits: { start: 80, end: 100, source: 'chapter' } });
  assert.equal(store.markers(ids.e4).intro, null);
  assert.deepEqual(['e1', 'e2', 'e3', 'e4'].map((k) => store.job(ids[k], 'intros').status), ['done', 'done', 'done', 'none']);
  db.close();
});

test('a stopped job records nothing', async () => {
  const { db, store, season, ids } = seasonDb({ e1: '/nowhere/e1.mp4' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runIntroJob({ seasonId: season, store, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(store.job(ids.e1, 'intros'), null);
  db.close();
});

test('an unreadable episode is marked failed, not "no intro"', { skip }, async () => {
  const { db, store, season, ids } = seasonDb({ e1: path.join(tempDir(), 'missing.mp4') });
  await runIntroJob({ seasonId: season, store, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', signal: new AbortController().signal });
  const job = store.job(ids.e1, 'intros');
  assert.equal(job.status, 'failed');
  assert.match(job.error, /ffmpeg exited/);
  db.close();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/intros.test.js`
Expected: FAIL with `Cannot find module '.../src/extras/intros.js'`.

- [ ] **Step 4: Write the module**

Create `src/extras/intros.js`:

```js
// Finding intros (and credits) in TV episodes: chapter names first, then the
// longest stretch of sound a season's episodes share (the theme tune).
import { parseJson } from '../db.js';
import { run } from '../library/probe.js';
import { fingerprint, findSharedSegment, SAMPLE_RATE } from './fingerprint.js';

const INTRO_TITLES = new Set(['intro', 'opening', 'opening credits', 'op', 'title sequence', 'main titles']);
const CREDITS_TITLES = new Set(['credits', 'end credits', 'ending', 'ed', 'outro', 'closing credits']);

/** ffprobe chapters → { intro, credits } (first chapter of each kind wins). */
export function markersFromChapters(chapters = []) {
  const out = { intro: null, credits: null };
  for (const c of chapters || []) {
    const title = String(c?.tags?.title ?? '').trim().toLowerCase();
    const start = Number(c?.start_time);
    const end = Number(c?.end_time);
    if (!Number.isFinite(start) || !(end > start)) continue;
    if (!out.intro && INTRO_TITLES.has(title)) out.intro = { start, end };
    else if (!out.credits && CREDITS_TITLES.has(title)) out.credits = { start, end };
  }
  return out;
}

export async function readChapters(ffprobePath, file, { onSpawn } = {}) {
  const out = await run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_chapters', file], { timeout: 60000, onSpawn });
  return JSON.parse(out.toString('utf8')).chapters || [];
}

/** How much of the start of an episode to search, in seconds. */
export const searchWindow = (duration) => Math.min(600, 0.4 * duration);

export async function audioFingerprint(ffmpegPath, file, duration, { onSpawn } = {}) {
  const out = await run(
    ffmpegPath,
    ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-t', searchWindow(duration).toFixed(2), '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'],
    { timeout: 5 * 60 * 1000, maxBuffer: 20 * 1024 * 1024, onSpawn },
  );
  // Copy into a fresh ArrayBuffer (2-byte aligned) before reading it as 16-bit samples.
  const bytes = out.buffer.slice(out.byteOffset, out.byteOffset + (out.length & ~1));
  return fingerprint(new Int16Array(bytes));
}

/** Who to compare an episode with, in order: next, next-but-one, previous, then another season's. */
export function partnersFor(ep, seasonEpisodes, otherSeason = null) {
  const i = seasonEpisodes.findIndex((e) => e.id === ep.id);
  const near = i < 0 ? [] : [seasonEpisodes[i + 1], seasonEpisodes[i + 2], seasonEpisodes[i - 1]];
  return [...near, otherSeason].filter((e) => e && e.id !== ep.id);
}

const checkable = (ep) => ep.duration >= 60 && (parseJson(ep.media, null)?.audio || []).length > 0;

/** Check a season's pending episodes and record markers and results. */
export async function runIntroJob({ seasonId, store, ffmpegPath, ffprobePath, signal, onSpawn }) {
  signal?.throwIfAborted();
  const pending = store.pendingIntroEpisodes(seasonId);
  if (!pending.length) return;
  const season = store.seasonEpisodes(seasonId);
  const other = store.otherSeasonEpisode(seasonId);

  const prints = new Map(); // episode id → { fp, error }
  async function printOf(ep) {
    if (!prints.has(ep.id)) {
      const entry = { fp: null, error: null };
      if (checkable(ep)) {
        try {
          entry.fp = await audioFingerprint(ffmpegPath, ep.path, ep.duration, { onSpawn });
        } catch (err) {
          signal?.throwIfAborted();
          entry.error = err.message;
        }
      }
      prints.set(ep.id, entry);
    }
    signal?.throwIfAborted();
    return prints.get(ep.id);
  }

  for (const ep of pending) {
    signal?.throwIfAborted();
    try {
      let chapters = { intro: null, credits: null };
      try {
        chapters = markersFromChapters(await readChapters(ffprobePath, ep.path, { onSpawn }));
      } catch {
        signal?.throwIfAborted(); // no readable chapters: carry on with the audio
      }
      if (chapters.credits) store.setMarker(ep.id, 'credits', { ...chapters.credits, source: 'chapter' });
      if (chapters.intro) {
        store.setMarker(ep.id, 'intro', { ...chapters.intro, source: 'chapter' });
        store.saveJob(ep, 'intros', { status: 'done' });
        continue;
      }
      const mine = await printOf(ep);
      if (mine.error) {
        store.saveJob(ep, 'intros', { status: 'failed', error: mine.error });
        continue;
      }
      let found = false;
      if (mine.fp) {
        for (const partner of partnersFor(ep, season, other)) {
          const theirs = (await printOf(partner)).fp;
          if (!theirs) continue;
          const match = findSharedSegment(mine.fp, theirs);
          if (!match) continue;
          store.setMarker(ep.id, 'intro', { start: match.aStart, end: match.aEnd, source: 'audio' });
          if (!store.markers(partner.id).intro) store.setMarker(partner.id, 'intro', { start: match.bStart, end: match.bEnd, source: 'audio' });
          found = true;
          break;
        }
      }
      store.saveJob(ep, 'intros', { status: found ? 'done' : 'none' });
    } catch (err) {
      signal?.throwIfAborted();
      store.saveJob(ep, 'intros', { status: 'failed', error: err.message });
    }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/intros.test.js`
Expected: PASS, 6 tests. The real-season test takes about 5 s; it was checked on 29 Sep with the prototype matcher at 6.21–25.92 and 17.22–36.93.

- [ ] **Step 6: Checkpoint**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/*.test.js`
Expected: all pass.

---
### Task 5: The background job runner

**Files:**
- Create: `src/extras/jobs.js`
- Create: `src/tasks.js`
- Test: `test/tasks.test.js`

**Interfaces:**
- Consumes:
  - `ExtrasStore` (Task 1)
  - `generatePreviews`, `removePreviews` (Task 2)
  - `runIntroJob` (Task 4)
  - `Settings` from `src/settings.js` (`all()`, `set()`)
- Produces:
  - `makeJobs({ store, config, tools }) → { previews(itemRow, ctx), intros(seasonId, ctx) }`, where `ctx = { signal: AbortSignal, onSpawn(proc) }` and `config` has `ffmpegPath`, `ffprobePath`, `previewsDir`
  - `class TaskRunner({ store, settings, tools, busy, jobs, previewsDir, pollMs?, busyPollMs?, gapMs? })` with:
    - `start()`, `stop() → Promise`, `kick()`
    - `prioritise(itemRow)`, `interruptIfBusy()`
    - `status() → { running: {job,itemId,title,startedAt}|null, paused: null|'converting'|'disabled'|'no-ffmpeg', queued: {previews,intros}, failed: [...] }`
    - `sweep()`
    - `current`: the running task or null; `current.proc` is the child process

- [ ] **Step 1: Write the failing tests**

Create `test/tasks.test.js`:

```js
// The job runner: one job at a time, new titles first, pauses (and redoes the
// interrupted job) while a conversion plays, records failures, cleans up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { hasFfmpeg, tempDir } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { Settings } from '../src/settings.js';
import { ExtrasStore } from '../src/extras/store.js';
import { makeJobs } from '../src/extras/jobs.js';
import { TaskRunner } from '../src/tasks.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function setup() {
  const db = openDatabase(path.join(tempDir(), 't.db'));
  const store = new ExtrasStore(db);
  const settings = new Settings(db);
  const t = Date.now();
  let seq = 0;
  const lib = (type) => Number(db.run('INSERT INTO libraries (name, type, paths, created_at) VALUES (?, ?, ?, ?)', type, type, '[]', t).lastInsertRowid);
  const add = (f) => {
    const all = { title: `item ${++seq}`, path: `/media/${seq}`, size: 1, mtime: 1, duration: 600, media: JSON.stringify({ video: { width: 640, height: 360 }, audio: [{ index: 0 }] }), ...f };
    const cols = Object.keys(all);
    return Number(db.run(`INSERT INTO items (${cols.join(', ')}, added_at, updated_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`, ...Object.values(all), t, t).lastInsertRowid);
  };
  const row = (id) => db.get('SELECT * FROM items WHERE id = ?', id);
  return { db, store, settings, lib, add, row };
}
const withFfmpeg = () => ({ ffmpeg: { available: true }, filters: {} });
const done = (store, item) => store.saveJob(item, 'previews', { status: 'done', data: { sheets: 1 } });

test('one job at a time: new titles first, then intros, then the backlog oldest first', async () => {
  const { db, store, settings, lib, add, row } = setup();
  const movies = lib('movies');
  const m1 = add({ library_id: movies, kind: 'movie' });
  const m2 = add({ library_id: movies, kind: 'movie' });
  const tv = lib('tv');
  const show = add({ library_id: tv, kind: 'show', duration: null, media: null });
  const s1 = add({ library_id: tv, kind: 'season', parent_id: show, show_id: show, season: 1, duration: null, media: null });
  const e1 = add({ library_id: tv, kind: 'episode', parent_id: s1, show_id: show, season: 1, episode: 1 });

  const log = [];
  let active = 0;
  let most = 0;
  const jobs = {
    async previews(item) {
      log.push(`p${item.id}`);
      most = Math.max(most, ++active);
      await sleep(15);
      active--;
      done(store, item);
    },
    async intros(seasonId) {
      log.push(`i${seasonId}`);
      for (const ep of store.pendingIntroEpisodes(seasonId)) store.saveJob(ep, 'intros', { status: 'none' });
    },
  };
  const runner = new TaskRunner({ store, settings, tools: withFfmpeg, busy: () => false, jobs, previewsDir: tempDir(), pollMs: 30, busyPollMs: 10, gapMs: 0 });
  runner.prioritise(row(m2));
  runner.start();
  await until(() => log.length === 4 && !runner.current, 'four jobs');
  await runner.stop();
  assert.deepEqual(log, [`p${m2}`, `i${s1}`, `p${m1}`, `p${e1}`]);
  assert.equal(most, 1, 'never two at once');
  assert.deepEqual(runner.status().queued, { previews: 0, intros: 0 });
  db.close();
});

test('a conversion pauses the runner, and the interrupted job is redone', async () => {
  const { db, store, settings, lib, add, row } = setup();
  const movie = add({ library_id: lib('movies'), kind: 'movie', title: 'Big Film' });
  let busy = false;
  const calls = [];
  const exits = [];
  const jobs = {
    async previews(item, ctx) {
      calls.push(item.id);
      if (calls.length === 1) {
        // Stand-in for ffmpeg: a process that would run for 30 s.
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
        ctx.onSpawn(child);
        exits.push(await new Promise((r) => child.on('exit', (code, signal) => r(signal))));
        throw new Error('ffmpeg exited with null');
      }
      done(store, item);
    },
    async intros() {},
  };
  const runner = new TaskRunner({ store, settings, tools: withFfmpeg, busy: () => busy, jobs, previewsDir: tempDir(), pollMs: 30, busyPollMs: 10, gapMs: 0 });
  runner.start();
  await until(() => runner.current?.proc, 'the job to start its process');
  assert.equal(runner.status().running.title, 'Big Film');
  busy = true;
  runner.interruptIfBusy();
  await until(() => exits.length === 1, 'the process to be killed');
  assert.deepEqual(exits, ['SIGKILL']);
  await until(() => runner.status().paused === 'converting', 'paused');
  assert.equal(store.job(movie, 'previews'), null, 'nothing recorded for the interrupted job');
  busy = false;
  runner.kick();
  await until(() => store.job(movie, 'previews')?.status === 'done', 'the redo');
  assert.deepEqual(calls, [movie, movie]);
  await runner.stop();
  db.close();
});

test('stopping the server stops the running job', async () => {
  const { db, store, settings, lib, add } = setup();
  const movie = add({ library_id: lib('movies'), kind: 'movie' });
  let child;
  const jobs = {
    async previews(item, ctx) {
      child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
      ctx.onSpawn(child);
      await new Promise((r) => child.on('exit', r));
      throw new Error('killed');
    },
    async intros() {},
  };
  const runner = new TaskRunner({ store, settings, tools: withFfmpeg, busy: () => false, jobs, previewsDir: tempDir(), pollMs: 30, busyPollMs: 10, gapMs: 0 });
  runner.start();
  await until(() => runner.current?.proc, 'the job to start');
  await runner.stop();
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(store.job(movie, 'previews'), null, 'redone next time the server starts');
  db.close();
});

test('failures are recorded once, and a job that records nothing does not loop', async () => {
  const { db, store, settings, lib, add } = setup();
  const movies = lib('movies');
  const broken = add({ library_id: movies, kind: 'movie', title: 'Broken' });
  const silent = add({ library_id: movies, kind: 'movie', title: 'Silent' });
  const calls = [];
  const jobs = {
    async previews(item) {
      calls.push(item.id);
      if (item.id === broken) throw new Error('moov atom not found');
    },
    async intros() {},
  };
  const runner = new TaskRunner({ store, settings, tools: withFfmpeg, busy: () => false, jobs, previewsDir: tempDir(), pollMs: 30, busyPollMs: 10, gapMs: 0 });
  runner.start();
  await until(() => store.job(silent, 'previews')?.status === 'failed', 'the silent job to be failed');
  await sleep(80);
  await runner.stop();
  assert.deepEqual(calls, [broken, silent], 'each ran once');
  assert.equal(store.job(broken, 'previews').error, 'moov atom not found');
  assert.match(store.job(silent, 'previews').error, /without recording a result/);
  assert.deepEqual(runner.status().failed.map((f) => f.title).sort(), ['Broken', 'Silent']);
  db.close();
});

test('nothing runs without ffmpeg, or with both jobs switched off', async () => {
  const { db, store, settings, lib, add } = setup();
  add({ library_id: lib('movies'), kind: 'movie' });
  const calls = [];
  const jobs = { previews: async (item) => calls.push(item.id), intros: async () => {} };
  let tools = { ffmpeg: { available: false } };
  const runner = new TaskRunner({ store, settings, tools: () => tools, busy: () => false, jobs, previewsDir: tempDir(), pollMs: 20, busyPollMs: 10, gapMs: 0 });
  runner.start();
  await sleep(80);
  assert.deepEqual(calls, []);
  assert.equal(runner.status().paused, 'no-ffmpeg');
  tools = withFfmpeg();
  settings.set({ previewsEnabled: false, introDetection: false });
  runner.kick();
  await sleep(80);
  assert.deepEqual(calls, []);
  assert.equal(runner.status().paused, 'disabled');
  await runner.stop();
  db.close();
});

test('sweeping removes half-made and orphaned preview folders only', () => {
  const { db, store, settings, lib, add, row } = setup();
  const movies = lib('movies');
  const kept = add({ library_id: movies, kind: 'movie' });
  const gone = add({ library_id: movies, kind: 'movie' });
  done(store, row(kept));
  const dir = tempDir();
  for (const name of [String(kept), String(gone), `${kept}.tmp`, '999']) fs.mkdirSync(path.join(dir, name));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ours');
  const runner = new TaskRunner({ store, settings, tools: withFfmpeg, busy: () => false, jobs: {}, previewsDir: dir });
  runner.sweep();
  assert.deepEqual(fs.readdirSync(dir).sort(), [String(kept), 'notes.txt'].sort());
  db.close();
});

test('a title removed while its previews are made leaves nothing behind', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const { db, store, lib, add, row } = setup();
  const file = path.join(tempDir(), 'Soon Gone (2020).mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=2:duration=60', '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', file]);
  const id = add({ library_id: lib('movies'), kind: 'movie', path: file, duration: 60, media: JSON.stringify({ video: { width: 160, height: 90 } }) });
  const dir = tempDir();
  const jobs = makeJobs({ store, config: { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', previewsDir: dir }, tools: withFfmpeg });
  const item = row(id);
  // The library scan removes the title while ffmpeg is still working.
  await jobs.previews(item, { signal: new AbortController().signal, onSpawn: () => db.run('DELETE FROM items WHERE id = ?', id) });
  assert.deepEqual(fs.readdirSync(dir), [], 'no folder for a title that no longer exists');
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/tasks.test.js`
Expected: FAIL with `Cannot find module '.../src/extras/jobs.js'`.

- [ ] **Step 3: Write the job wiring**

Create `src/extras/jobs.js`:

```js
// The two background jobs, wired to ffmpeg, the database and the previews folder.
import { parseJson } from '../db.js';
import { generatePreviews, removePreviews } from './previews.js';
import { runIntroJob } from './intros.js';

export function makeJobs({ store, config, tools }) {
  return {
    async previews(item, { signal, onSpawn }) {
      const filters = tools()?.filters || {};
      const layout = await generatePreviews({
        ffmpegPath: config.ffmpegPath,
        dir: config.previewsDir,
        item,
        media: parseJson(item.media, null),
        hdrFilters: Boolean(filters.zscale && filters.tonemap),
        onSpawn,
      });
      signal?.throwIfAborted();
      // False when the title was removed while ffmpeg worked: don't keep its pictures.
      if (!store.saveJob(item, 'previews', { status: 'done', data: layout })) removePreviews(config.previewsDir, item.id);
    },
    intros(seasonId, { signal, onSpawn }) {
      return runIntroJob({ seasonId, store, ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath, signal, onSpawn });
    },
  };
}
```

- [ ] **Step 4: Write the runner**

Create `src/tasks.js`:

```js
// Background jobs: seek-bar previews and intro finding. One job at a time, ffmpeg
// at low CPU priority, and nothing runs while someone watches a video the server
// is converting. A job that's running when a conversion starts is stopped and
// redone later.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('tasks');
const LOW_PRIORITY = 10; // nice 10; "below normal" on Windows

export class TaskRunner {
  /**
   * @param {object} o
   * @param {import('./extras/store.js').ExtrasStore} o.store
   * @param {{ all(): object }} o.settings
   * @param {() => object} o.tools   the current ffmpeg detection result
   * @param {() => boolean} o.busy   true while a converted video is playing
   * @param {{ previews(item, ctx): Promise, intros(seasonId, ctx): Promise }} o.jobs  ctx = { signal, onSpawn }
   * @param {string} o.previewsDir
   */
  constructor({ store, settings, tools, busy, jobs, previewsDir, pollMs = 5 * 60 * 1000, busyPollMs = 5000, gapMs = 200 }) {
    Object.assign(this, { store, settings, tools, busy, jobs, previewsDir, pollMs, busyPollMs, gapMs });
    this.priority = new Set();
    this.current = null;
    this.stopped = true;
    this.wake = null;
    this.loopDone = Promise.resolve();
    this.lastDone = null; // key of the last job that finished without an error
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.sweep();
    this.loopDone = this.loop();
  }

  async stop() {
    this.stopped = true;
    this.abortCurrent();
    this.kick();
    await this.loopDone;
  }

  /** Look for work now instead of at the next poll. */
  kick() {
    this.lastDone = null;
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  /** A newly scanned title: its jobs go before the backlog. */
  prioritise(item) {
    if (!item || !['movie', 'episode'].includes(item.kind)) return;
    this.priority.add(item.id);
    if (item.kind === 'episode' && item.parent_id) this.store.resetSeasonNone(item.parent_id);
    this.kick();
  }

  /** Playback started: if a conversion is now playing, stop the running job. */
  interruptIfBusy() {
    if (this.current && this.busy()) this.abortCurrent();
  }

  abortCurrent() {
    const c = this.current;
    if (!c) return;
    c.controller.abort();
    try {
      c.proc?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }

  status() {
    const s = this.settings.all();
    const c = this.current;
    let paused = null;
    if (!this.tools()?.ffmpeg?.available) paused = 'no-ffmpeg';
    else if (!s.previewsEnabled && !s.introDetection) paused = 'disabled';
    else if (!c && this.busy()) paused = 'converting';
    return {
      running: c ? { job: c.job, itemId: c.itemId, title: c.title, startedAt: c.startedAt } : null,
      paused,
      queued: this.store.pendingCounts(),
      failed: this.store.failed(20),
    };
  }

  /** Delete half-written preview folders, and previews of titles that are gone. */
  sweep() {
    let entries;
    try {
      entries = fs.readdirSync(this.previewsDir, { withFileTypes: true });
    } catch {
      return;
    }
    const keep = this.store.previewIds();
    const working = this.current?.job === 'previews' ? this.current.itemId : null;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const id = Number(e.name.replace(/\.tmp$/, ''));
      if (id === working) continue;
      if (e.name.endsWith('.tmp') || !keep.has(id)) fs.rmSync(path.join(this.previewsDir, e.name), { recursive: true, force: true });
    }
  }

  next() {
    const s = this.settings.all();
    const pick = (only) => {
      if (s.introDetection) {
        const seasonId = this.store.nextIntroSeason(only);
        if (seasonId != null) {
          const ids = this.store.pendingIntroEpisodes(seasonId).map((e) => e.id);
          return { key: `intros:${seasonId}:${ids.join(',')}`, job: 'intros', seasonId, itemId: seasonId, title: this.store.seasonLabel(seasonId) };
        }
      }
      if (s.previewsEnabled) {
        const item = this.store.nextPreviewItem(only);
        if (item) return { key: `previews:${item.id}:${item.size}:${item.mtime}`, job: 'previews', item, itemId: item.id, title: this.store.itemLabel(item) };
      }
      return null;
    };
    if (this.priority.size) {
      const first = pick([...this.priority]);
      if (first) return first;
      this.priority.clear();
    }
    return pick(null);
  }

  idle(ms) {
    this.lastDone = null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async loop() {
    while (!this.stopped) {
      try {
        const s = this.settings.all();
        if (!this.tools()?.ffmpeg?.available || (!s.previewsEnabled && !s.introDetection)) {
          await this.idle(this.pollMs);
          continue;
        }
        if (this.busy()) {
          await this.idle(this.busyPollMs);
          continue;
        }
        const task = this.next();
        if (!task) {
          await this.idle(this.pollMs);
          continue;
        }
        if (task.key === this.lastDone) {
          // It ran, didn't fail, and is still wanted: it recorded nothing. Don't spin on it.
          this.recordFailure(task, new Error('The job finished without recording a result.'));
          this.lastDone = null;
          continue;
        }
        await this.runTask(task);
      } catch (err) {
        log.error(`Background tasks: ${err.stack || err.message}`);
        if (!this.stopped) await this.idle(this.busyPollMs);
      }
      if (!this.stopped && this.gapMs) await new Promise((r) => setTimeout(r, this.gapMs));
    }
  }

  async runTask(task) {
    const controller = new AbortController();
    this.current = { ...task, startedAt: Date.now(), controller, proc: null };
    const ctx = {
      signal: controller.signal,
      onSpawn: (proc) => {
        if (this.current?.controller === controller) this.current.proc = proc;
        try {
          os.setPriority(proc.pid, LOW_PRIORITY);
        } catch {
          /* not allowed here; it still runs */
        }
        if (controller.signal.aborted) proc.kill('SIGKILL');
      },
    };
    try {
      if (task.job === 'previews') await this.jobs.previews(task.item, ctx);
      else await this.jobs.intros(task.seasonId, ctx);
      this.lastDone = task.key;
    } catch (err) {
      this.lastDone = null;
      if (controller.signal.aborted) log.info(`Stopped "${task.title}" for now; it will be redone later.`);
      else {
        log.warn(`${task.job === 'previews' ? 'Previews' : 'Intro check'} for "${task.title}" failed: ${err.message}`);
        this.recordFailure(task, err);
      }
    } finally {
      this.current = null;
    }
  }

  recordFailure(task, err) {
    if (task.job === 'previews') this.store.saveJob(task.item, 'previews', { status: 'failed', error: err.message });
    else for (const ep of this.store.pendingIntroEpisodes(task.seasonId)) this.store.saveJob(ep, 'intros', { status: 'failed', error: err.message });
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/tasks.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Checkpoint**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/*.test.js`
Expected: all pass. The runner isn't wired into the server yet, so the existing tests are unaffected.

---

### Task 6: Wiring it into the server, and the API

**Files:**
- Modify: `src/library/probe.js`: `detectTools()` reports `filters`
- Create: `src/api/extras.js`
- Modify: `src/app.js` (imports, the core set-up after `core.plugins = …`, `settings.onChange`, `start()`, `stop()`)
- Modify: `src/api/playback.js`: the `return { … }` of `POST /api/items/:id/playback`
- Modify: `src/api/library.js`: `GET /api/items/:id`, the `if (row.kind === 'movie' || row.kind === 'episode')` block
- Test: `test/extras-api.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–5, plus `library.get`, `library.canSee`, `sendFile(req, res, file, { cacheControl })` and the `hooks` events `item:added` (`{ item }`), `scan:complete` and `playback:start`.
- Produces (HTTP):
  - `GET /api/items/:id/previews/:n` returns `image/jpeg`, cached `private, max-age=31536000, immutable`, or 404.
  - `POST /api/items/:id/playback`: the response gains `previews` (manifest or null) and `markers` (`{ intro, credits }`, each `{start,end}` or null).
  - `GET /api/items/:id` (episode, admin viewer): the response gains `markers` (`{ intro, credits }` with `source`/`none`).
  - `PUT /api/items/:id/markers/intro` with body `{ start, end, applyToSeason? }` or `{ none: true, applyToSeason? }` (admin). Returns `markers(ep)`.
  - `DELETE /api/items/:id/markers/intro` (admin) goes back to automatic and requeues the season.
  - `POST /api/items/:id/markers/detect` (admin) drops the audio marker and requeues the season.
  - `GET /api/admin/tasks` returns `runner.status()`; `POST /api/admin/tasks/retry` returns `{ retried }`.
  - `core.extras` (ExtrasStore) and `core.tasks` (TaskRunner) on the app core.
  - `createApp({ backgroundTasks: false })` doesn't start the runner (for tests that don't want it).
  - `detectTools()` result gains `filters: { zscale: boolean, tonemap: boolean }`.

- [ ] **Step 1: Write the failing tests**

Create `test/extras-api.test.js`:

```js
// End to end: scan a library, let the background jobs run, then check previews
// and intro markers through the API, with the access rules for kids and non-admins.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, makeEpisode, startNodeFlix, client, waitForScan } from './helpers.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
const CAPS = { caps: { video: ['h264'], audio: ['aac'], containers: ['mp4'] } };
let nf;
let admin;
let viewer;
const ids = {};

async function waitForTasks(c, ms = 90000) {
  const end = Date.now() + ms;
  for (;;) {
    const t = (await c.get('/api/admin/tasks')).data;
    if (!t.running && !t.queued.previews && !t.queued.intros) return t;
    if (Date.now() > end) throw new Error(`background tasks did not finish: ${JSON.stringify(t)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
/** Start playback, then stop it at once (a converting session would pause the jobs). */
async function play(c, id) {
  const r = await c.post(`/api/items/${id}/playback`, CAPS);
  if (r.data?.sessionId) await c.post(`/api/playback/${r.data.sessionId}/stop`, {});
  return r;
}
const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) <= 0.5, `${what}: ${actual} is not within 0.5 s of ${expected}`);

before(async () => {
  if (!hasFfmpeg) return;
  const m = path.join(media, 'Movies');
  makeVideo(path.join(m, "Bob's Whānau Film (2020)", "Bob's Whānau Film (2020).mp4"), { seconds: 40 });
  const s1 = path.join(media, 'TV', 'Theme Show', 'Season 01');
  makeEpisode(path.join(s1, 'Theme.Show.S01E01.mp4'), { themeAt: 6, seed: 1 });
  makeEpisode(path.join(s1, 'Theme.Show.S01E02.mkv'), { themeAt: 17, seed: 3, audioCodec: 'mp3', gain: 0.5, lowpass: 3000 });
  makeEpisode(path.join(s1, 'Theme.Show.S01E03.mkv'), { seed: 5, chapters: [[0, 5, 'Recap'], [5, 20, 'Opening'], [20, 80, 'Part 1'], [80, 100, 'End Credits']] });

  nf = await startNodeFlix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'admin', password: 'password123' });
  ids.movies = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [m] })).data.id;
  ids.tv = (await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [path.join(media, 'TV')] })).data.id;
  await waitForScan(admin);
  await waitForTasks(admin);
  const movie = (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items[0];
  ids.movie = movie.id;
  ids.movieTitle = movie.title;
  const show = (await admin.get(`/api/libraries/${ids.tv}/items`)).data.items[0];
  const season = (await admin.get(`/api/items/${show.id}`)).data.seasons[0];
  const eps = (await admin.get(`/api/items/${season.id}`)).data.episodes;
  [ids.e1, ids.e2, ids.e3] = eps.map((e) => e.id);

  await admin.post('/api/users', { username: 'viewer', password: 'password123' });
  viewer = client(nf.base);
  await viewer.post('/api/auth/login', { username: 'viewer', password: 'password123' });
});

after(async () => {
  await nf?.app.stop();
});

test('previews are made after a scan and follow the title’s access rules', { skip }, async () => {
  const r = await play(admin, ids.movie);
  assert.equal(r.status, 200);
  const p = r.data.previews;
  assert.deepEqual([p.interval, p.width, p.columns, p.rows, p.count, p.sheets], [5, 320, 10, 10, 8, 1]);
  assert.deepEqual(r.data.markers, { intro: null, credits: null });
  const img = await admin.raw(p.url.replace('{n}', '1'));
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.match(img.headers.get('cache-control'), /immutable/);
  assert.equal((await admin.raw(p.url.replace('{n}', '2'))).status, 404, 'only one sheet');
  assert.equal((await admin.raw(`/api/items/${ids.movie}/previews/abc`)).status, 404);
  assert.equal((await viewer.raw(p.url.replace('{n}', '1'))).status, 200, 'any viewer allowed to see the title');
  assert.deepEqual((await admin.get('/api/admin/tasks')).data.failed, []);
});

test('intros come from the shared theme tune, or from chapters', { skip }, async () => {
  const m1 = (await play(admin, ids.e1)).data.markers;
  near(m1.intro.start, 6, 'E01 start');
  near(m1.intro.end, 26, 'E01 end');
  assert.equal(m1.credits, null);
  const m2 = (await play(admin, ids.e2)).data.markers;
  near(m2.intro.start, 17, 'E02 start');
  near(m2.intro.end, 37, 'E02 end');
  const m3 = (await play(admin, ids.e3)).data.markers;
  assert.deepEqual(m3, { intro: { start: 5, end: 20 }, credits: { start: 80, end: 100 } });

  assert.equal((await admin.get(`/api/items/${ids.e1}`)).data.markers.intro.source, 'audio', 'admins see where it came from');
  assert.equal((await viewer.get(`/api/items/${ids.e1}`)).data.markers, undefined, 'other people do not');
});

test('admins can correct an intro; nobody else can', { skip }, async () => {
  const url = `/api/items/${ids.e1}/markers/intro`;
  assert.equal((await viewer.put(url, { start: 1, end: 30 })).status, 403);
  let r = await admin.put(url, { start: 30, end: 20 });
  assert.deepEqual([r.status, r.data.error], [400, 'The intro must end after it starts.']);
  assert.equal((await admin.put(url, { start: 0, end: 500 })).status, 400, 'past the end of the episode');
  assert.equal((await admin.put(url, {})).status, 400);

  r = await admin.put(url, { start: 10, end: 40, applyToSeason: true });
  assert.deepEqual(r.data.intro, { start: 10, end: 40, source: 'manual' });
  for (const id of [ids.e2, ids.e3]) assert.deepEqual((await admin.get(`/api/items/${id}`)).data.markers.intro, { start: 10, end: 40, source: 'manual' });

  r = await admin.put(url, { none: true });
  assert.deepEqual(r.data.intro, { none: true, source: 'manual' });
  assert.equal((await play(admin, ids.e1)).data.markers.intro, null, 'no Skip button');

  r = await admin.del(url);
  assert.equal(r.data.intro, null);
  await waitForTasks(admin);
  const again = (await admin.get(`/api/items/${ids.e1}`)).data.markers.intro;
  assert.equal(again.source, 'audio', 'found again automatically');
  near(again.start, 6, 'E01 start');
  assert.equal((await admin.get(`/api/items/${ids.e2}`)).data.markers.intro.source, 'manual', 'hand-set times elsewhere are kept');

  assert.equal((await admin.post(`/api/items/${ids.movie}/markers/detect`, {})).status, 404, 'movies have no intro markers');
});

test('the task status shows failures, and they can be retried', { skip }, async () => {
  assert.equal((await viewer.get('/api/admin/tasks')).status, 403);
  const row = nf.app.core.db.get('SELECT * FROM items WHERE id = ?', ids.movie);
  nf.app.core.extras.saveJob(row, 'previews', { status: 'failed', error: 'moov atom not found' });
  let t = (await admin.get('/api/admin/tasks')).data;
  assert.match(ids.movieTitle, /Whānau/, 'the awkward file name was scanned');
  assert.deepEqual(t.failed.map((f) => [f.title, f.error]), [[ids.movieTitle, 'moov atom not found']]);
  assert.deepEqual((await admin.post('/api/admin/tasks/retry', {})).data, { retried: 1 });
  t = await waitForTasks(admin);
  assert.deepEqual(t.failed, []);
  assert.ok((await play(admin, ids.movie)).data.previews, 'made again');
  const tools = (await admin.get('/api/admin/dashboard')).data.tools;
  assert.equal(typeof tools.filters.zscale, 'boolean');
});

test('a kids profile cannot fetch pictures from titles it cannot see', { skip }, async () => {
  const url = (await play(admin, ids.movie)).data.previews.url.replace('{n}', '1');
  const kidId = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10 })).data.id;
  const kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'admin', password: 'password123' });
  await kid.post(`/api/profiles/${kidId}/select`, {});
  assert.equal((await kid.raw(url)).status, 404, 'unrated title: hidden, so 404, not 403');
  assert.equal((await kid.put(`/api/items/${ids.e1}/markers/intro`, { none: true })).status, 403);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/extras-api.test.js`
Expected: FAIL. `before` hangs and then throws on `/api/admin/tasks`, which returns 404 `Unknown API endpoint` (`t.queued` is undefined).

- [ ] **Step 3: Report the HDR filters**

In `src/library/probe.js` `detectTools()`, before `return { ffmpeg, ffprobe, encoders };`, add the following, and return `filters` too:

```js
  // Used to tone-map HDR films for seek-bar previews, when this ffmpeg has them.
  let filters = { zscale: false, tonemap: false };
  if (ffmpeg.available) {
    try {
      const out = (await run(config.ffmpegPath, ['-hide_banner', '-filters'], { timeout: 10000 })).toString();
      filters = { zscale: /\szscale\s/.test(out), tonemap: /\stonemap\s/.test(out) };
    } catch {
      /* ignore */
    }
  }
  return { ffmpeg, ffprobe, encoders, filters };
```

- [ ] **Step 4: Write the routes**

Create `src/api/extras.js`:

```js
// Seek-bar preview pictures, intro corrections, and the background task status.
import path from 'node:path';
import { HttpError } from '../http/router.js';
import { sendFile } from '../http/static.js';

export function registerExtrasRoutes(r, core) {
  const { db, library, extras, tasks, config } = core;
  const admin = { auth: 'admin' };

  r.get('/api/items/:id/previews/:n', async (ctx) => {
    const item = library.get(ctx.params.id);
    if (!item || !library.canSee(ctx.viewer, item)) throw new HttpError(404, 'Not found');
    const manifest = extras.previewManifest(item);
    const n = Number(ctx.params.n);
    if (!manifest || !Number.isInteger(n) || n < 1 || n > manifest.sheets) throw new HttpError(404, 'No preview here');
    const ok = await sendFile(ctx.req, ctx.res, path.join(config.previewsDir, String(item.id), `${n}.jpg`), { cacheControl: 'private, max-age=31536000, immutable' });
    if (!ok) throw new HttpError(404, 'No preview here');
  });

  const episode = (ctx) => {
    const item = library.get(ctx.params.id);
    if (!item || item.kind !== 'episode' || !library.canSee(ctx.viewer, item)) throw new HttpError(404, 'Episode not found');
    return item;
  };
  const restOfSeason = (ep) => db.all("SELECT id, duration FROM items WHERE parent_id = ? AND kind = 'episode'", ep.parent_id);

  r.put(
    '/api/items/:id/markers/intro',
    async (ctx) => {
      const ep = episode(ctx);
      const body = await ctx.body();
      const targets = body.applyToSeason ? restOfSeason(ep) : [ep];
      if (body.none) {
        for (const t of targets) extras.setMarker(t.id, 'intro', { start: null, end: null, source: 'manual' });
        return extras.markers(ep.id);
      }
      const start = Number(body.start);
      const end = Number(body.end);
      if (body.start == null || body.end == null || !Number.isFinite(start) || !Number.isFinite(end)) throw new HttpError(400, 'Enter when the intro starts and ends.');
      if (start < 0) throw new HttpError(400, "The intro can't start before the episode does.");
      if (end <= start) throw new HttpError(400, 'The intro must end after it starts.');
      if (ep.duration && end > ep.duration) throw new HttpError(400, 'The intro must end before the episode does.');
      for (const t of targets) {
        if (t.duration && end > t.duration) continue; // too short for these times; leave it alone
        extras.setMarker(t.id, 'intro', { start, end, source: 'manual' });
      }
      return extras.markers(ep.id);
    },
    admin,
  );

  r.delete(
    '/api/items/:id/markers/intro',
    (ctx) => {
      const ep = episode(ctx);
      extras.deleteMarker(ep.id, 'intro');
      extras.clearIntroJobs(ep.parent_id);
      tasks.kick();
      return extras.markers(ep.id);
    },
    admin,
  );

  r.post(
    '/api/items/:id/markers/detect',
    (ctx) => {
      const ep = episode(ctx);
      extras.deleteMarker(ep.id, 'intro', { sources: ['audio'] });
      extras.clearIntroJobs(ep.parent_id);
      tasks.kick();
      return extras.markers(ep.id);
    },
    admin,
  );

  r.get('/api/admin/tasks', () => tasks.status(), admin);
  r.post(
    '/api/admin/tasks/retry',
    () => {
      const retried = extras.retryFailed();
      tasks.kick();
      return { retried };
    },
    admin,
  );
}
```

- [ ] **Step 5: Wire the store and runner into the app**

In `src/app.js`:

1. Add the imports after `import { registerAdminRoutes } from './api/admin.js';`:

```js
import { registerExtrasRoutes } from './api/extras.js';
import { ExtrasStore } from './extras/store.js';
import { makeJobs } from './extras/jobs.js';
import { TaskRunner } from './tasks.js';
```

2. After `core.plugins = new PluginManager(core);`, add:

```js
  core.extras = new ExtrasStore(db);
  core.tasks = new TaskRunner({
    store: core.extras,
    settings,
    tools: () => core.tools,
    // Converting video needs the CPU; converting music is light enough to share it.
    busy: () => [...core.playback.sessions.values()].some((s) => s.mode !== 'direct' && !s.audioOnly),
    jobs: makeJobs({ store: core.extras, config, tools: () => core.tools }),
    previewsDir: config.previewsDir,
  });
  hooks.on('item:added', ({ item }) => core.tasks.prioritise(item));
  hooks.on('scan:complete', () => {
    core.tasks.sweep();
    core.tasks.kick();
  });
  hooks.on('playback:start', () => core.tasks.interruptIfBusy());
```

3. After `registerAdminRoutes(router, core);` add `registerExtrasRoutes(router, core);`.

4. In the `settings.onChange` callback, add:

```js
    if ('previewsEnabled' in changed || 'introDetection' in changed) core.tasks.kick();
```

5. In `start()`, after `core.scanner.schedule();` add:

```js
    if (overrides.backgroundTasks !== false) core.tasks.start();
```

6. In `stop()`, make this the first line:

```js
    await core.tasks.stop(); // before the database closes
```

- [ ] **Step 6: Add previews and markers to the playback response**

In `src/api/playback.js`, in the object returned by `POST /api/items/:id/playback`, add after `next: next ? serializeItem(next) : null,`:

```js
      previews: item.kind === 'track' ? null : core.extras.previewManifest(item),
      markers: item.kind === 'episode' ? core.extras.playbackMarkers(item.id) : { intro: null, credits: null },
```

- [ ] **Step 7: Show admins the markers on episode pages**

In `src/api/library.js` `GET /api/items/:id`, inside `if (row.kind === 'movie' || row.kind === 'episode') {`, after `out.subtitles = listSubtitles(row, config);`, add:

```js
      // Admins can see (and fix) where the intro is; the Skip button itself comes with playback.
      if (row.kind === 'episode' && ctx.user.role === 'admin' && !ctx.profile?.kids) out.markers = core.extras.markers(row.id);
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/extras-api.test.js`
Expected: PASS, 5 tests, in about 20–40 s (most of it is `before`: making the files, scanning and the jobs).

- [ ] **Step 9: Checkpoint: the whole suite, now with the runner live in every server**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/*.test.js`
Expected: all pass. Every test server now runs background jobs on its tiny test clips. If an older test becomes flaky, **do not turn the runner off to hide it**: find what it collides with (usually a playback session left open, which pauses the runner) and fix that.

---
### Task 7: Settings: two switches, a library checkbox, the dashboard card, the profile option

**Files:**
- Modify: `src/api/library.js`: `POST /api/libraries` and `PUT /api/libraries/:id`, plus a `cleanOptions()` helper above `registerLibraryRoutes`
- Modify: `src/api/serialize.js`: `serializeLibrary`
- Modify: `src/api/account.js`: `PREF_KEYS`
- Modify: `public/js/views/settings.js`: `profileTab`, `dashboardTab`, `libraryDialog`, `serverTab`
- Modify: `public/css/app.css`: add `.check[hidden]`
- Create (dev only): `/home/claude/devtools/restart-dev.sh`
- Test: `test/extras-settings.test.js`

**Interfaces:**
- Consumes: `GET /api/admin/tasks` and `POST /api/admin/tasks/retry` (Task 6); settings `previewsEnabled` and `introDetection` (Task 1); `core.tasks.kick()` (Task 6).
- Produces:
  - Libraries accept `options: { previews: boolean }`, and `serializeLibrary` returns `options` (always `{ previews }`, default `true`).
  - The profile pref `skipIntros: boolean`, which Task 9's player reads as `prefs.skipIntros === true`.
  - `/home/claude/devtools/restart-dev.sh`: restarts the dev server and mocks, and exits 0 once `/api/status` answers.

- [ ] **Step 1: Write the failing tests**

Create `test/extras-settings.test.js`:

```js
// The settings behind the background jobs: per-library opt-out, the two server
// switches, and each profile's "skip intros automatically".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir, startNodeFlix, client } from './helpers.js';

let nf;
let admin;
before(async () => {
  nf = await startNodeFlix({}, { backgroundTasks: false });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'admin', password: 'password123' });
});
after(async () => {
  await nf?.app.stop();
});

test('libraries can opt out of seek-bar previews', async () => {
  let r = await admin.post('/api/libraries', { name: 'Films', type: 'movies', paths: [tempDir()] });
  assert.deepEqual(r.data.options, { previews: true }, 'on unless switched off');
  r = await admin.post('/api/libraries', { name: 'Home videos', type: 'movies', paths: [tempDir()], options: { previews: false, evil: 1 } });
  assert.deepEqual(r.data.options, { previews: false }, 'unknown options are dropped');
  const id = r.data.id;
  r = await admin.put(`/api/libraries/${id}`, { options: { previews: true } });
  assert.deepEqual(r.data.options, { previews: true });
  r = await admin.put(`/api/libraries/${id}`, { name: 'Renamed' });
  assert.deepEqual(r.data.options, { previews: true }, 'kept when not sent');
  assert.deepEqual((await admin.get('/api/libraries')).data.find((l) => l.id === id).options, { previews: true });
});

test('the two background jobs can be switched off', async () => {
  let s = (await admin.get('/api/admin/settings')).data;
  assert.deepEqual([s.previewsEnabled, s.introDetection], [true, true]);
  await admin.put('/api/admin/settings', { previewsEnabled: false, introDetection: false });
  s = (await admin.get('/api/admin/settings')).data;
  assert.deepEqual([s.previewsEnabled, s.introDetection], [false, false]);
  const paused = (await admin.get('/api/admin/tasks')).data.paused;
  assert.ok(['disabled', 'no-ffmpeg'].includes(paused), paused);
});

test('each profile can choose to skip intros automatically', async () => {
  let r = await admin.patch('/api/me', { prefs: { skipIntros: true } });
  assert.equal(r.data.profile.prefs.skipIntros, true);
  r = await admin.patch('/api/me', { prefs: { skipIntros: false } });
  assert.equal(r.data.profile.prefs.skipIntros, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/extras-settings.test.js`
Expected: FAIL. `r.data.options` is `undefined`, and `skipIntros` isn't stored.

- [ ] **Step 3: Library options on the server**

In `src/api/library.js`, add above `export function registerLibraryRoutes`:

```js
/** Library options an admin can set. Only known keys are kept, as booleans. */
function cleanOptions(input, current = {}) {
  const previews = input && typeof input === 'object' && 'previews' in input ? Boolean(input.previews) : current.previews;
  return { previews: previews ?? true };
}
```

In `POST /api/libraries`, replace the `INSERT` line with:

```js
      const res = db.run(
        'INSERT INTO libraries (name, type, paths, options, created_at) VALUES (?, ?, ?, ?, ?)',
        name,
        body.type,
        JSON.stringify(paths),
        JSON.stringify(cleanOptions(body.options)),
        Date.now(),
      );
```

In `PUT /api/libraries/:id`, replace the `UPDATE` line with:

```js
      const options = body.options != null ? cleanOptions(body.options, parseJson(lib.options, {})) : cleanOptions(null, parseJson(lib.options, {}));
      db.run('UPDATE libraries SET name = ?, paths = ?, options = ? WHERE id = ?', name, JSON.stringify(paths), JSON.stringify(options), lib.id);
      if (body.options != null) core.tasks.kick(); // previews may have just been switched on
```

In `src/api/serialize.js` `serializeLibrary`, add after `count: counts[row.id] || 0,`:

```js
    options: { previews: true, ...parseJson(row.options, {}) },
```

In `src/api/account.js` `PREF_KEYS`, add after `autoplayNext: 'boolean',`:

```js
  skipIntros: 'boolean',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/extras-settings.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: The settings screens**

In `public/js/views/settings.js`:

1. **Profile tab.** After the line `toggle('Play the next episode automatically', prefs.autoplayNext !== false, (v) => save(() => updatePrefs({ autoplayNext: v }))),` add:

```js
      toggle('Skip intros automatically', prefs.skipIntros === true, (v) => save(() => updatePrefs({ skipIntros: v }))),
```

2. **Dashboard.** Add these above `async function dashboardTab(el) {`:

```js
const TASK_PAUSED = {
  converting: 'Paused while someone watches a video the server is converting.',
  'no-ffmpeg': 'Waiting for ffmpeg. Install it to make previews and find intros.',
  disabled: 'Both are turned off in Server settings.',
};

/** What the background jobs are doing, what's left, and anything that failed. */
function backgroundSection(t, reload) {
  const now = t.running ? `${t.running.job === 'previews' ? 'Making seek-bar previews for' : 'Finding intros in'} ${t.running.title}.` : TASK_PAUSED[t.paused] || 'Nothing running right now.';
  const waiting = [
    t.queued.previews ? `${t.queued.previews} ${t.queued.previews === 1 ? 'title' : 'titles'} waiting for previews` : null,
    t.queued.intros ? `${t.queued.intros} ${t.queued.intros === 1 ? 'season' : 'seasons'} waiting for an intro check` : null,
  ].filter(Boolean);
  return section(
    'Background tasks',
    h('p', {}, now, waiting.length ? ` ${waiting.join(', ')}.` : ''),
    t.failed.length
      ? h('ul', { class: 'plain-list' }, t.failed.map((f) => h('li', {}, h('strong', {}, f.title), ` (${f.job === 'previews' ? 'previews' : 'intro check'}): `, h('span', { class: 'danger-text' }, f.error || 'failed'))))
      : null,
    t.failed.length ? button('Try again', { icon: 'refresh', onClick: async () => (await api.post('/api/admin/tasks/retry', {}), toast('Trying again'), reload()) }) : null,
  );
}
```

In `dashboardTab`'s `load()`, replace `const d = await api.get('/api/admin/dashboard');` with:

```js
    const [d, tasks] = await Promise.all([api.get('/api/admin/dashboard'), api.get('/api/admin/tasks')]);
```

and insert `backgroundSection(tasks, load),` into `body.append(…)` between the `section('Library scan', …)` and the `section('Server', …)` arguments.

3. **Library dialog.** In `libraryDialog`, after `const newPath = h('input', …);` add:

```js
  const previews = h('input', { type: 'checkbox', checked: lib?.options?.previews !== false });
  const previewsRow = h('label', { class: 'check', hidden: type.value === 'music' }, previews, h('span', {}, 'Make seek-bar previews'));
```

In the `body` built with `h('div', { class: 'stack' }, …)`, insert `previewsRow,` directly before `h('p', { class: 'hint' }, LIBRARY_HINTS[type.value]),`. Replace the `type.addEventListener('change', …)` line with:

```js
  type.addEventListener('change', () => {
    body.querySelector('.hint').textContent = LIBRARY_HINTS[type.value];
    previewsRow.hidden = type.value === 'music';
  });
```

In `onSubmit`, replace the `payload` line with:

```js
      const payload = { name: name.value.trim(), type: type.value, paths, options: { previews: previews.checked } };
```

4. **Server tab.** After `const vaapiDevice = h('input', { value: s.vaapiDevice });` add:

```js
  const previewsOn = h('input', { type: 'checkbox', checked: s.previewsEnabled });
  const introsOn = h('input', { type: 'checkbox', checked: s.introDetection });
```

In `form`, insert this section after the `section('Playback & transcoding', …)` argument, before `h('div', { class: 'actions sticky-actions' }, …)`:

```js
    section(
      'Background tasks',
      h('p', { class: 'muted' }, 'These run one at a time at low priority, and wait while someone watches a video the server is converting.'),
      h('label', { class: 'check' }, previewsOn, h('span', {}, 'Seek-bar previews: small pictures above the seek bar (a few MB per film)')),
      h('label', { class: 'check' }, introsOn, h('span', {}, 'Find TV intros, so viewers can skip them')),
    ),
```

In the `api.put('/api/admin/settings', { … })` payload, add after `vaapiDevice: vaapiDevice.value.trim(),`:

```js
        previewsEnabled: previewsOn.checked,
        introDetection: introsOn.checked,
```

In `public/css/app.css`, after the `.check { display: inline-flex; … }` rule, add:

```css
.check[hidden] { display: none; }
```

- [ ] **Step 6: A restart script for the dev server**

Create `/home/claude/devtools/restart-dev.sh` and run `chmod +x` on it:

```sh
#!/bin/sh
# Restart the NodeFlix dev server and the OpenSubtitles mock (which resets its quota),
# and start the TMDB mock if it isn't running. Kills by PID: never `pkill -f`, which
# also matches the shell running it.
for pat in 'node --disable-warning=ExperimentalWarning server.js' 'mock-os.mjs'; do
  for pid in $(ps -eo pid=,args= | grep -F "$pat" | grep -v grep | awk '{print $1}'); do kill "$pid"; done
done
sleep 1
if ! ps -eo args= | grep -F mock-tmdb.mjs | grep -qv grep; then
  nohup node /home/claude/devtools/mock-tmdb.mjs > /tmp/mock-tmdb.log 2>&1 &
fi
nohup node /home/claude/devtools/mock-os.mjs > /tmp/mock-os.log 2>&1 &
nohup /home/claude/devtools/run-dev.sh > /tmp/nf-dev.log 2>&1 &
for i in $(seq 1 50); do
  curl -s -o /dev/null http://127.0.0.1:8787/api/status && exit 0
  sleep 0.2
done
echo "The dev server did not start; see /tmp/nf-dev.log" >&2
exit 1
```

- [ ] **Step 7: Check the screens in a browser**

Run: `sh /home/claude/devtools/restart-dev.sh && node /home/claude/devtools/regress.mjs`
Expected: `38/38 PASS`, with no new console errors; CSP messages about the mock TMDB images are known and fine. The new controls are checked properly in Task 11.

- [ ] **Step 8: Checkpoint**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/*.test.js`
Expected: all pass.

---

### Task 8: The preview bubble and remote scrubbing in the player

**Files:**
- Create: `public/js/scrub.js`
- Create: `public/js/seekpreview.js`
- Modify: `public/js/views/player.js` (imports; the `seek-track` element on line 57; after `totalDuration` on line 93; `startSession`; the `seek` input/change listeners; `onKey`; `cleanupFn`)
- Modify: `public/css/app.css`: add the `.seek-preview` rules after the `.seekbar:focus-visible::-webkit-slider-runnable-track` rule
- Test: `test/scrub.test.js`

**Interfaces:**
- Consumes: `tileFor(manifest, t)` (Task 2, `public/js/previews.js`); `session.previews` from the playback response (Task 6).
- Produces:
  - `public/js/scrub.js`:
    - `export const STEPS`, `export const COMMIT_AFTER_MS = 1000`
    - `class Scrubber({ duration: () => number })` with `active`, `target`, `press(dir, { from, now, repeat }) → target`, `due(now) → boolean`, `commit() → number|null` and `cancel() → boolean`
  - `public/js/seekpreview.js`: `seekPreview(trackEl) → { el, setManifest(m), show(t, total), hide() }`
  - In the player: `bubble`, `scrubber`, `commitScrub()`, `cancelScrub()`, and a `scrubbing` flag that stays true while a remote scrub is in progress (Task 9 reads `scrubbing`).

- [ ] **Step 1: Write the failing tests**

Create `test/scrub.test.js`:

```js
// Scrubbing with a TV remote: presses move a marker, the video jumps on OK or
// after a second's pause, and holding the button speeds it up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scrubber, COMMIT_AFTER_MS } from '../public/js/scrub.js';

test('presses move a marker; the video only jumps on OK or after a pause', () => {
  const s = new Scrubber({ duration: () => 600 });
  assert.equal(s.press(1, { from: 100, now: 0 }), 110);
  assert.equal(s.press(1, { from: 999, now: 400 }), 120, 'later presses start from the marker, not the video');
  assert.equal(s.press(-1, { from: 999, now: 800 }), 110);
  assert.equal(COMMIT_AFTER_MS, 1000);
  assert.equal(s.due(800 + COMMIT_AFTER_MS - 1), false);
  assert.equal(s.due(800 + COMMIT_AFTER_MS), true);
  assert.equal(s.commit(), 110);
  assert.equal(s.active, false);
  assert.equal(s.commit(), null, 'nothing left to jump to');
});

test('holding the button: 10 s steps, 30 s after 1.5 s, 60 s after 4 s', () => {
  const s = new Scrubber({ duration: () => 7200 });
  const steps = [];
  let last = 1000;
  for (let now = 0; now <= 5000; now += 100) {
    const t = s.press(1, { from: 1000, now, repeat: now > 0 });
    steps.push(t - last);
    last = t;
  }
  assert.deepEqual([steps[0], steps[14], steps[15], steps[39], steps[40]], [10, 10, 30, 30, 60]);
});

test('quick separate presses (remotes that do not repeat keys) count as holding', () => {
  const s = new Scrubber({ duration: () => 7200 });
  let t = 0;
  for (let now = 0; now <= 1600; now += 200) t = s.press(1, { from: 0, now });
  assert.equal(t, 8 * 10 + 30);
});

test('turning round, or pausing, starts slow again', () => {
  const s = new Scrubber({ duration: () => 7200 });
  for (let now = 0; now <= 2000; now += 100) s.press(1, { from: 0, now, repeat: now > 0 });
  const before = s.target;
  assert.equal(s.press(-1, { from: 0, now: 2100, repeat: true }), before - 10);
  s.commit();
  s.press(1, { from: 500, now: 10000 });
  assert.equal(s.press(1, { from: 500, now: 10600 }), 520);
});

test('stays inside the video, and Back cancels', () => {
  const s = new Scrubber({ duration: () => 100 });
  assert.equal(s.press(-1, { from: 5, now: 0 }), 0);
  for (let i = 1; i <= 20; i++) s.press(1, { from: 5, now: i * 1000 });
  assert.equal(s.target, 99, 'never past the last second');
  assert.equal(s.cancel(), true);
  assert.equal(s.active, false);
  assert.equal(s.cancel(), false);
  const unknown = new Scrubber({ duration: () => 0 });
  assert.equal(unknown.press(1, { from: 50, now: 0 }), 60, 'length not known yet: no upper limit');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/scrub.test.js`
Expected: FAIL with `Cannot find module '.../public/js/scrub.js'`.

- [ ] **Step 3: Write the scrubber**

Create `public/js/scrub.js`:

```js
// Scrubbing the seek bar with a remote: arrow presses move a marker (with a
// preview picture) and the video only jumps when you press OK or stop pressing.
// That also means one ffmpeg restart per scrub on converted streams, instead of
// one per press. Pure: the player passes the time in, so this is easy to test.

// [held for at least (ms), seconds per press], longest hold first.
export const STEPS = [
  [4000, 60],
  [1500, 30],
  [0, 10],
];
export const COMMIT_AFTER_MS = 1000;
const HOLD_GAP_MS = 250; // presses closer together than this count as holding the button

export class Scrubber {
  constructor({ duration = () => 0 } = {}) {
    this.duration = duration;
    this.reset();
  }

  reset() {
    this.active = false;
    this.target = 0;
    this.dir = 0;
    this.heldSince = 0;
    this.lastPress = -Infinity;
  }

  /** An arrow press: `dir` is −1 or +1, `from` the playing position when a scrub begins. */
  press(dir, { from, now, repeat = false }) {
    if (!this.active) {
      this.active = true;
      this.target = from;
    }
    const held = dir === this.dir && (repeat || now - this.lastPress < HOLD_GAP_MS);
    if (!held) this.heldSince = now;
    this.dir = dir;
    this.lastPress = now;
    const step = STEPS.find(([ms]) => now - this.heldSince >= ms)[1];
    const total = this.duration();
    const max = total > 0 ? Math.max(0, total - 1) : Infinity;
    this.target = Math.max(0, Math.min(max, this.target + dir * step));
    return this.target;
  }

  /** True once the viewer has stopped pressing for long enough. */
  due(now) {
    return this.active && now - this.lastPress >= COMMIT_AFTER_MS;
  }

  /** Finish: the time to jump to, or null if there's no scrub in progress. */
  commit() {
    if (!this.active) return null;
    const t = this.target;
    this.reset();
    return t;
  }

  cancel() {
    const was = this.active;
    this.reset();
    return was;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/scrub.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the preview bubble**

Create `public/js/seekpreview.js`:

```js
// The picture-and-time bubble above the player's seek bar.
import { h, formatClock } from './dom.js';
import { tileFor } from './previews.js';

export function seekPreview(track) {
  const img = h('div', { class: 'seek-preview-img' });
  const time = h('span', { class: 'seek-preview-time' });
  const el = h('div', { class: 'seek-preview', hidden: true, 'aria-hidden': 'true' }, img, time);
  track.append(el);
  let manifest = null;
  const loaded = new Set();
  const preload = (url) => {
    if (!url || loaded.has(url)) return;
    loaded.add(url);
    new Image().src = url;
  };

  return {
    el,
    setManifest(m) {
      manifest = m || null;
      el.classList.toggle('has-image', Boolean(manifest));
    },
    show(t, total) {
      el.hidden = false;
      time.textContent = formatClock(t);
      const tile = tileFor(manifest, t);
      if (tile) {
        const scale = (img.clientWidth || tile.width) / tile.width;
        img.style.aspectRatio = `${tile.width} / ${tile.height}`;
        img.style.backgroundImage = `url("${tile.url}")`;
        img.style.backgroundSize = `${tile.sheetWidth * scale}px ${tile.sheetHeight * scale}px`;
        img.style.backgroundPosition = `${-tile.x * scale}px ${-tile.y * scale}px`;
        preload(tile.url);
        // The sheets either side, so scrubbing across a sheet boundary doesn't flash.
        const perSheet = manifest.interval * manifest.columns * manifest.rows;
        preload(tileFor(manifest, t + perSheet)?.url);
        preload(tileFor(manifest, t - perSheet)?.url);
      }
      const pct = total > 0 ? Math.max(0, Math.min(1, t / total)) : 0;
      const half = el.offsetWidth / 2;
      const width = track.clientWidth;
      el.style.left = `${Math.max(half, Math.min(width - half, pct * width))}px`;
    },
    hide() {
      el.hidden = true;
    },
  };
}
```

- [ ] **Step 6: Put the bubble and the scrubber into the player**

In `public/js/views/player.js`:

1. After `import { toast, endsAt } from '../components.js';` add:

```js
import { Scrubber, COMMIT_AFTER_MS } from '../scrub.js';
import { seekPreview } from '../seekpreview.js';
```

2. After `const timeEnd = h('span', { class: 'time' }, '0:00');` add:

```js
  const seekTrack = h('div', { class: 'seek-track' }, bufferBar, seek);
  const bubble = seekPreview(seekTrack);
```

and in the `controls` element, replace `h('div', { class: 'seek-wrap' }, timeCur, h('div', { class: 'seek-track' }, bufferBar, seek), timeEnd),` with:

```js
    h('div', { class: 'seek-wrap' }, timeCur, seekTrack, timeEnd),
```

3. After `const totalDuration = () => duration || (Number.isFinite(video.duration) ? video.duration : 0);` add:

```js
  const scrubber = new Scrubber({ duration: () => totalDuration() });
  let commitTimer = null;
```

4. In `startSession`, after `session = res;` add:

```js
    bubble.setManifest(res.previews);
```

5. In the `seek.addEventListener('input', …)` handler, after the `seek.style.setProperty('--pct', …)` line add `bubble.show(t, total);`. In the `seek.addEventListener('change', …)` handler, add `bubble.hide();` as its first line.

6. After the `seek.addEventListener('change', …)` block, add:

```js
  // Mouse over the bar: preview without seeking.
  seekTrack.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || scrubbing) return;
    const rect = seekTrack.getBoundingClientRect();
    const total = totalDuration();
    if (!total || !rect.width) return;
    bubble.show(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * total, total);
  });
  seekTrack.addEventListener('pointerleave', () => {
    if (!scrubbing) bubble.hide();
  });

  // ---- Scrubbing with a remote: arrows move a marker, OK (or a pause) jumps ----
  function showScrub(t) {
    scrubbing = true;
    const total = totalDuration();
    seek.value = String(Math.floor(t));
    seek.style.setProperty('--pct', total ? `${(t / total) * 100}%` : '0%');
    seek.setAttribute('aria-valuetext', `Jump to ${formatClock(t)}`);
    timeCur.textContent = formatClock(t);
    bubble.show(t, total);
    showControls(true);
  }
  function scrubPress(dir, e) {
    showScrub(scrubber.press(dir, { from: currentTime(), now: performance.now(), repeat: e.repeat }));
    clearTimeout(commitTimer);
    const check = () => {
      if (scrubber.due(performance.now())) commitScrub();
      else if (scrubber.active) commitTimer = setTimeout(check, 50);
    };
    commitTimer = setTimeout(check, COMMIT_AFTER_MS);
  }
  function commitScrub() {
    clearTimeout(commitTimer);
    const t = scrubber.commit();
    scrubbing = false;
    bubble.hide();
    if (t != null) seekTo(t);
  }
  function cancelScrub() {
    clearTimeout(commitTimer);
    if (!scrubber.cancel()) return false;
    scrubbing = false;
    bubble.hide();
    updateTimeline();
    showControls();
    return true;
  }
  seek.addEventListener('blur', () => {
    if (scrubber.active) commitScrub(); // moving off the bar keeps the chosen spot
  });
```

7. In `onKey`, in `case 'ArrowLeft': case 'ArrowRight': {`, directly after `if (!menu.hidden) return;`, add:

```js
        if (active === seek) {
          e.preventDefault(); // stops the slider's own step, which would seek on every press
          scrubPress(e.key === 'ArrowRight' ? 1 : -1, e);
          return;
        }
```

Add a new case before `case 'ArrowUp':`:

```js
      case 'Enter':
        if (active === seek && scrubber.active) {
          e.preventDefault();
          commitScrub();
        }
        break;
```

and in the `case 'Escape': … case 'GoBack':` branch, directly after `e.preventDefault();`, add:

```js
        if (cancelScrub()) break;
```

8. In `cleanupFn`, after `clearTimeout(hideTimer);` add `clearTimeout(commitTimer);`.

- [ ] **Step 7: Style the bubble**

In `public/css/app.css`, after the `.seekbar:focus-visible::-webkit-slider-runnable-track { … }` rule, add:

```css
/* Seek-bar preview: a frame from the video and the time, above the scrub point */
.seek-preview { position: absolute; bottom: calc(100% + 12px); left: 0; transform: translateX(-50%); display: grid; justify-items: center; gap: 6px; pointer-events: none; z-index: 2; }
.seek-preview[hidden] { display: none; }
.seek-preview-img { width: var(--preview-width, 320px); aspect-ratio: 16 / 9; border-radius: var(--radius); background: #000 no-repeat; box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.85), 0 12px 40px rgba(0, 0, 0, 0.6); }
.seek-preview:not(.has-image) .seek-preview-img { display: none; }
.seek-preview-time { padding: 3px 10px; border-radius: 99px; background: rgba(0, 0, 0, 0.75); color: #fff; font-weight: 700; font-variant-numeric: tabular-nums; }
@media (max-width: 720px) { .seek-preview { --preview-width: 200px; } }
```

- [ ] **Step 8: Smoke-check the player**

Run: `sh /home/claude/devtools/restart-dev.sh && node /home/claude/devtools/regress.mjs`
Expected: `38/38 PASS`, with no page errors. The bubble and scrubbing are checked properly in Task 11.

- [ ] **Step 9: Checkpoint**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/*.test.js`
Expected: all pass.

---

### Task 9: Skip intro, auto-skip and Up next at the credits

**Files:**
- Create: `public/js/markers.js`
- Modify: `public/js/views/player.js` (imports; the element list; state; `updateTimeline`; the `ended` listener; `startUpNext` and `cancelUpNext`)
- Modify: `public/css/app.css`: `.skip-intro` rules after the `.upnext-count` rule
- Test: `test/markers.test.js`

**Interfaces:**
- Consumes: `session.markers` (Task 6); `prefs.skipIntros` (Task 7); `scrubbing`, `seekTarget`, `seekTo`, `setNotice`, `startUpNext` and `showControls`, all already in the player (Task 8 keeps `scrubbing` true while a remote scrub is in progress).
- Produces, in `public/js/markers.js` (all pure):
  - `HIDE_BEFORE_END = 2`
  - `introRange(markers, duration) → {start,end}|null`
  - `inIntro(range, t) → boolean`
  - `introLeft(range, t) → 0..1`
  - `upNextAt(markers, duration) → seconds|null`
  - `parseClock(text) → seconds|null` (Task 10 uses it)

- [ ] **Step 1: Write the failing tests**

Create `test/markers.test.js`:

```js
// What the player does about intros and credits, including when it doesn't know
// the video's length yet, plus reading times typed as m:ss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { introRange, inIntro, introLeft, upNextAt, parseClock, HIDE_BEFORE_END } from '../public/js/markers.js';

test('the intro to offer skipping, kept inside the video', () => {
  assert.deepEqual(introRange({ intro: { start: 42, end: 92 } }, 1500), { start: 42, end: 92 });
  assert.deepEqual(introRange({ intro: { start: 42, end: 92 } }, 0), { start: 42, end: 92 }, 'length not known yet: as given');
  assert.deepEqual(introRange({ intro: { start: 1400, end: 1600 } }, 1500), { start: 1400, end: 1500 }, 'cut at the end of the file');
  assert.equal(introRange({ intro: { start: -3, end: 30 } }, 1500).start, 0);
  assert.equal(introRange({ intro: { start: 10, end: 11.5 } }, 1500), null, 'too short to bother');
  assert.equal(introRange({ intro: { start: 1499, end: 1600 } }, 1500), null, 'starts at the very end');
  assert.equal(introRange({ intro: null }, 1500), null);
  assert.equal(introRange(undefined, 1500), null);
});

test('when Skip intro shows, and how much intro is left', () => {
  const r = { start: 40, end: 100 };
  assert.equal(HIDE_BEFORE_END, 2);
  assert.deepEqual([39.9, 40, 97.9, 98, 120].map((t) => inIntro(r, t)), [false, true, true, false, false]);
  assert.equal(inIntro(null, 50), false);
  assert.equal(introLeft(r, 70), 0.5);
  assert.equal(introLeft(r, 10), 1);
  assert.equal(introLeft(null, 10), 0);
});

test('Up next starts when the credits do', () => {
  assert.equal(upNextAt({ credits: { start: 1300, end: 1390 } }, 1400), 1300);
  assert.equal(upNextAt({ credits: { start: 1300, end: 1390 } }, 0), 1300, 'length not known yet');
  assert.equal(upNextAt({ credits: { start: 1399.5, end: 1400 } }, 1400), null, 'right at the end: the same as no credits');
  assert.equal(upNextAt({ credits: { start: 0, end: 30 } }, 1400), null);
  assert.equal(upNextAt({ credits: null }, 1400), null);
  assert.equal(upNextAt(undefined, 1400), null);
});

test('times typed as m:ss', () => {
  assert.deepEqual(['0:42', '1:32', '92', '1:02:03', ' 1:32.5 ', '1,5'].map(parseClock), [42, 92, 92, 3723, 92.5, 1.5]);
  assert.deepEqual(['', 'abc', '1:75', '-5', '1:2:3:4', null].map(parseClock), [null, null, null, null, null, null]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/markers.test.js`
Expected: FAIL with `Cannot find module '.../public/js/markers.js'`.

- [ ] **Step 3: Write the module**

Create `public/js/markers.js`:

```js
// What the player should do about intros and credits (pure, shared with tests).

/** The Skip intro button goes away this many seconds before the intro ends. */
export const HIDE_BEFORE_END = 2;

/** The intro range to offer skipping, kept inside the video, or null. */
export function introRange(markers, duration) {
  const m = markers?.intro;
  if (!m || !(m.end > m.start)) return null;
  const start = Math.max(0, m.start);
  const end = duration > 0 ? Math.min(m.end, duration) : m.end;
  return end - start > HIDE_BEFORE_END ? { start, end } : null;
}

export const inIntro = (range, t) => Boolean(range) && t >= range.start && t < range.end - HIDE_BEFORE_END;

/** How much of the intro is left (1 → 0), for the thin bar on the button. */
export const introLeft = (range, t) => (range ? Math.max(0, Math.min(1, (range.end - t) / (range.end - range.start))) : 0);

/** When Up next should appear: when the credits start, or null (= at the very end). */
export function upNextAt(markers, duration) {
  const c = markers?.credits;
  if (!c || !(c.start > 0)) return null;
  if (duration > 0 && c.start >= duration - 1) return null;
  return c.start;
}

/** "0:42", "1:02:03", "92" or "1:32.5" → seconds; null if it isn't a time. */
export function parseClock(text) {
  const s = String(text ?? '').trim().replace(',', '.');
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return null;
  const parts = s.split(':').map(Number);
  if (parts.slice(1).some((p) => p >= 60)) return null;
  return parts.reduce((total, p) => total * 60 + p, 0);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/markers.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the button and the behaviour to the player**

In `public/js/views/player.js`:

1. After the `seekpreview.js` import (Task 8), add:

```js
import { introRange, inIntro, introLeft, upNextAt } from '../markers.js';
```

2. After `const upNext = h('div', { class: 'upnext', hidden: true });` add:

```js
  const skipBtn = h('button', { class: 'skip-intro', type: 'button', hidden: true, onClick: () => skipIntro() }, h('span', {}, 'Skip intro'), h('span', { class: 'skip-intro-bar', 'aria-hidden': 'true' }));
```

and in the `root` element's children, put `skipBtn` after `upNext`: `… infoEl, upNext, skipBtn, top, controls);`.

3. After `let lastReported = 0;` add:

```js
  let autoSkip = prefs.skipIntros === true; // "Watch it" turns this off for the rest of the video
  let autoSkipped = false; // auto-skip once per play-through
  let creditsArmed = true; // Up next may start at the credits (again after seeking back)
  let upNextCancelled = false; // cancelled during the credits: don't start it again at the end
```

4. At the end of `updateTimeline()`, after the `bufferBar` if/else, add:

```js
    updateIntro(now, total);
    updateCredits(now, total);
```

5. After the scrubbing functions (Task 8), add:

```js
  // ---- Intros and credits ----
  const busyFocus = () => [controls, top, menu, upNext].some((el) => el.contains(document.activeElement));
  function updateIntro(now, total) {
    const range = introRange(session?.markers, total);
    const show = inIntro(range, now) && seekTarget == null && !scrubbing;
    if (show && autoSkip && !autoSkipped) {
      autoSkipped = true;
      skipIntro({ auto: true });
      return;
    }
    if (show === skipBtn.hidden) {
      skipBtn.hidden = !show;
      // Like a TV app: OK skips, unless the viewer is busy with the controls.
      if (show && !busyFocus()) skipBtn.focus({ preventScroll: true });
      if (!show && document.activeElement === skipBtn) root.focus({ preventScroll: true });
    }
    if (show) skipBtn.style.setProperty('--left', String(introLeft(range, now)));
  }
  function skipIntro({ auto = false } = {}) {
    const range = introRange(session?.markers, totalDuration());
    if (!range) return;
    skipBtn.hidden = true;
    if (document.activeElement === skipBtn) root.focus({ preventScroll: true });
    seekTo(range.end);
    if (auto) {
      setNotice('Skipped intro', {
        label: 'Watch it',
        onClick: () => {
          autoSkip = false;
          setNotice(null);
          seekTo(range.start);
        },
      });
    }
  }
  function updateCredits(now, total) {
    const at = upNextAt(session?.markers, total);
    if (at == null || !session?.next || prefs.autoplayNext === false) return;
    if (now < at - 1) {
      creditsArmed = true;
      upNextCancelled = false;
      return;
    }
    if (creditsArmed && seekTarget == null && !scrubbing && upNext.hidden) {
      creditsArmed = false;
      startUpNext();
    }
  }
```

6. Replace the whole `video.addEventListener('ended', …)` block with:

```js
  video.addEventListener('ended', () => {
    report(true);
    if (!upNext.hidden) return; // already counting down (it started at the credits)
    if (session?.next && prefs.autoplayNext !== false && !upNextCancelled) startUpNext();
    else showControls(true);
  });
```

7. In `startUpNext()`, add `upNextCancelled = false;` as its first line. In `cancelUpNext()`, add as its first line:

```js
    if (upNextAt(session?.markers, totalDuration()) != null) upNextCancelled = true;
```

- [ ] **Step 6: Style the button**

In `public/css/app.css`, after the `.upnext-count { … }` rule, add:

```css
/* Skip intro: bottom right, above the controls; a thin bar shows how much intro is left */
.skip-intro { position: absolute; right: var(--gutter); bottom: 150px; z-index: 4; overflow: hidden; padding: 12px 24px; border: 0; border-radius: 99px; background: rgba(22, 24, 30, 0.92); color: #fff; font: inherit; font-size: 1.05rem; font-weight: 700; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5); cursor: pointer; }
.skip-intro[hidden] { display: none; }
.skip-intro:hover { background: rgba(40, 44, 54, 0.95); }
.skip-intro:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }
.skip-intro-bar { position: absolute; left: 0; bottom: 0; height: 3px; width: calc(var(--left, 1) * 100%); background: var(--accent); transition: width 0.25s linear; }
.player[data-controls="hidden"] .skip-intro { bottom: 60px; }
@media (prefers-reduced-motion: reduce) { .skip-intro-bar { transition: none; } }
```

- [ ] **Step 7: Smoke-check the player**

Run: `sh /home/claude/devtools/restart-dev.sh && node /home/claude/devtools/regress.mjs`
Expected: `38/38 PASS`, with no page errors.

- [ ] **Step 8: Checkpoint**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/*.test.js`
Expected: all pass.

---
### Task 10: Fixing an intro on the episode page (admins)

**Files:**
- Modify: `public/js/views/item.js` (imports; add `introLine()` and `introDialog()` after `identifyDialog()`; one line in `render()`)
- Modify: `public/css/app.css`: add `.intro-line`

**Interfaces:**
- Consumes:
  - `data.markers`: present only for admins on episode pages (Task 6)
  - `PUT`/`DELETE /api/items/:id/markers/intro` and `POST /api/items/:id/markers/detect` (Task 6)
  - `parseClock` (Task 9)
  - `openDialog({ title, body, actions, onSubmit })`, `field(label, input, hint)`, `button()` and `toast()` from `components.js`
- Produces: `.intro-line` on admin episode pages, and the "Intro for …" dialog.

- [ ] **Step 1: Add the line and the dialog**

In `public/js/views/item.js`:

1. Change the components import to include `field`, and add the markers import:

```js
import { art, metaLine, button, toast, openDialog, landscapeCard, spinner, grid, mediaFlags, endsAt, timeLeft, field } from '../components.js';
import { parseClock } from '../markers.js';
```

2. After the closing `}` of `identifyDialog`, add:

```js
const INTRO_SOURCE = { audio: 'found automatically', chapter: 'from chapters', manual: 'set by hand' };

/** Admins: where this episode's intro is, and a way to fix it. */
function introLine(item, markers) {
  const m = markers?.intro;
  const text = !m ? 'Intro not found yet' : m.none ? 'No intro' : `Intro ${formatClock(m.start)}–${formatClock(m.end)} · ${INTRO_SOURCE[m.source] || ''}`;
  return h('p', { class: 'intro-line muted' }, h('span', {}, text), button('Edit', { icon: 'edit', variant: 'ghost', onClick: () => introDialog(item, m) }));
}

async function introDialog(item, current) {
  const has = current && !current.none;
  const start = h('input', { value: has ? formatClock(current.start) : '', placeholder: '0:42', inputmode: 'decimal', autocomplete: 'off', 'data-autofocus': true });
  const end = h('input', { value: has ? formatClock(current.end) : '', placeholder: '1:32', inputmode: 'decimal', autocomplete: 'off' });
  const all = h('input', { type: 'checkbox' });
  const actions = [
    { label: 'Cancel', value: 'cancel' },
    { label: 'No intro', value: 'none' },
    { label: 'Find again', value: 'detect' },
  ];
  if (current?.source === 'manual') actions.push({ label: 'Use automatic', value: 'auto' });
  actions.push({ label: 'Save', value: 'save', variant: 'primary' });
  await openDialog({
    title: `Intro for ${episodeLabel(item)}`,
    body: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'form-grid' }, field('Starts at', start, 'Minutes and seconds, like 0:42'), field('Ends at', end)),
      h('label', { class: 'check' }, all, h('span', {}, 'Apply to the rest of this season')),
    ),
    actions,
    onSubmit: async (value) => {
      const applyToSeason = all.checked;
      if (value === 'save') {
        const s = parseClock(start.value);
        const e = parseClock(end.value);
        if (s == null || e == null) {
          toast('Enter times like 0:42 and 1:32.');
          return false;
        }
        await api.put(`/api/items/${item.id}/markers/intro`, { start: s, end: e, applyToSeason });
        toast('Intro saved', { type: 'success' });
      } else if (value === 'none') {
        await api.put(`/api/items/${item.id}/markers/intro`, { none: true, applyToSeason });
        toast('Saved: no intro', { type: 'success' });
      } else if (value === 'detect') {
        await api.post(`/api/items/${item.id}/markers/detect`, {});
        toast('Looking for the intro again. This can take a minute.');
      } else if (value === 'auto') {
        await api.del(`/api/items/${item.id}/markers/intro`);
        toast('Using the automatic intro times.');
      }
      refreshView();
      return true;
    },
  });
}
```

3. In `render()`, in the `detail-info` children, directly after `h('div', { class: 'actions' }, actions),` add:

```js
          data.markers !== undefined ? introLine(item, data.markers) : null,
```

In `public/css/app.css`, add after the `.check[hidden]` rule (Task 7):

```css
.intro-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin: 14px 0 0; }
```

- [ ] **Step 2: Check it in the browser**

Run: `sh /home/claude/devtools/restart-dev.sh && node /home/claude/devtools/regress.mjs`
Expected: `38/38 PASS`. The dialog itself is exercised in Task 11: Save with Enter, "Use automatic", and the line text.

- [ ] **Step 3: Checkpoint**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/*.test.js`
Expected: all pass.

---

### Task 11: Browser checks, docs, version 0.5.0, and delivery to Dallas's PC

**Files:**
- Create (dev only): `/home/claude/devtools/make-extras-media.mjs`, `/home/claude/devtools/extras-ui.mjs`
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `docs/THEMES.md`, `package.json`
- Project docs: `claude/build-status.md`, `claude/architecture.md` (through the Projects tool)

**Interfaces:**
- Consumes: everything above.
- Produces: screenshots `/tmp/shots/b1-…b8-….png`, version `0.5.0`, and the synced `D:\Nodeflix`.

- [ ] **Step 1: Make the dev test show**

Create `/home/claude/devtools/make-extras-media.mjs`:

```js
// Makes the dev "Theme Show" for the v0.5 browser checks. VP9/Opus, so Chromium
// (which has no H.264/AAC in this environment) plays it directly.
import { makeEpisode } from '/home/claude/nodeflix/test/helpers.js';

const dir = '/home/claude/testmedia/TV/Theme Show (2024)/Season 01';
const vp9 = { audioCodec: 'opus', videoCodec: 'libvpx-vp9' };
makeEpisode(`${dir}/Theme Show - S01E01 - Kia ora.webm`, { ...vp9, themeAt: 6, seed: 1 });
makeEpisode(`${dir}/Theme Show - S01E02 - Two.webm`, { ...vp9, themeAt: 17, seed: 3, gain: 0.5, lowpass: 3000, chapters: [[0, 17, 'Prologue'], [17, 37, 'Part 1'], [37, 80, 'Part 2'], [80, 100, 'End Credits']] });
makeEpisode(`${dir}/Theme Show - S01E03 - Three.webm`, { ...vp9, themeAt: 9, seed: 11 });
console.log('Made', dir);
```

Run: `node /home/claude/devtools/make-extras-media.mjs`
Expected: `Made /home/claude/testmedia/TV/Theme Show (2024)/Season 01`. Then check that the dev TV library covers that folder:

Run: `sqlite3 /tmp/nf-dev/nodeflix.db "SELECT name, paths FROM libraries WHERE type = 'tv'" 2>/dev/null || node -e "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync('/tmp/nf-dev/nodeflix.db').prepare(\"SELECT name, paths FROM libraries WHERE type='tv'\").all())"`
Expected: a TV library whose paths include `/home/claude/testmedia/TV`. If none does, add that folder as a TV library in Settings → Libraries before Step 3.

- [ ] **Step 2: Write the browser checks**

Create `/home/claude/devtools/extras-ui.mjs`:

```js
// Browser checks for v0.5: seek-bar previews, remote scrubbing, Skip intro,
// auto-skip, Up next at the credits, the admin intro dialog and the settings screens.
// Needs restart-dev.sh running and make-extras-media.mjs run once.
import fs from 'node:fs';
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';

const { chromium } = pw;
const base = 'http://127.0.0.1:8787';
fs.mkdirSync('/tmp/shots', { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|Content Security Policy/.test(m.text()) && errors.push(m.text()));
const wait = (ms) => page.waitForTimeout(ms);
const api = (url, method = 'GET', body) =>
  page.evaluate(
    async ([u, m, b]) => {
      const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: m === 'GET' ? undefined : JSON.stringify(b || {}) });
      return r.status === 204 ? null : r.json();
    },
    [url, method, body],
  );
const videoTime = () => page.evaluate(() => document.querySelector('.player video').currentTime);
const playing = (id, t) => page.goto(`${base}/#/play/${id}?t=${t}`).then(() => page.waitForFunction((from) => document.querySelector('.player video')?.currentTime > from + 0.3, t, { timeout: 15000 }));

// Sign in as dallas and pick the PIN profile.
await page.goto(base);
await page.fill('input[name=username]', 'dallas');
await page.fill('input[name=password]', 'password123');
await page.keyboard.press('Enter');
await page.waitForSelector('.picker-grid');
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('Enter');
await page.waitForSelector('dialog[open] .pin-input');
await page.keyboard.type('4321');
await page.keyboard.press('Enter');
await page.waitForSelector('.home-rows, .rows', { timeout: 8000 });

// Scan, then wait for the background jobs.
await api('/api/scan', 'POST', {});
for (let i = 0; i < 600; i++) {
  const s = await api('/api/scan/status');
  const t = await api('/api/admin/tasks');
  if (!s.running && !s.queued && !t.running && !t.queued.previews && !t.queued.intros) break;
  await wait(500);
}
const tv = (await api('/api/libraries')).find((l) => l.type === 'tv');
const show = (await api(`/api/libraries/${tv.id}/items`)).items.find((i) => i.title === 'Theme Show');
const season = (await api(`/api/items/${show.id}`)).seasons[0];
const eps = (await api(`/api/items/${season.id}`)).episodes;
const intro = (await api(`/api/items/${eps[0].id}`)).markers?.intro;
check('the dev episodes have an intro found from the theme tune', intro?.source === 'audio', JSON.stringify(intro));

// 1. Hovering the seek bar shows a picture.
await playing(eps[0].id, 0);
const box = await (await page.$('.seek-track')).boundingBox();
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
await wait(300);
const hover = await page.evaluate(() => {
  const b = document.querySelector('.seek-preview');
  return { shown: !b.hidden, image: getComputedStyle(b.querySelector('.seek-preview-img')).backgroundImage, time: b.querySelector('.seek-preview-time').textContent };
});
check('hovering the seek bar shows a preview picture', hover.shown && /\/previews\/1/.test(hover.image), JSON.stringify(hover));
await page.screenshot({ path: '/tmp/shots/b1-preview-hover.png' });

// 2. Remote scrubbing: presses move the marker; the video jumps a second later.
await page.mouse.move(5, 5);
await page.focus('.seekbar');
const t0 = await videoTime();
for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight', { delay: 30 });
await wait(150);
const during = await page.evaluate(() => ({ t: document.querySelector('.player video').currentTime, value: Number(document.querySelector('.seekbar').value), bubble: !document.querySelector('.seek-preview').hidden }));
check('arrow presses move the marker, not the video', Math.abs(during.t - t0) < 1.5 && during.value >= Math.floor(t0) + 29 && during.bubble, JSON.stringify({ t0, ...during }));
await page.screenshot({ path: '/tmp/shots/b2-remote-scrub.png' });
await wait(1300);
const after = await videoTime();
check('the video jumps a second after the last press', Math.abs(after - (t0 + 30)) < 2.5, `${t0.toFixed(1)} → ${after.toFixed(1)}`);

// 3. Back cancels a scrub (and doesn't leave the player).
await page.focus('.seekbar');
const t1 = await videoTime();
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Escape');
await wait(1300);
const t2 = await videoTime();
check('Back cancels a scrub and stays in the player', page.url().includes('#/play/') && Math.abs(t2 - t1) < 2.5 && (await page.evaluate(() => document.querySelector('.seek-preview').hidden)), `${t1.toFixed(1)} → ${t2.toFixed(1)}`);

// 4. Skip intro: shows during the intro, takes focus, OK skips.
await page.evaluate((t) => (document.querySelector('.player video').currentTime = t), intro.start + 1);
await page.evaluate(() => document.querySelector('.player').focus());
await wait(900);
const skip = await page.evaluate(() => ({ shown: !document.querySelector('.skip-intro').hidden, focused: document.activeElement === document.querySelector('.skip-intro') }));
check('Skip intro shows during the intro and takes focus', skip.shown && skip.focused, JSON.stringify(skip));
await page.screenshot({ path: '/tmp/shots/b3-skip-intro.png' });
await page.keyboard.press('Enter');
await wait(500);
const skipped = await videoTime();
check('OK skips to the end of the intro', skipped >= intro.end - 0.5 && (await page.evaluate(() => document.querySelector('.skip-intro').hidden)), `${skipped.toFixed(1)} vs ${intro.end}`);

// 5. Auto-skip (switched on in the profile settings), and "Watch it".
const toggleAutoSkip = async () => {
  await page.goto(`${base}/#/settings/profile`);
  await page.click('label.toggle:has-text("Skip intros automatically")');
  await wait(600);
};
await toggleAutoSkip();
await playing(eps[0].id, Math.max(0, Math.floor(intro.start) - 1));
await page.waitForFunction((end) => document.querySelector('.player video').currentTime >= end - 0.5, intro.end, { timeout: 10000 }).catch(() => {});
const auto = await page.evaluate(() => ({ t: document.querySelector('.player video').currentTime, notice: document.querySelector('.player-notice')?.textContent || '' }));
check('with auto-skip on, the intro is skipped and the player says so', auto.t >= intro.end - 0.5 && /Skipped intro/.test(auto.notice) && /Watch it/.test(auto.notice), JSON.stringify(auto));
await page.screenshot({ path: '/tmp/shots/b4-auto-skip.png' });
await page.click('.player-notice button');
await wait(700);
const back = await videoTime();
check('"Watch it" goes back to the start of the intro', Math.abs(back - intro.start) < 1.5, back.toFixed(1));
await toggleAutoSkip();

// 6. Up next at the credits (E02 has an "End Credits" chapter at 1:20).
await playing(eps[1].id, 77);
const shownUpNext = await page.waitForSelector('.upnext:not([hidden])', { timeout: 12000 }).then(() => true, () => false);
const at = await videoTime();
check('Up next appears when the credits start', shownUpNext && at < 99, `at ${at.toFixed(1)}`);
await page.screenshot({ path: '/tmp/shots/b5-credits-upnext.png' });
await page.click('.upnext button:has-text("Cancel")');
await wait(400);
check('cancelling Up next lets the credits play on', await page.evaluate(() => document.querySelector('.upnext').hidden && !document.querySelector('.player video').paused));

// 7. The admin intro line and dialog.
await page.goto(`${base}/#/item/${eps[0].id}`);
await page.waitForSelector('.intro-line');
const line1 = await page.textContent('.intro-line');
check('the episode page says where the intro is', /Intro \d+:\d\d–\d+:\d\d · found automatically/.test(line1), line1);
await page.click('.intro-line button');
await page.waitForSelector('dialog[open]');
await page.fill('dialog[open] input >> nth=0', '0:10');
await page.fill('dialog[open] input >> nth=1', '0:40');
await page.screenshot({ path: '/tmp/shots/b6-intro-dialog.png' });
await page.keyboard.press('Enter');
await page.waitForFunction(() => /set by hand/.test(document.querySelector('.intro-line')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
const line2 = await page.textContent('.intro-line');
check('Enter saves hand-set times', /Intro 0:10–0:40 · set by hand/.test(line2), line2);
await page.click('.intro-line button');
await page.waitForSelector('dialog[open]');
await page.click('dialog[open] button:has-text("Use automatic")');
for (let i = 0; i < 120; i++) {
  const t = await api('/api/admin/tasks');
  if (!t.running && !t.queued.intros) break;
  await wait(500);
}
await page.goto(`${base}/#/`);
await page.goto(`${base}/#/item/${eps[0].id}`);
await page.waitForSelector('.intro-line');
check('"Use automatic" finds it again', /found automatically/.test(await page.textContent('.intro-line')));

// 8. Settings screens.
await page.goto(`${base}/#/settings/dashboard`);
check('the dashboard has a Background tasks card', await page.waitForSelector('h2:has-text("Background tasks")', { timeout: 5000 }).then(() => true, () => false));
await page.screenshot({ path: '/tmp/shots/b7-dashboard-tasks.png', fullPage: true });
await page.goto(`${base}/#/settings/server`);
await page.waitForSelector('form');
check('server settings have both switches', (await page.locator('label.check:has-text("Seek-bar previews")').count()) === 1 && (await page.locator('label.check:has-text("Find TV intros")').count()) === 1);
await page.goto(`${base}/#/settings/libraries`);
await page.click('button:has-text("Edit") >> nth=0');
await page.waitForSelector('dialog[open]');
check('the library dialog has the previews checkbox', (await page.locator('dialog[open] label.check:has-text("Make seek-bar previews")').count()) === 1);
await page.keyboard.press('Escape');

// 9. TV and phone sizes.
await page.setViewportSize({ width: 1920, height: 1080 });
await playing(eps[2].id, 30);
const tvBox = await (await page.$('.seek-track')).boundingBox();
await page.mouse.move(tvBox.x + tvBox.width * 0.7, tvBox.y + tvBox.height / 2);
await wait(300);
await page.screenshot({ path: '/tmp/shots/b8-preview-tv.png' });
await page.setViewportSize({ width: 390, height: 844 });
await wait(300);
const phoneBox = await (await page.$('.seek-track')).boundingBox();
await page.mouse.move(phoneBox.x + phoneBox.width * 0.9, phoneBox.y + phoneBox.height / 2);
await wait(300);
const inside = await page.evaluate(() => {
  const r = document.querySelector('.seek-preview').getBoundingClientRect();
  return r.left >= 0 && r.right <= window.innerWidth;
});
check('on a phone the bubble stays on screen', inside);
await page.screenshot({ path: '/tmp/shots/b9-preview-phone.png' });

check('no errors in the console', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 3: Run the browser checks**

Run: `sh /home/claude/devtools/restart-dev.sh && node /home/claude/devtools/extras-ui.mjs`
Expected: every line `PASS`, ending with `ALL PASS`. Then look at every screenshot `/tmp/shots/b1…b9` with the Read tool. Check that the bubble sits centred above the pointer and inside the screen, the Skip button doesn't overlap the controls, and Up next and the dialog look like the rest of the Arctic theme. Fix what's wrong and re-run. If a check fails, use superpowers:systematic-debugging before changing code.

Then run `node /home/claude/devtools/regress.mjs` and `node /home/claude/devtools/arctic-shots.mjs laptop`.
Expected: `38/38 PASS`, and home and detail screenshots unchanged from v0.4 apart from the admin intro line on episode pages.

- [ ] **Step 4: Docs and version**

1. `package.json`: `"version": "0.5.0"`.

2. `README.md`: after the **Plays anything** bullet, add:

```markdown
- **Seek-bar previews and Skip intro** — small pictures above the seek bar while you scrub, also with a TV remote (hold → to go faster, OK to jump). TV episodes get a **Skip intro** button: intros are found from chapter names, or by matching the theme tune across a season, and admins can fix them on the episode page. Both are made in the background at low priority and pause while someone watches a converted video.
```

In the player keys table, add these rows after `| ← / → (or J / L) | Back / forward 10 s |`:

```markdown
| ← / → on the seek bar | Scrub with a preview picture (hold to go faster); Enter jumps, Esc cancels |
| Enter on **Skip intro** | Skip the opening titles |
```

In **Troubleshooting**, add:

```markdown
- **No seek-bar previews yet** — they're made in the background after a scan; **Settings → Dashboard → Background tasks** shows what's left. They wait while someone watches a video the server is converting.
- **Skip intro is missing or in the wrong place** — an admin can fix it on the episode's page (**Edit** next to "Intro"), for one episode or the whole season.
```

In **Roadmap ideas**, remove `trickplay thumbnails on the seek bar ·` and `intro/credits skip ·`.

3. `docs/ARCHITECTURE.md`: add to the Migrations list:

```markdown
6. Background jobs: `libraries.options` (JSON, e.g. `{"previews": false}`), `media_jobs` (what each job did for which
   file: `status` done/none/failed, the file's size and mtime at the time, preview layout in `data`) and `markers`
   (intro/credits per episode; `source` manual > chapter > audio; start and end both NULL mean "no intro").
```

and, before `## Security model`, add this section:

```markdown
## Background tasks (`src/tasks.js`, `src/extras/`)

`TaskRunner` runs one job at a time and asks the database what's next: titles from the latest scan first, then the
backlog oldest first. Intro checks (seconds each) come before previews. ffmpeg runs at low priority
(`os.setPriority`), and nothing runs while a video is being converted for someone. If a conversion starts during a
job, its ffmpeg is killed and the job is redone later. A job counts as needed when it has no `media_jobs` row, or
the file's size or mtime has changed. Failed jobs wait for an admin's **Try again**.

- **Previews** (`extras/previews.js`): a single ffmpeg pass with `-skip_frame nokey` (keyframes only) and
  `fps=1/10` (1/5 under 20 minutes), `scale=320:-2`, `tile=10x10`, giving JPEG sheets in `data/previews/<item id>/`.
  Sheets are written into `<id>.tmp` and swapped in. The player picks a tile with `public/js/previews.js`.
- **Intros** (`extras/intros.js`, `extras/fingerprint.js`): chapters named Intro/Opening/… (and Credits/End
  Credits/…) win. Otherwise the first `min(10 min, 40%)` of each episode is decoded to 8 kHz mono and turned into
  32-bit codes every 64 ms (Haitsma–Kalker band-energy differences). Two episodes are compared at every alignment,
  and the longest stretch that matches for 15–150 s is the intro. Each episode is compared with the next, the
  next-but-one, the previous, then another season.
- The player gets `previews` and `markers` in the playback response.
```

4. `docs/THEMES.md`: in "Handy selectors", add `` `.seek-preview`, `.seek-preview-img`, `.seek-preview-time` `` (the bubble; its picture width is `--preview-width`), `` `.skip-intro`, `.skip-intro-bar` `` (whose width follows `--left`, from 1 down to 0) and `` `.intro-line` ``.

- [ ] **Step 5: The full suite, one last time**

Run: `cd /home/claude/nodeflix && node --disable-warning=ExperimentalWarning --test test/*.test.js 2>&1 | tail -8`
Expected: `# fail 0`. The pass count is 86 plus the new tests: 7 + 5 + 6 + 6 + 7 + 5 + 3 + 5 + 4 = 48, so **134**.

- [ ] **Step 6: Deliver to `D:\Nodeflix`**

Use the remote-devices tools (load them with ToolSearch if they're deferred).

1. On the device, check nothing changed since the last sync:
   `cd "$HOME/mnt/Nodeflix" && sha256sum -c --quiet "$HOME/device-sums.txt"; echo "exit $?"; find . -type f -newer "$HOME/device-sums.txt" -not -path './data/*'`
   Expected: `exit 0` and no files listed. Otherwise stop and ask Dallas before overwriting anything.
2. In the cloud workspace, list the files that changed since the last sync:
   `cd /home/claude/nodeflix && find . -type f -not -path './data/*' -not -path './node_modules/*' -not -path './public/img/*' | sort | xargs -d '\n' sha256sum > /tmp/claude-0/sync/cloud-sums5.txt && diff <(awk '{print $2}' /tmp/claude-0/sync/cloud-sums-synced.txt) <(awk '{print $2}' /tmp/claude-0/sync/cloud-sums5.txt); join -j 2 <(sort -k2 /tmp/claude-0/sync/cloud-sums-synced.txt) <(sort -k2 /tmp/claude-0/sync/cloud-sums5.txt) | awk '$2 != $3 {print $1}'`
   Take the new files (lines starting `>`) plus the changed files as the list.
3. Copy each one to `/mnt/user-data/outputs/NodeFlix/<path>`, then call `device_commit_files` with `{ stagedPath: "/mnt/user-data/outputs/NodeFlix/<path>", devicePath: "D:\\Nodeflix\\<path with backslashes>" }` for each (at most 50 per call).
4. Compare the aggregate checksums.
   - Device: `cd "$HOME/mnt/Nodeflix" && find . -type f -not -path './data/*' -not -path './Claude outputs/*' -not -path './public/img/*' | sort | xargs -d '\n' sha256sum | sha256sum`
   - Cloud: `cd /home/claude/nodeflix && find . -type f -not -path './data/*' -not -path './node_modules/*' -not -path './public/img/*' | sort | xargs -d '\n' sha256sum | sha256sum`
   - Expected: identical.
5. Run the tests on the PC: `cd "$HOME/mnt/Nodeflix" && node --disable-warning=ExperimentalWarning --test test/*.test.js 2>&1 | tail -8`, with a timeout of 170000 ms.
   Expected: `# fail 0` (the ffmpeg tests skip if its VM has no ffmpeg).
6. Save the new checksums, for the next sync:
   - Device: `cd "$HOME/mnt/Nodeflix" && find . -type f -not -path './data/*' | sort | xargs -d '\n' sha256sum > "$HOME/device-sums.txt"`
   - Cloud: `cp /tmp/claude-0/sync/cloud-sums5.txt /tmp/claude-0/sync/cloud-sums-synced.txt`
7. Commit the best screenshots (b1, b3, b5, b6, b8, b9) to `D:\Nodeflix\Claude outputs\v0.5-*.png`, and send them to Dallas with SendUserFile.

- [ ] **Step 7: Project notes**

With the Projects tool:
- `project_write` a new `claude/build-status.md`: v0.5.0, what was added, what was verified, and what's still unverified (real TV remotes, very large libraries, HDR tone mapping on a real HDR file).
- `project_write` `claude/architecture.md` from `local_path: /home/claude/nodeflix/docs/ARCHITECTURE.md`.

- [ ] **Step 8: Verification before claiming done**

Use superpowers:verification-before-completion. Re-read this plan's Review Focus list and the spec's Testing section, and point to the passing test or browser check for each item. Only then tell Dallas it's done.
