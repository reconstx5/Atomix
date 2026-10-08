# Atomix v0.14.0 — the casting polish and the QoL leftovers

Round 16. Dallas asked for "improvements on any of the features or QoL features" and chose: **polish the casting**
(the ten leftovers from the v0.13 review) and **player & library QoL** (four groups of leftovers from earlier
reviews: episode cards saying what's left, remote-friendly lists, smoother player bits, library tidy-ups). Nothing
new is added to the surface beyond what those imply.

## 1. Constraints

- Node ≥ 22.13, zero npm dependencies, plain ES-module browser JS, no build step. Orbit first with a TV remote; the
  older themes change only where this spec changes content (the episode captions).
- Version `0.14.0`. **No migration**: nothing changes in the schema.
- Nothing new leaves the server. Tokens and secrets never reach a browser or a device.
- Copy, exactly as written: "Watched", "<n> min left", "+30 s" / "−30 s" / "+60 s" / "−60 s", "Play this song",
  "This ffmpeg can't draw subtitles onto video (it needs libass)".

## 2. Casting polish (`src/cast/`, `src/remote/progress.js`, `public/js/cast.js`)

1. **Progress reports per viewer** (`src/remote/progress.js`). The reporter's 10 s throttle map (`last`) and its
   pending-report map (`waiting`) are keyed by `sessionId || item.id` (the hook already carries `sessionId`). A
   pending report whose `watched` is true is never replaced by a later non-watched one (the newer run is dropped;
   the watched one goes). The per-session `last` entry is cleared on that session's stop.
2. **DLNA resume on a TV that can't seek** (`CastManager.play`). When `start > 0` and the device's `seekSupported`
   is false after the load (the TV refused `Seek`, fault 710), the manager restarts the same title as a converted
   stream from `start` (`forceTranscode`, as `seekTo` does) instead of leaving it playing from 0. A TV that already
   reported no seek support skips the native attempt: a start above 0 goes converted at once.
3. **A stale status after a load** (`DlnaDevice`). `load()` increments `this.generation`; `refresh()` captures it at
   the start and drops its result (no `update`, no "taken") when the generation changed while its SOAP calls were in
   flight.
4. **Links die first** (`CastManager.end`). `revokeCast(s.id)` runs right after `s.ended = true`, before the progress
   save and the device Stop.
5. **A subtitle downloaded mid-cast** (`CastManager.command('subtitle')`). On a Chromecast, if the chosen text
   subtitle has no track in `s.tracks` (it arrived after the load), the manager restarts at the current position
   with the fresh subtitle list, as it does for a picture subtitle. `s.subtitleId` and `s.audioIndex` are set only
   after a restart succeeds (the old values stay on a failure).
6. **A deleted profile** (`src/app.js` cast-link block). A link whose `profileId` no longer resolves to a profile of
   its user is refused with 401 "This cast link has ended."; `CastManager` ends a session whose profile is gone
   (checked on the next status) with `lost` and "Atomix lost touch with <device>." (the TV's requests fail, so the
   stream ends either way).
7. **The address stays with admins** (`src/api/cast.js`). `GET /api/cast/devices` includes `baseUrl` only for
   admins (others get `baseUrl: null`; `reachable` is still answered for everyone). `?refresh=1` is honoured only
   for admins; others get the cached list (which `CastDevices` refreshes itself after 5 minutes). The picker shows
   **Find devices again** only to admins; Settings → Casting is admin-only already.
8. **Cheaper Remote polling** (`CastManager.play`, `toJson`). `play()` stores `s.subtitles` (the serialized
   subtitle list), `s.previews` and the queue's `{ id, title }` list once; `toJson` reads them. The subtitle
   download route (`POST /api/items/:id/subtitles/download`) calls `core.cast.manager.subtitlesChanged(itemId)`,
   which re-reads the list for any live session on that item.
9. **One poll chain in the browser** (`public/js/cast.js`). `refreshCast` keeps an in-flight promise: a call while
   one is running sets `again = true` and returns that promise; when the poll ends and `again` is set, it polls once
   more at once, then schedules the next as usual. `music.setProfile` resets the volume to the device's remembered
   value (`VOLUME_KEY`, else 1) when the new profile has no `musicVolume` pref.
10. **Orphaned subtitle files and the libass message.** `play()` deletes the `.vtt` it wrote whenever it throws
    before `playback.create` succeeded; `CastManager`'s constructor empties `<transcodeDir>/cast-subs`.
    `detectTools` adds `filters.subtitles` (the `subtitles` filter in `ffmpeg -filters`). Choosing a text subtitle
    on a DLNA TV when it is false answers 400 "This ffmpeg can't draw subtitles onto video (it needs libass)" and
    nothing restarts; a start with a text subtitle on DLNA under the same condition loads without the subtitle
    and the session's `subtitleId` stays null.

## 3. The player and the remote (`public/js/`)

- **Episode cards say what's left.** A shared `episodeCaption(ep)` in `components.js` returns `"Watched"` when
  `progress.watched`, `"<n> min left"` when `progress.position > 30` and not watched (n = ceil of the remainder in
  minutes, at least 1), else the running time as today (`formatRuntime`). It is used by the season row on a show's
  page (`views/item.js`), Continue watching / Next up and the landscape cards (`wideCaption`, whose `left` for
  episodes becomes `label, Watched|<n> min left` and otherwise the label alone). Films are unchanged. Older themes
  show the same text.
- **The Up next ring sweeps.** The ring is driven by a CSS custom-property animation (`@property --left` with a
  10 s linear `animation` from 1 to 0, `animation-play-state: paused` under `.reduce-motion`, where the per-second
  `--left` updates keep stepping as today). The animation starts when the card is shown; "Starting in N s" keeps
  ticking per second.
- **"+30 s" while scrubbing.** `Scrubber.press` returns the step it used (`{ target, step }`; `press` keeps
  returning the target for old callers via a `lastStep` property). The seek-preview bubble gets `setStep(text)`:
  the player and the cast Remote show `+30 s` / `−30 s` / `+60 s` / `−60 s` beside the time when the step is above
  10, and nothing at 10 (`"+10 s"` is the default and not shown).
- **Notice buttons reachable with arrows.** The player's arrow pool (`.player-controls button, .player-top button`)
  also includes `.player-notice button` and the subtitle menu's buttons, so Left/Right reach "Watch it", "Start
  over" and the search's **Search**. Up from the control row lands on the notice's button when one is showing.
- **The intro editor keeps fractions.** Start/End parse and show tenths (`0:42.5`, `formatClock` with one decimal
  when the value isn't whole); the save sends the decimal unchanged; the server stores it as it is (it already
  takes a float).
- **Remote-friendly lists** (`views/lists.js`). Move up/down and Remove update the list in place (`renderItems`
  re-renders only the items container) and focus the moved item's card (after a remove: the next item, else the
  previous, else Play). The song menu's **Lyrics** entry navigates to `#/now-playing?song=<id>`: Now Playing shows
  that song's cover, title and lyrics (from `/api/items/:id/lyrics`) without changing the queue, with a **Play this
  song** button (`music.playTracks([song])`) in place of the transport when it isn't the current song; when it is
  the current song, Now Playing is as today.

