# Atomix: trailers, extras and lyrics — design (round 12, v0.10.0)

Date: 2026-10-01. Author: Claude, with Dallas's choices. Builds on v0.9.0 (lists, collections, picks).

## 1. What Dallas wants

The second of three "big updates": trailers, extras and lyrics. His choices during the design:

- Trailers come from **local files first, with the film's TMDB/YouTube trailer as the fallback**.
- Extras show as **an Extras row on the film or show page** (not a separate page).
- Lyrics come from **the person's own files first, then LRCLIB online** (a free, key-less service).
- Lyrics show on **a full-screen Now Playing page**, made for a TV across the room.
- A trailer **never starts on its own**: only a Trailer button plays one.

Success looks like: a film with `Film-trailer.mp4` beside it, or with a TMDB match, has a Trailer button that plays
with one press; a film folder with `Featurettes/` shows those on the film's page and nowhere else; a song with a
`.lrc` file, embedded lyrics, or an LRCLIB match shows its words scrolling in time on a big screen; none of this
sends anything but the song's name, artist, album and length off the server, and every online part has an admin
switch.

Project-wide rules that apply throughout (from the earlier rounds): Node ≥ 22.13, zero npm dependencies
(`node:http`, `node:sqlite`, `node:test`), plain ES-module browser JS with no build step; Orbit is the default
look and a TV remote (arrows, Enter, Back) comes first; older themes are compared pixel by pixel and only change
where this spec adds content; nothing copied from Kodi (its conventions only); the design and pictures stay
private to Dallas.

## 2. Data

Migration 10 (`src/db.js`, `MIGRATIONS[9]`):

- `items.extra_kind TEXT` — null for everything but extras; one of `trailer`, `featurette`, `behindthescenes`,
  `deleted`, `interview`, `scene`, `short`, `other`.
- `items.trailer TEXT` — JSON, `{ "site": "youtube", "key": "<video id>", "name": "<TMDB name>" }` or null; set by
  metadata for movies and shows.
