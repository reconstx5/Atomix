# Atomix Round 19 — encrypted Live TV channels (Widevine / ClearKey over DASH)

Status: approved design (10 Oct 2026). Round 19; recording and pause/rewind move to Round 20.

## Why

Some channels in an IPTV playlist are DASH streams protected with Widevine (Kodi plays them through
inputstream.adaptive and a licensed Widevine module). Atomix plays every live channel through ffmpeg, which can't
decrypt them, so they never load. Browsers ship their own Widevine module and play protected streams through the
standard Encrypted Media Extensions (EME): the browser asks the provider's licence server for a licence that only its
own module can open. Atomix will play these channels that way — in the browser, with a DASH player written for
Atomix — and keep relaying every request so provider addresses still never reach the browser.

Dallas's choices: hand-rolled player (no Shaka/dash.js); every request proxied through Atomix; its own round.

## 1. Scope

**Plays:** a live channel whose playlist marks it as Widevine (`com.widevine.alpha`) or ClearKey (`org.w3.clearkey`)
and whose stream is DASH (`.mpd`, `manifest_type=mpd`, or `mimetype=application/dash+xml`).

**Playlist forms read** (Kodi inputstream.adaptive conventions):
- `#KODIPROP:inputstream.adaptive.license_type=<system>` with `#KODIPROP:inputstream.adaptive.license_key=<key>`.
- `#KODIPROP:inputstream.adaptive.drm_legacy=<system>|<licence url>|<headers>` (newer playlists).
- `#KODIPROP:inputstream.adaptive.manifest_headers=` / `stream_headers=` (`Name=Value&Name=Value`, values URL-encoded):
  sent with the manifest / segments.
- `license_key` = `<url>|<headers>|<post data>|<response>` (every part after the URL optional):
  - headers: `Name=Value&…`, URL-encoded values;
  - post data: empty or `R{SSM}` = the browser's request as-is; `b{SSM}` = base64; `B{SSM}` = base64 then
    URL-encoded; any other text is a template with those placeholders replaced (e.g. `{"challenge":"b{SSM}"}`);
  - response: empty = the body as-is; `B` = base64; `J<field>` = a JSON field as-is; `JB<field>` = a JSON field,
    base64 (dotted paths allowed).
- ClearKey `license_key` may instead be keys: `kid:key` (hex, comma-separated pairs) or `{"<kid>":"<key>"}`; Atomix
  answers the browser's ClearKey request itself.

**Not in scope:** encrypted HLS (FairPlay/SAMPLE-AES), PlayReady, casting an encrypted channel, encrypted radio,
catch-up or recording of encrypted channels, Safari (no Widevine), multiple periods with different keys (the first
period that has video is played; a period change re-reads the manifest and continues), subtitles/text tracks in DASH.

**In the UI:** encrypted channels carry a small lock ("Encrypted") on rows and in the guide; Cast to… and the player's
Cast button are not offered for them; the cast route refuses them (400 "This channel is encrypted, so it can't be cast").

## 2. Server

**Plugin (IPTV Simple).** `m3u.js` keeps the DRM lines; each channel gets `drm: { system, licence }` where `licence`
is the parsed licence description (`{ url, headers, body, response }` or `{ keys: [{ kid, key }] }`), plus
`manifestHeaders` / `streamHeaders`. Stored in the plugin's own storage like the stream URL (never in Atomix's
database, never sent to the browser). The refreshed channel list reports `drm: '<system>'` so the store can mark it.
`stream(key)` returns `{ url, headers, mime, drm }`.

**Database.** Migration 16 adds `live_channels.drm TEXT` (the system name or NULL). Channel and programme shapes gain
`drm: 'widevine'|'clearkey'|null`.

