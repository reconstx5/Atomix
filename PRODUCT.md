# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Three audiences, weighted equally. No screen is allowed to be the lesser experience.

- **Viewers on a TV**, on the sofa with a remote or arrow keys, browsing and watching from across the room.
- **Viewers on a phone or laptop**, browsing, watching, listening to music, or acting as the remote for a cast to a TV.
- **Self-hosters**, who install Atomix on their own PC or VPS, add libraries, manage accounts and profiles, and keep it running. They are strangers downloading a public open-source project, not only the author's household.

Within a household, accounts hold several "Who's watching?" profiles, including kids profiles limited by age rating.

## Product Purpose

Atomix is a self-hosted media hub. Point it at movie, TV and music folders and it builds a library with artwork, resume points and per-profile watch history, then streams to any browser on the same PC, the home network, or the internet from the owner's VPS.

It is intended for public open-source release, so first run, documentation and defaults have to work for someone who has never seen it before.

## Positioning

Three claims future work must protect:

- **Zero dependencies.** One Node.js process using only built-in modules, plus external ffmpeg/ffprobe. No `npm install`, no build step; the web app is plain ES modules that are edited and refreshed.
- **A TV-grade interface in a browser.** A 10-foot, remote-driven experience that needs no native app, alongside phone and laptop use of the same web app.
- **One front for every server.** Jellyfin, Emby, Plex and other Atomix libraries appear beside local files in one interface, under the same access and kids rules.

## Operating Context

- Runs on Windows, macOS, Linux, or in Docker on a VPS behind Caddy or nginx. Default address is port 8787.
- Used with a TV remote or arrow keys (Enter to open, Backspace for back), a mouse, touch, and keyboard media keys.
- File layouts, artwork names and `.nfo` files follow Kodi, Plex and Jellyfin conventions.
- Metadata comes from TMDB (owner supplies a key), local artwork and `.nfo` files; lyrics from `.lrc` files, tags or LRCLIB; subtitles from files, embedded tracks or OpenSubtitles.
- Playback is direct when the browser can handle the file, otherwise remuxed or transcoded by ffmpeg; HLS for Safari and iPhone.
- Casting targets Chromecast / Google TV and DLNA TVs on the same network; AirPlay through Safari.
- Most settings live in the web UI; start-up options come from environment variables or `atomix.config.json`.

## Capabilities and Constraints

- Movies, TV and music libraries; collections and film series; watchlist and playlists; "because you watched" rows; trailers and extras; lyrics and Now Playing; seek-bar previews and Skip intro; new-arrival alerts.
- Accounts are admin or viewer. Up to 12 profiles per account, optional PINs. Kids profiles hide unrated or over-age titles, settings and add-ons. Library access can be limited per account and per profile.
- Every library query passes through viewer visibility rules, so UI work must not expose titles a profile cannot see.
- Themes are swappable folders under `themes/` (Orbit is the default; Arctic, Arctic Side, Midnight, Harbour, Daylight, Obsidian also ship), with per-user accent colours. Plugins are folders under `plugins/`.
- A **Reduce effects** setting exists for slower TVs.
- Hard constraint: no npm dependencies and no build step, for server or web app. Requires Node.js 22.13 or newer.
- Terminology in use: library, profile, "Who's watching?", Watchlist, playlist, collection, Up next, Now Playing, Extras, connected server, add-on source.
- Undecided: licence for the public release (no licence is recorded in the repository).

## Brand Commitments

- The name is **Atomix**. It was previously called NodeFlix; old config names, environment variables and database files keep working.
- Atomix is an independent project. It borrows Kodi's conventions but contains no Kodi code, and the Arctic themes are original stylesheets inspired by, not copied from, the Arctic Kodi skins.
- Written voice in the README and UI labels is plain and direct, explaining what a thing does rather than naming the technology behind it.
- Stated use: media the owner owns or has the right to share.

## Evidence on Hand

- `README.md` for the feature list, setup and troubleshooting.
- `docs/ARCHITECTURE.md`, `docs/THEMES.md`, `docs/PLUGINS.md`, `docs/DEPLOY.md`.
- Seven shipped themes in `themes/`; five example plugins in `plugins/`.
- Bundled fonts in `public/fonts/` (Sora, League Gothic, Roboto Condensed, all OFL).
- App icon and favicon in `public/img/`.
- None on hand: testimonials, user counts, benchmarks, press, screenshots or demo recordings. Future work must not invent them.

## Product Principles

1. **Every screen is first-class.** A change is not done until it works with a remote on a TV, with touch on a phone, and with a mouse and keyboard on a laptop.
2. **Nothing to install, nothing to build.** Any change that needs an npm dependency or a build step is out of bounds.
3. **A stranger can run it.** First run, defaults, labels and error messages must make sense to a self-hoster who has only the README.
4. **The household's rules always hold.** Profiles, PINs, kids limits and library access apply everywhere, including connected servers, search, casting and plugins.
5. **Other servers are guests.** Connected servers keep their own catalogue, artwork and watched state; Atomix presents them without changing them.
