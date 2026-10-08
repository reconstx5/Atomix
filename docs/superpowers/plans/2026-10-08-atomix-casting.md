# Casting to the TV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Atomix server finds Chromecasts and DLNA TVs on the home network and plays films, episodes and music on them, with the browser as a full remote. AirPlay works through Safari's own button. This round also adds proxy hardening and the connected-server and older leftovers. It ships as v0.13.0.

**Architecture:**
- `src/cast/` holds discovery, two device drivers behind one status interface, cast links, and a `CastManager` that owns cast sessions. Each cast session wraps an ordinary `PlaybackManager` session made with the device's caps.
- The browser polls one route for the profile's session and sends commands to it.
- Media routes accept a `?cast=` link in place of the cookie, only for their own item or session.

**Tech Stack:** Node ≥ 22.13 (node:tls, node:dgram, node:http, node:crypto, node:sqlite, node:test), zero npm dependencies, plain ES-module browser JS, Playwright harnesses in `/home/claude/devtools` (cloud only).

**Spec:** `docs/superpowers/specs/2026-10-08-atomix-casting-design.md`

## Global Constraints

- Node ≥ 22.13 and zero npm dependencies. Discovery, Cast v2 framing/protobuf and UPnP SOAP are written by hand. Plain ES-module browser JS; no build step.
- Orbit first with a TV remote. The older themes change only where this spec adds content.
- Nothing leaves the server except what it already sends, plus traffic to devices on the local network that Atomix found or an admin added. No Google script, and no call to any Google or Apple service.
- A connected server's token never reaches a browser or a device. A device only gets Atomix's own cast link: 32 random bytes, URL-safe, for one item or playback session, revoked when the cast ends, 12 h at most.
- `Access-Control-Allow-Origin: *` only on responses served with a cast link.
- Default Media Receiver app id is `CC1AD845`. The Cast port is 8009, and certificates are not verified (local devices only).
- Copy, exactly as written:
  - "Looking for devices…"
  - "Find devices again"
  - "In use"
  - "Add a device by address…"
  - "No devices found on your network."
  - "Casting needs Atomix on the same home network as your TV"
  - "Playing on <device>"
  - "Casting ended on <device>"
  - "Stop casting"
  - "Play now" / "Cancel"
  - "<device> couldn't load the video from <base url>. Check the address in Settings → Server → Casting."
  - "<server> didn't answer in time"
  - "Enter the code at plex.tv/link first"
  - "This film"
- Version `0.13.0`; migration 13.

## Review Focus

1. **Base address on a computer with several networks.** A computer with Docker's bridge (172.17.x), a VPN (10.x) and Wi-Fi (192.168.x) must give each device the address on the device's own subnet, never docker0 or a VPN tunnel. Pinned in Task 4: `baseUrlFor(host)`.
2. **Seeking a converted stream.** A converted stream that is seeked (restarted) revokes the old link and its playback session. The device's old URL then answers 401, and no ffmpeg is left running. Pinned in Task 5.
3. **Profiles and tabs.** A second profile on the same account sees no pill for another profile's cast, and polling `current` from several tabs has no side effects. Pinned in Task 5.
4. **DLNA control URLs.** A description with relative `controlURL`s, a `URLBase` element, or neither (resolve against `LOCATION`) must reach the right SOAP endpoints. Pinned in Task 3.
5. **Picture subtitles on a Chromecast.** A picture (PGS) subtitle chosen for a Chromecast is burned in by a restart, not sent as a text track. Pinned in Task 5.

---

### Task 1: Migration 13, settings, cast links on the media routes

**Files:**
- Create: `src/cast/tokens.js`
- Modify:
  - `src/db.js` (`MIGRATIONS[12]`: `cast_devices`)
  - `src/settings.js` (`castEnabled: true`, `castBaseUrl: null`)
  - `src/config.js` (`castDevices` from `ATOMIX_CAST_DEVICES`, `castBaseUrl` from `ATOMIX_CAST_BASE_URL`)
  - `src/app.js` (`core.cast = { links }`)
  - `src/api/library.js` (`/file`, `/subtitles/:sub`, `/image/:type`)
  - `src/api/playback.js` (`/api/stream/:sid`, `/api/hls/:sid/*`, `POST /api/playback/:sid/cast-link`)
  - the router's auth hook, if the routes are `auth: 'user'` today (add `auth: 'cast'` meaning "a session cookie, or a valid cast link for this route")
