# Seek-bar previews and Skip intro — design

Status: approved in conversation (29 Sep 2026), awaiting spec review
Target version: 0.5.0

## Goal

Two player features, built in this order:

1. **Seek-bar previews** — a small picture of the scene above the seek bar while scrubbing (mouse, touch, keyboard and TV remote).
2. **Skip intro** — a button during a TV episode's opening titles, with an optional per-profile auto-skip.

Both are produced by a low-priority background job runner after library scans. Admins can correct anything the detection gets wrong.

## Decisions (from Dallas)

- Build both; previews first.
- Previews are made **in the background after scans**, with an admin on/off setting and a per-library opt-out.
- Intros are found **automatically (chapters first, then audio matching) with manual correction**.
- Recommended approaches accepted: tile sheets for previews; NodeFlix's own audio fingerprint matcher for intros.
- Assumptions accepted:
  - Previews for movies and episodes only (no music).
  - Skip is a button by default, plus a per-profile "Skip intros automatically" option (off by default).
  - Credits markers come from chapters only, and make "Up next" appear when the credits start.

## Constraints

- Zero npm dependencies. Works with any ffmpeg ≥ 4.4, on Windows, Linux and Docker; no chromaprint or other optional ffmpeg libraries required.
- Must not make playback stutter on a small VPS.
- Existing access rules apply everywhere: library access and Kids ratings.

## Out of scope

- Previews for music.
- Detecting credits from audio.
- Skipping recaps.
- Hardware-decoded preview generation.
- Exporting BIF files for other apps.
- Chromecast.

## Architecture

New units, each with one job:

| Unit | Purpose | Depends on |
|---|---|---|
| `src/tasks.js` — `TaskRunner` | Queue of background jobs, one at a time, low CPU priority; pauses while a conversion is playing; kills ffmpeg on shutdown | playback manager (active sessions), settings, log |
| `src/extras/previews.js` | `planPreviews(item, media)` (pure: interval, tile size, count) and `generatePreviews(...)` (runs ffmpeg into a temp folder, then renames it into place) | probe.js `run()` |
| `src/extras/fingerprint.js` | Pure functions: `fingerprint(pcm, sampleRate)` → `Uint32Array`, and `findSharedSegment(fpA, fpB)` → `{aStart, aEnd, bStart, bEnd}` or null. Includes a small radix-2 FFT. | none |
| `src/extras/intros.js` | Chapter title matching (pure), audio extraction via ffmpeg, season orchestration (which episodes to compare) | fingerprint.js, probe.js `run()` |
| `src/extras/store.js` | DB access for job state, preview layouts and markers; enforces "manual wins" | db |
| `src/api/extras.js` | Preview image route, marker admin routes, task status routes | store, library.canSee |
| `public/js/previews.js` | Pure `tileFor(manifest, seconds)` → `{url, x, y, width, height}` | none |
| `public/js/scrub.js` | Pure `Scrubber` state machine for remote and keyboard scrubbing: step acceleration, commit on OK or 1 s idle, cancel | none |

Changes to existing files:

- `db.js`: migration 6.
- `settings.js`: new keys.
- `probe.js` `detectTools`: reports whether the `zscale` and `tonemap` filters exist.
- `app.js`: wires up `TaskRunner` and listens for the `scan:complete` hook.
- `api/playback.js`: the playback response gains `previews` and `markers`.
- `api/serialize.js`: admin-only markers on episode detail.
- `views/player.js`: preview bubble, scrubber, skip button, credits "Up next".
- `views/item.js`: admin intro row and Edit dialog.
- `views/settings.js`: server toggles, per-library checkbox, dashboard task status, profile toggle.
- `api/account.js`: `skipIntros` pref.
- CSS: `.seek-preview`, `.skip-intro`.

## Data model — migration 6

```sql
ALTER TABLE libraries ADD COLUMN options TEXT NOT NULL DEFAULT '{}';   -- {"previews": false} opts a library out

CREATE TABLE media_jobs (
  item_id      INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  job          TEXT NOT NULL CHECK (job IN ('previews', 'intros')),
  status       TEXT NOT NULL CHECK (status IN ('done', 'none', 'failed')),
  data         TEXT,            -- previews: layout JSON {interval,width,height,columns,rows,count,sheets}
  error        TEXT,
  source_size  INTEGER,         -- items.size / items.mtime when the job ran; a mismatch means "do it again"
  source_mtime INTEGER,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (item_id, job)
);

CREATE TABLE markers (
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('intro', 'credits')),
  start_time REAL,              -- start_time and end_time both NULL = "there isn't one" (set by an admin)
  end_time   REAL,              -- (not "start"/"end": END is an SQL keyword)
  source     TEXT NOT NULL CHECK (source IN ('chapter', 'audio', 'manual')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, kind)
);
```

