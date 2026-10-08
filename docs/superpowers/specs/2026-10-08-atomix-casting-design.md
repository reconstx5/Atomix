# Atomix: casting to the TV — design (round 15, v0.13.0)

Date: 2026-10-08. Author: Claude, with Dallas's choices. Builds on v0.12.0.

## 1. What Dallas wants

"Do some updates and add new features." Casting was the round he chose after Plex. His choices during the design:

- **Devices:** Chromecast and Google TV; DLNA/UPnP TVs; AirPlay (Apple TV).
- **How it works:** **the Atomix server casts and your phone is the remote.** Atomix finds Chromecasts and DLNA TVs on
  the home network and drives them itself, with no Google script in the page. AirPlay uses Safari's own AirPlay
  button. Casting needs Atomix on the same home network as the TV.
- **A full remote:** a "Playing on Living room TV" pill on every page, and a Remote page with:
  - play/pause, seek with previews, ±10 s;
  - volume, subtitles and audio track;
  - Up next with the countdown, and Stop casting.

  Progress and watched state are saved as if you watched it here.
- **What can be cast:** films, episodes and music (the music queue plays on the device).
- **Who can cast:** everyone, under the same access and kids rules as playing here.
- **Alongside casting:** proxy hardening, the connected-server leftovers, and the older review leftovers (§7).

Success looks like this. On a phone, Dallas opens a film and taps **Cast to…**, then picks "Living room TV" (a
Chromecast). The film starts there from where he stopped. The phone shows the pill; tapping it opens the Remote,
where he pauses, seeks, turns on English subtitles and changes the volume. When the episode ends, the next one
starts after the countdown. He closes the app and the TV keeps playing. Back in Atomix, the episode is marked
watched and Continue watching is right. The same works with a Samsung TV over DLNA (subtitles burned in when
chosen), and a song queue plays on the TV while the mini-player is the remote. On an iPhone, the player's AirPlay
button sends the film to an Apple TV, and the normal player controls keep working.

Project-wide rules that apply throughout:

- **Code:** Node ≥ 22.13 and zero npm dependencies. Discovery, the Cast protocol, protobuf framing and UPnP SOAP are
  written with node:dgram, node:tls, node:http and node:crypto. Plain ES-module browser JS; no build step.
- **UI:** Orbit first with a TV remote. The older themes change only where this spec adds content.
- **Network:** nothing leaves the server except what it already sends, plus traffic to devices on the local network
  that Atomix found or an admin added. No Google script, and no call to any Google or Apple service.
- **Tokens:** a connected server's token still never reaches a browser or a device. A device only gets Atomix's own
  short-lived cast link (§3.3).

## 2. Data

Migration 13 (`src/db.js`, `MIGRATIONS[12]`):

- Table `cast_devices` holds the devices an admin added by address: `id`, `kind TEXT CHECK (kind IN ('chromecast',
  'dlna'))`, `name TEXT`, `address TEXT` (`host:port` for Chromecast, the description URL for DLNA), and
  `created_at`. Devices found on the network are not stored; they live in memory (§3.1).

Two new settings:

- `castEnabled`: true. The admin switch in Settings → Server → Casting.
- `castBaseUrl`: null, meaning "detect". The address devices use to reach Atomix, for example
  `http://192.168.1.20:8787`.

Cast sessions and cast links live in memory. On restart they end, and devices stop on their own once the link
dies.

## 3. The server side (`src/cast/`)

### 3.1 Finding devices (`mdns.js`, `ssdp.js`, `devices.js`)

- **`mdns.js`:**
  - Sends one mDNS query for `_googlecast._tcp.local` (PTR) to `224.0.0.251:5353` from every IPv4 interface.
  - Collects answers for 2 s and parses PTR/SRV/TXT/A records with a hand-written DNS packet reader.
  - From TXT: `fn` is the friendly name, `md` the model, `id` a stable id.
  - Each device is `{ id: 'cc:<id>', kind: 'chromecast', name: fn, model: md, host, port }`.
- **`ssdp.js`:**
  - Sends `M-SEARCH` for `urn:schemas-upnp-org:device:MediaRenderer:1` to `239.255.255.250:1900` (MX 2), and
    collects answers for 2.5 s.
  - Fetches each `LOCATION` and reads `friendlyName`, `UDN`, and the `controlURL`s of `AVTransport:1`,
    `RenderingControl:1` and `ConnectionManager:1`.
  - Each device is `{ id: 'dlna:<UDN>', kind: 'dlna', name, model, location, control: {...} }`.
