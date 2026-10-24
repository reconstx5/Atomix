# Atomix v0.16.0 — Live TV design

Round 18. Dallas: "create a plugin for Atomix that is based on / a copy of IPTV Simple Client for Kodi PVR". Kodi's `pvr.iptvsimple` is GPL; this is an **original implementation** of the same job, written from the M3U and XMLTV formats and IPTV Simple's feature list, with no Kodi code.

Dallas's choices: it must handle **a paid IPTV provider, free public lists, his own tuner/server and a local M3U file**; Live TV gets **its own section** (not just an Add-ons source); built as **a Live TV core in Atomix plus an `iptv-simple` plugin**; in this round: **catch-up**, **casting**, the **"On now" home row**, **radio channels** and **Kids groups**. Pause/rewind live (timeshift) and recording (DVR) were chosen too and go to **Round 19** with their own spec, since both write a live stream to disk. One playlist/guide pair per source in this round (several playlists were not chosen).

Project-wide constraints (unchanged): Node ≥ 22.13, zero dependencies, plain ES-module browser JS, no build step. Tokens travel in headers, never in browser-visible URLs (`?cast=` links excepted). No route returns `servers.secret`/`extra`. Kids profiles never see unrated/adult content or admin data. Admin-only stays admin-only. Older themes stay pixel-identical outside the new pages. Outbound destinations gain one: **the playlist, guide and stream hosts an admin configures** in a live source (nothing else new leaves the server).

## 1. Architecture and data

**The hook.** Plugins get `api.registerLiveSource(source)`:

```
{
  id, name,
  refresh(ctx)                       → { channels: Channel[], programmes: Programme[], warnings?: string[] }
  stream(channelKey, ctx)            → { url, headers?: {name: value}, mime?: string }
  catchup(channelKey, programme, { from }, ctx) → { url, headers?, duration }   // from: seconds into the programme
  settingsSummary?()                 → string                                     // shown with the last refresh
}
Channel   = { key, number?, name, group: string[], logo?, radio: boolean, guideId?, catchup?: { mode, days, source?, correction? } }
Programme = { guideId, start: ms, end: ms, title, subtitle?, description?, category?: string[], episode?, image? }
```

Atomix owns all storage: a plugin never touches the database. `channelKey` is the plugin's stable id for a channel (the `tvg-id` + URL hash in `iptv-simple`). `ctx` carries `{ signal, log, fetch, maxStreams }`.

**Migration 15.**
- `live_channels (id INTEGER PK, source TEXT, key TEXT, number INTEGER, name TEXT, groups TEXT /*JSON array*/, logo TEXT, radio INTEGER, guide_id TEXT, catchup TEXT /*JSON or NULL*/, hidden INTEGER DEFAULT 0, sort INTEGER, updated_at INTEGER, UNIQUE(source, key))`
- `live_programmes (id INTEGER PK, channel_id INTEGER REFERENCES live_channels ON DELETE CASCADE, start INTEGER, end INTEGER, title TEXT, subtitle TEXT, description TEXT, categories TEXT, episode TEXT, image TEXT)` with an index on `(channel_id, start)` and on `(start)`.
- `live_favourites (profile_id INTEGER REFERENCES profiles ON DELETE CASCADE, channel_id INTEGER REFERENCES live_channels ON DELETE CASCADE, position INTEGER, PRIMARY KEY (profile_id, channel_id))`
- `live_kids_groups (profile_id INTEGER REFERENCES profiles ON DELETE CASCADE, source TEXT, grp TEXT, PRIMARY KEY (profile_id, source, grp))`
- `live_sources (id TEXT PK /*plugin/source*/, last_refresh INTEGER, last_ok INTEGER, channels INTEGER, programmes INTEGER, unmatched INTEGER, warning TEXT, error TEXT)`

