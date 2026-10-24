# Atomix Round 29 — v0.27.0: Live TV on phones, encrypted channels included

Approved in conversation with Dallas on 22 Oct 2026. He chose approach 1 ("use what the devices already have"), HTTPS by **both** routes with Tailscale first, and kept FairPlay mode. Each of the three sections was approved ("looks right").

## Intent

Dallas: "I want to have a way that you can watch tv (including the encrypted channels) on phones … I don't want functionality to be affected for other platforms. if there is a way to have a built in cdn so it doesn't rely on the built in browser do some research and come up with a plan."

He also sent a design doc (`ios_drm_design_doc.md`: FairPlay through a native Capacitor/Swift `AVPlayer` bridge).

### What the research found

**No built-in decryption module.**
- Widevine and FairPlay decryption modules are licensed by Google and Apple, and ship only inside browsers, the phone's OS, Chromecasts and TVs.
- Atomix can't carry its own; that would be circumvention.
- A phone can use its *own* module.

**Android** has Widevine in the system and in Chrome.

**iPhone** has only FairPlay.
- Google's iOS Widevine SDK was for licensed partners only, and went end-of-life on 1 Jan 2024 with no new integrations (Axinom).
- Safari has played FairPlay through EME since iOS 11.2, so a native app isn't needed for FairPlay.

**Dallas's playlist** (read from Atomix's stored copy on his PC):
- TVNZ 1, TVNZ 2 and DUKE are each **DASH + Widevine** only, with mjh's licence proxy (`c.mjh.nz/tvnz-*-wv`).
- There is no HLS/FairPlay variant.
- TVNZ's own FairPlay licence sits behind the TVNZ+ sign-in (Geekzone: "a complex sequence of HTTP requests"). Atomix won't impersonate TVNZ's app.
- So TVNZ on an iPhone means **casting to a Chromecast/Google TV**, which has Widevine.

**Found in the code:** browsers allow EME only in a **secure context** (HTTPS, or `localhost`).
- A phone on `http://<pc>:8787` gets "This channel's protection won't play in this browser", Android included.
- Installing the app needs HTTPS too.

### Success

- On an Android phone, Atomix on its secure address plays TVNZ 1/2 and DUKE.
- On an iPhone, an encrypted channel offers **Watch on TV**. The plain channels play as now.
- A FairPlay source, if a playlist ever has one, plays in Safari.
- Computers, TVs and the plain HTTP address behave exactly as in v0.26.

## Global constraints

- **No DRM circumvention.** Decryption happens only in the device's own module, with licences relayed by Atomix. Provider addresses, headers, keys and tokens never reach a browser, a TV or a log.
- **Nothing changes for other platforms.**
  - The HTTP address (`:8787`) and everything on it stay as they are.
  - HTTPS is an extra listener.
  - New behaviour switches on only where it applies: an insecure context, no Widevine, a cast of an encrypted channel, or a FairPlay channel.
- **No npm install, no build step**; no new libraries. Certificates are built with `node:crypto` and a small DER writer.
- **Rules kept from v0.26:**
  - Kids rules;
  - the provider's stream limit and the account's 4 streams;
  - encrypted channels are live only (no record, rewind or catch-up).
- Older themes stay pixel-identical (`oldthemes-compare` → "all pages match").
- Each file is changed in its own style: Live TV is a Preact screen; the player and Settings are still `render(el)` views.
- Node ≥ 22.13. Windows is the main host: paths, the Tailscale binary location, permissions.

## 1. A secure address at home (HTTPS)

### The listener

`src/tls/server.js`:
- When an HTTPS mode is on, Atomix also listens with `https.createServer` on `httpsPort`.
  - Setting `httpsPort`, default **8443**; env `ATOMIX_HTTPS_PORT`.
  - It serves the same request handler as the HTTP server.
- Certificates live in `<data>/certs/`.
- `server.setSecureContext()` swaps in a renewed certificate without a restart.
- HTTP keeps running unchanged.
- The keep-alive timeouts match the HTTP server's (65 s / 66 s).

### Settings

- `httpsMode`: `off` | `tailscale` | `own` (default `off`).
- `/api/status` adds `secureUrl`: the HTTPS address phones should use, or null.

### Tailscale (`src/tls/tailscale.js`)

**Finding the binary:**
1. `ATOMIX_TAILSCALE` if set;
2. `tailscale` on PATH;
3. `C:\Program Files\Tailscale\tailscale.exe`;
4. `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.

**Getting a certificate:**
- `tailscale status --json` → `Self.DNSName` (trailing dot dropped).
- `CertDomains` must include it. Otherwise: "Turn on HTTPS certificates in Tailscale's admin page (DNS → HTTPS Certificates)".
- `tailscale cert --cert-file <data>/certs/ts.crt --key-file <data>/certs/ts.key <name>`.

**Renewal:** checked at start and daily; renewed when under 30 days are left.

**When something fails, the card shows one sentence:**
- "Tailscale isn't installed on this computer";
- "Tailscale isn't signed in";
- "Run this once as administrator: `<command>`" (permission refused);
- otherwise the command's message.

`secureUrl` is `https://<name>:<httpsPort>`.