- **`devices.js` (`CastDevices`):**
  - `list({ refresh })` runs both searches together (≤ 3 s), adds the stored manual devices, and keeps the result
    for 5 minutes. A refresh replaces it.
  - `get(id)` finds a device by id.
  - `addManual({ kind, address, name? })` checks the address first (Chromecast: a TLS connect plus GET_STATUS; DLNA:
    the description loads), then stores it.
  - Both searches go through an injectable transport so the tests can run them against fakes on loopback ports.

### 3.2 Driving a device

**`castv2.js`** speaks the Cast v2 channel:

- **Connection:** a TLS connection to `host:8009`, with certificate checks off because Chromecasts use self-signed
  certificates. This is local network only, to a device from discovery or an admin.
- **Framing:** each message is a 4-byte big-endian length, then a protobuf `CastMessage` with the fields
  `protocol_version=0`, `source_id`, `destination_id`, `namespace`, `payload_type=0` and `payload_utf8`. Encoding
  and decoding are hand-written varint and length-delimited code.
- **Requests and heartbeats:** request ids, with `PING` every 5 s and `PONG` answered.
- **Namespaces used:**
  - `urn:x-cast:com.google.cast.tp.connection`
  - `urn:x-cast:com.google.cast.tp.heartbeat`
  - `urn:x-cast:com.google.cast.receiver`
  - `urn:x-cast:com.google.cast.media`

**`chromecast.js` (`ChromecastDevice`)** builds on it:

- **Connect and launch:** `connect()` → `launch()` starts the Default Media Receiver (app id `CC1AD845`) unless it is
  already running. It opens a channel to its `transportId`.
- **Load:**
  - `load({ url, contentType, title, subtitle, image, startTime, tracks, activeTrackIds, duration })` sends `LOAD`
    with `streamType: 'BUFFERED'` and metadata type 0 (movie, episode) or 3 (music).
  - Text tracks: `{ trackId, type: 'TEXT', subtype: 'SUBTITLES', trackContentId: <vtt url>,
    trackContentType: 'text/vtt', language, name }`.
- **Controls:**
  - `play()`, `pause()`, `seek(seconds)` and `stop()` go to the media session.
  - `setVolume(level 0–1)` and `setMuted()` go to the receiver.
  - `setTracks(activeTrackIds)` uses `EDIT_TRACKS_INFO`.
- **Status:** events come from `MEDIA_STATUS` (`playerState`, `currentTime`, `idleReason`, `volume`) and
  `RECEIVER_STATUS`. If another app takes the screen, the status names that app.

**`dlna.js` (`DlnaDevice`)** drives a UPnP renderer:

- **SOAP:** calls over node:http, with `SOAPACTION` and the XML envelope.
  - `SetAVTransportURI` with the URL and DIDL-Lite metadata: title, `upnp:class` `object.item.videoItem` or
    `.audioItem.musicTrack`, `res` with `protocolInfo`, and `upnp:albumArtURI`.
  - `Play`, `Pause`, `Stop`, and `Seek` with `REL_TIME`.
  - `GetPositionInfo` (`RelTime`, `TrackDuration`), `GetTransportInfo` (`CurrentTransportState`) and `GetMediaInfo`
    (`CurrentURI`).
  - RenderingControl `SetVolume` / `GetVolume` (0–100) and ConnectionManager `GetProtocolInfo` (the `Sink` list).
- **Status:** a 2 s `GetPositionInfo` + `GetTransportInfo` poll (`GetMediaInfo` every 10 s) raises the same status
  events as the Chromecast driver.
- **Shared interface:** both drivers emit `{ state: 'playing'|'paused'|'buffering'|'idle', position, duration,
  volume, idleReason: 'finished'|'stopped'|'error'|'taken'|null }`.

### 3.3 Cast links (`tokens.js`)

- **`CastLinks.issue({ sessionId, itemId, userId, profileId })`** gives a 32-byte random URL-safe token, valid
  until the session ends and at most 12 h.