- Test: `test/migrations.test.js`, `test/cast-links.test.js`

**Interfaces:**
- Produces:
  - `class CastLinks`:
    - `issue({ sessionId, itemId, userId, profileId, ttlMs = 12 * 3600e3 }) → token`
    - `check(token, { itemId, sessionId, route }) → link | null`
    - `revoke(token)`
    - `revokeSession(sessionId)` (by playback session id)
    - `revokeCast(castId)`; `issue` also takes `castId`
  - Route kinds `'file' | 'stream' | 'subtitle' | 'image'`. The image route also accepts the item's `show_id` and `parent_id`.

- [ ] **Step 1: Failing tests.**
  - `migration 13 adds cast_devices` (columns `id, kind, name, address, created_at`; kind CHECK refuses `'roku'`).
  - In `test/cast-links.test.js` (Atomix started, one film with ffmpeg):
    - `a cast link plays its own file with no cookie, and nothing else`:
      - `/api/items/<film>/file?cast=T` gives 200, with Range 206;
      - another item with T gives 401;
      - `/api/items/<film>?cast=T` (a JSON route) gives 401;
      - a bad token gives 401.
    - `a cast link serves its film's subtitles and artwork with CORS; a cookie request has no CORS header`.
    - `a converted session's stream accepts its own link only`: `/api/stream/<sid>?cast=T` gives 200; a link for another sid gives 401.
    - `revokeSession and revokeCast end a link; an expired link is refused` (ttl 1 ms).
    - `POST /api/playback/:sid/cast-link gives a link for the caller's own session; another user's session is a 404`.
- [ ] **Step 2: Run** `node --test test/migrations.test.js test/cast-links.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Tokens are `crypto.randomBytes(32).toString('base64url')`, stored in a Map. Expired ones are swept on `check`.
  - A request authorised by a link runs as that link's user and profile, so the existing visibility checks apply.
- [ ] **Step 4: Run** the two files and `npm test`. Expected: PASS.
- [ ] **Step 5: Ledger** `Task 1: complete`.

### Task 2: The Cast v2 channel and the Chromecast driver

**Files:**
- Create: `src/cast/protobuf.js`, `src/cast/castv2.js`, `src/cast/chromecast.js`, `test/helpers-cast.js` (`fakeChromecast`), `test/cast-chromecast.test.js`

**Interfaces:**
- Produces:
  - `protobuf.js`:
    - `encodeCastMessage({ sourceId, destinationId, namespace, payload }) → Buffer` (fields 1 = 0, 2, 3, 4, 5 = 0, 6, as length-delimited strings and varints)
    - `decodeCastMessage(buf) → { sourceId, destinationId, namespace, payload }`
    - `class FrameReader` with `push(chunk) → Buffer[]` (complete messages; handles split and joined chunks)
  - `castv2.js`: `class CastChannel extends EventEmitter`
    - `static connect({ host, port = 8009, timeoutMs = 5000 })`
    - `send(namespace, payload, { destinationId = 'receiver-0', sourceId = 'sender-0' })`
    - `request(namespace, payload, opts) → Promise<reply>` (by `requestId`, 5 s timeout)
    - events `message`, `close`
    - a heartbeat `PING` every 5 s, and an answer to `PING` with `PONG`
  - `chromecast.js`: `class ChromecastDevice extends EventEmitter`
    - `connect()`, `launch()`, `load(media)`, `play()`, `pause()`, `seek(s)`, `stop()`, `setVolume(l)`, `setTracks(ids)`, `status()`, `close()`
    - emits `status` `{ state, position, duration, volume, idleReason }`. `idleReason` is mapped as FINISHED → `'finished'`, CANCELLED/INTERRUPTED → `'stopped'`, ERROR → `'error'`, and another app on the receiver → `'taken'`.
    - emits `close` when the connection drops.
  - `test/helpers-cast.js`:
    - `fakeChromecast({ clock })` → `{ host, port, messages, state, finish(), failNextLoad(), takeOver(), drop(), close() }`
    - The certificate is made with `openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=fake -days 1` in a temp dir. `hasOpenssl` is exported for `skip`.

- [ ] **Step 1: Failing tests:**
  - `CastMessage round-trips, including a 300-byte payload`.
  - `FrameReader joins a message split in three chunks and splits two messages in one chunk`.
  - `connect, launch CC1AD845, load with startTime, tracks and metadata; the fake recorded them`.
  - `play/pause/seek/stop/volume/EDIT_TRACKS_INFO reach the fake; status events follow the fake's clock`.
  - `FINISHED, LOAD_FAILED and another app taking over map to finished, error and taken`.
  - `a dropped connection emits close`.
  - `a PING from the device is answered with PONG`.
