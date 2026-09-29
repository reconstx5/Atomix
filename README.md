# NodeFlix

A self-hosted, customisable media hub in the spirit of Kodi. Point it at your movie, TV and music folders and it
builds a Netflix-style library with artwork, resume points and per-person watch history — then streams to any
browser on your PC, your home network, or the internet from your own VPS.

- **Zero dependencies.** Pure Node.js (built-in HTTP server and SQLite). No `npm install`, no build step.
- **Movies & TV** — folder scanning, season/episode detection, posters, descriptions and age ratings from TMDB, local artwork and Kodi `.nfo` files.
- **Music** — artists, albums and songs from your tags (or folder names), cover art, a queue with shuffle/repeat, and a mini-player that keeps going while you browse. Works with the keyboard's media keys and the phone lock screen.
- **Plays anything** — direct play when the browser can handle the file, otherwise on-the-fly remux or transcode with ffmpeg (optional NVIDIA/Intel/AMD/Apple hardware acceleration). HLS for Safari/iPhone.
- **Seek-bar previews and Skip intro** — small pictures above the seek bar while you scrub, also with a TV remote (hold → to go faster, OK to jump). TV episodes get a **Skip intro** button: intros are found from chapter names, or by matching the theme tune across a season, and admins can fix them on the episode page. Both are made in the background at low priority and pause while someone watches a converted video.
- **Subtitles** — `.srt`/`.vtt`/`.ass` next to the video and embedded text tracks; picture subtitles (PGS/DVD) are burned in. Missing ones can be searched for and downloaded from OpenSubtitles right in the player.
- **Accounts and profiles** — admin and viewer accounts; each account can have several “Who's watching?” profiles with their own progress, “continue watching” and “next up”. Optional PINs.
- **Kids profiles** — only show titles rated for an age you choose (NZ, AU, UK, US, CA or IE ratings), and hide settings and add-ons. You can also limit which libraries each account or profile sees.
- **New-episode alerts** — a message to Discord, email or any webhook when new movies or episodes arrive.
- **Arctic look** — the default theme takes its cues from the Arctic: Zephyr – Reloaded and Arctic Horizon 2 Kodi skins: full-screen artwork that follows what you're focused on, a spotlight with the title's clear logo and details above rows of posters, a plain text menu with a clock, media flags (4K · HDR · 5.1…) and "Ends at" times. Its signature: the interface takes its light from the artwork — each title's colour tints the glow, focus and buttons. **Arctic Side** puts the menu down the left.
- **Customisable** — swappable themes (Arctic, Arctic Side, Midnight, Harbour, Daylight, Obsidian), per-user accent colours, and a plugin system for new metadata sources, home-screen rows, API routes and Kodi-style add-on sources.
- **10-foot UI** — arrow keys / TV remote navigation, Backspace for back, media keys in the player.

> NodeFlix is for media you own or have the right to share. If you open it up on the internet, only give
> accounts to people allowed to watch that content.

---

## Quick start (Windows, macOS, Linux)

