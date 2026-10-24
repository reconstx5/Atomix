# Atomix Round 20 — the tidy-up (every open deferred minor, v0.14–v0.17)

Status: design approved in chat (10 Oct 2026, "looks right"). Version **v0.18.0**. Next round (21): Live TV recording
and pause/rewind, which builds on the Live TV code tidied here.

## Why

Four review rounds left ~84 deferred minors (listed in the project note, `claude/build-status.md`). Dallas chose to
close all of them before DVR. Each is small; together they touch the relay, Live TV, casting, libraries, sign-in, the
encrypted player, the Live TV pages and the Orbit theme. Item ids below (17A-3, 16B-5, 14-8…) follow the note's
sections: version, plan, position.

## Out of scope (rulings, recorded in the ledger)

- **17A-9 BaseURL failover** and **17A-16 DNS rebinding** (a pinned-address agent): need a library or a real
  multi-server provider to build and test against. Stay deferred.
- **17A-15** (`D{SSM}`/`{SID}`/`{KID}`/`%` licence forms) and **15B-12** (the v0.15 spec deviations): earlier rulings
  stand; no change.
- **16A-4** is already fixed (no user agent mentioned in `serveImage`).
- **17B-17** lives in the dev tool `live-ui.mjs`; it's done in Plan B's browser checks, not in the repo.

## Global rules

- Each item gets a test that fails first (Node test where the logic is pure or server-side; the devtools browser
  suites for view-only behaviour). No dependencies. Older themes stay pixel-identical (`oldthemes-compare.mjs
  compare` → "all pages match") except the two Orbit-only changes named in Plan C.
- New sentences are exactly as written here. Migrations append (17, 18…).

## Plan A — server (relay, Live TV, plugin, casting, libraries, sign-in)

**Encrypted relay (`src/live/drm.js`)**
- 17A-1/2: a segment target is built as the base origin + `'/' + rest` + the query (no relative resolve), so a colon
  in the first path part and a double slash in a provider path both work; the `rest.startsWith('/')` refusal goes.
- 17A-3: upstream segment requests send `accept-encoding: identity`; if a provider still answers encoded,
  `content-length` isn't forwarded.
- 17A-4: a non-2xx segment answer (other than 206) reaches the browser as 502 "This channel's stream couldn't be read".
- 17A-5: a manifest re-read answered 401/403/410 asks the source's `stream()` once for a fresh address
  (`s.manifestUrl`, headers, licence updated), then retries; a second failure is the existing 502.
- 17A-6: a session keeps at most 32 provider origins; more → the manifest is refused ("too big").
- 17A-7: `/api/live/drm/:sid/time` answers the provider's own UTCTiming clock when the manifest has one (fetched
  server-side through the session's checks, cached 60 s; `urn:mpeg:dash:utc:direct:2014` values used as given;
  unreadable → Atomix's clock).
- 17A-8: stream headers' credentials (Authorization, Cookie, Proxy-Authorization) go only to the manifest's own origin.
- 17A-10: Period/AdaptationSet-level SegmentBase/SegmentList are inherited into each Representation before rewriting.
- 17A-13: a body over the cap without Content-Length is answered 413 (stop buffering, drain, `Connection: close`)
  instead of a reset (`src/http/router.js` `readBody`).
- 17A-14 and 15A-6: host names are resolved and refused when they resolve to link-local (169.254/16, fe80::/10) or the
  unspecified address — for a home-network manifest's hops too, and for image downloads, server connections, cast
  device fetches and the IPTV plugin's playlist/guide fetches (an async resolve-and-check beside `isPrivateTarget`).

**IPTV Simple (`plugins/iptv-simple/`)**
- 17A-11: ClearKey keys in JWK form (`{"keys":[{"kty":"oct","kid":"…","k":"…"}]}`) are read (base64url → hex).
- 17A-12: `#KODIPROP:inputstream.adaptive.stream_params=` / `manifest_params=` (query strings appended to segment /
  manifest addresses by the relay), `license_data=` (base64 init data for the key system, used when the manifest
  carries none: the browser opens its key session with it), and `server_certificate=` (base64; the browser calls
  `MediaKeys.setServerCertificate` before the first request). Both reach the browser in the play reply; neither is a
  provider address.
