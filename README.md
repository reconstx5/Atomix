# Atomix

A self-hosted, customisable media hub in the spirit of Kodi. Point it at your movie, TV and music folders and it
builds a Netflix-style library with artwork, resume points and per-person watch history — then streams to any
browser on your PC, your home network, or the internet from your own VPS.

- **Zero dependencies.** Pure Node.js (built-in HTTP server and SQLite). No `npm install`, no build step.
- **Movies & TV** — folder scanning, season/episode detection, posters, descriptions and age ratings from TMDB, local artwork and Kodi `.nfo` files. Episode cards say **Watched** or how many minutes are left.
- **Music** — artists, albums and songs from your tags (or folder names), cover art, a queue with shuffle/repeat, and a mini-player that keeps going while you browse. Works with the keyboard's media keys and the phone lock screen.
- **Plays anything** — direct play when the browser can handle the file, otherwise on-the-fly remux or transcode with ffmpeg (optional NVIDIA/Intel/AMD/Apple hardware acceleration). HLS for Safari/iPhone.
- **Seek-bar previews and Skip intro** — small pictures above the seek bar while you scrub, also with a TV remote (hold → to go faster, OK to jump). TV episodes get a **Skip intro** button: intros are found from chapter names, or by matching the theme tune across a season, and admins can fix them on the episode page. Both are made in the background at low priority and pause while someone watches a converted video.
- **Subtitles** — `.srt`/`.vtt`/`.ass` next to the video and embedded text tracks; picture subtitles (PGS/DVD) are burned in. Missing ones can be searched for and downloaded from OpenSubtitles right in the player.
- **Accounts and profiles** — admin and viewer accounts; each account can have several “Who's watching?” profiles with their own progress, “continue watching” and “next up”. Optional PINs.
- **Kids profiles** — only show titles rated for an age you choose (NZ, AU, UK, US, CA or IE ratings), and hide settings and add-ons. You can also limit which libraries each account or profile sees.
- **Collections and film series** — films that belong to a series (from TMDB) are grouped, with the parts you're missing listed; admins can make their own collections from any films and shows. A **Collections** view in each movie library, and a **Part of** row on the film's page.
- **Playlists and the Watchlist** — press the plus on any film or show to keep it in your profile's Watchlist. **Add to playlist…** builds video playlists (a season at a time if you like) and song playlists; playlists can be shared with the whole household, reordered with the remote or the mouse, and played straight through with **Up next**.
- **Because you watched** — two Home rows picked from what you watched lately, matched on series, keywords, director and cast, then genre and decade; the film's page has a **More like this** row.
- **Trailers** — a `Film-trailer.mp4` or `Trailers/` folder beside a film plays in Atomix's own player; without one, the film's TMDB trailer plays from YouTube inside the app (an admin switch; never on kids profiles). One **Trailer** button on the film's page and the Home spotlight.
- **Extras** — Kodi-style `Featurettes/`, `Behind The Scenes/`, `Deleted Scenes/`, `Interviews/`, `Scenes/`, `Shorts/`, `Extras/` folders and `-featurette`, `-deleted`… file suffixes show as an **Extras** row on the film's or show's page (and nowhere else), with thumbnails made in the background.
- **Lyrics and Now Playing** — press the mini-player to open a full-screen **Now Playing** page: cover, the queue, a volume slider, and lyrics that scroll in time from a `.lrc` beside the song, the song's tags, or LRCLIB (free, no key; an admin switch). **Lyrics** in a song's menu shows that song's words without changing what's playing, with a **Play this song** button.
- **Connected servers** — a Jellyfin, Emby, Plex or another Atomix you already run can be connected in **Settings → Libraries** (Plex with a code you enter at plex.tv/link). Its libraries appear beside your own (for everyone, under the same access and kids rules), their catalogue is copied into Atomix and refreshed on a schedule, and video reaches the TV through Atomix — direct, or converted by ffmpeg from the server's stream. The server sees the stream start and stop and what you finished, so it is watched there too; "Recently added" follows the server's own dates, and a poster changed there shows up here after the next sync.
- **Casting** — play a film, an episode or a whole album on a Chromecast / Google TV or a DLNA TV (Samsung, LG, Sony…) from **Cast** in the player or **Cast to…** on a title. Atomix drives the TV itself, so your phone or this page is the remote: play, pause, ±10 s, seek with previews, volume, subtitles, audio, Up next and Stop casting, with your progress saved as it plays. A **Playing on Living room TV** pill follows you round the app. On an iPhone or Mac, Safari's **AirPlay** button sends the player to an Apple TV.
- **New-episode alerts** — a message to Discord, email or any webhook when new movies or episodes arrive.
- **Orbit look** — the default theme, made for a TV and a remote:
  - Your artwork fills the screen behind the page, with a glass menu floating beside it that grows when the remote reaches it.
  - Whatever the remote is on turns white; everything else takes its colour from the artwork.
  - Sora type, wide cards with progress, a side panel for subtitles and audio, and a floating mini-player.
  - **Reduce effects** swaps the glass for solid panels on slower TVs.
  - Opening Atomix plays a short animated splash, then asks **who's watching**; it asks again after the TV has sat untouched for a while (an admin sets how long), and a profile with a PIN always asks for it.
  - The **Arctic** looks (inspired by the Arctic: Zephyr – Reloaded and Arctic Horizon 2 Kodi skins) are still there.