1. Install **Node.js 22.13 or newer** (the current LTS from <https://nodejs.org> is perfect).
2. Install **ffmpeg** (needed for MKV/HEVC files and media info):
   - Windows: `winget install Gyan.FFmpeg` (then open a new terminal)
   - macOS: `brew install ffmpeg`
   - Ubuntu/Debian: `sudo apt install ffmpeg`
3. Start NodeFlix in this folder:
   - Windows: double-click **`start-windows.bat`**
   - Or in a terminal: `npm start`
4. Open <http://localhost:8787>, create the admin account, then **Settings → Libraries → Add library**.

Other devices on your network can use the "Network" address printed in the terminal
(Windows may ask to allow Node.js through the firewall — allow it on private networks).

### Get posters and descriptions

Create a free account at [themoviedb.org](https://www.themoviedb.org), go to **Settings → API**, and paste either the
**API Key** or the **API Read Access Token** into **NodeFlix → Settings → Server → Metadata**. Then use
**Dashboard → Refresh all metadata**.

### Run it on a VPS as your own streaming site

```sh
git clone <your copy of this folder> nodeflix && cd nodeflix
cp .env.example .env        # set NODEFLIX_DOMAIN and your media folders
docker compose --profile https up -d
```

Caddy fetches an HTTPS certificate automatically. Full walkthrough: [docs/DEPLOY.md](docs/DEPLOY.md).

---

## Organising your files

NodeFlix understands the same layouts as Kodi, Plex and Jellyfin:

```
Movies/
  Blade Runner (1982)/Blade Runner (1982).mkv
  Blade Runner (1982)/poster.jpg            ← optional local artwork (also fanart.jpg, clearlogo.png)
  Blade Runner (1982)/movie.nfo             ← optional Kodi NFO
  The.Matrix.1999.1080p.BluRay.x264.mkv    ← loose files work too

TV/
  Doctor Who (2005)/
    poster.jpg  fanart.jpg  logo.png  tvshow.nfo      ← logo.png / clearlogo.png: transparent title art
    Season 01/Doctor.Who.S01E01.Rose.mkv
    Season 01/Doctor.Who.S01E01.Rose.en.srt
    Specials/Doctor Who - S00E01 - The Christmas Invasion.mkv

Music/
  Artist Name/
    artist.jpg                              ← optional artist picture (fanart.jpg for the background)
    Album Name (2004)/cover.jpg             ← or folder.jpg / front.jpg, or art embedded in the files
    Album Name (2004)/01 - First Song.flac
```

Episode names like `S01E02`, `s01_e02`, `1x02`, `S01E01-E02`, `103` and dated shows (`2024.03.05`) are recognised.
Folders called `Extras`, `Featurettes`, `Trailers`, `Sample` etc. are skipped. If a match is wrong, open the title and
use **Fix match**.

For music the tags win (title, artist, album artist, album, track and disc number, year, genre); the folder layout is
only used when a file has no tags. Albums with several artists and no album-artist tag are grouped under
“Various Artists”. MP3, AAC/M4A, FLAC, Ogg/Opus and WAV play directly in most browsers; anything else (WMA, ALAC,
APE…) is converted on the fly.

## Profiles, kids and parental controls

- **Settings → Profiles** adds up to 12 profiles per account. Give a profile a PIN to stop others using it.
- Turn on **Kids profile** and pick the oldest age rating it may watch. Titles without a rating are hidden unless you
  allow them (add-on sources count as unrated). Kids profiles can't open the admin settings, download files or use
  add-ons (unless unrated titles are allowed). Give the grown-up profiles a PIN so kids can't just switch back.
- The rating country is set in **Settings → Server** (New Zealand by default, with US ratings as a fallback).
- Admins can limit an account to certain libraries (**Settings → Users**), and each profile can be narrowed further.
- Music isn't age-rated — to keep a library of songs away from a profile, take the library away instead.

## Using it

| Key (anywhere) | Action |
| --- | --- |
| Arrow keys | Move between items (TV remote friendly) |
| Enter | Open / activate |
| Backspace | Back |
| Media keys | Play/pause, next and previous song (music) |

Music keeps playing while you move around the app. Starting a video pauses it. The queue (**Up next** in the
mini-player) is remembered per profile on each device.

| Key (player) | Action |
| --- | --- |
| Space / K | Play / pause |
| ← / → (or J / L) | Back / forward 10 s |
| ← / → on the seek bar | Scrub with a preview picture (hold to go faster); Enter jumps, Esc cancels |
| Enter on **Skip intro** | Skip the opening titles |
| ↑ / ↓ | Volume (↑ also shows the controls) |
| F | Full screen |
| M | Mute |
| C | Cycle subtitles |
| N | Next episode |
| I | Playback info (direct play / remux / transcode and why) |
| Esc / Backspace | Leave the player |

## Configuration

Most settings live in the web UI (**Settings → Server**). Start-up options can be set with environment variables
or a `nodeflix.config.json` next to `server.js` (see `nodeflix.config.example.json`):

| Variable | Default | What it does |
| --- | --- | --- |
| `NODEFLIX_PORT` | `8787` | Port to listen on |
| `NODEFLIX_HOST` | `0.0.0.0` | Interface (`127.0.0.1` = this computer only) |
| `NODEFLIX_DATA_DIR` | `./data` | Database, artwork cache, plugin data |
| `NODEFLIX_FFMPEG` / `NODEFLIX_FFPROBE` | `ffmpeg` / `ffprobe` | Paths if they're not on your PATH |
| `NODEFLIX_TRUST_PROXY` | `false` | Set `true` behind Caddy/nginx so HTTPS and client IPs are detected |
| `NODEFLIX_SESSION_DAYS` | `30` | How long sign-ins last |
| `TMDB_API_KEY` | — | Pre-fills the TMDB key on first start |
| `NODEFLIX_LOG_LEVEL` | `info` | `debug` shows every ffmpeg command |

Forgot the admin password? `npm run reset-password -- <username> <new-password>`

## Customising

- **Themes** — pick one in **Settings → Profile**. Make your own by copying `themes/arctic` (or the simpler `themes/midnight`). See [docs/THEMES.md](docs/THEMES.md).
- **Plugins** — drop a folder into `plugins/` and restart. Included examples:
  - `nfo-metadata` — reads Kodi `.nfo` files (including age ratings)
  - `internet-archive` — browse and stream public-domain films from archive.org (an add-on source)
  - `random-picks` — a shuffled "Something different" row on the home screen
  - `opensubtitles` — search and download subtitles (needs a free API key from opensubtitles.com; off by default)
  - `notifications` — new-arrival alerts to Discord, email (SMTP) or a webhook, with a “Send a test message” button (off by default)

  Turn plugins on and fill in their settings in **Settings → Plugins**.

  Write your own with [docs/PLUGINS.md](docs/PLUGINS.md).

## Project layout

```
server.js              entry point
src/                   server (HTTP router, auth, library scanner, metadata, playback, plugins)
public/                web app (plain ES modules — edit and refresh, no build)
plugins/               plugins, one folder each
themes/                themes, one folder each
deploy/                Caddy and nginx examples
docs/                  architecture, plugin, theme and deployment guides
test/                  node --test suites (npm test)
```

How it fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Troubleshooting

- **"ffmpeg not found"** on the dashboard — install it (see above), then click **Re-check ffmpeg**, or set `NODEFLIX_FFMPEG` to the full path of `ffmpeg.exe`.
- **A video won't play** — press **I** in the player to see why it's being converted. Check the terminal for `ffmpeg exited with…` lines. Try a lower quality from the player's quality menu.
- **Nothing shows up after adding a folder** — check the path is a full path (e.g. `D:\Movies`) and that the dashboard's scan finished. TV needs the episode number in the file name.
- **"Choose who is watching first"** — the account has more than one profile (or a PIN); pick one on the “Who's watching?” screen.
- **A kids profile shows nothing** — the titles have no age rating yet. Add a TMDB key and refresh metadata, or allow unrated titles for that profile.
- **Stutters on a small VPS** — transcoding is CPU heavy. Store files as H.264/AAC MP4 where you can (direct play costs almost nothing), lower **Max simultaneous conversions**, or enable hardware acceleration.
- **No seek-bar previews yet** — they're made in the background after a scan; **Settings → Dashboard → Background tasks** shows what's left. They wait while someone watches a video the server is converting.
- **Skip intro is missing or in the wrong place** — an admin can fix it on the episode's page (**Edit** next to "Intro"), for one episode or the whole season.

## Roadmap ideas

Photo libraries · collections and saved playlists · lyrics · offline downloads · a Chromecast / DLNA plugin · client-side plugins that add pages to the UI.

## About Kodi

NodeFlix is an independent project. It borrows Kodi's conventions — folder naming, artwork names and the `.nfo`
format documented on the [Kodi wiki](https://kodi.wiki/view/NFO_files) — but contains no Kodi code. The Arctic theme is
an original stylesheet inspired by the look of jurialmunkey's and beatmasterRS's Arctic skins; none of their files or
artwork are included (those skins are licensed for non-commercial use under Creative Commons). (Kodi is
GPL-licensed C++; copying its source would also put NodeFlix under the GPL.)
"# Atomix" 