## 4. Library tidy-ups (`src/library/`, `src/lyrics.js`, `src/collections.js`)

- **A show left with only extras.** `Scanner.prune` also deletes shows (and seasons) in the library with no episode
  left under them — `NOT EXISTS (SELECT 1 FROM items e WHERE e.show_id = s.id AND e.kind = 'episode')` — so a show
  whose only children are extras goes, extras and all. A show whose episodes return is re-created by the next scan.
- **Embedded lyrics for songs scanned before 0.10.** After a scan, `Scanner.lyricsCatchUp(lib)` re-probes, at low
  priority through the task runner, every track whose stored `media.tags` has no `lyrics` key *and* no
  `lyricsChecked` marker; it writes `tags.lyrics` when found and `tags.lyricsChecked = true` either way, so each song
  is read once. The dashboard's background-task line counts the songs waiting.
- **A stored "no lyrics" is retried after a re-tag.** When the scanner sees a track's file size or mtime change, it
  deletes that song's `lyrics` row when its `source` is `none` or `tags` (a `file` row has its own mtime check).
- **"N of M" follows TMDB.** `Collections.upsertFromTmdb` updates a non-manual collection's `parts`, `overview`
  (when ours is null), `poster` and `backdrop` when TMDB's differ (`updated_at` bumped); the name is never
  overwritten. On a film's refresh, if TMDB no longer lists the film in that series (`belongs_to_collection` null
  or another id), the film is detached from the old collection (`collection_items` row removed; an empty
  non-manual collection is deleted).

## 5. Errors and edge cases

- Per-session reporter keys fall back to the title for callers without a session (plugins, old clients).
- A DLNA no-seek restart that fails ends the cast with the usual "didn't answer" / "couldn't load" notes.
- A mid-cast subtitle restart that fails keeps the previous subtitle and answers 502; the cast ends as `error`
  (as any failed restart does).
- `baseUrl: null` for non-admins never changes `reachable`; the picker's "Casting needs Atomix on the same home
  network" message still shows only when `reachable` is false.
- The libass check is made once at startup with the other tools (Re-check ffmpeg refreshes it).
- The lyrics catch-up skips remote (connected-server) tracks and files that can't be probed (marked checked so they
  aren't retried every scan).
- A collection detach never touches manual collections or renamed ones' names.

## 6. Testing

- **Server** (node:test, existing fakes): reporter keys per session and the watched guard (`remote-play`); DLNA
  no-seek resume restarting converted, the stale-poll generation, links revoked before Stop, the mid-cast subtitle
  restart, the deleted-profile link, admin-only `baseUrl`/refresh, cached `current` fields, `.vtt` cleanup, the
  libass message (`cast-sessions`, `cast-dlna`, `cast-links`, `cast-discovery`); show-with-only-extras pruned,
  the lyrics catch-up and the re-tag reset (`scanner`/`extras`/`lyrics` tests); collection parts updating and a
  dropped film detached (`collections`, `lists-api`); the fraction-of-a-second marker round trip.
- **Browser** (Playwright): a new `devtools/qol-ui.mjs` (episode captions on a show's page and Home; the ring's
  animation and its paused state under Reduce motion; the `+30 s` label; arrowing onto "Watch it"; tenths in the
  intro editor; playlist focus after move/remove; Lyrics keeping the queue and **Play this song**); `cast-ui.mjs`
  gains a non-admin picker check (no **Find devices again**, no address in the API answer) and the single poll
  chain (request counting). The full set as before; the older-theme pixel compare, with the pages the episode
  captions change re-baselined and noted.
- **Delivery**: hash-checked against the v0.13.0 snapshot; `npm test` on the PC; project note; a fresh reviewer and
  one fix pass; pictures `orbit-progress/v0140-desktop.png` and `v0140-phone.png`.

## 7. Out of scope

Photo libraries, the Last.fm scrobbler, the older review leftovers not named above, and testing casting on real TVs.