- `media_jobs.status` is one of:
  - `done`: finished.
  - `none`: checked, nothing found. For intros only.
  - `failed`: an error. It is not retried until the file changes or an admin presses Try again.
- Preview files live in `data/previews/<item id>/<n>.jpg`, where n starts at 1.
- Folders are written as `<item id>.tmp` and renamed into place when complete.
- On startup the runner deletes `*.tmp` folders, and folders whose item has no `previews` job row.

## Job runner

- **Queue order:**
  1. Items from the latest scan, oldest first.
  2. Then a slow sweep of the existing library.
  - Within a batch, intro jobs (seconds each) run before preview jobs (up to a minute or two each).
  - Duplicate jobs are merged.
- **Work selection:**
  - Previews: movies and episodes where `previewsEnabled` is on and the library isn't opted out, and that have no `media_jobs` row or a size/mtime mismatch.
  - Intros: episodes where `introDetection` is on, with the same rule. One intro job covers a season.
- **Priority:**
  - Each child process runs at a lower priority via `os.setPriority(pid, 10)`. On Windows this maps to "below normal"; errors are ignored.
  - Only one job runs at a time.
- **Pausing:**
  - Before each job, the runner waits while any playback session's mode is not `direct` (that is, a remux or transcode is running).
  - If a conversion starts during a job, the job's ffmpeg is killed and the job goes back to the front of the queue. Killing is cross-platform; suspending is not.
- **No ffmpeg:** the runner stays idle, and the dashboard says it needs ffmpeg.
- **Shutdown:** the runner kills the running child and exits cleanly. Temp folders are cleaned on the next start.
- **Status:** `GET /api/admin/tasks` (admin only) returns `{ running: {job, itemId, title, startedAt} | null, queued, paused: null | 'converting' | 'disabled' | 'no-ffmpeg', failed: [{itemId, title, job, error}] }`. `POST /api/admin/tasks/retry` clears failed rows so the jobs requeue.

## Previews

- **Interval:** 5 s for videos under 20 minutes, otherwise 10 s.
- **Tiles:** 320 px wide; height from the display aspect ratio, rounded to an even number; 10 × 10 tiles per sheet.
- **Count:** `min(ceil(duration / interval), sheets × 100)`.
- **Command:**

  ```
  ffmpeg -hide_banner -loglevel error -skip_frame nokey -i <file> -an -sn -dn
         -vf "fps=1/<interval>,<tonemap?>scale=320:-2,tile=10x10" -q:v 5 -f image2 <tmp>/%d.jpg
  ```

  - Checked on 29 Sep: the last, partial sheet is flushed at full size, padded.
  - A 130 s test clip took 0.3 s.
- **HDR:** when the item is HDR and `zscale` and `tonemap` are both available, the tone-map chain `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,` is placed first. Otherwise nothing is done and the previews look washed out.
- **Timeout:** 30 minutes. Timeouts and errors mark the job `failed` with the last lines of ffmpeg's error output.
- **Tile lookup** (`tileFor`):
  - `index = clamp(round(t / interval), 0, count − 1)`
  - `sheet = floor(index / 100) + 1`
  - `col = index % 10`
  - `row = floor((index % 100) / 10)`
- **Image route:** `GET /api/items/:id/previews/:n`
  - Access: signed in with a profile, and `library.canSee`. Anything else is a 404, never a 403, so Kids profiles can't find out a title exists.
  - Response: `image/jpeg` with `Cache-Control: private, max-age=31536000, immutable`. The URL carries `?v=<updated_at>`.
- **Playback response:** gains `previews: { interval, width, height, columns, rows, count, sheets, url: "/api/items/42/previews/{n}?v=…" } | null`.

## Intros and credits

