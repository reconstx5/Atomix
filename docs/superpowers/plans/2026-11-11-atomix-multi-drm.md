# Multi-DRM channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live TV channels can offer several DRM systems; each device plays the one it has (Widevine, PlayReady, FairPlay, ClearKey), and on an iPhone/iPad the channels it can't play are hidden (with a switch) or explained with Watch on TV and the provider's app.

**Architecture:** The IPTV Simple plugin reads every system a channel offers into `drm.systems`; the channels API names them as a list. The browser probes its key systems once and sends them, in its own order, with the play request; `src/live/drm.js` picks the first match and relays only that system (PlayReady added beside Widevine/ClearKey on the DASH path, FairPlay on its HLS path). A pure `channelPlayable()` decides, per device, what the lists hide.

**Tech Stack:** Node ≥ 22.13 (`node:test`, `node:sqlite`), Preact 11 + htm (vendored), EME. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-11-atomix-multi-drm-design.md`

## Global Constraints

- No DRM circumvention: nothing decrypted on the server, no keys taken out of a key system.
- Provider addresses, licence servers and headers never reach browsers, TVs or logs.
- Single-system channels behave as in v0.27; the existing live-drm/live-ui tests pass unchanged.
- Older themes pixel-identical where nothing is hidden (desktop Chrome hides nothing).
- Sentences (exact): "This browser can't play any of this channel's protections." · "This channel's protection doesn't play on iPhone or iPad." · switch "Show channels this iPhone can't play" / "…this iPad…" / "…this browser…" · tag "Can't play here" · button "Open <app name>".
- Provider links: https only; built-in TVNZ 1 / TVNZ 2 / DUKE / TVNZ DUKE → name "TVNZ+", `https://www.tvnz.co.nz`; not shown to Kids profiles.
- Test first (RED → GREEN) for every task; full suite in groups at the end.

## Review Focus

1. A playlist with both `inputstream.adaptive.drm` and `license_type` for the same system — one entry, the JSON's details win.
2. An older page (no `keySystems` in the play body) on a multi-system channel — gets the first system, plays as before.
3. iPhone before the probe finishes — hiding must not flash channels in and out (iOS is decided synchronously).
4. Zapping on an iPhone from a playable channel past hidden ones — never lands on a hidden one, wraps correctly when all others are hidden.
5. A PlayReady licence message that isn't the wrapped XML (or is malformed) — passed through raw / answered with the existing refusal sentence, never a 500.

---

### Task 1: The plugin reads several systems per channel

**Files:**
- Modify: `plugins/iptv-simple/drm.js` (add `parseDrmJson`, PlayReady names), `plugins/iptv-simple/m3u.js` (or wherever `#KODIPROP` lines are read — find with `grep -n license_type plugins/iptv-simple/*.js`), `plugins/iptv-simple/index.js` (`addressOf(..., { system })`, `drm` name list to core)
- Test: `test/iptv-multi-drm.test.js`