- **Where a link works:** a media request carrying `?cast=<token>` is accepted without the session cookie only on
  these routes:
  - `/api/items/:id/file`, for that item only;
  - `/api/stream/:sid` and `/api/hls/:sid/*`, for that playback session only;
  - `/api/items/:id/subtitles/:sub.vtt`, for that item only;
  - `/api/items/:id/image/:type`, for that item and its show or album.
- **Anything else:** a link used for any other item, session or route is a 401. An expired or revoked link is a
  401.
- **CORS:** responses served with a cast link carry `Access-Control-Allow-Origin: *`, because the Chromecast
  receiver page fetches the text tracks. No other response changes.
- **Revocation:** `revoke(token)` and `revokeSession(sessionId)` run when a cast session ends.

### 3.4 Formats per device

`castCaps(device)` returns the `caps` shape that `decide()` already takes:

- **Chromecast:**
  - `{ containers: ['mp4', 'webm'], video: ['h264', 'vp9', 'vp8'], audio: ['aac', 'mp3', 'opus', 'vorbis', 'flac'],
    hls: false, hdr: false }`
  - plus `hevc` and `hdr: true` when the model (`md`) names Google TV or Chromecast Ultra.
- **DLNA:**
  - Built from the `Sink` list: containers `video/mp4` → mp4, `video/x-matroska` → mkv, `video/webm` → webm,
    `audio/mpeg` → mp3, `audio/flac` → flac, `audio/mp4` → m4a.
  - Video `h264` (and `hevc` only when `video/hevc` or `video/x-hevc` is listed); audio `aac`, `mp3` and `ac3` (when
    `audio/ac3`/`audio/vnd.dolby.dd-raw` is listed).
  - An empty or unreadable list falls back to mp4/h264/aac.
- **Burn-in:** `burnSubtitle` is forced on DLNA when a subtitle is chosen.
- **Converting:** anything else goes through ffmpeg as today, with progressive fMP4 (`/api/stream/:sid`). A
  converted DLNA stream is served with `transferMode.dlna.org: Streaming` and
  `contentFeatures.dlna.org: DLNA.ORG_OP=00;DLNA.ORG_CI=1`.
- **Seeking a converted stream:** Atomix starts a new playback session at the new time, loads it, and adds the
  offset to every position the device reports. A direct file seeks natively.

### 3.5 Cast sessions (`sessions.js`, `CastManager`)

`start({ user, viewer, device, itemId | queue: { itemIds, index }, position?, audioIndex?, subtitle? })`:

1. **Check.** Run the same checks as `POST /api/items/:id/playback`: the viewer can see the item, the kids age
   rule, and the item is playable (films, episodes, extras and tracks).
2. **Make the stream.** Build a playback session with `castCaps(device)` (`PlaybackManager.create` with
   `clientIp: 'cast'` and `castDevice: name`), then a cast link.
3. **Build the URLs** from `baseUrl()`. That is `castBaseUrl`, or the first private IPv4 address of a non-internal
   interface, plus the listening port. Start from the resume position (or the `position` given). The text tracks
   are the item's text subtitles (Chromecast only).
4. **Load.** Connect to the device, launch the receiver (Chromecast only), and load.
5. **Store and return.** The `CastSession` is `{ id, userId, profileId, deviceId, deviceName, kind, itemId, queue?,
   playbackSessionId, offset, state, position, duration, volume, subtitle, audioIndex, upNext? }`. Return it.

Device status updates the session:

- **Progress:** the position (plus `offset`) is saved through the same code as the player's progress POST
  (`library.saveProgress`, which also emits `playback:progress`, so connected servers hear about it), at most every
  10 s and at once at the end. Watched follows the same 90% / credits rule.
- **Heartbeats:** the playback session's `lastSeen` is refreshed so the idle reap leaves it alone.
- **Finished:**
  - An episode with a next one: when the profile's autoplay is on, `upNext = { itemId, at: now + 10 s }`, then the
    next starts on the same device.
  - A music queue moves to the next track.
  - Anything else ends the session with `ended: 'finished'`.
- **Taken over** (another app, another phone, or another URL on a DLNA TV): it ends with `ended: 'taken'`.
- **Device unreachable:** it reconnects for up to 30 s, then ends with `ended: 'lost'`.
- **Ending:** the session revokes its links, stops its playback session (`reason: 'cast ended'`), and keeps a
  "last ended" note per profile for 2 minutes so the pill can say why.