**Encrypted sessions (`src/live/drm.js`, `LiveDrm`).** Pressing play on an encrypted channel:
1. Checks visibility (as now) and takes a slot with the existing per-source reservation (`LiveStreams.reserve`;
   `openOn(source)` counts encrypted sessions too, and the same-profile rule stops the profile's own older stream).
2. Calls `source.stream(key)`; refuses anything but http(s) DASH; fetches the manifest once (with the manifest headers,
   `fetchFollowing` with the per-hop private check, 2 MB cap, 15 s) to check it parses.
3. Creates `{ id, userId, profileId, channelId, channelName, sourceKey, manifestUrl, headers, licence, bases, createdAt,
   lastSeen }` and replies `{ sessionId, delivery: 'drm', keySystem, manifest, licence, channel, programme, next }` —
   `manifest`/`licence` are Atomix paths. `replaces` stops the old session (playback or encrypted) first, as now.
- Sessions end on Stop, on `pagehide` (the player already sends a stop), after 2 min without a ping, when the
  channel or source disappears, and for an admin's Stop; they appear on the Dashboard ("Encrypted" as the mode) and
  count toward the per-account cap of 4.

**Relay routes** (all need the session's own user and profile; anything else is 404):
- `GET /api/live/drm/:sid/manifest.mpd` — fetches the provider's manifest fresh each time (the browser re-reads it
  for live updates), and rewrites it: every `BaseURL` (MPD, Period, AdaptationSet, Representation level) is resolved
  against the manifest URL and replaced by `/api/live/drm/:sid/r/<n>/`, where `<n>` indexes the resolved bases the
  session keeps; absolute URLs in `SegmentTemplate@media/@initialization`, `SegmentURL`, `Initialization@sourceURL`
  and `Location` are mapped the same way; `UTCTiming` sources are replaced by `/api/live/drm/:sid/time` (Atomix's
  clock, ISO text). Nothing else changes (`ContentProtection`, `pssh`, codecs stay as they are). The rewritten text must
  contain no provider host — a test checks every attribute and text node.
- `GET /api/live/drm/:sid/r/:n/*` — resolves the rest of the path (and query) against base `n`; only the same host as
  that base; private addresses refused per hop; sends the stream headers; streams the body with its content-type and
  length; 64 MB per response; 20 s to start answering. Range requests pass through.
- `POST /api/live/drm/:sid/licence` — body ≤ 64 KB. For a licence URL: builds the request from the post-data template,
  sends it with the licence headers (`Content-Type: application/octet-stream` unless the template is JSON/text),
  10 s timeout, and decodes the answer per the response format; replies with the licence bytes. For ClearKey keys:
  reads the browser's request (`{"kids":[…],"type":…}`) and answers a JWK set for the requested kids it has (unknown
  kids → 403 "The playlist doesn't have the key for this channel"). A provider 4xx → 403 "The provider refused this
  channel's licence"; unreachable → 502 "The licence server isn't answering".
- `POST /api/live/drm/:sid/ping` → `{ ok }` (or `{ ok: false, error }` once ended); `POST /api/live/drm/:sid/stop`.
- With Widevine the licence is sealed for the browser's Widevine module: Atomix relays bytes and never holds a key.

## 3. Browser — the DASH player (`public/js/dash/`)

Pure modules (no DOM, Node-tested):
- `xml.js` — a small XML reader to a tree (`{ name, attrs, children, text }`), namespaces kept as prefixes, entities,
  CDATA, comments; refuses DOCTYPE/entities declarations; 2 MB cap.
- `mpd.js` — `parseMpd(text, manifestUrl)` → `{ type: 'static'|'dynamic', availabilityStartTime, publishTime,
  minimumUpdatePeriod, timeShiftBufferDepth, suggestedPresentationDelay, maxSegmentDuration, utcTiming, periods: [{ id,
  start, duration, adaptationSets: [{ type: 'video'|'audio', lang, mimeType, contentProtection: [{ system, kid, pssh }],
  representations: [{ id, bandwidth, codecs, width, height, mimeType, baseUrl, template }] }] }] }` where
  `template = { media, initialization, startNumber, timescale, duration, presentationTimeOffset, timeline: [{ t, d, r
  }] }` merged down the hierarchy; durations (`PT1H2M3.5S`) parsed; system from schemeIdUri (Widevine
  `edef8ba9-79d6-4ace-a3c8-27dcd51d21ed`, ClearKey `e2719d58-a985-b3c9-781a-b030af78d30e` / `1077efec-c0b2-4d02-ace3-3c1e52e2fb4b`,
  `mp4protection` gives `default_KID`).
- `timeline.js` — `segmentsAt(rep, period, mpd, nowMs)`: the segments in the live window (`$Number$` with
  `duration`, or `SegmentTimeline` with `$Time$`/`$Number$`), each `{ number, time, start, end, url }` with
  `$RepresentationID$`, `$Bandwidth$`, `$Number%05d$`-style widths substituted; `liveEdge` = now − max(3 segments,
  `suggestedPresentationDelay`); static manifests from 0. `clockOffset(serverIso, localMs)` for UTCTiming.