- 16A-7: the first channel with a tvg-id keeps it as its key; later duplicates get the address hash.
- 16A-8: `guideShift` clamped to −24…24 hours; not a number → 0.
- 16A-11: the 30-s limit covers reaching the server; the download then fails only after 30 s with no data.
- 16A-14: programmes for guide channels matched to no playlist channel aren't kept in memory (filtered as read).

**Live TV core (`src/live/`, `src/api/live.js`)**
- Guide count: unmatched channels are counted and listed separately for TV and radio. The summary says
  "8 TV channels without guide" (radio isn't mentioned in the summary); the Settings card lists the TV ones, then a
  folded "Radio without guide (415)" group. The names are stored (16A-10: migration, `live_sources.unmatched` JSON),
  so they survive a restart.
- 16A-6: a channel missing from a refresh is hidden (`missing_since`, migration) — not in lists, guide, search, zapping
  or Home — and deleted after 7 days missing; if it comes back its id, favourites and number return.
- 16A-1: `replaces` only discounts a session of the same account.
- 16A-2: a 409 names the holders only to the same profile, or to an admin on a non-Kids profile; otherwise
  "Your provider allows N stream(s) at a time — another profile on your account is using it".
- 16A-3: a Kids profile's `/api/live/status` counts only the channels it can see.
- 16A-5: `ImageCache.download` refuses images over 10 MB (Content-Length or streamed size).
- 16A-9: a plugin setting change refreshes the source only when a setting that changes channels or the guide
  changed (playlist, guide, userAgent, numbering, startNumber, guideShift, logosPath, catchupDays).
- 16A-12: a copied (not converted) live radio stream doesn't count toward the conversion cap.
- 16A-13: a channel's probe result is reused for 10 minutes, so a start opens one provider connection.
- 16B-7: a stream refused by another profile's streams is refused before any of the caller's own streams (including
  a TV's) are stopped.

**Casting (`src/cast/`)**
- 16B-5: Stop pressed on a DLNA TV's own remote during a live cast ends with "Stopped on <TV name>."
- 14-9: DLNA Seek faults 701 and 602 at the start are treated like 710 (the converted fallback runs).
- 14-10: a DLNA start that drops the chosen subtitle (no libass) carries the existing libass sentence as the
  session's notice, shown in the player and on the Remote.

**Libraries, sign-in, playback, remote**
- 15A-1: the setup code is skipped only for a loopback socket addressed to localhost/127.0.0.1/[::1] with no
  forwarding headers and `trustProxy` off.
- 15A-2: `trustProxy` may be a number N (trusted hops): the client address is the Nth entry from the right of
  X-Forwarded-For (`true` stays 1).
- 15A-3: Settings → Libraries → a library's "…" → **Remove missing titles**, with an in-page confirmation ("Remove
  N titles whose files are gone?"), runs a scan that prunes even when the folder is empty.
- 15A-4/5: the software transcode cap uses the displayed height (rotation 90/270 → width), and when it binds,
  `reasons` gets "Capped at {cap}p (software conversion)".
- 15A-7: the keyframe search looks 30 s back, then 60 s if none is found.
- 14-1/2: detaching the last member deletes an emptied TMDB collection; a detached film leaves the old collection's
  "missing" parts.
- 14-3: the remote progress reporter drops its entry for a session that has stopped (and prunes entries over 1 h).
- 14-6/7: the lyrics catch-up caches "none pending" until the next scan; the Settings count is cached 60 s.
- 14-8: a missing ffprobe doesn't mark songs as lyrics-checked.

## Plan B — browser (encrypted player, Live TV pages, guide, accessibility)

**DashPlayer (`public/js/dash/`)**
- 17B-1: each SourceBuffer's work (append, remove, changeType, timestampOffset) runs through one queue per track.
- 17B-2: append listeners are removed after each append.
- 17B-3/4: `get()` refuses after destroy and refuses any address not on the page's own origin.
- 17B-5/6/7: a static manifest: a stall nudges forward 0.1 s (no jump to the start); its end shows
  "This programme has ended" with the controls; the refresh loop stops once the manifest is static.
- 17B-8: only video segments feed the throughput estimate.
- 17B-9: a refresh that changes the video levels calls `onLevels` again; an open Quality menu redraws.
- 17B-16: a licence 404 is "This channel's stream couldn't be read" (so the restart budget applies); 401 is
  "Your sign-in has expired — sign in again".

**Player view, Live TV pages, guide (`public/js/views/`, `public/js/live.js`)**
- 17B-10: Info's mode heading for an encrypted session reads "Encrypted".
- 17B-11: an old engine's error is ignored once a newer channel was asked for.
- 17B-12: a play() rejection from an interrupted start (AbortError, or an older session) doesn't show the big Play
  button.
- 17B-13: a failed engine load stops the session before the error.
- 17B-14/15: the lock is a visible icon plus visually-hidden text "Encrypted"; guide programme buttons and the
  phone guide's channel picker include ", encrypted".
- 16B-1: the next programme only becomes "now" once it has started.
- 16B-2: leaving the player cancels a pending channel change (`zapQueue.cancel()`).
- 16B-3: channel up/down before the channel list has loaded does nothing.
- 16B-4: the guide's "more rows" ignores an answer for a window that has since moved.
- 16B-6: saving a Kids profile keeps the Live TV ticks of sources not shown (the server replaces only the sources
  sent).
- 16B-8: the Channels page's timer isn't re-armed after leaving.
- 15B-2: a notice's dismiss listeners go when the next notice replaces it.
- 15B-3: closing a menu whose button is hidden (phone width) returns focus to "More controls".
- 15B-9: empty-state lines inside menus are `role="none"`/`aria-disabled` items, not stray paragraphs.
- 17B-17 (devtools): `live-ui.mjs` zaps plain ↔ encrypted with PageUp/PageDown inside the player.

## Plan C — older polish (components, Orbit theme, lists, intro editor)

- 15B-1: `rowActions` switches between wide and compact with the window (both rendered; CSS chooses).
- 15B-4: the watchlist button keeps the accessible name "Watchlist"; `aria-pressed` carries the state.
- 15B-5 (Orbit only): the large-text rule for 600–999 px applies only at ≥ 1.5 device pixels per CSS pixel.
- 15B-6/7: `--bg-rgb` is replaced by `color-mix()` on `--bg`; `.picker-profile`'s `#05050c` becomes `var(--bg)`.
- 15B-8 (Orbit only): the logo keeps its own colours (`--logo-b` no longer follows the accent).
- 15B-10: Shuffle all is disabled for an empty music library (no toast).
- 15B-11: the plain-paragraph empties in lists and settings use `emptyState`.
- 14-4/5: `formatClock` rounds to tenths before splitting (42.97 → 0:43.0); the intro editor saves only a changed
  value.

## Testing

Node tests in the existing files named per item (live-drm-relay, iptv-drm, iptv-m3u, iptv-plugin, live-store,
live-stream, live-api, live-refresh, cast-live, cast-dlna, cast-sessions, passover-server, passover-library,
passover-ffmpeg, passover-keyframes, collections, remote-*, extras-*, dash-player, dash-eme, live-client, dom).
Browser suites: `live-ui.mjs` (drm, channels, guide, player, admin), `qol-ui.mjs`, `a11y-ui.mjs`, `orbit-*.mjs`,
`lists-ui.mjs`, `music-ui.mjs`, plus `oldthemes-compare.mjs`. Delivered as v0.18.0 with the usual hash-checked copy
to the PC, PC tests, the project note and pictures of the visible changes.