Commands go to the device:

- `play`, `pause`, `seek(seconds)` (native, or a restart for a converted stream), `skip(±10)` and `volume(0–1)`.
- `subtitle(id | null)`: Chromecast switches tracks; DLNA restarts with the subtitle burned in at the current time.
- `audio(index)`: a restart at the current time.
- `next`, which plays Up next or the next track now; `cancelUpNext`; `stop`, which tells the device to stop and
  ends the session.

Ownership:

- **One session per device.** A new start on a device ends any other session there (`ended: 'taken'`).
- **Who can control it:** only the profile that started a session. An admin can stop any session from the
  dashboard.

### 3.6 API (`src/api/cast.js`)

| Route | What it does |
| --- | --- |
| `GET /api/cast/devices?refresh=1` | `{ enabled, baseUrl, reachable, devices: [{ id, kind, name, model, busy }] }`. `reachable` is false when no private home-network address is known and none is set; the picker then explains. |
| `POST /api/cast/devices` (admin) | `{ kind, address, name? }`: add by address. |
| `DELETE /api/cast/devices/:id` (admin) | Remove a device that was added by address. |
| `POST /api/cast/sessions` | Body `{ deviceId, itemId \| queue, position?, audioIndex?, subtitle? }`. Answers the session. |
| `GET /api/cast/sessions/current` | This profile's live session, or `{ ended: 'taken' \| 'lost' \| 'finished' \| 'error', deviceName, detail }` for 2 minutes after one ends, or 204. Polled every second while the Remote is open and every 5 s by the pill. |
| `POST /api/cast/sessions/:id/:command` | Commands: `play`, `pause`, `seek {position}`, `skip {by}`, `volume {level}`, `subtitle {id}`, `audio {index}`, `next`, `cancel-up-next`, `stop`. |

The admin dashboard's Now playing lists cast sessions with "on <device>", and Stop works on them.

## 4. The browser side

### 4.1 Starting a cast

Where it starts:

- The player bar gets a **Cast** button (an icon) beside subtitles and quality.
- A film's or episode's "…" sheet gets **Cast to…**.
- A song's menu and the album/playlist "…" sheet get **Cast to…**.

The picker sheet (`public/js/cast.js` `openCastPicker({ itemId | queue })`):

- **Waiting:** "Looking for devices…".
- **Found:** one row per device, with its kind's icon, name and model. A device already in use says "In use".
- **Always there:** a **Find devices again** row.
- **Empty or unreachable:** the explanation from §6, and for admins **Add a device by address…**.
- **Picking a device** starts the cast from the current position: the player's time, or the resume point. It uses
  the profile's audio and subtitle choices. When it is called from the player, the local video pauses and the
  player closes to the Remote page.

### 4.2 The pill and the Remote page

**The pill.** While the profile has a live session, a pill sits above the dock / beside the mini-player on every
page, in the music mini-player's place and style. It shows the artwork thumbnail, "Playing on Living room TV", the
title, and a play/pause button. Selecting it opens the Remote. When the session ends, the pill shows "Casting
ended on Living room TV" (and why) for 10 s.

**The Remote page** (`#/cast`, `views/remote.js`, full screen like Now Playing):

- the artwork and title (with the show and episode, or the artist);
- "on Living room TV";
- a seek bar with the seek-bar previews when the item has them, and the times;
- −10 s, play/pause and +10 s;
- a volume slider (Up/Down on the bar change it by 5);
- **Subtitles** and **Audio** buttons that open the existing side-panel style list;
- **Up next**: a card with the countdown ring, **Play now** and **Cancel**;
- a **Queue** list for music;
- **Stop casting**.

Remote and keyboard handling follows the player's: Left/Right on the bar seek (with the 1 s hold-to-jump of
scrubbing), Space plays/pauses, and Back leaves (casting goes on). The page reads the session state every second
and keeps the last state on screen if a poll fails.

**Music.** While a music queue is casting, the mini-player shows the cast state and its controls drive the cast.
"Now Playing" works as a remote too, with lyrics following the reported position.

### 4.3 AirPlay

The player's `<video>` gets `x-webkit-airplay="allow"`.

- **The button.** When `window.WebKitPlaybackTargetAvailabilityEvent` exists and reports `available`, an **AirPlay**
  button appears in the player bar. It calls `video.webkitShowPlaybackTargetPicker()`.