- `abr.js` — `pickRepresentation(reps, { throughputBps, bufferedSec, maxHeight, current })`: start at the highest that
  fits 70 % of throughput (first segment: the lowest above 1 Mb/s or the lowest), switch up only with ≥ 10 s buffered,
  down at once when the buffer is under 4 s; never above the screen's height × devicePixelRatio (rounded up to a level).

Browser modules:
- `eme.js` — `setupKeys(video, { keySystem, licenceUrl, contentProtection })`: `requestMediaKeySystemAccess` with the
  representations' codecs (Widevine robustness `SW_SECURE_CRYPTO`), `setMediaKeys`, one session per `pssh` (Widevine)
  or per KID (`keyids` for ClearKey); also handles the `encrypted` event for streams whose keys are only in the init
  segment; `message` → `POST licence` (bytes) → `update`. Errors become sentences: no key system →
  "This browser can't play encrypted channels (it has no Widevine)"; licence 403 → the server's sentence; key status
  `output-restricted`/`internal-error` → "This channel's protection won't play in this browser".
- `player.js` — `class DashPlayer` (`new DashPlayer(video, { manifest, licence, keySystem, onError, onLevels })`,
  `start()`, `destroy()`, `setLevel(id|'auto')`): one MediaSource, one SourceBuffer each for video and audio; loads the
  manifest, sets up keys, appends init then segments from the live edge; keeps 10–30 s ahead, removes more than 30 s
  behind; re-reads a dynamic manifest every `minimumUpdatePeriod` (at least 2 s); a stall longer than 4 s, or falling
  behind the window, jumps to the live edge; a segment error retries 3 times then skips; `QuotaExceededError` trims
  and retries; `destroy()` aborts fetches and frees the MediaSource.
- `public/js/views/player.js` — a play reply with `delivery: 'drm'` uses `DashPlayer` instead of `video.src`; the
  drop/reconnect logic is the player's own; pings go to the encrypted session's ping; Quality offers Auto plus the
  channel's levels; everything else in live mode (badge, programme bar, zapping, Channels overlay, Info, programme
  change) is unchanged. Zapping between encrypted and plain channels swaps engines cleanly.

## 4. Errors (one sentence, Back)

"This browser can't play encrypted channels (it has no Widevine)" · "The provider refused this channel's licence" ·
"The licence server isn't answering" · "The playlist doesn't have the key for this channel" · "This channel's stream
couldn't be read" (manifest unparsable / no playable video) · "This channel's protection won't play in this browser" ·
the existing limit 409 "Your provider allows N stream(s) at a time — stop the other one first" ·
"This channel is encrypted, so it can't be cast".

## 5. Testing

- Node: `xml.js`, `mpd.js` (number templates, timelines with `r` and `t`, BaseURL nesting, PTO, multi-period,
  ContentProtection systems/KIDs/pssh, durations), `timeline.js` (live edge with a fake clock, window limits,
  startNumber, `%05d` widths, timeline repeats, clock offset), `abr.js`; IPTV Simple's DRM lines (each licence-key
  form, drm_legacy, headers, ClearKey keys); `LiveDrm` and the relay (no provider host in the rewritten manifest, other
  hosts and private addresses refused, licence forwarding raw/base64/template and each response form, ClearKey JWK
  answer and unknown kid, owner/Kids 404, the stream limit and same-profile rule, ping/stop/reaper, Dashboard
  listing, cast refusal), migration 16.
- Pretend provider (`devtools/mock-iptv.mjs`): two ClearKey channels — a live looping DASH (VP9/Opus, because the
  test browser has no H.264), encrypted with MP4Box (a cloud-only dev tool), served as a dynamic manifest whose segment
  numbers follow the clock (the segment's decode time is rewritten so the loop is seamless) with a ClearKey licence
  server; and one whose keys are in the playlist. `live-ui.mjs` section `drm`: plays (time advances, no error), zaps
  encrypted → plain → encrypted with one session open, a refused licence shows its sentence, no request from the page
  goes to the provider's host, phone width fits, no console errors.
- Widevine itself can't run in the cloud (the test browser has no Widevine module). Its code differs only in the key
  system name, robustness and opaque licence bytes the relay forwards; it is checked on Dallas's PC in Chrome when a
  Widevine channel is live (TVNZ 1/2 and DUKE don't currently play in Kodi either).

Two plans: **A** — plugin DRM lines, migration 16, `LiveDrm` and the relay, and the pure player modules (`xml`, `mpd`,
`timeline`, `abr`); **B** — `eme.js`, `player.js`, the Live TV player and UI, the pretend provider, browser checks, docs,
v0.17.0.