- [ ] **Step 2: Run** `node --test test/cast-chromecast.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** per spec §3.2.
- [ ] **Step 4: Run** the file and `npm test`. Expected: PASS.
- [ ] **Step 5: Ledger** `Task 2: complete`.

### Task 3: The DLNA driver

**Files:**
- Create: `src/cast/dlna.js`, `test/cast-dlna.test.js`
- Modify: `test/helpers-cast.js` (`fakeDlna`)

**Interfaces:**
- Produces:
  - `parseDescription(xml, location) → { udn, name, model, control: { avTransport, rendering, connection } }`. Control URLs are absolute, resolved against `URLBase`, else `location`.
  - `class DlnaDevice extends EventEmitter`, built with `{ location, pollMs = 2000 }`:
    - `connect()` (loads the description), `protocolInfo() → string[]` (the Sink list)
    - `load({ url, title, kind, image, startTime, protocolInfo })`, `play()`, `pause()`, `seek(s)`, `stop()`, `setVolume(l 0–1)`, `close()`
    - emits `status` (the same shape as Task 2); `CurrentURI` changing to a URL that isn't ours gives `idleReason: 'taken'`
    - `seekSupported` becomes false after a Seek fault 710
    - `load` retries once with empty metadata after a SOAP fault on `SetAVTransportURI`
  - `fakeDlna({ clock, sink, urlBase?, relativeControl? })` → `{ location, calls, state, finish(), takeOver(), rejectMetadataOnce(), noSeek() }`

- [ ] **Step 1: Failing tests:**
  - `parseDescription resolves relative controlURLs against URLBase, or LOCATION when there is none` (Review Focus 4: three descriptions).
  - `load sends SetAVTransportURI with DIDL-Lite (title, class, res protocolInfo, albumArtURI), then Play; startTime seeks with REL_TIME 00:01:40`.
  - `pause/stop/SetVolume 0.4 → 40; GetProtocolInfo returns the Sink list`.
  - `status follows GetPositionInfo/GetTransportInfo; a changed CurrentURI is taken; STOPPED at the end is finished`.
  - `a metadata rejection retries once with empty metadata`.
  - `a Seek fault 710 sets seekSupported false`.
- [ ] **Step 2: Run** `node --test test/cast-dlna.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** per spec §3.2. SOAP bodies are string templates, with the text in them XML-escaped, and answers are read with small regex extractors.
- [ ] **Step 4: Run** the file and `npm test`. Expected: PASS.
- [ ] **Step 5: Ledger** `Task 3: complete`.

### Task 4: Discovery, the device list, the base address, caps

**Files:**
- Create: `src/cast/mdns.js`, `src/cast/ssdp.js`, `src/cast/devices.js`, `src/cast/caps.js`, `test/cast-discovery.test.js`

