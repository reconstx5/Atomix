# Multi-DRM channels — design (v0.28)

Dallas, 11 Nov 2026: "make my custom player for atomix to have cross-platform DRM or Multi-DRM support". Chosen:
**more provider channels** (not protecting his own library) and **approach 1 — several systems per channel, chosen
per device**.

## Goal

A Live TV channel whose provider offers several DRM systems plays on every device that has one of them, each with its
own key system: Widevine (Chrome, Firefox, Android, Chromecast), PlayReady (Edge on Windows, Xbox, many smart TVs,
Chromecast), FairPlay (Safari on iPhone, iPad and Mac), ClearKey (any browser). The device says what it has; the server
picks the match, relays only that system's details and licence.

## Not in scope

- Decrypting anything on the server, or taking keys out of a key system. Nothing changes here: the device's own key
  system decrypts; Atomix relays manifests, segments and licence requests (as v0.17–v0.27).
- Channels that offer one system only. TVNZ 1/2 and DUKE (Widevine only) still won't play on an iPhone; the sentence
  stays the same.
- Protecting Atomix's own library with DRM (a separate idea, needs a paid licence service).
- PlayReady or FairPlay offline, persistent licences, key rotation beyond what the relay already passes through.

## Success

1. A playlist entry listing several systems is read into one channel with all of them, in the playlist's order.
2. Chrome gets Widevine, Edge gets PlayReady, Safari gets FairPlay, a browser with only ClearKey gets ClearKey — for the
   same channel — and each plays (verified with ClearKey mocks in the cloud; Widevine, PlayReady and FairPlay on real
   devices by Dallas when a provider offers them).
3. A device with none of the channel's systems hears one sentence before any stream opens, and gets **Watch on TV**
   where a TV could play it.
4. Single-system channels behave exactly as in v0.27 (same tests pass unchanged).
5. Provider addresses, licence servers and headers never reach the browser or logs (as before).

## Playlist (IPTV Simple)

Read in this order; a later form adds systems the earlier ones didn't name:

1. **Kodi's newer property** (inputstream.adaptive 21+):
   `#KODIPROP:inputstream.adaptive.drm={"<key system>": {"license": {...}}, ...}` — a JSON object, one entry per key
   system, in order of preference. Per system, the subset Atomix reads:
   - `license.server_url` (http/https only), `license.req_headers` ("Name=Value&…", URL-encoded), `license.req_data`
     (the body template: `R{SSM}`, `b{SSM}`, `B{SSM}` as today), `license.unwrapper` (`base64`, `json`,
     `json,base64`, `base64,json` → the existing response kinds) and `license.unwrapper_params.path_data` (JSON path),
     `license.server_certificate` (base64), `license.keyids` (ClearKey: `{"<kid hex>":"<key hex>"}`).
   - `init_data` (base64) as `license_data` today.
   - **Atomix extension:** `atomix_url` — this system's own stream address (FairPlay usually needs the provider's HLS
     address while the channel's URL line is the DASH one). Without it the channel's URL is used.
   - Key system names: `com.widevine.alpha`, `com.microsoft.playready` (also `com.microsoft.playready.recommendation`),
     `com.apple.fps` (also `com.apple.fps.1_0`), `org.w3.clearkey`. Others are skipped.
2. **The older properties** (`license_type` + `license_key`, `drm_legacy`): one system, as today.

A channel with systems keeps them as `drm.systems = [{ system, licence, serverCertificate, initData, url }]`; the
existing single-system shape is read as a one-entry list everywhere (no migration of plugin storage needed).

## Data

`live_channels.drm` (TEXT) holds the names in the playlist's order, comma-separated (`widevine,playready,fairplay`).
A single name stays valid. `/api/live/channels` (and the shapes built from it) carry `drm` as an **array** of names;
the browser's `protectionOf()` accepts the old string too.

## Choosing the system

- The browser probes, once per page, which of `fairplay`, `playready`, `widevine`, `clearkey` it has
  (`requestMediaKeySystemAccess`, on a secure page only) and sends them **in its own order of preference** with the
  play request as `keySystems: [...]`:
  - Safari (Apple): fairplay, clearkey (Safari's Widevine/PlayReady don't exist).
  - Edge on Windows: playready, widevine, clearkey (PlayReady is hardware-backed there; Widevine is software-only).
  - Everything else: widevine, playready, clearkey.