### Atomix's own certificate (`src/tls/own.js`, `src/tls/x509.js`)

**The home CA**, made once:
- an EC P-256 key;
- "Atomix home CA (<server name>)";
- 10 years;
- `basicConstraints CA`, `keyUsage keyCertSign`.

**The server certificate**, signed by the CA:
- P-256;
- **825 days** (Apple's limit for private CAs);
- `extendedKeyUsage serverAuth`;
- SAN entries: the hostname, `<hostname>.local`, `localhost`, every LAN IPv4 address and `127.0.0.1`.
- It is remade, by the same CA, when the addresses change or under 30 days are left, so phones never reinstall.

**Downloads** (public, no sign-in, since a phone needs them first; it is only the public CA certificate):
- `/tls/atomix-home-ca.crt` (DER, `application/x-x509-ca-cert`) for Android;
- `/tls/atomix-home-ca.mobileconfig` (an Apple configuration profile carrying the CA) for iPhone.

`secureUrl` is `https://<first LAN IPv4>:<httpsPort>`.

`x509.js` writes DER/PEM (SEQUENCE, INTEGER, OID, UTCTime/GeneralizedTime, the extensions above) and signs with `crypto.sign('sha256')`. Its output must load in `new crypto.X509Certificate()`, and a `tls.connect` with the CA as `ca` must verify.

### Settings → Server → "Secure address (HTTPS)"

The card (older-themes and Orbit styles as for other cards) shows:
- whether *this page* is secure;
- the current secure address (a copy button);
- why phones need it: encrypted channels, installing the app.

**Set-ups:**
- **Use Tailscale** (recommended): steps 1–3 and the status sentence.
- **Use Atomix's own certificate**:
  - the two download links;
  - Android steps: Settings → Security → Encryption & credentials → Install a certificate → CA certificate;
  - iPhone steps: open the profile link in Safari → Settings → Profile Downloaded → Install; then Settings → General → About → Certificate Trust Settings → turn on.
- **Off.**

Choosing a mode starts or stops the listener at once.

### On a phone

On a page that isn't a secure context, an encrypted channel no longer just says `WONT_PLAY`:
- "Encrypted channels need Atomix's secure address on this device", with `secureUrl` as a link when known;
- otherwise "Ask the admin to turn on the secure address (Settings → Server)".

On a secure page, the v0.26 behaviour holds.

## 2. Watching on the phone

### Android (Chrome or the installed app), on the secure address

The same DashPlayer + EME relay as on the PC. On touch devices only:
- **Full screen:** entering full screen locks the orientation to landscape (`screen.orientation.lock`, failures ignored).
- **Screen stays on:** a Screen Wake Lock while a channel plays, released on pause or leave, and taken again on `visibilitychange`.
- **On mobile data** (`navigator.connection.saveData` or `type === 'cellular'`): DashPlayer keeps 10 s ahead instead of 30.
- **Refused quality:** a key status `output-restricted` / `usable-in-future` on a level makes the player drop to the next level down, and say "This phone's protection won't play HD; playing a lower quality".

### No Widevine

When the browser can't get `com.widevine.alpha` (iPhone, Safari on a Mac, some Firefox builds), an encrypted Widevine channel shows the new notice:
- **iPhone/iPad:** "This channel is encrypted with Widevine, which iPhones can't play."
- **Others:** "This browser can't play this channel's protection."
- Then a **Watch on TV** button (Section 3).

Plain channels are unchanged (iPhone: the converted stream).

### FairPlay mode

**IPTV Simple** reads Kodi-style properties (Atomix extension, documented in the plugin README):
- `inputstream.adaptive.license_type=com.apple.fps`;
- `license_key=<licence url>|<headers>|<post form>|<response form>` (the existing grammar);
- `server_certificate=<url or base64>`;
- the manifest is HLS.

`live_channels.drm = 'fairplay'`.

**Server** (`LiveDrm`, system `fairplay`):
- relays the HLS playlists:
  - master and media playlists are rewritten so every URI goes through `r/<n>/…`, with the same origin rules and `relayCheck` as DASH;
  - `#EXT-X-KEY` `skd://` URIs are kept as they are;
  - other key URIs are relayed;
- serves the certificate at `/api/live/drm/:sid/certificate` (fetched by Atomix, or decoded from base64);
- relays the licence, SPC in and CKC out, in the playlist's forms.

**Browser (Safari):**
- `video.src` = the relayed playlist;
- modern EME `com.apple.fps` with `setServerCertificate`;
- the `encrypted` event (`skd`) → `generateRequest('skd', initData)` → the relayed licence.

**Elsewhere:**
- No FairPlay (Chrome/Android): "This channel is encrypted with FairPlay, which plays in Safari on Apple devices", with no Watch on TV.
- FairPlay channels can't be cast.

### Unchanged

Kids rules, stream limits, the Encrypted badge, live only.

## 3. Watch on TV (casting encrypted channels)

**Chromecast only.**
- A Widevine or ClearKey channel can be cast to a Chromecast/Google TV device.
- DLNA and AirPlay keep refusing it: "This TV can't play encrypted channels; use a Chromecast or Google TV".
- FairPlay can't be cast.

**The session:**
- `CastManager` starts a `LiveDrm` session for the cast, whose holder is the cast session: the provider's stream limit and the account's 4 apply.
- The cast session keeps it alive (no browser pings) and stops it on Stop, lost or takeover.

**The cast link:**
- The cast link (`?cast=`, `src/cast/tokens.js`) gains a scope for one DRM session.
- With it, its manifest, segments and licence routes answer the TV.

**The manifest for a TV** (`rewriteManifest(..., { cast })`):
- segment addresses are absolute on `baseUrlFor(...)`'s plain address, with the cast link;
- inside the kept Widevine (or ClearKey) `ContentProtection`, a `<dashif:Laurl>` (namespace `https://dashif.org/CPS`) points at `<base>/api/live/drm/<sid>/licence?cast=<link>`.
- Google's standard receiver (Shaka-based) plays DRM when the licence is named in the manifest.

**The load:** `contentType: application/dash+xml`, `streamType: LIVE`, the channel's name and logo. Channel up/down from the Remote starts the next channel's session, then stops the old one.

**The buttons:**
- **Watch on TV** on touch devices for an encrypted channel: in the player's notice, in the channel's "…" (older themes) and in the Orbit spotlight.
- **Cast to…** (every device) now allows encrypted channels for Chromecast targets.
- With no Chromecast found: "Encrypted channels need a Chromecast or Google TV on your network. Plain channels still play here."

**Not built this round:** a custom Atomix receiver (a one-time US$5 Google Cast registration and an HTTPS page). It is kept as the fallback if a real Chromecast refuses the standard receiver path.

## Verification

### Node tests

**x509 and own certificates:**
- the certificates load in `X509Certificate`;
- they carry the SAN entries, EKU and validity above;
- `tls.connect` verifies against the CA;
- they are remade when addresses change.

**Tailscale:**
- binary discovery;
- reading the status;
- each failure sentence;
- renewal, using a fake `tailscale` script.

**The HTTPS listener:**
- it starts and stops with the setting;
- `setSecureContext` takes a renewed certificate;
- the HTTP server is untouched;
- `/api/status` reports `secureUrl`.

**FairPlay:**
- the playlist properties are read;
- the HLS rewrite leaves no provider host and keeps `skd://`;
- the certificate route;
- the SPC/CKC relay in each form.

**Cast:**
- a DRM session with a cast scope;
- the manifest's `dashif:Laurl` and absolute segment URLs;
- the cast link refused for another session;
- the DLNA refusal sentence;
- the stream limits counted.

### Browser (`devtools/v027-ui.mjs`)

- **https:**
  - the Settings card in each mode;
  - Chromium on the HTTPS address (`ignoreHTTPSErrors`) has a secure context and plays the ClearKey mock channels.
- **phone** (a 390-px touch context):
  - on plain HTTP, an encrypted channel shows the secure-address sentence and link;
  - on HTTPS, a ClearKey channel plays;
  - the wake lock is taken and released;
  - the cellular buffer;
  - without Widevine (`requestMediaKeySystemAccess` patched to reject `com.widevine.alpha`) → the iPhone sentence and Watch on TV.
- **cast:**
  - Watch on TV to the mock Chromecast: the LOAD names the relayed manifest;
  - fetching that manifest with the cast link shows `dashif:Laurl` and no provider host;
  - posting the mock's ClearKey request to the licence URL returns keys;
  - Stop ends the DRM session.

### Other checks

- `live-ui.mjs` (drm, nomse, cast), `a11y-ui.mjs`, `cast-ui.mjs`, `v026-ui.mjs`, `settings-check` green;
- `oldthemes-compare` "all pages match";
- the v0.26 pilot markup (`v026-dom.mjs`) unchanged apart from the new buttons.

**Pictures (`v027-shots.mjs`):**
- the HTTPS card (each mode);
- a phone with the secure-address notice;
- the iPhone notice with Watch on TV;
- Watch on TV's device list.

**A fresh review and one fix pass per plan.** PC delivery hash-checked against v0.26.0, then the PC tests.

### Not yet verified (listed in build status)

- a real Tailscale account and `tailscale cert` on Dallas's Windows PC;
- installing the home CA on a real Android phone and iPhone;
- TVNZ 1/2 and DUKE on a real Android phone (Widevine L1/L3, HD limits);
- the standard Chromecast receiver honouring `dashif:Laurl` with Widevine on a real device;
- FairPlay on a real iPhone (no source yet);
- the wake lock and orientation lock on real phones.

## Plans

- **A:** HTTPS. The listener, Tailscale, the own certificate (x509), the Settings card, `secureUrl` and the phone's secure-address notice.
- **B:** phones. Android polish (orientation, wake lock, cellular buffer, refused quality), the no-Widevine notice, FairPlay mode (plugin, relay, Safari player).
- **C:** Watch on TV. The cast DRM session, the cast link scope, the manifest licence address, buttons and sentences, `v027-ui cast`, `v027-shots`, v0.27.0 and the round close.

Native (inline) execution, as before.