- Table `lyrics`: `item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE`, `source TEXT NOT NULL`
  (`file` | `tags` | `lrclib` | `none`), `synced INTEGER NOT NULL DEFAULT 0`, `text TEXT` (LRC text when synced,
  plain lines otherwise; null for `none`), `file_mtime INTEGER` (the `.lrc` file's mtime when `source = 'file'`),
  `fetched_at INTEGER NOT NULL`.
- Index `items_extras` on `(parent_id, extra_kind) WHERE extra_kind IS NOT NULL`.

Settings (`src/settings.js` `SETTING_DEFAULTS`): `onlineTrailers: true`, `onlineLyrics: true`. Both appear in
Settings → Server as toggles ("Online trailers — play the film's YouTube trailer when there is no local one";
"Online lyrics — ask LRCLIB for lyrics your files don't have").

Extras are items of `kind = 'extra'` with `parent_id` the movie or show they belong to, `show_id` the show when the
parent is a show (so the show's visibility rules find them), `library_id` the parent's library, `path`, `size`,
`mtime`, `duration` and `media` from ffprobe like any video, `title` from the file name, `min_age` and
`certification` copied from the parent on every scan (so a rating fix on the film reaches its extras), `poster` a
`cache:` thumbnail once one is made (§4), else null.

## 3. Trailers

### 3.1 Local trailers

The scanner (`src/library/scanner.js`, `src/library/parser.js`) stops skipping them:

- A file whose stem ends in `-trailer` (case-insensitive; Kodi and Plex both use it) is an extra of kind `trailer`.
- Files inside a folder named `Trailers` (case-insensitive) are extras of kind `trailer`.
- Ownership follows §4.2.

A film or show's trailer for the button is its first local `trailer` extra (by name), else its `items.trailer`.

### 3.2 TMDB trailers

`TmdbProvider.fetch` appends `videos` to the movie and TV requests it already makes (`append_to_response`). The
pick, a pure function `pickTrailer(videos, language)` in `src/library/metadata.js`, tested in Node:

1. Only `site === 'YouTube'` and `type === 'Trailer'` (then `Teaser` if no trailer at all).
2. Prefer `official === true`, then the metadata language (`iso_639_1`), then English, then anything.
3. Within a group, the most recent `published_at`.

The result is stored as `items.trailer` and refreshed with the rest of the metadata; a manual "Fix match" replaces it.
`enrichMissing()` (v0.9.0's catch-up pass) also fills `trailer` for titles that have a TMDB id and were matched
before v0.10.0: it already re-reads those titles, so no extra request is made.

### 3.3 The Trailer button and the trailer page

`GET /api/items/:id` gains `trailer: { kind: 'local', itemId } | { kind: 'youtube', key, name } | null`, decided
server-side: a local trailer the viewer may see wins; a YouTube trailer is offered only when `onlineTrailers` is
on **and the profile is not a kids profile** (the YouTube frame carries YouTube's own suggestions, which nobody
has rated). `GET /api/home` includes the same field on the spotlight's featured items (cards don't need it).

The film or show page shows a **Trailer** button (icon `film`) after Play (Orbit: in the actions row; older layouts:
the same row) whenever `trailer` is set. The Home spotlight shows a Trailer button after "More info" when the
featured title has one. One press:

- `local` → `#/play/<extraId>?from=<titleId>`: the normal player; when the trailer ends (or Back), the player
  returns to the title's page (the `from` query names it; the player already returns to the page it was opened
  from (v0.7.2's `visited` list) — the same mechanism, with `from` as the fallback when there is no history). No "Up next".
- `youtube` → `#/trailer/<titleId>`: a new view `public/js/views/trailer.js`: a dark page, the title's name as the
  heading, a 16:9 frame filling the width (`max-width` the screen's height × 16/9), an `<iframe>` from
  `https://www.youtube-nocookie.com/embed/<key>?autoplay=1&rel=0&modestbranding=1`, and a Back button under it
  that takes focus (a remote can't focus into the frame reliably; Back/Escape leaves). If the frame has not
  loaded in 6 s (`load` event not seen), the page says "The trailer didn't load — this TV may not reach YouTube."
  with the Back button. The CSP in `src/app.js` gains `frame-src https://www.youtube-nocookie.com`. Music playing
  in the mini-player pauses when the trailer page opens (as starting a video does today) and does not resume.

Kids profiles: the `trailer` field is `local` or null, never `youtube`; `#/trailer/:id` answers a kids profile
with the "Nothing to play here" empty state.

## 4. Extras

### 4.1 Kinds

| Folder name (case-insensitive) | File suffix | `extra_kind` | Caption |
| --- | --- | --- | --- |
| `Trailers` | `-trailer` | `trailer` | Trailer |
| `Featurettes` | `-featurette` | `featurette` | Featurette |
| `Behind The Scenes` | `-behindthescenes` | `behindthescenes` | Behind the scenes |
| `Deleted Scenes` | `-deleted` | `deleted` | Deleted scene |
| `Interviews` | `-interview` | `interview` | Interview |
| `Scenes` | `-scene` | `scene` | Scene |
| `Shorts` | `-short` | `short` | Short |
| `Extras`, `Other`, `Bonus` | `-other` | `other` | Extra |

`Sample`, `Samples` folders and `-sample` files stay skipped as today. The existing `EXTRAS_DIRS` set in
`parser.js` is replaced by `EXTRA_DIR_KINDS` (name → kind) plus `EXTRA_SUFFIX_KINDS`; `extraKindOf(filePath)`
returns `{ kind, title }` (title = the file's stem with the suffix removed, `.`/`_` turned to spaces, trimmed) or
null — a pure function tested in Node.

### 4.2 Ownership

`walk()` no longer skips extras folders or `-trailer` files; it tags each found file with `extra: { kind,
folder }` when §4.1 matches, and the scanner assigns owners after the main files are known:

- Movies library: an extra whose folder (for suffix files, the same folder; for folder extras, the parent folder)
  holds **exactly one** movie file belongs to that movie. A suffix file in a folder with several movies belongs to
  the movie whose stem is a prefix of the extra's stem (case-insensitive), else nobody. Folder extras in a folder
  with several movies belong to nobody. Orphan extras are not stored (logged at debug once per scan).
- TV library: an extras folder anywhere under a show's folder (`<root>/<Show>/…`) belongs to the show; a suffix
  file next to an episode belongs to the show. Flat TV layouts (`<root>/S01E01.mkv`) give extras no owner.

Extras are upserted like other items (`seen_scan`, removal when the file is gone), probed, and never sent to
metadata. Their `min_age`/`certification` are copied from the owner on each scan and after each metadata refresh
of the owner (`applyEnrichment` copies to children with `extra_kind`).

### 4.3 Hidden everywhere but the title page

`Library.list()` and every query that lists titles exclude `kind = 'extra'` unless the caller passes
`kind: 'extra'` explicitly (`src/library/queries.js`: the visibility SQL gains `AND i.kind <> 'extra'` in the
`list`, search, Home-row, picks-candidate and playlist-add paths). Concretely: the library grid, Home rows
(including Continue watching and Recently added), search, picks, `Lists.add` (refused with 400 "Extras can't go in
playlists"), collections (`setItems` refuses them), and the Kids rules all treat extras as invisible. Progress is
still recorded (resume works) but `progress` rows for extras never appear in Continue watching.

`GET /api/items/:id` for a movie or show gains `extras: [{ id, title, extraKind, caption, duration, poster,
progress }]` — the owner's extras the viewer may see, sorted by kind (table order) then title; empty array when
none. `GET /api/items/:id` for an extra returns it with `parent` (`{ id, title, kind }`) so the player can label and
return.

### 4.4 Thumbnails

The background runner (`src/tasks.js`) gets a third job, `thumb`, for extras with no `poster`: one ffmpeg call
takes a frame at 10 % of the duration (a keyframe seek, 640 px wide, JPEG quality 4) into `data/images/` and
stores `poster = cache:<file>`; failures are recorded in `media_jobs` like previews and retried with "Try again"
on the dashboard. Thumb jobs run after intro checks and previews for the same scan (lowest priority) and are
skipped when previews are switched off for the library (same switch — the dashboard copy says "previews and
extra thumbnails"). Until a thumbnail exists, the card shows the owner's backdrop.

### 4.5 The Extras row

On the film or show page, after the details block (film) or the seasons (show) and before **Part of**, when
`extras.length > 0`: `row({ id: 'extras', title: 'Extras', items, style: 'landscape' })` — the landscape card's
caption is the kind's caption (§4.1) and the length; a watched tick and progress bar as any video. Pressing a card
plays it: `#/play/<extraId>?from=<titleId>`; the player's title line shows "Featurette · Film name"; at the end it
returns to the title's page (no Up next, no auto-advance through the row). The older layouts get the same row.

## 5. Lyrics

### 5.1 Lookup

`src/lyrics.js`, class `Lyrics({ db, settings, fetchFn })`, `async get(track)` → `{ synced, lines, source } | null`:

1. **File**: `<song stem>.lrc` beside the song (also `.txt` with the same stem, plain). If it exists and its mtime
   differs from `lyrics.file_mtime`, it is read again and stored (`source = 'file'`). A file always wins, even over
   a stored `lrclib` answer.
2. **Stored answer**: a `lyrics` row with `source` `tags` or `lrclib` is returned as is; `none` is returned as null
   unless `fetched_at` is older than 30 days, in which case step 4 runs again.
3. **Tags**: the song's stored `media` JSON gains `tags.lyrics` at scan time — `probe.js` keeps the first of
   `lyrics`, `LYRICS`, `unsyncedlyrics`, `USLT`, `lyrics-eng` (any `lyrics-*`) from the format and first audio
   stream tags, up to 64 KB. If present it is stored (`source = 'tags'`, synced when the text parses as LRC with at
   least three timed lines).
4. **LRCLIB** (when `onlineLyrics` is on): `GET https://lrclib.net/api/get?artist_name=&track_name=&album_name=&duration=`
   with the song's artist, title, album and rounded duration, `User-Agent: Atomix/<version> (https://github.com/reconstx5/Atomix)`,
   10 s timeout. 200 → store `syncedLyrics` if present (synced) else `plainLyrics`; 404 or any error → store
   `none` (an error is still `none`, so a flaky connection doesn't hammer the service; the dashboard's log line says
   why). Only one request per song is ever in flight (a per-id promise map).

`get` is called on demand by `GET /api/items/:id/lyrics` (any signed-in profile that may see the track), never by
the scanner. The response: `{ synced: boolean, lines: [{ at: seconds | null, text }], source }` or `204` when none.

### 5.2 LRC parsing

`public/js/lrc.js` (a plain ES module with no DOM use; the server imports the same file from `public/js/` for the
tags check, the way `test/orbit-rules.test.js` imports `orbit-rules.js` in Node): `parseLrc(text)` → `{ synced, lines: [{ at, text }], offset }`. Rules: `[mm:ss.xx]`,
`[mm:ss.xxx]` and `[mm:ss]` stamps; several stamps before one line produce several lines; `[offset:±ms]` shifts
every stamp; `[ar:]`, `[ti:]`, `[al:]`, `[length:]` and unknown `[xx:]` tags are dropped; lines are sorted by time;
a text with fewer than three timed lines is plain (`synced: false`, one line per text line, `at: null`); empty
lines are kept as breathing room but never highlighted. Tested in Node.

### 5.3 The Now Playing page

`#/now-playing`, `public/js/views/nowplaying.js`, `.nowplaying-view`. Opened by: Enter or a click on the mini-player's
cover/title (older layouts: the same), a **Lyrics** entry in a song's "…" sheet, and the media-session artwork on
phones. With nothing playing it shows "Nothing playing" and a Back button.

Layout (Orbit; `orbit.css` for structure, `theme.css` for the look):

- Wide screens: three columns — the cover (about 360 × `--px`) with the song and artist and album under it on the
  left; the lyrics in the middle, the current line white and larger, the others dimmed, the current line kept at the
  vertical centre by scrolling the list (a `transform` on the list, no page scroll); the queue on the right
  (`trackList` with the current song marked, as the mini-player's Up next today). The environment wash comes from
  the cover (as album pages do).
- Phones and portrait: the cover smaller at the top, the lyrics below, the queue reachable by a **Queue** button that
  opens the existing Up next sheet.
- The transport along the bottom: previous, play/pause (autofocus), next, shuffle, repeat, the seek bar with elapsed
  and remaining, and a volume control on wide screens; it is the same `music` object the mini-player drives, so the
  mini-player pill hides while this page is open and returns when it closes.
- Plain lyrics: the whole text, scrollable, no highlight. None: "No lyrics for this song" and, when `onlineLyrics`
  is off and the song had none on disk, "Online lyrics are off in Settings → Server" for admins.

Remote and keyboard: Up/Down from the transport go to the lyric lines (synced only: each line is focusable; Enter
seeks there); Left/Right on the seek bar seek 5 s; Back leaves to the page the person came from (`history.back()`
when it was reached from within the app, else Home); Space toggles play/pause anywhere on the page except inside
a text field. The synced highlight follows `timeupdate` (about 4 times a second) with the line whose `at` is the last
≤ current time + 0.3 s; after the person scrolls or moves through the lines the auto-scroll waits 4 s before
taking over again. Reduce motion: no scrolling animation, lines jump.

When the song changes (`music` fires its change event), the page fetches the new song's lyrics, keeps the transport's
focus, and resets the scroll.

## 6. What is left out (deliberately)

- Trailer downloads (`yt-dlp`) — breaks with YouTube changes and needs a binary.
- Autoplaying trailers in the backdrop — Dallas chose "only from a button".
- Extras for music (album booklets, videos) — a later round.
- Editing or translating lyrics in the app; lyrics for episodes.
- Karaoke-style word timing (LRC's `<mm:ss.xx>` inline stamps are stripped to the line).
- Any lyrics or trailer request beyond the one described; no telemetry.

## 7. Testing

Node (`node --test`): migration 10 shape; `extraKindOf` for every folder and suffix, mixed case, `.`/`_` titles,
`-sample` still skipped; scanner ownership (one movie per folder, several movies with prefix match, orphan skipped,
a show's folder, flat TV gives no owner, removal when a file goes, rating copied from the owner); `pickTrailer`
preference order; `/api/items/:id` `trailer` field for an adult, a kid (`local` only) and with `onlineTrailers`
off; extras hidden from `list`, search, Home rows, picks, playlists and collections; `parseLrc` (all §5.2 rules);
`Lyrics.get` order with a fake LRCLIB server (file wins, tags, lrclib synced/plain, `none` remembered and retried
after 30 days, only one in-flight request, switch off → no request); the lyrics route's visibility (a kid can't
fetch lyrics for a track in a hidden library → 404).

Browser (`devtools/extras-lyrics-ui.mjs`, plus a section in `orbit-ui.mjs`): the Trailer button on a film with a
local trailer plays it and returns to the film; the YouTube trailer page renders the frame (the dev server's CSP
allows it; the check confirms the iframe element and the Back button's focus, not YouTube itself) and its
"didn't load" message when the frame is blocked; the Extras row appears with captions and plays back to the page;
extras absent from the library grid and Home; Now Playing opens from the mini-player, shows synced lyrics with
the moving highlight (a dev `.lrc` beside a dev song), Enter on a line seeks, Back returns, the queue column on wide
screens, the phone layout, and no console errors. Older themes: the pixel comparison, re-baselined only where the
Trailer button and Extras row add content.

## 8. Dev data

The mock TMDB (`devtools/mock-tmdb.mjs`) answers `videos` for the two dev films (one official trailer key); the dev
library gains `Another Film-trailer.mp4` (a short generated clip), a `Featurettes/` folder with one clip, and a
`.lrc` for one dev song (`devtools/make-extras-media.mjs` already generates media; it gains these).