**Core modules.**
- `src/live/store.js` — `replaceChannels(source, channels)` (upsert by `(source, key)`, keeps ids so favourites survive; channels gone from the playlist are deleted), `replaceProgrammes(source, programmes, { window })` (programmes keyed to channels by `guide_id`, replacing the window's rows for that source in one transaction), `channels(viewer, { group, favourites })`, `nowNext(channelIds, at)`, `guide(viewer, { from, to, channelIds })`, `programme(id)`, `favourites`, `kidsGroups`, `prune(now)`.
- `src/live/refresh.js` — runs a source's `refresh()`, validates the shape, writes the store, records `live_sources`. A failed refresh keeps the last good data. On its own timer (not the task runner, which pauses while video converts): channels every *N* hours (plugin setting, default 6) and immediately when the plugin's settings change; the guide also when its furthest programme is under 24 h away. The window kept is `now − max(catch-up days, 1 day)` to `now + 7 days`; older and later rows are pruned.
- `src/live/stream.js` — turns a channel or a catch-up programme into a playback session (§3).
- `src/api/live.js` — the routes (§4).

**Permissions.** Live TV is invisible to a Kids profile unless an admin has ticked groups for it; a Kids profile sees only channels in at least one ticked group, and their programmes. Non-admin adults see every channel. Provider URLs, credentials inside them and request headers never reach the browser: routes return channel ids, names, logos (proxied, §4) and programme data only. Logos are fetched by the server and served from `/api/live/channels/:id/logo` (cached on disk like other images), because they're often `http://` and would otherwise reveal the provider host.

## 2. The `iptv-simple` plugin

`plugins/iptv-simple/` — `plugin.json`, `index.js` (setup and the hook), `m3u.js`, `xmltv.js`, `catchup.js`, `match.js`. All parsing is pure and tested on fixtures.

**Settings** (Settings → Plugins, admin only):
- `playlist` — an `http(s)://` URL or an absolute file path on the server.
- `guide` — URL, file path, or empty = use the playlist's `url-tvg`/`x-tvg-url`.
- `userAgent` — default `Atomix/<version>`.
- `refreshHours` — 1, 6, 12, 24 (default 6).
- `numbering` — `playlist` (use `tvg-chno`, else playlist order) or `order` (playlist order only); `startNumber` (default 1).
- `guideShift` — hours, −12…+14 (default 0), applied on top of each programme's own offset.
- `logosPath` — optional folder or URL prefix for bare logo file names.
- `maxStreams` — "Streams at once": 1, 2, 3, 4, unlimited (default 1 when `playlist` is a URL, unlimited for a file).
- `catchupDays` — default days when the playlist doesn't say (default 7).

**M3U parsing (`m3u.js`, `parseM3u(text, opts) → { header, channels, warnings }`).**
- Accept a BOM, CRLF/LF, blank lines, and a missing `#EXTM3U` (warning only).
- Header attributes: `url-tvg`, `x-tvg-url` (comma-separated lists: the first is used, all are recorded), `catchup`, `catchup-days`, `catchup-source`, `tvg-shift`.
- `#EXTINF:<duration> <attrs>,<name>`: `tvg-id`, `tvg-name`, `tvg-logo`, `tvg-chno`, `channel-number` (alias), `group-title` (split on `;`, trimmed, empty dropped), `radio="true"`, `tvg-shift`, `catchup`, `catchup-days`, `catchup-source`, `catchup-correction`. Attribute values may be double- or single-quoted; unknown attributes are ignored.
- `#EXTGRP:<group>` adds a group to the next channel.
- `#EXTVLCOPT:http-user-agent=…` and `http-referrer=…` set headers for the next channel.
- `#KODIPROP:` lines: only `mimetype=` / `inputstream.adaptive.manifest_type=` are read, as a mime hint; anything else is ignored.
- URL suffix `url|Name=Value&Name2=Value2` (values URL-decoded) adds headers (`User-Agent`, `Referer`, `Origin`, `Cookie` honoured; others passed through).
- A channel with the same final URL as an earlier one is dropped (warning count). A channel whose name is empty takes `tvg-name`, else "Channel N".
- `key` = `tvg-id` (if present and unique) else a SHA-1 of the URL (first 16 hex).
- 20 000 channels parse in under 1 s.

**XMLTV parsing (`xmltv.js`, `parseXmltv(stream | string, { shiftHours }) → async { channels: Map<id, names[]>, programmes }`).**
- A hand-written streaming tokenizer: tags, attributes, text, CDATA, the five predefined entities and numeric character references; comments and `<?…?>`/`<!DOCTYPE>` skipped. Fed in chunks, so memory stays bounded by one programme.
- `<channel id>` with every `<display-name>`; `<programme start stop channel>` with `<title>`, `<sub-title>`, `<desc>`, `<category>` (all), `<episode-num system="xmltv_ns">` ("S{a+1} E{b+1}", parts missing → omitted), `<episode-num system="onscreen">` (as written, preferred when present), `<icon src>`.
- Times `YYYYMMDDhhmmss ±hhmm` (offset optional = UTC); `guideShift` added. A programme without `stop` ends at the next programme's start on that channel; one that still has none is dropped.
- `.gz` (by magic bytes, not the name) unpacked with `zlib.createGunzip()`; `.xz` and `.zip` → error "This guide is compressed as .xz/.zip — Atomix can read plain or .gz XMLTV".
- Malformed XML fails with "The guide file isn't valid XMLTV (line N)"; a file with no `<tv>` root fails with "The guide file isn't XMLTV".

**Matching (`match.js`).** Guide channel for an M3U channel: `tvg-id` = XMLTV id (exact, then case-insensitive); else `tvg-name`, else channel name, against every display name, normalised (lower case, accents stripped, punctuation and spaces removed, a trailing " hd"/" fhd"/" uhd"/" 4k" ignored). Unmatched channels are counted in `live_sources.unmatched` and listed (first 20 names) on the plugin page.

**Catch-up URLs (`catchup.js`, `catchupUrl(channel, liveUrl, { start, end, now, from })`).** `start`/`end` are the programme's (ms); `from` shifts the start for seeking; `catchup-correction` (hours) is added. Modes:
- `default` — `catchup-source` as a full template.
- `append` — `liveUrl` + `catchup-source`.
- `shift` / `timeshift` — `liveUrl` + `?utc={utc}&lutc={lutc}` (or `&` when the URL already has a query).
- `flussonic` / `flussonic-hls` / `flussonic-ts` — the live URL's `/<stream>/<file>` becomes `/<stream>/<file-type>-<utc>-<duration>.<ext>` (`index-…m3u8` for HLS, `archive-…ts` for TS).
- `xc` / `xtream` — `http(s)://host[:port]/live/<user>/<pass>/<id>.<ext>` becomes `/timeshift/<user>/<pass>/<minutes>/<YYYY-MM-DD:HH-MM>/<id>.<ext>`.
- Template tokens: `{utc}` `{start}` (seconds), `{utcend}` `{end}`, `{lutc}` `{now}` `{timestamp}` (now), `{duration}` (seconds), `{duration:N}` (divided by N), `{offset:N}` (seconds ago ÷ N), `{Y} {m} {d} {H} {M} {S}` (programme start, UTC), `${start}`/`${end}`/`${timestamp}`/`${duration}` forms, and `{utc:FORMAT}`/`${start:FORMAT}` with `Y m d H M S` letters.
- A channel offers catch-up only for programmes that ended (or started, for Start over) within its `catchup-days` (channel, else header, else `catchupDays` setting).

**Refresh** fetches with the user agent, 30 s timeout, `fetchFollowing` (same-origin redirects), a 200 MB size cap; a file path is read directly (admin-chosen; must be absolute and a regular file). HTTP errors: "The playlist didn't answer (HTTP 403) — check the address and that your subscription is active", "The guide didn't answer (HTTP 404)", "The playlist took too long to answer". `settingsSummary()` gives "312 channels in 14 groups · guide to Sat 6 pm · 12 channels without guide".

## 3. Playing live TV, catch-up, radio and casting

**`src/live/stream.js`, `startLive({ user, profile, viewer, channelId, caps, quality, replaces, audioOnly })`.**
1. Checks the viewer may see the channel (404 "This channel no longer exists." otherwise).
2. Checks the source's stream limit: live/catch-up sessions open on that source, not counting `replaces`. Over the limit → 409 "Your provider allows 1 stream at a time — stop the other one first" with `{ holders: [{ profile, channel }] }` (names only; admins see all, others see "someone else in your household").
3. Stops `replaces` **before** asking the plugin for the new URL (a 1-stream provider refuses an overlapping connection).
4. Calls `source.stream(key)`, probes it with ffprobe (`-rw_timeout 8000000`, the headers, `-analyzeduration 5000000 -probesize 5000000`), and builds a synthetic item `{ id: 'live:<channelId>', kind: 'live', title, media: <probe summary>, duration: null }`.
5. Calls `playback.create({ …, item, source: { file: url, remote: true, live: true, headers } })`.

**Playback changes (`src/stream/playback.js`).**
- `source.live`: input flags `-reconnect 1 -reconnect_streamed 1 -reconnect_on_network_error 1 -reconnect_delay_max 5 -rw_timeout 15000000`, `-user_agent` and `-headers` from `source.headers`, no `-ss`, no `-t`, no `-readrate`; `decide()` never returns `direct` for live (the browser can't reach the URL). H.264+AAC → remux (copy); anything the client can't play → the existing convert rules; `quality` honoured.
- Output: fragmented MP4 (endless) for most browsers; HLS (`-hls_list_size 6 -hls_flags delete_segments+independent_segments`, no `ENDLIST`) for Safari.
- A live session has `live: true`, `duration: null`, no progress reports; the reaper stops it after 2 min without a heartbeat, as now.
- ffmpeg exits non-zero mid-stream → the session restarts itself up to 3 times in 2 minutes (the player shows "Lost the channel — trying again"); after that it ends with `error: 'This channel stopped sending video.'`.
- Live and catch-up sessions count toward the per-account 4 and the conversion cap.

**Zapping.** `POST /api/live/channels/:id/play` with `replaces` = the current session; channel up/down in the player use the visible channel order (the current group filter, else all).

**Catch-up.** `startCatchup({ …, programmeId, from = 0 })` — checks the channel has catch-up and the programme is within its days, calls `source.catchup(key, programme, { from })`, probes, then a **finite** session (`duration = programme length − from`, seek bar from `from`). The player's seek calls `startCatchup` again with the new `from` (every catch-up style puts the start in the URL). "Start over" on a programme on now is a catch-up from its start. Catch-up sessions count toward the source's stream limit.

**Radio.** Channels with `radio` play in the music player: `audioOnly` maps no video (`-vn`), copies MP3/AAC/Opus the browser can play and converts others to AAC; the music player's `playLive(channel)` shows the logo as art, the channel name, and the programme title from the guide (refreshed when the programme changes); the mini-player and Now Playing show "Live" instead of times, no seek; next/previous step through radio channels. The queue and repeat don't apply.

**Casting.** `castManager.start({ …, liveChannelId })` / `{ catchupProgrammeId }`: the session is started by `stream.js` and handed to the existing cast link path (`?cast=` token); DLNA gets no duration; the Remote shows LIVE, the programme, and channel up/down instead of the seek bar; catch-up casts like a movie with its seek. A source's stream limit applies to cast sessions too.

**No history.** Live and catch-up write no progress, no "watched", and nothing to Continue watching.

## 4. Routes and pages

**Routes (`src/api/live.js`).** All need a signed-in profile; Kids filtered as §1.
- `GET /api/live/status` → `{ enabled, sources: [{ id, name, channels, lastOk, error? }] }` (error text admin only).
- `GET /api/live/channels?group=&favourites=1` → `[{ id, number, name, groups, logo: url|null, radio, catchup: boolean, favourite, now: Programme|null, next: Programme|null }]`, and `GET /api/live/groups`.
- `GET /api/live/guide?from=&to=&channels=` (window capped at 6 h per request, 200 channels) → `{ channels: [...], programmes: { [channelId]: Programme[] } }`.
- `GET /api/live/programmes/:id` → the programme with `{ channel, canWatchLive, canStartOver, canCatchup }`.
- `POST /api/live/channels/:id/play` `{ caps, quality, replaces, audioOnly }` and `POST /api/live/programmes/:id/play` `{ caps, quality, replaces, from }` → the same session shape `/api/items/:id/play` returns, plus `{ live, channel, programme }`.
- `GET /api/live/channels/:id/logo` → the cached image (404 when none).
- `PUT /api/live/favourites` `{ channelIds }` (ordered); `POST /api/live/favourites/:id` / `DELETE` toggles.
- Admin: `POST /api/live/sources/:id/refresh`; `GET/PUT /api/profiles/:id/live-groups`.
- Programme objects: `{ id, channelId, start, end, title, subtitle, description, categories, episode, image }` — `image` proxied like logos.

**Menu.** "Live TV" (icon `live`) after the libraries, shown when `status.enabled` and the profile sees at least one channel; Orbit and the classic layouts.

**Channels (`#/live`).** Group chips (Favourites — only if any; All; then groups in playlist order). Rows: number, logo (or the channel's initials), name, now (title + progress bar + "until 7:30 PM") and next ("Next: 7:30 The Chase"). Enter plays (radio → music player); "…" → Add to favourites / Remove from favourites, Guide for this channel, Cast to…. Typing digits jumps (after 1.5 s, or Enter) to that channel number and plays it. Empty states: no source → "Live TV isn't set up yet" (admins: "Add a playlist in Settings → Plugins → IPTV Simple"); Kids with no groups → hidden menu entry.

**Guide (`#/live/guide`).** `role="grid"`: channel column (sticky), 30-minute columns, about 2½ hours visible at 1920 px; a "Now" line; arrows move cell to cell (Left/Right by programme, Up/Down keeps the time); Earlier/Later move 2 h; a day picker from the catch-up start to +7 days; the group chips filter rows. Cells: title and time; aired programmes on catch-up channels carry a small rewind icon, other aired ones are dimmed; each cell's name is "Channel, 7:00 to 7:30 PM, Title, on now|aired|upcoming|catch-up available". Rows load in pages of 50 as you scroll; the window loads ±3 h around the view. Phones (≤ 720 px): one channel's schedule as a list for the chosen day, a channel picker at the top.

**Programme sheet.** Title, episode, channel, day and time, categories, description, image; buttons by state: Watch live (on now), Start over (on now, catch-up), Play (aired, within catch-up), and for upcoming only Close (Round 19 adds Record).

**Player, live mode** (`#/live/play/:channelId`, `#/live/catchup/:programmeId`). LIVE badge in place of the clock; the bar shows progress through the current programme (`aria-valuetext` "18 minutes into 1 News, 12 minutes left"; not seekable); channel up/down buttons and PageUp/PageDown, ChannelUp/ChannelDown (`ChannelUp`/`ChannelDown` keys) — not Up/Down, which already bring the controls back when they're hidden; Info (I) shows now/next; a "Channels" button opens the channel list over the video (Enter zaps, Back closes); the title updates when the programme changes (polled each minute and at the programme's end). Catch-up mode is the normal player with a seek bar and the programme's title. Errors replace the spinner with the sentence and Try again / Back.

**Home row "On now"** (registered by the core, position after Continue watching, hidden when Live TV is off for the viewer): favourites in their order, else the first 12 channels; landscape cards — logo on the programme image (or the logo on the card colour), programme title, channel name, progress bar.

**Search.** An "On TV" section after the library results: channels whose name matches, and programmes starting in the next 24 h whose title matches (each opens the programme sheet).

**Settings.** The IPTV Simple plugin page shows the last refresh (`settingsSummary()`, time, error, the first 20 unmatched channel names) and a Refresh now button. Household → a Kids profile has "Live TV groups": a checklist per source (none ticked by default). The Settings dashboard shows a live source's error like the scan warning.

**Accessibility.** The guide grid as above; channel rows are buttons named "7, TVNZ 1, now 1 News until 7:30 PM"; the live player's channel change is announced ("TVNZ 2, The Chase") through `announce()`; nothing in the guide is a live region.

## 5. Errors and testing

**Errors** (in words, where they happen): a channel that won't start — "This channel isn't answering right now (the provider closed the connection)", "…took too long to answer", "…isn't a video stream"; the stream limit (above); a refresh failure keeps the last good data and shows on the plugin page and dashboard; a channel without programmes shows "No guide information" in its row and a single empty cell in the guide.

**Node tests** (no network): `iptv-m3u.test.js` (header attributes, every `#EXTINF` attribute and quoting, `#EXTGRP`, `#EXTVLCOPT`, `|` headers, multi-group, radio, duplicates, BOM/CRLF, no `#EXTM3U`, 20 000 channels < 1 s), `iptv-xmltv.test.js` (offsets and shift, missing stop, gzip by magic bytes, xz refused, `xmltv_ns`/onscreen, entities/CDATA, a 50 MB synthetic file streamed in chunks with bounded memory, malformed XML with line number), `iptv-catchup.test.js` (each mode and token against expected URLs, correction, `from`), `iptv-match.test.js`, `live-store.test.js` (upsert keeps ids and favourites, removed channels, window replace, prune, now/next, guide window, Kids groups), `live-api.test.js` (routes, Kids filtering, admin-only bits, logo proxy, no provider URL or header in any response), `live-stream.test.js` (stream limit and holders, zapping stops the old session first, live ffmpeg args, restart-on-exit up to 3, catch-up `from`, radio audio-only args, no progress written).

**Devtools.** `mock-iptv.mjs` (:9919): an M3U with groups, numbers, radio and catch-up channels; a gzipped XMLTV with programmes around now; live MPEG-TS and HLS test streams generated by ffmpeg (a clock and a tone); Xtream-style `/timeshift/…` and `?utc=` catch-up paths; `/__mode?m=403|slow|drop|limit`. `live-ui.mjs`: channel list (groups, favourites, digits), guide (grid names, arrows, Earlier/Later, day picker, phone list), programme sheet buttons, live player (badge, bar text, channel up/down, Info, Channels overlay, programme change), catch-up seek, the stream-limit sentence, radio in the mini-player, home row, search "On TV", Kids groups, casting to the mock Chromecast, phone layout; plus orbit-ui/orbit-a11y/a11y-ui/orbit-sizes and `oldthemes-compare`.

**Not yet verified** (into the project note): a real provider's playlist, guide and catch-up; HDHomeRun and Tvheadend on Dallas's network; real connection limits; hours-long live streams on a real TV; MPEG-2 DVB streams through the converter on Dallas's PC.

## Delivery

One plan (or two if it grows past ~10 tasks: plan A core + plugin + routes + playback, plan B pages + player + radio + casting + search), each ending with the fresh review and one fix pass; delivered to the PC as v0.16.0 (package.json, README "Live TV", ARCHITECTURE notes for `registerLiveSource` and migration 15, docs/PLUGINS.md for the hook). Round 19 (timeshift + DVR) gets its own spec.