**Interfaces:**
- Produces:
  - `mdns.js`:
    - `buildQuery(name) → Buffer`
    - `parseResponse(buf) → records[]` (PTR, SRV, TXT, A, with name compression)
    - `searchCast({ transport, timeoutMs = 2000 }) → [{ id, kind: 'chromecast', name, model, host, port }]`
  - `ssdp.js`:
    - `parseSsdp(text) → { location, usn, st }`
    - `searchDlna({ transport, timeoutMs = 2500, fetchDescription }) → [{ id, kind: 'dlna', name, model, location, control }]`
  - `devices.js`: `class CastDevices`, built with `{ db, config, transports }`:
    - `list({ refresh }) → devices[]` (a 5 min cache; adds `cast_devices` rows and `config.castDevices`)
    - `get(id)`
    - `addManual({ kind, address, name })` (validates, 400 on failure)
    - `remove(id)`
  - `baseUrlFor(host, { settings, config, port, interfaces = os.networkInterfaces() }) → string | null`. The order is:
    1. `castBaseUrl` (setting or config);
    2. the IPv4 address of the non-internal interface whose subnet contains `host`;
    3. the first private address on an interface not named `docker*`, `br-*`, `veth*`, `tun*`, `tap*`, `wg*` or `utun*`;
    4. null.
  - `caps.js`:
    - `castCaps(device) → caps` (spec §3.4)
    - `sinkToCaps(sink[]) → caps`
    - `dlnaHeaders() → { 'transferMode.dlna.org': 'Streaming', 'contentFeatures.dlna.org': 'DLNA.ORG_OP=00;DLNA.ORG_CI=1' }`
  - The transport is injectable: `{ send(buf, port, address), on('message', (buf, rinfo)) , close() }`. The real one is node:dgram multicast on each IPv4 interface.

- [ ] **Step 1: Failing tests:**
  - `parseResponse reads a captured _googlecast answer (PTR, SRV, TXT fn/md/id, A) with name compression`: a hex fixture written in the test.
  - `searchCast and searchDlna collect devices from fake transports; duplicates merge`.
  - `the list is kept 5 minutes; refresh replaces it; manual and ATOMIX_CAST_DEVICES devices are added`.
  - `addManual checks a Chromecast (fakeChromecast) and a DLNA description (fakeDlna); a dead address is a 400`.
  - `baseUrlFor picks the interface on the device's subnet, then a private non-docker/VPN address, else null; the setting wins` (Review Focus 1). The interfaces table has docker0 172.17.0.1/16, tun0 10.8.0.2/24, wlan0 192.168.1.20/24 and lo:
    - host 192.168.1.50 gives `http://192.168.1.20:8787`;
    - host 10.1.2.3 gives `http://192.168.1.20:8787`;
    - only a public address gives null.
  - `castCaps: a Chromecast, a Google TV (hevc, hdr), a DLNA Sink list, and an empty Sink list → mp4/h264/aac`.