- **Switching to a cast link.** On `webkitcurrentplaybacktargetiswirelesschanged` to true, the player asks
  `POST /api/playback/:sid/cast-link` for a cast link for its own session and item. It swaps `src` to the same URL
  with `?cast=`, keeping the time. Tracks get the same treatment.
- **Back.** When AirPlay ends, the player goes back to the plain URL.
- **Progress and controls.** The player keeps posting progress as today. Its own controls drive the Apple TV.

## 5. Settings → Server → Casting

- **Casting:** an on/off toggle.
- **Address the TV uses:** shows the detected address, which you can replace, with "Change this if your TV can't
  load videos (it must be this computer's address on your home network)".
- **Devices:** the devices found and added, with **Find devices again**, **Add a device by address…** (kind pills
  Chromecast / DLNA TV, then the address) and **Remove** for added ones.

## 6. Errors and edge cases

**Nothing found.** "No devices found on your network." The note says Atomix and the TV must be on the same network,
and that Atomix in Docker needs `network_mode: host` to see them. Admins also get **Add a device by address…**.

**No home-network address.**

- When does it happen: a VPS, or only public addresses.
- The picker says "Casting needs Atomix on the same home network as your TV" and shows no device list.
- The admin can still set the address.

**The TV can't load the video.** A Chromecast `LOAD_FAILED` or a DLNA error/STOPPED within 10 s of loading reads:
"Living room TV couldn't load the video from http://192.168.1.20:8787. Check the address in Settings → Server →
Casting."

**Takeover, a lost device, the end.** These go as in §3.5. Progress is saved first.

**Kids.**

- A kids profile can only cast what it can play.
- Its picker and pill look the same.
- It can't add devices.

**Cast links.**

- A link only serves its own item and playback session.
- It dies with the session, and after 12 h at most.
- A link never carries a connected server's token: the device fetches from Atomix, and Atomix fetches from the
  server as today.

**Restarts.** An Atomix restart ends every cast session. Devices stop once their link dies. The pill shows
nothing, and the progress saved last stands.

**DLNA quirks.**

- A TV that rejects the DIDL metadata is retried once with empty metadata.
- A TV without seek support (`Seek` error 710) seeks by a restart, the converted-stream way.

## 7. Updates alongside casting

### 7.1 Proxy hardening (`proxyRemote`, `src/api/library.js`)

- A HEAD is sent upstream as a HEAD.
- `accept-encoding: identity` is always sent.
- A 416 from upstream is passed through with its `content-range`.
- 15 s to receive the upstream headers. Otherwise the answer is 504 "<server> didn't answer in time", and the
  upstream request is aborted.
- `redirect: 'manual'`: a redirect to the same origin is followed (at most 3). A redirect to another origin is
  followed only without the server's sign-in headers, and only for images (CDNs). Streams that redirect to another
  origin are a 502.
- The same redirect rule applies to `ImageCache.download` when it is given sign-in headers.

### 7.2 Connected-server leftovers

**The reporter (`src/remote/progress.js`).**

- A progress report waiting in a server's queue is replaced by a newer one for the same title, so only the latest
  position goes.
- The stop never waits behind more than one pending report.
- The per-title `last` entry is cleared on stop.

**The Plex link step.**

- Up to 3 failed polls in a row are retried quietly before the dialog shows "Couldn't reach plex.tv".
- **Connect** during the code step shows "Enter the code at plex.tv/link first".
- Cancelling the dialog while a pick is posting still refreshes the panel once the post finishes.

**Plex sessions.**

- Timeline calls carry `X-Plex-Session-Identifier: <atomix session id>`, and a per-session
  `X-Plex-Client-Identifier` of `<plexClientId>-<session id>`.
- Two people playing the same Plex title appear as two players, and one's stop doesn't end the other.

### 7.3 Older leftovers

- **Now Playing:** gets a volume control (a slider in the transport row; Up/Down on it change it by 5%). It sets
  the music player's volume, which is kept per profile in prefs.
- **Escape:** leaves Now Playing, as Back and Backspace do.
- **The Watchlist button:** ignores presses while its request is in flight, so `aria-pressed` always matches the
  server.
- **"Part of":** the row marks the film you're on with a "This film" badge, and its card is not a link to itself.

## 8. Out of scope (deliberately)

- Casting from a VPS deployment (it needs the home network).
- Google's Cast SDK, and custom receivers.
- AirPlay driven by the server (pairing with tvOS).
- Roku, Fire TV and Sonos.
- Casting add-on sources (they play from other sites).
- Group or multi-room audio.
- Casting the trailer page's YouTube trailer (a local trailer file casts like any extra).
- Mirroring.

## 9. Testing

**Fakes in `test/helpers-cast.js`:**

- **`fakeChromecast`** is a TLS server on a loopback port, with a self-signed certificate made at test start by
  `openssl` when present (the test is skipped otherwise). It speaks the real framing and protobuf, answers
  CONNECT/PING/GET_STATUS/LAUNCH/LOAD/PLAY/PAUSE/SEEK/STOP/SET_VOLUME/EDIT_TRACKS_INFO, advances `currentTime` on a
  clock the test controls, can report `FINISHED`, `LOAD_FAILED` and another app taking over, can drop the
  connection, and records every message.
- **`fakeDlna`** is an HTTP server with a device description, a `Sink` list chosen by the test, and AVTransport,
  RenderingControl and ConnectionManager SOAP. It records calls, reports position and state from the test's clock,
  and can change `CurrentURI` (a takeover) or reject the metadata once.
- **`fakeMdns` and `fakeSsdp`** answer through the injectable transport on loopback.

**Node tests:**

- **Discovery:** the DNS packet reader against real captured mDNS answers; the SSDP parse; the description parse;
  the 5-minute list; a refresh; adding a device by address (good and bad).
- **Protobuf and framing:** a round trip of `CastMessage`, split and joined TCP chunks.
- **Cast links:** the right item/session only, other routes refused, expiry, revocation, CORS only with a link.
- **`castCaps`:** Chromecast models, DLNA Sink lists, an empty list, and burn-in on DLNA.
- **A whole session on each fake:** load with the resume time, play/pause/seek, ±10, volume, subtitle (a track on
  Chromecast, a restart with burn-in on DLNA), audio track, a converted stream's seek with the offset, progress
  saved and watched at the end, Up next starting the next episode, cancelling Up next, a music queue advancing,
  takeover, a device dropping (reconnect, then lost), LOAD_FAILED's message, one session per device, and only the
  owner's commands accepted.
- **Kids:** an R16 film can't be cast from a 10-year-old's profile.
- **AirPlay:** `POST /api/playback/:sid/cast-link` only for the session's own user.
- **Proxy hardening:** HEAD, identity encoding, 416, a header timeout (504), and the redirect rules. **Leftovers:**
  the progress coalescing, the plex.tv retry, the Plex session identifiers, the Watchlist guard, and "Part of".

**Browser:** `devtools/cast-ui.mjs` runs against `devtools/mock-cast.mjs`, a fake Chromecast and a fake DLNA TV
that the dev server is told about through `ATOMIX_CAST_DEVICES` (devices added to the list as if found; the
multicast searches still run). It covers:

- the Cast button and picker with the TV remote keys;
- starting from the player and from a sheet;
- the pill on other pages;
- the Remote page (seek, volume, subtitles, Up next countdown, Stop casting);
- casting music from the mini-player;
- the "ended" pill;
- the empty-network explanation;
- Settings → Casting;
- the new Now Playing volume and Escape;
- no console errors.

orbit-sizes adds the Remote page at phone and desktop sizes, and orbit-a11y adds the pill's and Remote's
contrast.

**Not testable here:** a real Chromecast, Google TV, DLNA TV and Apple TV. The project note lists what to try
first on the home network.

## 10. Dev data

`devtools/mock-cast.mjs` runs a fake Chromecast "Living room TV" on a loopback TLS port and a fake DLNA TV "Bedroom
TV" on :9917, and both "play" by advancing a clock. `restart-dev.sh` starts it, and `run-dev.sh` sets
`ATOMIX_CAST_DEVICES=chromecast:127.0.0.1:9916,dlna:http://127.0.0.1:9917/description.xml` and
`ATOMIX_CAST_BASE_URL=http://127.0.0.1:8787`. `ATOMIX_CAST_DEVICES` is a dev/test switch; it is read once at boot
and documented in ARCHITECTURE only.