- **Chapters:**
  - Read with `ffprobe -show_chapters` during the intro job, so no rescan is needed.
  - Titles are trimmed and compared case-insensitively.
  - Intro titles: `intro`, `opening`, `opening credits`, `op`, `title sequence`, `main titles`.
  - Credits titles: `credits`, `end credits`, `ending`, `ed`, `outro`, `closing credits`.
  - A chapter's own start and end become the marker, with source `chapter`.
- **Audio extraction:**
  - Command: `ffmpeg -v error -i <file> -t <window> -map 0:a:0 -ac 1 -ar 8000 -f s16le -`.
  - `window = min(600, 0.4 × duration)` seconds.
  - This produces at most 9.6 MB, within `run()`'s 20 MB buffer.
- **Fingerprint:**
  - 1024-sample Hann-windowed frames (128 ms), hop 512 (64 ms).
  - 33 log-spaced bands from 300 to 2000 Hz give 32 bits: bit m = `(E[n][m] − E[n][m+1]) − (E[n−1][m] − E[n−1][m+1]) > 0`. This is the Haitsma–Kalker method.
- **Matching:**
  1. Build an inverted index of B's frame hashes.
  2. Each exact match between A and B votes for an offset `posB − posA`.
  3. Take the top 5 offsets that have at least 8 votes.
  4. For each offset, compute the bit errors of every aligned frame pair, smoothed over 16 frames (≈1 s).
  5. The matching stretch is the longest run where the smoothed error is ≤ 11 of 32 bits, allowing gaps up to 1 s.
  - Accept a stretch 15 to 150 s long.
  - Thresholds are tuned in tests against the same tune encoded with different codecs and loudness levels.
- **Season orchestration:**
  - Episodes are sorted by `items.episode` (the season comes from `items.season` and `parent_id`).
  - Each episode that needs checking is compared with the next episode, then the next-but-one, then the previous one, then an episode from the show's other seasons. It stops at the first match.
  - Matches fill in the marker for both episodes, unless the other already has one.
  - Fingerprints are held in memory only for the length of the job.
  - Episodes with no match get `media_jobs.status = 'none'`. They're checked again when a new episode arrives in the season.
- **Precedence:**
  - A `manual` marker, including "none", is never replaced by `chapter` or `audio`.
  - A `chapter` marker is never replaced by `audio`.