- **Customisable** — swappable themes (Orbit, Arctic, Arctic Side, Midnight, Harbour, Daylight, Obsidian), per-user accent colours, and a plugin system for new metadata sources, home-screen rows, API routes and Kodi-style add-on sources.
- **10-foot UI** — arrow keys / TV remote navigation, Backspace for back, media keys in the player.

> Atomix is for media you own or have the right to share. If you open it up on the internet, only give
> accounts to people allowed to watch that content.

---

## Quick start (Windows, macOS, Linux)

1. Install **Node.js 22.13 or newer** (the current LTS from <https://nodejs.org> is perfect).
2. Install **ffmpeg** (needed for MKV/HEVC files and media info):
   - Windows: `winget install Gyan.FFmpeg` (then open a new terminal)
   - macOS: `brew install ffmpeg`
   - Ubuntu/Debian: `sudo apt install ffmpeg`
3. Start Atomix in this folder:
   - Windows: double-click **`start-windows.bat`**
   - Or in a terminal: `npm start`
4. Open <http://localhost:8787>, create the admin account, then **Settings → Libraries → Add library**.

Other devices on your network can use the "Network" address printed in the terminal
(Windows may ask to allow Node.js through the firewall — allow it on private networks).

### Get posters and descriptions

Create a free account at [themoviedb.org](https://www.themoviedb.org), go to **Settings → API**, and paste either the
**API Key** or the **API Read Access Token** into **Atomix → Settings → Server → Metadata**. Then use
**Dashboard → Refresh all metadata**.

### Run it on a VPS as your own streaming site

```sh
git clone <your copy of this folder> atomix && cd atomix
cp .env.example .env        # set ATOMIX_DOMAIN and your media folders
docker compose --profile https up -d
```

Caddy fetches an HTTPS certificate automatically. Full walkthrough: [docs/DEPLOY.md](docs/DEPLOY.md).

---

## Organising your files

Atomix understands the same layouts as Kodi, Plex and Jellyfin:

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

### Connecting a server

**Settings → Libraries → Connect a server…** asks for the kind (Jellyfin, Emby or Atomix), the address
(`jellyfin.local:8096`; `https://` is assumed, `http://` is allowed on your own network) and a sign-in for that server;
for an Atomix, use an account there with a profile that has no PIN. Tick the libraries you want and Atomix syncs
them, then again every six hours (**Settings → Server**) or when you press **Sync now**. The server's own posters and
descriptions are kept as they are. If the server can't be reached the library keeps its last catalogue; if it stops
accepting the sign-in the row says **Sign in again**. **Remove** takes its libraries away; nothing changes on the
other server. Sign-in tokens stay on the Atomix server and never reach the browser.

For **Plex**, pick Plex: Atomix shows a four-character code. Go to **plex.tv/link** on your phone or computer, sign
in to Plex there if asked, and enter the code; no password is typed into Atomix, and two-factor accounts work.
Atomix then lists the servers on your account (yours, and any shared with you); pick one and tick its libraries.
It plays Plex's original files and converts with its own ffmpeg when the TV needs it — Plex's transcoder isn't used.
If the server's address changes (a new LAN address after a router restart), the next sync finds it again through
plex.tv. A server only reachable through Plex's relay works, but slowly, and the row says so.

## Casting to a TV

Atomix finds Chromecasts (and Google TVs) and DLNA TVs on your home network by itself: press **Cast** in the player,
or **Cast to…** in a title's **…** menu (an album's or a song's too), and pick the TV. The TV fetches the video
straight from Atomix with a private link that only works for that title and ends with the cast; Atomix converts it
when the TV can't play the file (DLNA TVs get subtitles drawn onto the picture). Your page becomes the remote, and
Back leaves it while the TV keeps playing; the **Playing on…** pill brings it back.

- **Same network.** Atomix and the TV must be on the same home network. Atomix in Docker only sees TVs with
  `network_mode: host` (see `docker-compose.yml`). The first cast on Windows may ask to let Node.js through the firewall
  (multicast for finding TVs, and port 8787 so the TV can fetch the video): allow it on private networks.
- **The address the TV uses.** Atomix picks this computer's address on the TV's own network (never Docker's bridge or
  a VPN). If a TV says it couldn't load the video, set the address yourself in **Settings → Server → Casting** — it
  must be this computer's home-network address, like `http://192.168.1.20:8787`.
- **A TV that isn't found** can be added in **Settings → Server → Casting → Add a device by address…**: a Chromecast by
  its address (`192.168.1.40`), a DLNA TV by its description address (`http://192.168.1.50:7676/description.xml`, from
  the TV's network settings or your router).
- **AirPlay.** Safari shows its AirPlay button in the player when an Apple TV is near; the Apple TV then plays the
  video from Atomix the same way.
- **On a VPS** there is no home network, so casting says so; AirPlay from a phone on the same Wi-Fi as an Apple TV
  still works.

Everyone can cast, under the same kids rules as playing; only admins can add or remove devices.

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

Music keeps playing while you move around the app. Starting a video pauses it. Enter (or a click) on the mini-player's
cover or title opens **Now Playing**, with the lyrics; Space there plays and pauses. The queue (**Up next** in the
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
or an `atomix.config.json` next to `server.js` (see `atomix.config.example.json`):

| Variable | Default | What it does |
| --- | --- | --- |
| `ATOMIX_PORT` | `8787` | Port to listen on |
| `ATOMIX_HOST` | `0.0.0.0` | Interface (`127.0.0.1` = this computer only) |
| `ATOMIX_DATA_DIR` | `./data` | Database, artwork cache, plugin data |
| `ATOMIX_FFMPEG` / `ATOMIX_FFPROBE` | `ffmpeg` / `ffprobe` | Paths if they're not on your PATH |
| `ATOMIX_TRUST_PROXY` | `false` | Set `true` behind Caddy/nginx so HTTPS and client IPs are detected |
| `ATOMIX_SESSION_DAYS` | `30` | How long sign-ins last |
| `TMDB_API_KEY` | — | Pre-fills the TMDB key on first start |
| `ATOMIX_LOG_LEVEL` | `info` | `debug` shows every ffmpeg command |
| `ATOMIX_CAST_BASE_URL` | — | The address TVs fetch from (otherwise **Settings → Server → Casting**, or found by itself) |
| `ATOMIX_CAST_DISCOVERY` | `on` | `off` stops looking for TVs on the network (devices added by address still work) |

Forgot the admin password? `npm run reset-password -- <username> <new-password>`

### Upgrading from NodeFlix

Atomix used to be called NodeFlix. Copy the new files over the old ones (keep your `data` folder) and start it as
usual; everything carries on:

- `data/nodeflix.db` is renamed to `data/atomix.db` the first time Atomix starts (if another program has it open,
  it keeps the old name until the next start).
- `NODEFLIX_…` environment variables and `nodeflix.config.json` still work. The terminal lists the ones to rename
  (`NODEFLIX_PORT` → `ATOMIX_PORT` and so on).
- A server still called "NodeFlix" (the name the setup screen suggested) is renamed "Atomix". A name you chose stays.
- Nobody is signed out, and each browser keeps its volume and music queue.
- Docker: the service and container are now called `atomix`, so run `docker compose up -d --remove-orphans` once to
  replace the old `nodeflix` container. An existing `.env` with the `NODEFLIX_` names keeps working.

## Customising

- **Themes** — pick one in **Settings → Profile**. Make your own by copying `themes/orbit` (or `themes/arctic`, or the simpler `themes/midnight`). See [docs/THEMES.md](docs/THEMES.md).
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

- **"ffmpeg not found"** on the dashboard — install it (see above), then click **Re-check ffmpeg**, or set `ATOMIX_FFMPEG` to the full path of `ffmpeg.exe`.
- **A video won't play** — press **I** in the player to see why it's being converted. Check the terminal for `ffmpeg exited with…` lines. Try a lower quality from the player's quality menu.
- **Nothing shows up after adding a folder** — check the path is a full path (e.g. `D:\Movies`) and that the dashboard's scan finished. TV needs the episode number in the file name.
- **"Choose who is watching first"** — the account has more than one profile (or a PIN); pick one on the “Who's watching?” screen.
- **"Who's watching?" keeps coming back** — it returns after the idle time in **Settings → Server → Ask who's watching after**; choose a longer time or Never. Playing a video or music counts as being there.
- **A kids profile shows nothing** — the titles have no age rating yet. Add a TMDB key and refresh metadata, or allow unrated titles for that profile.
- **Stutters on a small VPS** — transcoding is CPU heavy. Store files as H.264/AAC MP4 where you can (direct play costs almost nothing), lower **Max simultaneous conversions**, or enable hardware acceleration.
- **No seek-bar previews yet** — they're made in the background after a scan; **Settings → Dashboard → Background tasks** shows what's left. They wait while someone watches a video the server is converting.
- **Skip intro is missing or in the wrong place** — an admin can fix it on the episode's page (**… → Edit intro** in
  Orbit, or **Edit** next to "Intro" in the other themes), for one episode or the whole season.

## Roadmap ideas

Casting to Chromecast / DLNA / AirPlay · photo libraries · offline downloads · client-side plugins that add pages to the UI.

## About Kodi

Atomix is an independent project. It borrows Kodi's conventions — folder naming, artwork names and the `.nfo`
format documented on the [Kodi wiki](https://kodi.wiki/view/NFO_files) — but contains no Kodi code. The Arctic theme is
an original stylesheet inspired by the look of jurialmunkey's and beatmasterRS's Arctic skins; none of their files or
artwork are included (those skins are licensed for non-commercial use under Creative Commons). (Kodi is
GPL-licensed C++; copying its source would also put Atomix under the GPL.)