- [ ] **Step 2: Run** `node --test test/cast-discovery.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** per spec §3.1 and §3.4.
- [ ] **Step 4: Run** the file and `npm test`. Expected: PASS.
- [ ] **Step 5: Ledger** `Task 4: complete`.

### Task 5: Cast sessions and the API

**Files:**
- Create: `src/cast/sessions.js` (`CastManager`), `src/api/cast.js`, `test/cast-sessions.test.js`
- Modify:
  - `src/app.js` (`core.cast = { links, devices, manager }`; stop the manager on shutdown)
  - `src/api/admin.js` (cast sessions in the dashboard's `sessions`, and Stop for them)
  - `src/stream/playback.js` (`create` takes `caps` straight from the caller and `extraHeaders` for DLNA; `publicSession` adds `castDevice`)
  - the progress save path: extract `saveProgress(viewer, item, { position, duration })` from the progress route into `src/library/queries.js` or a small helper, used by both

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `class CastManager`:
    - `start({ user, viewer, deviceId, itemId?, queue?: { itemIds, index }, position?, audioIndex?, subtitle? }) → session`
    - `command(id, viewer, name, args)`
    - `current(viewer) → session | ended | null`
    - `stopAll(reason)`
    - `upNextDelayMs = 10000`
    - `reconnectMs = 30000`
  - Routes per spec §3.6. A session as JSON is `{ id, deviceId, deviceName, kind, itemId, title, subtitle, image, state, position, duration, volume, subtitle: id|null, audioIndex, subtitles: [...], audio: [...], upNext: { itemId, title, at } | null, queue?: { items, index } }`.

- [ ] **Step 1: Failing tests** in `test/cast-sessions.test.js` (an Atomix with films, a show of 2 episodes, an album; one `fakeChromecast` and one `fakeDlna` given through `ATOMIX_CAST_DEVICES`; a test clock):
  - `casting a film to the Chromecast loads the cast link at the resume point with its text tracks and artwork`. The loaded URL starts with the base and contains `?cast=`, and a cookie-less fetch of it gives 200.
  - `play, pause, skip +10, seek, volume reach the device; current() follows the device's status`.
  - `a text subtitle switches tracks on the Chromecast; a picture subtitle restarts with it burned in` (Review Focus 5).
  - `on the DLNA TV a subtitle restarts the stream burned in at the current time; a seek on a converted stream restarts with the offset, revokes the old link and stops its playback session` (Review Focus 2). After the restart, the old URL gives 401 and the old sid is absent from `playback.sessions`.
  - `progress is saved as the device plays and the episode is watched at the end; Up next starts the next episode after the delay; cancel-up-next ends instead`.
  - `a music queue plays track after track on the device`.
  - `another app taking over ends the session as taken, with progress saved; a dropped device reconnects, then ends as lost after reconnectMs`.
  - `LOAD_FAILED ends the session with "<device> couldn't load the video from <base>…"`.
  - `one session per device: a second start there ends the first as taken`.
  - `only the profile that started a session sees it and can command it; another profile on the same account gets 204 from current and 404 on commands; polling current twice changes nothing` (Review Focus 3).
  - `a kids profile can't cast an R16 film (404, as playing does)`.
  - `GET /api/cast/devices reports enabled, baseUrl, reachable, and busy for the device in use; castEnabled false answers enabled: false and refuses a start`.
  - `admins see cast sessions in the dashboard and can stop them; an Atomix shutdown stops every cast`.
- [ ] **Step 2: Run** `node --test test/cast-sessions.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** per spec §3.5–3.6.
  - Status events save progress at most every 10 s, and at once at idle.
  - Heartbeat the playback session on every status.
- [ ] **Step 4: Run** the file and `npm test`. Expected: PASS.
- [ ] **Step 5: Ledger** `Task 5: complete`.

### Task 6: The browser — picker, pill, Remote, music, AirPlay, Settings → Casting

**Files:**
- Create: `public/js/cast.js` (state and polling, `openCastPicker`, the pill), `public/js/views/remote.js` (`#/cast`)
- Modify:
  - `public/js/app.js` (the route, the pill mount, the poll start)
  - `public/js/views/player.js` (the Cast button; the AirPlay button and the src swap)
  - `public/js/views/item.js` (**Cast to…** in the sheet)
  - `public/js/music.js` and `public/js/views/nowplaying.js` (the cast queue)
  - the song/album/playlist menus
  - `public/js/views/settings.js` (Server → Casting)
  - `public/css/app.css`, `themes/orbit/theme.css`
- Create (harness): `devtools/mock-cast.mjs` (a fake Chromecast on :9916 using the Task 2 helper code, a fake DLNA TV on :9917), `devtools/cast-ui.mjs`
- Modify: `devtools/restart-dev.sh`, `devtools/run-dev.sh` (`ATOMIX_CAST_DEVICES`, `ATOMIX_CAST_BASE_URL`), `devtools/orbit-sizes.mjs`, `devtools/orbit-a11y.mjs`

**Interfaces:**
- Consumes: Task 5's routes.
- Produces:
  - `cast.js` exports:
    - `openCastPicker({ itemId } | { queue })`
    - `castState()` → the last session or null
    - `onCastChange(fn)`
    - `castCommand(name, args)`
  - The pill is `.cast-pill`, the Remote root is `.remote-view`, picker rows are `.cast-device[data-id]`.