- **Admin routes** (all admin only; 404 when the episode isn't visible):
  - `PUT /api/items/:id/markers/intro`
    - Body `{start, end, applyToSeason?}` validates `0 ≤ start < end ≤ duration`.
    - Body `{none: true}` records that there's no intro.
    - `applyToSeason` copies the same times to the rest of the season's episodes as `manual` markers.
  - `DELETE /api/items/:id/markers/intro` goes back to automatic: it removes the manual marker and queues detection.
  - `POST /api/items/:id/markers/detect` requeues the season.
- **Playback response:** gains `markers: { intro: {start, end} | null, credits: {start, end} | null }`. A "none" marker is sent as null.

## Player and UI

- **Preview bubble:**
  - A 320 px frame (scaled down on phones), with the time under it, positioned above the scrub point and clamped inside the player.
  - Shown while the pointer hovers the seek track, while dragging, while a finger is on the bar, and during remote or keyboard scrubbing.
  - With no previews, the bubble shows only the time.
  - Sheets load lazily: the first one when the bubble first shows, then the neighbouring ones.
- **Remote and keyboard scrubbing** (the seek bar has focus):
  - Left/Right move a scrub marker and update the bubble. The video doesn't move yet.
  - Steps are 10 s; after 1.5 s of holding they become 30 s, and after 4 s, 60 s.
  - The jump happens on OK/Enter, or 1 s after the last press.
  - Back/Escape cancels and returns the marker to the playing position.
  - The range input's own key handling is prevented so each press doesn't seek.
  - Arrow shortcuts with the controls hidden are unchanged.
- **Skip intro:**
  - A `.skip-intro` button, bottom right, is shown while `intro.start ≤ t < intro.end − 2`, with a thin bar for the intro left.
  - It takes focus when nothing in the controls, menus or Up next is focused, so OK skips.
  - Pressing it seeks to `intro.end`.
  - It hides when the time leaves the range, including after a manual seek.
- **Auto-skip** (profile pref `skipIntros`, off by default):
  - When playback enters the intro, the player seeks to its end once per play-through, then shows the notice "Skipped intro" with a "Watch it" button that seeks back to `intro.start` and turns auto-skip off for the rest of that playback.
  - Starting playback inside an intro (for example on resume) also skips.
- **Credits:** when `markers.credits` exists and "Play the next episode automatically" is on, Up next starts at `credits.start` instead of at `ended`. Cancel hides it and the credits keep playing. `ended` still plays the next episode if Up next wasn't cancelled.
- **Episode page (admins):**
  - A line reads "Intro 0:42–1:32 · found automatically", or "from chapters", "set by hand", "No intro" or "Not found yet", followed by an **Edit** button.
  - The dialog has start and end (m:ss) fields, "Apply to the rest of this season", **Save**, **No intro**, **Find again** and **Use automatic**.
  - The design follows the existing `openDialog` patterns: Enter presses Save, and focus goes to the first field.
- **Settings:**
  - Server: "Seek-bar previews" and "Find TV intros" toggles.
  - Library dialog: "Make seek-bar previews" checkbox.
  - Dashboard: a "Background tasks" card showing the current job, the number queued, any pause reason, and failed items with **Try again**.
  - Profile: "Skip intros automatically".
- **Themes:** both new elements use existing tokens (`--accent`/`--tint`, `--radius`, focus ring). `docs/THEMES.md` lists the new selectors.

## Error handling

| Situation | Behaviour |
|---|---|
| ffmpeg missing | Runner idle; dashboard says "Needs ffmpeg"; the player works without previews or markers |
| File unreadable, corrupt or timed out | Job `failed` with an error summary; shown on the dashboard; retried only on file change or Try again |
| Disk full while writing previews | Job `failed`; temp folder removed |
| Item removed mid-job | Result discarded (the row insert fails its foreign key, which is caught); temp folder removed |
| Server stopped mid-job | Child killed; temp folder swept on the next start; job requeued because no row was written |
| Episode shorter than 60 s or with no audio track | Intro job records `none` without comparing |
| Bad manual times | 400 with a plain message ("The intro must end after it starts.") |

## Testing (test first)

- **Unit tests (no ffmpeg):**
  - `test/fingerprint.test.js`
    - A synthetic 20 s "theme" (a chord sequence) is embedded in different noise at 12 s and 47 s in two clips; the match is found within ±0.3 s.
    - A different-noise pair finds nothing.
    - A theme at −6 dB and with a 3 kHz low-pass still matches.
    - Stretches under 15 s are rejected.
  - `test/intros.test.js`
    - Chapter titles are matched.
    - Season pairing order is correct.
    - Precedence holds: manual beats chapter beats audio, and "none" sticks.
  - `test/previews.test.js`
    - `planPreviews` gives the right interval, height and count.
    - `tileFor` is correct at the edges: 0 s, the last tile, and sheet boundaries.
  - `test/scrub.test.js`: step acceleration, the idle commit, OK commit, cancel, and the clamp to [0, duration].
  - `test/tasks.test.js`: runs one job at a time, orders by queue, pauses while a conversion is active, requeues a killed job, skips failed jobs until retried, and sweeps temp folders.
- **ffmpeg tests** (skipped when ffmpeg is missing, like the existing ones):
  - Generate two 90 s episodes: the same `sine`/`aevalsrc` tune inside different `anoisesrc` noise, one encoded AAC and one MP3. Run the full intro job and check both markers within ±0.5 s.
  - Generate previews for a 130 s clip and check the sheet count, the tile size and that the layout JSON is stored.
  - Check a chapter-marked MKV (chapters written with ffmpeg's metadata input).
- **API tests:**
  - The preview route follows access rules: a Kids profile gets a 404 for an adult title.
  - Marker routes are admin only, validate their input, and apply to the season.
  - The playback response includes `previews` and `markers`.
  - The migration upgrades a v5 database.
- **Browser checks (Playwright):**
  - The hover and drag bubble.
  - Remote scrubbing: arrows, hold, OK, and Back.
  - The skip button: its focus, skipping, auto-skip and "Watch it".
  - Credits "Up next".
  - The admin Edit dialog.
  - Screenshots at TV, laptop and phone sizes.

## Docs

- README feature list.
- `docs/ARCHITECTURE.md`: task runner, extras, migration 6.
- `docs/THEMES.md`: new selectors.
- `.env.example`: no new variables.
- Version 0.5.0.
