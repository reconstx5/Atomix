# Atomix v0.20.0 — music apps, smart playlists, household and player extras (design)

Round 22. Dallas: "Add some updates. Take inspiration from Kodi, Jellyfin, Emby and Ampache." He picked three packages
(Music, Ampache-style; Household, Jellyfin/Emby-style; Player and library, Kodi-style) and dropped the Kodi remote API
(Kore/Yatse) this round.

## Why

Atomix plays everything but remembers little about it: where a title was left, and whether it was finished. It doesn't
know how often something was played, when, or what a profile thinks of it, and phone music apps can't use it at all
(the iPhone browser is also the weakest place to play music). The household features (watching together, signing a TV
in without typing, seeing what happened) and the Kodi player habits (speed, sync fixes, chapters, hand-edited details)
are the most-missed parts of Jellyfin, Emby and Kodi.

## Hard limits

- No dependencies. Node ≥ 22.13, `node:sqlite`, ffmpeg; plain ES-module browser code.
- Kids profiles: their library rules apply everywhere new (smart playlists, music apps, Watch together, stats); they
  never see admin data (the activity log, other profiles' stats, app passwords of other profiles).
- Secrets never reach the browser or the logs: app passwords are shown once; Last.fm session keys, ListenBrainz tokens
  and the Last.fm API secret stay server-side; the activity log records no passwords, tokens or provider addresses.
- Older themes stay pixel-identical (`oldthemes-compare.mjs compare` → "all pages match").
- Out of scope: the Kodi JSON-RPC remote, video in the music apps, Live TV and music in Watch together, guest links.

## 0. Groundwork (plan A)

- **Play history** (`plays`: id, profile_id, item_id, started_at, seconds, counted 0/1, client
  `browser|cast|subsonic|<app name>`): written by the video player's progress reports, the music player, casts and the
  Subsonic `scrobble`/`stream` calls. A song is **counted** after half its length or 4 minutes (whichever first); a film
  or episode when it is marked watched. One row per playing (a resumed title updates its open row for 6 hours).
- **Stars and hearts** (`user_ratings`: profile_id, item_id, stars 1–5 null, favourite 0/1, updated_at): for tracks,
  albums, artists, films and shows; per profile; any profile (Kids included). Shown and set on title pages, the song
  row's "…" menu, Now Playing and the music player. Routes `PUT /api/items/:id/rating {stars|null, favourite}`.
- Items gain `play_count`/`last_played`/`stars`/`favourite` for the viewer in their API shape (from those tables).

## 1. Smart playlists (plan A)

- A list of kind `smart` (lists gain `rules` JSON and `media` `music|video`). Lists → **New smart playlist**.
- Rules (each `{field, op, value}`), combined by **match all** or **match any**:
  - music: genre, artist, album artist, album, year, stars, favourite, play count, last played, date added, length;
  - video: genre, year, stars, favourite, play count (watched), last played, date added, length, kind (film/episode),
    age rating.
  - ops: is / is not / contains, ≥ / ≤ / between (numbers, years), "in the last N days" / "not in the last N days"
    (dates), is set / is not set.
- Sort: random, recently added, stars, most played, last played, title, year. Limit: none, N items, or N minutes.
- Evaluated each time it's opened or played (never stored), always through the viewer's visibility (Kids rules); a
  shared smart list is evaluated for the viewer, not its owner. Plays, shuffles, casts, shares like a playlist.
  Rule errors (an unknown field, a bad value) are refused on save with a sentence naming the rule.
- Music smart lists appear in the music apps (read-only).

## 2. Music apps — the Subsonic API (plan B)

- **App passwords** (`app_passwords`: id, profile_id, name, secret (random 24 chars, kept so token sign-in works),
  created_at, last_used_at, revoked). Settings → Profile → **Music apps**: name it → the password is shown once with the
  server address and username to type; the list shows last used; **Revoke**. Limit 20 per profile.
- `/rest/<method>` and `/rest/<method>.view`, GET and POST (form body), `f=xml|json|jsonp`, API version 1.16.1 plus
  OpenSubsonic (`openSubsonic: true`, extensions `songLyrics`, `apiKeyAuthentication`, `formPost`, `transcodeOffset`).
- **Auth:** `u` + (`t` = md5(app password + `s`) | `p` = app password or `enc:<hex>`) | `apiKey` (an app password).
  Wrong → Subsonic error 40; revoked → 40; missing → 10. The signed-in profile's library access and Kids rules apply;
  the account's role decides `adminRole` (no admin methods are implemented).
- **Methods:** ping, getLicense, getOpenSubsonicExtensions, getMusicFolders, getIndexes, getArtists, getArtist,
  getArtistInfo2, getAlbum, getAlbumInfo2, getSong, getMusicDirectory, getGenres, getSongsByGenre, getAlbumList,
  getAlbumList2 (random, newest, frequent, recent, starred, alphabeticalByName, alphabeticalByArtist, byYear, byGenre,
  highest), getRandomSongs, getStarred, getStarred2, search2, search3, getPlaylists, getPlaylist, createPlaylist,
  updatePlaylist, deletePlaylist, stream, download, getCoverArt, getLyrics, getLyricsBySongId, scrobble, star, unstar,
  setRating, getUser, getScanStatus, getNowPlaying. Unknown methods → error 0 "Not supported in Atomix".
- **Ids:** `ar-<id>`, `al-<id>`, `tr-<id>`, `pl-<id>` (smart lists `sp-<id>`, read-only: updating one → error 50).
- **stream:** the original file when no `format`/`maxBitRate` is asked or it already fits; else ffmpeg converts to MP3
  (`format=mp3` or default) or Opus (`format=opus`) at the asked bitrate (32–320), with `timeOffset`. Ranges for the
  original. Counts toward the transcode cap like any conversion.
- Shared and the profile's own playlists list; others' private ones don't. Stars and favourites are the same data as
  Atomix's own (section 0). `scrobble` writes play history (`submission=false` = now playing) and forwards to the
  profile's scrobblers.

## 3. Scrobbling (plan B)

- Per profile, Settings → Profile → **Scrobbling**: ListenBrainz (paste token; checked with `validate-token`), Last.fm
  (**Connect to Last.fm** → last.fm/api/auth with a callback to Atomix → session key stored). Last.fm needs an API key
  and secret entered once by an admin (Settings → Server → Last.fm); without them the Last.fm row explains that.
- "Now playing" at a song's start; a scrobble when it's counted (section 0). Songs only.
- A queue (`scrobble_queue`) holds submissions that failed (network, 5xx) and retries with backoff for 14 days; a
  401/invalid session stops that service for the profile and the card says "Connect again". The card shows the last
  sent and the last error.

## 4. Watch together (plan C)

- Player "…" → **Watch together** → a room with a 6-letter code (no 0/O/1/I) and a link `#/together/<code>`; **Join with
  a code** in the same menu. Anyone signed in may join; a profile that may not see the title (Kids rules, library
  access) is refused with "This title isn't available on your profile". Up to 8 people. Films and episodes only.
- Server room (`src/together.js`, in memory): title, position at a time, playing/paused, members (profile name, ready).
  Each member's player keeps an event stream open (`GET /api/together/:code/events`, Server-Sent Events) and sends its
  actions (`POST …/play|pause|seek|ready|leave`). Each member has its own playback session (quality, subtitles, audio).
- Sync: play/pause/seek by anyone apply to all; a member more than 2 s from the room's position is seeked; while any
  member reports buffering after a play/seek, the room pauses with "Waiting for <name>…" and starts together when all are
  ready (or after 10 s without that member). A strip in the player shows members and "<name> paused" etc.
- The room ends when its last member leaves (or 10 minutes with nobody connected). At the end of a title the room
  stops; anyone may start the next episode for the room.

## 5. Quick Connect (plan C)

- Sign-in page → **Sign in with a code** → a 6-character code (shown big, valid 5 minutes, refreshes).
- Any signed-in profile: Settings → Profile → **Quick Connect** → type the code → **Approve** names the device ("Living
  room TV" from its user agent) → the waiting screen signs in as that account and goes to "Who's watching?".
- 5 wrong codes cancel that code; codes are 6 random characters from the Watch together alphabet (32 letters and
  digits, no 0/O/1/I — 30 bits), compared in constant time. Admin switch in Settings → Server
  (on by default). Approvals go to the activity log.

## 6. Activity log (plan C)

- `activity` (id, at, type, user_id, profile_id, text, ip). Types: sign-in, sign-in failed, quick connect, app password
  (made / first use / revoked), play started / finished (who, what, which screen), watch together, recording, scan,
  settings changed (the setting names only), user/profile added/removed.
- Settings → **Activity** (admins): newest first, filter by type, profile and day, 50 at a time. Kept 30 days.

## 7. Stats (plan C)

- From play history. Settings → Profile → **Stats**: hours watched and listened this week / month / year; top films,
  shows, artists, songs (by plays); a day-of-week × hour grid. Admins: Dashboard → **Household** (per profile totals).
  Kids see only their own.

## 8. Player extras (plan D)

- **Speed:** settings menu → Speed 0.5/0.75/1/1.25/1.5/2 (`playbackRate`, `preservesPitch`); `[`/`]` step. Not for
  Live TV at the live edge (offered when rewound). Back to 1× for the next title.
- **Audio delay:** settings menu → −5…+5 s (0.1 s). A restart of the stream at the current time with `-itsoffset` on the
  audio input (copied, not converted; a file playing as-is becomes a copy with the shift). Remembered per profile and
  title (`play_settings`: profile_id, item_id, audio_delay, subtitle_delay).
- **Subtitle delay:** subtitles menu → −10…+10 s (0.1 s); `Z`/`X` step. Text tracks are shifted in the browser (cue
  times); burned-in subtitles restart with the offset. Remembered per profile and title.
- **Chapters:** from the stored probe (`media.chapters`); items probed before chapters were stored are re-read in the
  background once. Ticks on the seek bar, a **Chapters** menu (name, time, preview picture) and PageUp/PageDown to the
  previous/next chapter (Live TV keeps PageUp/PageDown for channels).

## 9. Edit details and artwork (plan D)

- Admins: title page → **Edit details** (beside Fix match).
  - films/shows: title, sort title, original title, year/release date, plot, tagline, genres, studio, age rating;
  - episodes: title, season/episode number, aired date, plot; albums: title, album artist, year, genres;
    artists: name, biography.
- Artwork: pick from TMDB's posters/backdrops/logos for the title, upload (≤ 10 MB, JPEG/PNG/WebP, checked by its bytes),
  or an address (downloaded once).
- Edited fields are locked (`items.locked_fields` JSON list) so refresh and Fix match leave them; each shows a lock with
  **Unlock** (it follows TMDB again at the next refresh).

## Migrations

19: `plays`, `user_ratings`, `lists.rules`/`lists.media` (kind gains `smart`); 20: `app_passwords`, scrobbler settings
(`profile_scrobblers`: profile_id, service, token/session (server-only), last_ok, last_error) and `scrobble_queue`;
21: `activity`; 22: `play_settings`, `items.locked_fields`.

## Testing

- Node: play counting rules; ratings routes and visibility; smart rule evaluation (every field/op, all/any, sort, limit,
  Kids filtering, shared lists for another viewer); Subsonic auth (t/s, p, enc:, apiKey, revoked), each method's shape
  in XML and JSON against the spec's examples, stream original vs converted, ids; scrobblers against fake ListenBrainz
  and Last.fm servers (now playing, scrobble, queue and retry, 401); Watch together room logic on a fake clock
  (play/pause/seek, drift, waiting, leave, Kids refused) and its SSE route; Quick Connect (expiry, 5 wrong tries,
  approval, constant-time compare); activity entries and pruning; stats sums; audio delay args; locked fields kept on
  refresh; uploads checked by bytes.
- Browser (devtools): stars/hearts, the smart playlist builder, Music apps and Scrobbling cards, two pages in one Watch
  together room (pause on one pauses the other), Quick Connect sign-in in a second context, the Activity tab, Stats,
  speed/delay/chapters menus and keys, Edit details with locks, a11y checks and phone widths.
- Music apps: a Subsonic conformance script calling every implemented method like Amperfy/Symfonium do.
