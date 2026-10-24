# Atomix v0.21.0 — install as an app, offline downloads, and the v0.19/v0.20 tidy-up (design)

Round 23. Dallas: "Add some updates." He picked **Install as an app + downloads** and the **tidy-up of the v0.19 and
v0.20 leftovers**; downloads go **inside the app, phone-sized**; admins switch downloads on **per account**.

## Why

Atomix only works while it can reach the server. On a plane, a bus or a phone plan with little data, the household
can't watch anything they own. The leftovers from the last two rounds are small, but there are about sixty of them,
and several are things people notice (a speed that survives a channel change, a plot locked by a Save nobody made).

## Hard limits

- No dependencies. Node ≥ 22.13, `node:sqlite`, ffmpeg; plain ES-module browser code; the offline helper is a plain
  service worker file.
- **Secure context:** installing, the service worker and the browser's private file storage (OPFS) only work over
  HTTPS or on `localhost`. On plain `http://<LAN address>` the app explains that and offers the existing file
  download instead (grown-up profiles, as today). No certificate tricks.
- Kids profiles download only what they may watch (their age and library rules); downloads stay inside the app (the
  "save the file" download stays grown-ups-only, as today). Kids never see admin settings.
- Nothing secret is stored on the device beyond what the browser already holds (the session cookie). Downloaded
  files are not encrypted (no DRM); encrypted Live TV channels can't be downloaded.
- Older themes stay pixel-identical (`oldthemes-compare.mjs compare` → "all pages match"); new pages and controls may
  appear in them only where they don't change an existing page's look.