- [ ] **Step 1: Mock and failing browser checks** in `cast-ui.mjs`. Each section is a group of checks:
  - **`picker`:**
    - the player bar has Cast; its picker shows "Looking for devices…" then the two fake devices, with Up/Down and Enter;
    - **Find devices again** works;
    - a film's sheet has **Cast to…**.
  - **`remote`:**
    - casting from the player pauses local playback and opens `#/cast`;
    - it shows "on Living room TV", and play/pause, ±10, seek with the keys, volume and Subtitles reach the mock (checked through `GET /__state` on the mock);
    - Back leaves, and the pill "Playing on Living room TV" shows on Home and Settings;
    - Up next shows the countdown with **Play now** and **Cancel** at the episode's end;
    - **Stop casting** ends it, and the pill reads "Casting ended on Living room TV".
  - **`dlna`:** the same start on "Bedroom TV" plays; choosing subtitles restarts it.
  - **`music`:** casting an album from its sheet plays on the mock; the mini-player shows the cast and Next moves the mock to track 2.
  - **`empty`:** with `castBaseUrl` cleared and the dev variable off (an admin settings PUT and `/api/cast/devices?refresh=1` on a server started without `ATOMIX_CAST_DEVICES`, or a mocked empty answer), the picker shows "No devices found on your network." and, for admins, **Add a device by address…**.
  - **`settings`:** Settings → Server → Casting shows the toggle, the address and the devices; adding a device by address works against the mock.
  - **all sections:** no console errors.
- [ ] **Step 2: Run** `node /home/claude/devtools/cast-ui.mjs`. Expected: FAIL at the Cast button.
- [ ] **Step 3: Implement** per spec §4–5, with the copy from Global Constraints.
  - The Remote's seek bar reuses `seekpreview.js` and `scrub.js`.
  - Its subtitle/audio lists reuse the player's side panel.
  - The pill sits in the mini-player's slot, and the two stack when both are live.
- [ ] **Step 4: Run** cast-ui twice, servers-ui, orbit-ui and orbit-sizes (add `cast-remote` at phone and desktop sizes: no overflow, the transport above the dock). Also run orbit-a11y (add `.cast-pill` and `.remote-view` text contrast) and music-kbd. Expected: all PASS.
- [ ] **Step 5: Ledger** `Task 6: complete`.

### Task 7: Proxy hardening

**Files:**
- Modify: `src/api/library.js` (`proxyRemote`), `src/library/images.js` (`download` redirect rule)
- Test: `test/remote-proxy.test.js` (new; fake Jellyfin with routes added to `test/helpers-jellyfin.js`: `/slow`, `/redir-same`, `/redir-other`, a 416 for a far range)

**Interfaces:**
- Produces:
  - `proxyRemote` answers HEAD with headers only.
  - A 416 is passed through.
  - A 504 "<server> didn't answer in time" comes after `headerTimeoutMs = 15000`, overridable as `core.remote.proxyHeaderTimeoutMs` for tests.
  - `fetchFollowing(url, { headers, sameOriginOnly, max = 3 })` lives in `src/remote/provider.js` and is shared by the proxy and `ImageCache`.

- [ ] **Step 1: Failing tests:**
  - `HEAD goes upstream as HEAD and returns the length with no body`.
  - `the upstream request asks for identity encoding`.
  - `a 416 upstream is a 416 with its content-range`.
  - `no headers within the timeout is a 504 and the upstream request is aborted`.
  - `a same-origin redirect is followed with the sign-in; a stream redirect to another origin is a 502; an image redirect to another origin is fetched without the sign-in`.