- The server takes the **first of the device's list that the channel offers**. None in common → 409 with the sentence
  below (no stream reserved, nothing fetched from the provider).
- An older page that sends no `keySystems` gets the channel's first system (today's behaviour).
- The pre-check before a stream (`dash/support.js protectionVerdict`) answers for the list: null when any of the
  channel's systems is on the device, else the sentence for the best one to explain:
  - iPhone/iPad, channel without FairPlay or ClearKey: the existing "encrypted with Widevine, which iPhones can't play"
    when Widevine is among them, else **"This channel's protection doesn't play on iPhone or iPad."**
  - Otherwise **"This browser can't play any of this channel's protections."** (Plain-http page: the existing
    NEED_SECURE sentence first.)

## Server relay (`src/live/drm.js`)

- `start({ ..., keySystems })` picks the system (above), asks the source for that system's address
  (`addressOf(source, channel, { system })`; the plugin returns the chosen entry's `url`/licence), and the session
  keeps only the chosen system.
- PlayReady joins the DASH path: `KEY_SYSTEMS.playready = 'com.microsoft.playready.recommendation'` (the browser asks
  for that first, then plain `com.microsoft.playready`; the session reply names the one the server expects as a hint
  only — the browser falls back itself), `SYSTEM_IDS.playready = ['urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95']`.
  The manifest keeps only the chosen system's ContentProtection (and `mp4protection`), as today for Widevine; the
  licence address (`ms:laurl` / the `mspr:pro` header's LA_URL) is the relay's own, never the provider's: the
  provider's `mspr:pro` element is kept (the key ids live in it) but its LA_URL is not used by the browser, which
  sends every request to Atomix's licence address.
- **PlayReady licence requests**: Edge and Chromium wrap the challenge in a `PlayReadyKeyMessage` XML (UTF-16) with
  the challenge (base64) and HTTP headers. The relay unwraps it: posts the decoded challenge to the provider with the
  wrapped headers that are safe (Content-Type, SOAPAction) plus the playlist's headers, and returns the provider's
  answer as it is. An unwrapped (raw) challenge is passed as is.
- FairPlay keeps its HLS path (v0.27), now reachable from a multi-system channel through the system's `atomix_url`.
- Casting (`src/cast/`): the TV's choice is widevine, then playready, then clearkey; a Chromecast's manifest names
  Atomix's licence address for whichever was chosen (`dashif:Laurl`, plus `mspr:pro`'s LA_URL rewritten for
  PlayReady). FairPlay still can't be cast. DLNA unchanged ("This TV can't play encrypted channels…").

## Browser (`public/js/dash/`)

- `eme.js`: PlayReady key system support — `keySystemConfigs` (robustness for PlayReady: `3000` then `2000`, i.e.
  hardware then software, asked as two configurations), `initDataFor('playready', …)` from the manifest's `mspr:pro`
  (wrapped into a PSSH) or the `cenc:pssh` for the PlayReady system id; the licence request posts the key system's
  message bytes unchanged (the server unwraps).
- `support.js`: `availableKeySystems()` (the probe, ordered as above, cached) and `protectionVerdict(systems)` for a
  list.
- `player.js` / `views/player.js`: send `keySystems` with the play request; play whichever system the reply names
  (DASH engine for widevine/playready/clearkey, the FairPlay path for fairplay). The Info line says which system is in
  use ("Encrypted (PlayReady)").
- Lock badges and the guide show "Encrypted" as before; the hidden text names the systems ("Encrypted: Widevine,
  PlayReady").

## Channels a device can't play (iPhone and iPad first)

Dallas's choices (11 Nov): **hide them, with a switch**, and **offer the provider's own app when known**.

- **Which:** an encrypted channel none of whose systems this device can play — known without asking on an iPhone or
  iPad (no Widevine or PlayReady there: a channel without FairPlay or ClearKey), and from the key-system probe
  elsewhere (secure page only: on a plain-http page nothing is hidden, since the secure address may play it).
  Worked out in one Preact-side helper, `public/js/dash/playable.js` (`channelPlayable(channel, device)` pure and
  Node-tested; `deviceKeySystems()` from `support.js`), used by every list below.
- **Hidden** from: the Live TV wall and channel rows (all themes), the guide, Home's On now, search's On TV, the
  player's channel list and channel up/down (zapping skips them). A typed channel number of a hidden channel opens its
  message card instead of playing.
- **The switch:** "Show channels this iPhone can't play" ("…this iPad…", "…this browser…" elsewhere) in Live TV's
  "…" sheet (Orbit) and as a check box above the channel list (older themes); kept per device (local storage, like
  the zap order). Shown only when at least one channel is hidden. With it on, those channels are listed dimmed with a
  small "Can't play here" tag; opening one shows the message card.
- **The message card** (replaces starting a stream; no stream is reserved): the sentence ("This channel is encrypted
  with Widevine, which iPhones can't play." / the multi-system sentences above), **Watch on TV** (when casting is on),
  and **Open <app name>** when the channel has a provider link. Back closes it.
- **Provider links:** a channel's link and name come from, in order: the admin's per-channel setting (Live TV channel
  "…" → "Provider app link…": an https address and a button name); the playlist (`#KODIPROP:atomix.app_url=` and
  `atomix.app_name=`, Atomix extensions); a short built-in list — TVNZ 1, TVNZ 2 and DUKE (also "TVNZ DUKE") →
  "TVNZ+", `https://www.tvnz.co.nz` (opens the TVNZ+ app when it is installed, the site otherwise). Only https
  addresses; the link is shown only on a device that can't play the channel. Stored in `live_channels.app_url` /
  `app_name` (migration 31; the admin's choice survives playlist refreshes).
- **Kids profiles** follow the same rules (a link opens outside Atomix, so Kids profiles don't get the button).

## Errors (plain sentences)

- "This browser can't play any of this channel's protections." (409 from the server, and the pre-check)
- "This channel's protection doesn't play on iPhone or iPad." (pre-check)
- Everything after a system is chosen uses the existing sentences (REFUSED, NOT_ANSWERING, WONT_PLAY, …).

## Testing

- Node: the `drm` JSON parsing (every field above, bad JSON, unknown systems, non-http URLs refused, order kept,
  merge with the older properties); the chooser (device order wins, none in common → 409 before the provider is
  asked, no list → first system); manifest filtering keeps only the chosen system's ContentProtection for each of the
  three DASH systems; PlayReady message unwrapping (UTF-16 XML → challenge + headers; raw passes through; malformed →
  REFUSED-class error, not a crash); the channels API returns `drm` as a list; single-system channels unchanged (the
  existing live-drm tests untouched and passing); casting picks widevine → playready → clearkey.
- Browser (cloud, Chromium): a mock channel offering Widevine + PlayReady + ClearKey plays with **ClearKey** (headless
  Chromium has no Widevine/PlayReady), proving the choice and fallback path end to end; a channel offering only
  PlayReady shows the "can't play any" sentence before any stream request; Info names the system.
- Hidden channels: `channelPlayable` for iPhone/iPad/Edge/Chrome/http-page cases; a browser check at phone size
  with an iPhone user agent and Widevine removed: TVNZ-like channels absent from the wall, guide, On now, search and
  zapping; the switch brings them back dimmed; opening one shows the card with Watch on TV and "Open TVNZ+" and opens
  no stream; desktop Chrome unchanged; older themes pixel-identical with nothing hidden.
- Real devices (Dallas, when a provider offers it): Edge with a PlayReady channel, an iPhone with a FairPlay +
  Widevine channel, a Chromecast with PlayReady.

## Risks

- PlayReady servers differ in what they want around the challenge (SOAPAction, content type); the unwrapper follows
  the wrapped headers, which is what Edge itself sends. Untestable here without a real PlayReady server.
- Kodi's `drm` property may grow fields Atomix ignores; ignored fields are listed in the plugin card's status when a
  channel's entry can't be used ("N channels have protection Atomix can't use").