**Interfaces:**
- Produces: `systemName()` now maps `com.microsoft.playready`, `com.microsoft.playready.recommendation`, `playready` → `'playready'` and `com.apple.fps.1_0` → `'fairplay'`.
- Produces: `parseDrmJson(text) → [{ system, licence, serverCertificate, initData, url }]` (empty array for bad JSON).
- Produces: channel `drm = { systems: [...] }` (order kept; a later form only adds systems not yet named); channel `appUrl`/`appName` from `atomix.app_url` / `atomix.app_name` (https only).
- Produces: `source.stream(channel, { system })` / `addressOf` returning `{ url, drm: { system, licence, serverCertificate, initData }, ... }` for the chosen system (its `url` when set, else the channel's).

- [ ] **Step 1: Write the failing tests** — `parseDrmJson` of
  `{"com.widevine.alpha":{"license":{"server_url":"https://lic.example/wv","req_headers":"X-A=1","unwrapper":"json,base64","unwrapper_params":{"path_data":"license"}}},"com.microsoft.playready":{"license":{"server_url":"https://lic.example/pr"}},"com.apple.fps":{"license":{"server_url":"https://lic.example/fps","server_certificate":"QUJD"},"atomix_url":"https://cdn.example/master.m3u8"},"com.example.unknown":{}}`
  → three systems in that order, Widevine `licence.headers = {'X-A':'1'}` and response `{kind:'json', path:'license', base64:true}`, FairPlay `url` and `serverCertificate:'QUJD'`; `ftp://` server_url → that system dropped; `{bad` → `[]`; ClearKey `license.keyids` `{"<32hex>":"<32hex>"}` → `{ keys:[…] }`; an M3U entry with the JSON line **and** `license_type=com.widevine.alpha` + `license_key` → one Widevine entry with the JSON's URL; `atomix.app_url=http://x` ignored, `https://x` kept.
- [ ] **Step 2:** `node --test test/iptv-multi-drm.test.js` → FAIL (`parseDrmJson` not exported).
- [ ] **Step 3: Implement** in `drm.js` (reuse `parseHeaderList`, `bodyOf`, `responseOf` — map `unwrapper` `base64`→`B`, `json`→`J<path>`, `json,base64`→`JB<path>`, `base64,json`→`BJ<path>`), then the M3U reader and plugin wiring.
- [ ] **Step 4:** test file PASS; `node --test test/iptv-*.test.js test/live-drm*.test.js` all pass.

### Task 2: Channel data, the channels API and provider links

**Files:**
- Modify: `src/db.js` (migration 31: `ALTER TABLE live_channels ADD COLUMN app_url TEXT; … app_name TEXT; … app_link_admin INTEGER DEFAULT 0`), `src/live/store.js` (`drm` stored as comma list of known names; app link kept unless `app_link_admin`), `src/api/live.js` (`shapeChannel`: `drm` → array or null, `appUrl`/`appName` with the built-in list, none for Kids; `PUT /api/live/channels/:id/app-link` admin: `{ url, name }` https only, `{}` clears), `src/home/rows.js`/`homeCards` (cards carry `drm` and `appUrl`/`appName`)
- Test: `test/live-multi-drm-api.test.js`

**Interfaces:**
- Produces: API channel shape `drm: string[] | null`, `appUrl: string | null`, `appName: string | null`.
- Produces: `providerLink(channel) → { url, name } | null` in `src/live/applinks.js` (admin value → playlist value → built-in by name, case-insensitive, `^(TVNZ ?1|TVNZ ?2|(TVNZ )?DUKE)$`).

- [ ] **Step 1: Failing tests:** a mock playlist channel with Widevine+PlayReady → `/api/live/channels` gives `drm: ['widevine','playready']`; single-system channel gives `['widevine']`; plain channel `null`; a channel named "TVNZ 2" → `appName 'TVNZ+'`, `appUrl 'https://www.tvnz.co.nz'`; admin PUT `{url:'http://x'}` → 400, `{url:'https://y', name:'Y'}` → shown and kept after a playlist refresh; Kids profile sees no link; the home On now card carries `drm`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** PASS; `node --test test/live-*.test.js` pass.

### Task 3: The server picks the system; PlayReady on the relay

**Files:**
- Modify: `src/live/drm.js` (`KEY_SYSTEMS.playready = 'com.microsoft.playready.recommendation'`, `SYSTEM_IDS.playready = ['urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95']`, `chooseSystem(offered, keySystems)`, `start({…, keySystems})`, manifest filter for the chosen system incl. `mspr:pro`, `unwrapPlayReady(bytes)`), `src/api/live.js` (`playEncrypted` passes `body.keySystems`, reply `keySystem` from the chosen one, `system` name too)
- Test: `test/live-multi-drm.test.js` (uses the mock IPTV in `test/helpers-live.js`; add a multi-system ClearKey-served channel there)

**Interfaces:**
- Produces: `chooseSystem(offered: string[], device?: string[]) → string | null` (device order wins; no device list → `offered[0]`).
- Produces: `unwrapPlayReady(buf: Buffer) → { challenge: Buffer, headers: object } | null` (null = not wrapped → send raw).
- Produces: play reply `{ …, keySystem, system }`; 409 `"This browser can't play any of this channel's protections."` before `streams.reserve`.

- [ ] **Step 1: Failing tests:** `chooseSystem(['widevine','playready','clearkey'], ['playready','widevine'])` → `'playready'`; `(['widevine'], ['fairplay','clearkey'])` → null; `(['widevine','clearkey'])` → `'widevine'`. API: multi channel + `keySystems:['clearkey']` → plays ClearKey (manifest has only the ClearKey ContentProtection + mp4protection; licence answered with the playlist keys); `keySystems:['fairplay']` on a DASH-only channel → 409 with the sentence and the provider's manifest **not fetched** (mock counts requests); no `keySystems` → first system. Manifest kept for `playready` keeps `mspr:pro` and drops Widevine's pssh. `unwrapPlayReady` on a UTF-16LE `<PlayReadyKeyMessage type="LicenseAcquisition"><LicenseAcquisition Version="1"><Challenge encoding="base64encoded">QUJD</Challenge><HttpHeaders><HttpHeader><name>Content-Type</name><value>text/xml; charset=utf-8</value></HttpHeader><HttpHeader><name>SOAPAction</name><value>"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"</value></HttpHeader></HttpHeaders></LicenseAcquisition></PlayReadyKeyMessage>` → challenge `ABC`, both headers; raw bytes → null; truncated XML → null. A PlayReady licence POST to the relay sends the unwrapped challenge and SOAPAction to the mock licence server.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement (licence path: when `s.system === 'playready'`, unwrap; headers from the message limited to `content-type` and `soapaction`, then the playlist's).
- [ ] **Step 4:** PASS; `node --test test/live-drm*.test.js test/live-multi-drm*.test.js` pass.

### Task 4: Casting picks Widevine, then PlayReady, then ClearKey

**Files:**
- Modify: `src/cast/sessions.js` (the encrypted cast start passes `keySystems: ['widevine','playready','clearkey']`; the TV manifest's licence address for PlayReady: `mspr:pro` LA_URL rewritten to Atomix's licence link), `public/js/ui/live.js`, `public/js/views/player.js` (castable when the channel offers widevine, playready or clearkey — a helper `castableDrm(drm)` in `public/js/live.js`)
- Test: `test/cast-multi-drm.test.js`

**Interfaces:**
- Consumes: `chooseSystem` (Task 3). Produces: `castableDrm(drm: string[]|string|null) → boolean`.

- [ ] **Step 1: Failing tests:** casting a Widevine+PlayReady channel → session system `widevine`; a PlayReady-only channel → `playready` and the TV manifest names the cast licence address (no provider host); FairPlay-only → refused as today; `castableDrm(['fairplay'])` false, `(['fairplay','playready'])` true, `('widevine')` true.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS; `node --test test/cast-*.test.js`.

### Task 5: The browser plays PlayReady and sends what it has

**Files:**
- Modify: `public/js/dash/eme.js` (`PLAYREADY` names; `keySystemConfigs('com.microsoft.playready…')` → two configs, robustness `3000` then `2000`; `initDataFor` for PlayReady: `cenc:pssh` of the PlayReady system id, else a PSSH built from `mspr:pro`), `public/js/dash/mpd.js` (read `mspr:pro` and the PlayReady system id), `public/js/dash/support.js` (`deviceKeySystems()` → ordered names, cached; iOS synchronous `['fairplay','clearkey']`; `protectionVerdict(systems)` accepts a list), `public/js/views/player.js` (sends `keySystems`; Info "Encrypted (PlayReady)"), `public/js/dash/player.js` (key system from the reply, falling back to plain `com.microsoft.playready` when `.recommendation` is refused)
- Test: `test/dash-multi-drm.test.js` (pure parts: `keySystemConfigs`, `initDataFor`, `deviceKeySystems` ordering with injected probe/ua, `protectionVerdict` for lists incl. the iPhone sentences)

**Interfaces:**
- Produces: `deviceKeySystems({ ua, probe, secure }) → Promise<string[]>` and `deviceKeySystemsNow() → string[] | null` (null until known; iOS known at once).
- Produces: `protectionVerdict(systems: string|string[], opts)` (string form unchanged).

- [ ] **Step 1: Failing tests** (orders: Safari `['fairplay','clearkey']`; Edge on Windows `['playready','widevine','clearkey']`; Chrome `['widevine','playready','clearkey']` filtered by the probe; plain-http page → `[]` plus verdict NEED_SECURE; iPhone with `['widevine']` → the existing iPhone sentence; iPhone with `['playready']` → "This channel's protection doesn't play on iPhone or iPad."; Chrome with `['fairplay']` → "This browser can't play any of this channel's protections.").
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS; `node --test test/dash-*.test.js`.

### Task 6: Hiding what this device can't play; the message card; provider links

**Files:**
- Create: `public/js/dash/playable.js` (`channelPlayable(drm, device) → boolean`, `hiddenFilter(list, { device, showAll })`, `deviceWord()` → 'iPhone'|'iPad'|'browser', `SHOW_KEY` local-storage key `atomix-show-unplayable`), `public/js/ui/cant-play.js` (Preact message card: sentence, Watch on TV, Open <app>, Back)
- Modify: `public/js/views/live.js` + `public/js/ui/live.js` (wall/rows filtered; dimmed + "Can't play here" when shown; the switch in "…"), the older themes' Live TV rows (`live-bits.js` and their view), `public/js/views/guide.js`, the Home On now row, search's On TV, `public/js/live.js` `zapQueue`/`neighbour` (skip unplayable), `public/js/views/player.js` (a typed number or opened hidden channel → the card, no play request), the admin channel "…" → "Provider app link…" dialog
- Test: `test/playable.test.js` (pure), browser check `devtools/iphone-channels.mjs`

**Interfaces:**
- Consumes: `deviceKeySystemsNow()` (Task 5), API `drm` list and `appUrl`/`appName` (Task 2), `castableDrm` (Task 4).

- [ ] **Step 1: Failing tests:** `channelPlayable(null, any)` true; `(['widevine'], ['fairplay','clearkey'])` false; `(['widevine','clearkey'], ['fairplay','clearkey'])` true; device `null` (not known yet) → true (nothing hidden); `hiddenFilter` keeps order, `showAll` returns all with `unplayable: true` marks; zap queue over [A playable, B hidden, C playable] from A → C, from C → A (wrap), only A playable → stays.
- [ ] **Step 2:** FAIL. **Step 3:** implement the helpers, then each list, the card and the admin dialog.
- [ ] **Step 4:** PASS. Browser check `devtools/iphone-channels.mjs` (390×844, iPhone UA, `requestMediaKeySystemAccess` stubbed to refuse Widevine/PlayReady): a mock Widevine-only channel absent from the wall, guide, On now, search; the switch shows it dimmed with "Can't play here"; opening it shows the card with "Watch on TV" and "Open TVNZ+" (named "TVNZ 2" in the mock) and no `/play` request; zapping skips it; desktop Chrome sees it as before. `devtools/compare.mjs` for the Live TV page on desktop: all themes identical.

### Task 7: Release

**Files:** `docs/PLUGINS.md` (the `drm` property, `atomix_url`, `atomix.app_url`/`app_name`), `CLAUDE.md`, `claude/round-30-v028.md` (project doc)

- [ ] **Step 1:** full suite in 4 groups (`ls test/*.test.js | split -n r/4`), all green (known timing tests rerun alone).
- [ ] **Step 2:** browser checks: `devtools/iphone-channels.mjs`, `skip-ui.mjs`, `channels-ui.mjs`, `compare.mjs` for Live TV.
- [ ] **Step 3:** one fresh review of the whole change; one fix pass (each fix RED→GREEN).
- [ ] **Step 4:** deliver to `D:\Nodeflix` (hash-check every PC file against the cloud HEAD of the last delivery first; re-hash after).