- [ ] **Step 2: Run** `node --test test/remote-proxy.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** per spec §7.1.
- [ ] **Step 4: Run** the file and `npm test`. Expected: PASS.
- [ ] **Step 5: Ledger** `Task 7: complete`.

### Task 8: The leftovers

**Files:**
- Modify:
  - `src/remote/progress.js` (coalescing; clear `last` on stop)
  - `src/remote/plex.js` (session headers)
  - `public/js/views/settings.js` (plex retry, the Connect message, refresh after a cancelled pick)
  - `public/js/views/nowplaying.js` and `public/js/music.js` (volume, Escape)
  - `public/js/lists.js` (the Watchlist guard)
  - `public/js/views/item.js` and `src/api/library.js` ("Part of": `isCurrent` on the collection item)
- Test: `test/remote-play.test.js`, `test/remote-plex.test.js`, `test/lists-api.test.js` (or the file holding the item-page collection tests), and a `leftovers` section added to `devtools/cast-ui.mjs`

**Interfaces:**
- Produces:
  - Timeline calls carry `X-Plex-Session-Identifier` and `X-Plex-Client-Identifier: <plexClientId>-<sessionId>`. `reportStart/Progress/Stop` take `{ sessionId }`, which the reporter passes on.
  - `/api/items/:id` `collection.items[].isCurrent`.

- [ ] **Step 1: Failing tests:**
  - `three progress reports queued behind a hung server send only the latest when it answers; the stop goes right after`.
  - `two sessions on the same Plex title use two client identifiers and session identifiers`.
  - `the item page marks the current film in its collection`.
  - Browser `leftovers`:
    - two plex.tv poll failures in a row show nothing, and three show the message (mock-plex `/__fail?n=`);
    - **Connect** during the code step shows "Enter the code at plex.tv/link first";
    - Now Playing has a volume slider that moves the music volume, and Escape leaves it;
    - a fast double press on the Watchlist button sends one request (Playwright counts requests) and the tick matches the server;
    - "Part of" shows "This film" on the current film.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** per spec §7.2–7.3.
- [ ] **Step 4: Run** `npm test`, cast-ui, servers-ui and lists-ui. Expected: PASS.
- [ ] **Step 5: Ledger** `Task 8: complete`.

### Task 9: Pictures, docs, version, verification, delivery, review

- [ ] **Step 1: Pictures.** `devtools/v013-shots.mjs`, at desktop and phone sizes: the picker, the Remote page, the pill on Home, Settings → Casting. Build `orbit-progress/v0130-desktop.png` and `v0130-phone.png`, look at them and fix what's wrong.
- [ ] **Step 2: Older themes.** Run `oldthemes-compare.mjs compare`. Expected: all match. Where the Cast button or the "…" sheet's **Cast to…** change a frozen page, re-baseline those pages only and ledger it.
- [ ] **Step 3: Docs and version.**
  - README: a **Casting** feature bullet and a "Casting to a TV" section covering the home network, Docker host networking, the address setting, adding by address and AirPlay.
  - ARCHITECTURE: migration 13, `src/cast/*`, cast links, sessions, the proxy rules, and `ATOMIX_CAST_DEVICES` as a dev switch.
  - `docker-compose.yml`: a commented `network_mode: host` line, with a note.
  - `package.json`: `0.13.0`.
- [ ] **Step 4: Full verification.**
  - `npm test` (expect ≥ 360).
  - cast-ui ×2, servers-ui ×2.
  - extras-lyrics-ui, lists-ui, orbit-ui, orbit-sizes, orbit-a11y, gate-ui, extras-ui, rebrand-ui, music-kbd, profiles-ui, dialogs.
  - The older themes.
- [ ] **Step 5: Delivery.**
  - Hash-check against the v0.12.0 snapshot, then deliver to `D:\Nodeflix`.
  - Run `npm test` on the PC.
  - Update the project note (Round 15 / v0.13.0). Under "Not yet verified": a real Chromecast/Google TV, a real DLNA TV (Samsung/LG), AirPlay from an iPhone to an Apple TV, a converted stream on each, subtitles on each, the address detection on his PC, and Windows Firewall prompts for multicast and port 8787.
- [ ] **Step 6: Review and wrap-up.**
  - Ledger `Task 9: complete`.
  - Run a fresh sonnet review, with the Review Focus verbatim and the ledger rulings.
  - Do one fix pass, each fix RED→GREEN, then re-deliver.
  - Write the final message with every ruling and the deferred minors.
  - Copy the ledger to `scratchpad/note/`, then delete the workspace.