- Out of scope: Live TV channels, titles from connected servers (Jellyfin/Emby/Plex/Atomix: "Downloads aren't
  available for titles from a connected server yet."), add-on sources, background downloads after the app is closed
  (Background Fetch isn't in Safari), push notifications.

## 1. Preparing a download on the server (plan A)

- **Migration 23:** `users.can_download` (0/1; admins 1, everyone else 0 on upgrade and for new users) and
  `download_jobs` (id, item_id, quality `480|720|1080`, format `mp4|webm|audio`, status
  `queued|preparing|ready|failed`, progress 0–1, file, size, error, created_at, used_at; unique on item, quality,
  format).
- **What a download is:** a film, an episode (also a recording) or a song. A season, an album and a playlist add
  each of their titles the profile may watch.
- **Format:** video → H.264/AAC MP4 (`+faststart`), or VP9/Opus WebM for a browser that can't play H.264 (from the
  same caps the player sends); 2-channel AAC/Opus at 128–160 kb/s; text subtitles kept as `.vtt` beside it; a burned
  picture subtitle is not included (they can be chosen online). Songs: the original when the browser plays its codec,
  else AAC 192 kb/s in MP4 (`audio`). A file already at or under the chosen height in the chosen codecs is copied,
  not converted.
- **Qualities:** 480p (~1 Mb/s), 720p (~2.5 Mb/s, the default), 1080p (~5 Mb/s). The admin picks the default.
- **Queue:** `src/downloads/` — one conversion at a time at low priority (`nice`/`-threads` like the preview jobs),
  paused while someone watches a converted stream or a recording is joining (the existing "media jobs yield" rule).
  The finished file sits in `<data>/downloads/` (or the admin's folder); a file nobody fetched for 7 days is removed;
  the folder is kept under the admin's size limit (default 50 GB, oldest-used first). A job for the same title,
  quality and format is shared.
- **Routes** (signed in; `can_download` or the request is 403 "Downloads aren't switched on for this account. Ask an
  admin."): `POST /api/downloads { itemIds, quality, caps }` → one entry per title `{ itemId, jobId, status, size? }`
  (titles the profile can't watch are left out, with a count); `GET /api/downloads/jobs?ids=` → status/progress;
  `GET /api/downloads/:jobId/file` (Range, `private, no-store`; only for a profile that may watch the title);
  `GET /api/downloads/:jobId/subtitles/:sub`; `POST /api/downloads/check { itemIds }` → `{ keep, remove }` (a title
  the account or profile may no longer download is in `remove`); `POST /api/downloads/progress [{ itemId, position,
  duration, at }]` (queued offline progress; newest `at` wins against what the server already has).
- **Settings → Server → Downloads:** on/off for the server, the folder, the cache size limit, the default quality,
  how long a device keeps a download offline (30 days, 7–90). **Settings → Users:** a "Can download" switch per
  account. The Dashboard shows "Preparing downloads: N".
- **Activity:** "dallas downloaded The Test Movie (720p)" once per title per device fetch.

## 2. On the device: install, the offline helper and Downloads (plan B)

- **Install:** the manifest gains proper icons (192, 512, maskable, from the Atomix mark), `id`, `scope`, shortcuts
  (Downloads, Live TV); the browser's own install prompt is caught and offered as **Install Atomix** in Settings →
  Profile (and in Orbit's "…" on Home). On iPhone the card says "In Safari: Share → Add to Home Screen". Not offered
  when already installed or when the page isn't secure (then the card says why).
- **Service worker** (`public/sw.js`, scope `/`): keeps the app shell (HTML, CSS, JS, fonts, icons) for offline use,
  cache-first with a version from `/api/status`; API calls always go to the network; `/offline/…` addresses are
  answered from the browser's private file storage (with Range, so seeking works). A new version takes over at the next
  open, never mid-playback.
- **Storage:** files in OPFS (`atomix-downloads/<profileId>/<itemId>.<ext>` + subtitles), a small index in IndexedDB
  (item details, artwork thumbnail, quality, size, downloaded/expires/position). `navigator.storage.persist()` is asked
  the first time. A per-device limit (the smaller of the browser's quota and what the admin allows per device, default
  20 GB) is shown as "Using 3.2 GB of 20 GB".
- **Downloading:** the device asks the server to prepare, shows "Preparing… 40%" (polled), then fetches in 8 MB
  Range pieces written straight into the file ("Downloading… 1.2 of 2.0 GB"), resuming where it stopped after a lost
  connection or a closed tab (on the next open). Up to 2 at a time; pause/resume/cancel. Only while the app is open.
- **Download buttons:** on film, episode, season, album and playlist pages (and a song's "…"): **Download** →
  a quality sheet (videos) → states Preparing / Downloading N% / **Downloaded** (pressing it offers Remove). Not shown
  for titles the rules exclude (above) or when the account can't download.
- **Downloads page** (`#/downloads`, in the menu): grouped Films / Shows (by show and season) / Music; each row with
  artwork, size, quality, expiry ("Expires in 26 days"), Play and Remove; the space bar; "Remove all". Each profile
  sees its own. It is the page the app opens to when the server can't be reached ("You're offline — your downloads are
  here"); the rest of the menu is disabled with that reason.
- **Playing offline:** the normal player, with `offline` source: plays from `/offline/…`, its subtitles, resume from
  the saved position; no quality, audio-track or cast controls; Up next only among downloaded episodes. Music plays
  through the normal music player and queue. Progress is saved on the device and sent (`/api/downloads/progress`)
  when back online; a watched film/episode counts in play history then.
- **Expiry and checks:** each time the app is online it calls `check`; titles in `remove` are deleted with a toast;
  a download not checked for the server's offline days stops playing ("Connect to Atomix to keep this download") and
  is deleted a week later.
- Kids profiles: the same page and buttons, their rules only; the picker still asks "Who's watching?" offline (PINs
  are checked against a salted PBKDF2 hash kept from the last online pick — guarding profiles from each other, as online —
  so a kid can't open a PIN'd profile offline).

## 3. Tidy-up: Live TV recording/rewind and music apps (plan C)

From the v0.19 and v0.20 reviews (each fixed with a test that fails first; one line each in the plan):

- **Tuner/rewind:** per-viewer listeners removed from long-lived tuners; the account stream cap re-checked after a dash
  viewer acquires; a tuner that fails fresh says why (403 → "The provider refused this channel" at once, not 10 s then
  "unbuffered"); a long-lived tuner restarts on a fresh provider URL; "paused too long" said once per pause; admins can
  stop a dash viewer from the Dashboard; a conversion can rewind into an earlier run.
- **Recording:** retune goes through takeSlotFor with a retry budget, DirectRecorder backs off (2 s → 60 s); folder
  names never start or end with a dot; a viewer start in progress no longer fails a recording "every stream is
  recording"; shutdown waits (≤ 10 s) for in-flight joins; the recordings folder can't be inside the data folder or a
  drive root, and the work folder stays with each recording; a rule edit cancels airings that no longer match;
  clashes counted once per tuner; a failed join keeps its pieces with a **Try again** on the Recordings page.
- **Recordings page:** focus kept after a failed row action; row focus matched by section and id; Stop series picks
  the rule the sheet came from; Back on the Delete question cancels it; the question is aria-describedby'd; a failed
  re-read keeps the page and retries; Stop's message says what happened; Remove says "Removed"; the sheet says
  "Recording scheduled" once; dot and catch-up badge don't overlap; an emptied minutes field is refused with a
  sentence, and an error focuses the field it names.
- **Music apps:** scrobbling several ids checks them all first; playlist index removal counts the entries the profile
  sees; other formats asked for become Opus when the app can play it (else MP3) and an unprobed bitrate under a cap is
  converted; a conversion stops when its app leaves before ffmpeg starts; the busy sentence says "converting other
  songs or videos"; a listen queued mid-send goes out in that pass; caps signal more (`<more>` paging where the API
  allows); apiKey compared in constant time; `remotefile.js` indentation.
- **Smart playlists and ratings (v0.20 A):** a media change without rules keeps the rules; the shuffle seed is per
  profile and device; the music bar's heart repaints from any change; Plays' recent map pruned in O(1); smart lists
  skip the second visibility pass; `favourite: "false"` is false; a Kids PATCH is refused before anything is saved.

## 4. Tidy-up: household, player and editing (plan D), and v0.21.0

- **Watch together:** a member's "ready" waits for its converted stream's restart; `next` only accepts the show's next
  episode (or the playlist's next); a member's Kids rules re-checked on next; headphone and lock-screen play/pause are
  shared (mediaSession handlers in the video player); the "Left doesn't seek" check tightened.
- **Quick Connect and Activity:** the TV's own address is logged for a Quick Connect sign-in; turning Quick Connect off
  cancels codes approved but not yet collected; the Activity profile filter lists every account's profiles.
- **Stats:** "1 hour"; grid cells read once; plays placed by each one's own time-zone offset.
- **Player:** any speed returns to 1× at a zap / Go live; an audio delay pressed just before leaving is saved; the HLS
  `-readrate` follows the speed (2× → 2.5); a delay save with no profile is 428 "Choose who is watching first."; Up/Down
  move past the delay row and Left/Right move across the speed grid; chapters backfill errors caught, and a timeout
  doesn't store "no chapters".
- **Edit details:** an address whose bytes aren't a picture is refused (and removed); clearing Sort title unlocks it;
  plots compared with normalised line endings and spaces (no lock without a change); focus returns to the title's "…".
- **Declined last round, decided now:** casts carry the audio and subtitle delay (Chromecast text tracks shifted; DLNA
  and burned subtitles through the same `-itsoffset` input); moving an episode to another season refuses a duplicate
  number ("Season 2 already has episode 3.") and removes a season left empty.
- **v0.21.0:** version, README (Install and Downloads; the HTTPS note), ARCHITECTURE (migration 23, downloads, the
  service worker), `devtools/v021-shots.mjs` (Install card, quality sheet, Downloads page online and offline, offline
  player, Settings → Downloads), and the full verification set.

## Testing

- Node tests: migration 23; the queue (one at a time, yields to converted playback, shared jobs, cache limit and 7-day
  cleanup, copy vs convert decision, the WebM path); routes (403 without `can_download`, Kids rules, Range on the
  file, check/remove after the switch is turned off, progress merge by time); each tidy-up item.
- Browser checks (`devtools/v021-ui.mjs`, Playwright on `localhost` so it is a secure context): install prompt
  caught; download a short film (WebM: this Chromium has no H.264) and an album; resume after the network is cut
  mid-download; go offline (`context.setOffline`) → the app opens to Downloads, plays the film with subtitles and
  seeks, saves progress; back online → progress reaches the server, an account switched off → its downloads removed;
  expiry; Kids rules; phone width; keyboard/remote only; a11y names.
- `a11y-ui`, `live-ui`, `lists-ui`, `music-ui`, `settings-check`, `v020-ui` and `oldthemes-compare` stay green.

## Review focus (for the plans)

1. A download cut off mid-file and resumed — the file plays to the end without a gap (byte offsets, not piece counts).
2. An account switched off, or a title re-rated above a Kids profile's age, while a device is offline — removed at the
   next online check, never played after the offline period.
3. The service worker after an Atomix update — no mix of old shell and new API; never swaps during playback.
4. A full device (quota error mid-download) — stops with "This device is out of space for downloads", nothing half-
   indexed.
5. Two profiles on one device downloading the same title — each sees only its own; removing one keeps the other.
