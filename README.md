# Atomix

A self-hosted, customisable media hub in the spirit of Kodi. Point it at your movie, TV and music folders and it
builds a Netflix-style library with artwork, resume points and per-person watch history — then streams to any
browser on your PC, your home network, or the internet from your own VPS.

- **No `npm install`, no build step.** Pure Node.js on the server (built-in HTTP server and SQLite). The web app is plain ES modules; since v0.26 its newer screens use Preact (React-style components), kept in the repo with htm — the only two libraries Atomix carries.
- **Movies & TV** — folder scanning, season/episode detection, posters, descriptions and age ratings from TMDB, local artwork and Kodi `.nfo` files. Episode cards say **Watched** or how many minutes are left.
- **Music** — artists, albums and songs from your tags (or folder names), cover art, a queue with shuffle/repeat, and a mini-player that keeps going while you browse. Works with the keyboard's media keys and the phone lock screen.
- **Plays anything** — direct play when the browser can handle the file, otherwise on-the-fly remux or transcode with ffmpeg (optional NVIDIA/Intel/AMD/Apple hardware acceleration). HLS for Safari/iPhone. HDR and Dolby Vision films are tone-mapped to normal colours for screens that can't show them; surround sound is mixed down with the dialogue kept clear; the first picture arrives in about a second.
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
- **Podcasts and audiobooks** — subscribe to a podcast by its feed or by searching for it; the server checks the feeds and keeps the newest episodes. Audiobooks from a folder per book or an `.m4b`, with chapters, one timeline per book, skip back and forward, a speed for spoken titles and a sleep timer.
- **Books and comics** — EPUB books and CBZ comics (CBR and CB7 with 7-Zip installed), read on a phone, a tablet or with a TV remote: pages you turn, your own text size and theme, comics two pages at a time or right to left, your place kept on every device and offline.
- **Search that helps** — accents, capitals, punctuation and a leading “the” don't matter (“amelie” finds *Amélie*, “spiderman” finds *Spider-Man*), here and in music apps. In the Orbit look, search opens on your recent searches (each profile's own), genre tiles and a tile per library, and suggests films, shows, music, books and people from the first letter; a person's page lists what they made or appear in. Orbit also asks for artwork at the size it's shown (smaller copies kept in a picture cache), and its menu keeps Search and Settings in reach, with a dock and **More** on phones.
- **Orbit's Live TV and library pages** — Live TV is a wall of glass channel cards (the programme's picture, or the logo on its colour) under a spotlight that follows the remote: what's on, how long is left, and Watch live, Record, ★, Guide and Cast. Movies and TV Shows open on the title you were last watching, with Resume ("Resume S1 · E3" for a show), one glass bar for sort, genre, unwatched and search, a line on titles you're part-way through, and an A–Z rail to jump through a big library.
- **Home you can arrange** — move, hide and pin rows (a playlist, a genre, a collection, a library sort, a web app); each profile can have its own Home, starting from the household's.
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

```
Podcasts/                                   ← where kept episodes go (subscribe in the app)
Audiobooks/
  Ursula K. Le Guin/A Wizard of Earthsea/01.mp3 02.mp3 …   ← a folder per book (natural order), or
  The Long Voyage.m4b                       ← one file per book, chapters from the file
Books/
  Le Guin - The Dispossessed.epub           ← title, author, series and cover from the book
Comics/
  Sky Riders/Sky Riders 001.cbz             ← series and issue from ComicInfo.xml, else folder and file name
  Sky Riders/Sky Riders 002.cbr             ← .cbr / .cb7 need 7-Zip (or unrar) installed
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
- **Encrypted channels (v0.27).** A Widevine or ClearKey Live TV channel (TVNZ 1/2, DUKE) can be cast to a
  Chromecast or Google TV, which decrypts it with its own Widevine; Atomix relays the stream and the licence, with a
  private link for that one channel. On a phone that can't play the channel (an iPhone), the player offers **Watch on
  TV**. DLNA TVs say "This TV can't play encrypted channels; use a Chromecast or Google TV"; FairPlay channels can't be
  cast. Channel up/down on the Remote moves the TV to the next channel, then stops the old one.

Everyone can cast, under the same kids rules as playing; only admins can add or remove devices.

## Live TV

**Live TV** in the menu is a channel list, a guide and a TV-style player, fed by the **IPTV Simple** plugin (an
original Atomix plugin in the spirit of Kodi's IPTV Simple PVR client): an M3U playlist for the channels and an
XMLTV guide for what's on. Turn it on in **Settings → Plugins → IPTV Simple** and set **Playlist**:

- **A paid IPTV provider** — the M3U address they gave you (`http://provider.example/get.php?username=…&type=m3u_plus`).
  The guide usually comes from the playlist's own `url-tvg`; otherwise paste the provider's XMLTV address into
  **Guide**. **Streams at once** is 1 for a provider unless you know your plan allows more.
- **Free public lists** — any public M3U, for example a country list from the iptv-org project.
- **Your own tuner or server** — HDHomeRun: `http://<tuner address>/lineup.m3u`; Tvheadend:
  `http://<server>:9981/playlist/channels` (with the guide at `http://<server>:9981/xmltv/channels`).
- **A file on this server** — a path such as `/media/tv/channels.m3u`. Logos can come from a folder you name in
  **Logos folder or URL**; Atomix only reads image files from it.

What you get:

- **Channels**: group chips (Favourites, All, the playlist's groups), what's on now and next, **…** to add a favourite,
  open the channel's guide or cast it. Type a channel number to jump to it.
- **Guide**: a grid of the next hours (Earlier / Now / Later, a day picker), every programme a button; on a phone one
  channel's day as a list. A programme opens its details with **Watch live**, **Start over** or **Play**.
- **Player**: LIVE, how far through the programme you are, channel up/down (PageUp/PageDown or a remote's channel
  keys), the channel list over the picture, and Info for now/next. A dropped stream is picked up again by itself.
- **Catch-up** for channels whose playlist says they have an archive (`catchup=` / `catchup-days=` / `catchup-source=`):
  aired programmes play with a normal seek bar, and **Start over** plays one on now from its beginning.
- **Radio** stations play in the music player, with Next/Previous between stations.
- **Casting** a channel or a catch-up programme to a Chromecast or DLNA TV, with channel up/down on the Remote.
- **On now** on Home and **On TV** in search.
- **Kids**: a Kids profile sees no Live TV until you tick groups for it (Household → edit the profile → **Live TV
  groups**); then only those groups' channels.

**Pause and rewind.** Every channel being watched keeps the last 30 minutes, so you can pause, go back (Back 10 /
Fwd 30, the arrow keys, or the seek bar) and press **Go to live** to catch up; the badge shows how far behind you are.
Everyone watching one channel shares one connection to the provider, so a second TV on the same channel doesn't use
up another stream. A channel whose format can't be kept this way plays as before and says "Rewind isn't available on
this channel". Encrypted channels pause in the browser but are never kept on the server.

**Recording.** In the guide, a programme's details offer **Record** and **Record series** (this channel or any
channel, new episodes only, keep all or the last 5 or 10); a red dot marks what's scheduled. **Live TV → Recordings**
lists what's recording now (**Stop**), what's scheduled (with a warning when your provider's stream limit means two
overlap), what's done (**Play**, **Delete**), what failed and why, and your series rules. Recordings start a minute
early and end three minutes late (change it in **Settings → Live TV → Recording**, which also sets the folder; the
default is `recordings` in the data folder), are saved without converting as `.mkv` with a `.nfo`, and appear in a
**Recordings** TV library that plays, resumes and casts like any show. If a recording needs a stream while someone is
watching another channel, the newest viewer is stopped ("Stopped to record …"); a recording never stops another
recording. Recordings don't start with less than 5 GB free. If Atomix restarts mid-recording, it carries on as part 2.
Encrypted channels and radio can't be recorded; Kids profiles can't record and see a recording only when its
channel is in one of their groups.

**Encrypted channels.** Some playlists mark channels as protected with Widevine or ClearKey, the way Kodi's
inputstream.adaptive reads them (`#KODIPROP:inputstream.adaptive.license_type=` / `license_key=`, `drm_legacy=`,
`manifest_headers=`, `stream_headers=`, `manifest_params=`, `stream_params=`, `license_data=`, `server_certificate=`;
ClearKey keys written in the playlist, in hex or JWK form; DASH `.mpd` streams). Atomix plays those in the browser with the browser's own
key system — Chrome, Edge and Firefox have Widevine; Safari doesn't — while still relaying the manifest, the video and
the licence requests, so the provider's addresses stay on the server. They carry a small lock in the list and the
guide, and can't be cast, played as radio, or played from catch-up. If a channel doesn't play, the player says why:
the browser can't play the channel's protection (an iPhone has no Widevine), the provider refused the licence, the licence server isn't answering, or your sign-in has
expired. An archive programme played to its end says "This programme has ended".

**FairPlay (an Atomix extension).** A playlist can also describe an Apple FairPlay channel with the same properties:
`license_type=com.apple.fps`, `license_key=<licence url>|<headers>|<post form>|<response form>` (the same grammar; the
post form may use `{CONTENTID}`, the `skd://` id, URL-encoded, beside `R{SSM}`/`b{SSM}`/`B{SSM}`), and
`server_certificate=<url or base64>`; the stream is an HLS `.m3u8`. Safari on an iPhone, iPad or Mac plays it on the
secure address; Atomix relays the playlists, the certificate and the licence. Other browsers say it plays in Safari.

The playlist and guide refresh every 6 hours (sooner when the guide is about to run out), and the IPTV Simple card in
Settings shows the last refresh, channels without guide and a **Refresh now** button. Provider addresses and
passwords stay on the server: the browser and TVs only ever see Atomix's own links. Live TV keeps no watch history.

## Music apps

Phone and desktop music apps that speak Subsonic — Symfonium, Amperfy, play:Sub, Substreamer, Feishin — can play
your music library. In **Settings → Profile → Music apps**, give the app a name and choose **Make password**. Then
type the address it shows, your username and that password into the app (pick "Subsonic" or "OpenSubsonic" as the
server type). Each app gets its own password, shown once; **Revoke** signs that app out. The profile's library access
and Kids rules apply in the app too, and stars, hearts, play counts and playlists are the same as on the web
(smart playlists show up read-only). The app gets the original file unless it asks for a lower quality; then
Atomix converts it to MP3 or Opus.

**Scrobbling:** in the same place, connect ListenBrainz (paste your user token) or Last.fm (**Connect to Last.fm**;
an admin first adds a Last.fm API key and shared secret in **Settings → Server**). Songs you listen to — on the web
or in music apps — are sent when they count as played (half the song or 4 minutes). If a service is down, Atomix
keeps trying for 14 days.

## Watching together, Quick Connect, activity and stats

- **Watch together:** in the player choose **Watch together** → **Start a room** and share the code or link. Anyone
  with an Atomix sign-in can join (with **Join with a code**, or the link) if their profile may watch that title. Play,
  pause and skips are shared, the room waits for anyone still loading, and at the end of an episode anyone can start
  the next one for everybody. Up to 8 people; films and episodes.
- **Quick Connect:** on a TV's sign-in page choose **Sign in with a code**, then on a phone that's signed in open
  **Settings → Profile → Quick Connect** and type the code. Admins can turn it off in **Settings → Server**.
- **Activity:** admins see sign-ins, plays, changes and recordings from the last 30 days in **Settings → Activity**.
- **Stats:** **Settings → Profile** shows each profile's hours watched and listened, its most played titles and when
  it watches; admins see every profile's hours on the **Dashboard**.

## Install Atomix and Downloads

- **Install:** **Settings → Profile → Install Atomix** puts Atomix on a phone's, tablet's or computer's home screen
  like an app (on iPhone: Safari's **Share → Add to Home Screen**). Installing and downloads need a **secure address**:
  `https://` (at home: **A secure address at home**, below; for a VPS, put Atomix behind a reverse proxy with a
  certificate) or the computer's own `localhost`. On a plain `http://` LAN address you can still save a file from a
  title's **…** menu.
- **Downloads:** on a film, episode, show (a season), album, artist or playlist choose **Download** and a quality.
  Atomix prepares a copy (converted to what this device plays when it has to), then the app fetches it in pieces that
  carry on where they stopped after a lost connection. **Downloads** (in Orbit's menu — in every theme's menu when offline — and in Settings → Profile) lists
  each profile's own, with the space used, Play, Pause and Remove. Downloads only run while the app is open.
- **Offline:** with no connection the app opens to **Who's watching?** (PINs still asked) and then Downloads. Films,
  episodes and songs play with their subtitles and saved place; Up next moves to the next downloaded episode. What you
  watched offline reaches Atomix when you're back online. A title an account may no longer have (or a Kids profile's
  rules no longer allow) is removed then; a download not checked for the offline days (30 by default) stops playing and
  is deleted a week later. Signing out removes the downloads from that device.
- **Admins:** **Settings → Server → Downloads** turns them on and sets the folder for prepared copies, how much they may
  take, the default quality, the offline days and the space per device. Each person needs **Can download** switched on
  in **Settings → Users** (admins always can).

## A secure address at home (HTTPS)

Browsers only play encrypted channels, and only install the app, on a secure page: `https://`, or the computer's own
`localhost`. A phone opening `http://<your PC>:8787` gets neither. **Settings → Server → Secure address (HTTPS)** adds a
second, secure address beside the plain one (port **8443**; change it on the card, or fix it with `ATOMIX_HTTPS_PORT`).
The plain address keeps working exactly as before. Each address keeps its own sign-in.

- **Tailscale (recommended):** install [Tailscale](https://tailscale.com) on the PC and on each phone (same account),
  turn on **HTTPS certificates** in Tailscale's admin page (DNS → HTTPS Certificates), then choose **Use Tailscale**.
  Atomix asks the PC's Tailscale for a real certificate for `<pc>.<tailnet>.ts.net` and renews it on its own; phones
  open `https://<pc>.<tailnet>.ts.net:8443`, at home or away. On Windows, if Atomix isn't allowed to run Tailscale's
  command, the card shows the one command to run once as administrator.
- **Atomix's own certificate:** choose **Use Atomix's own certificate**; each phone installs Atomix's home certificate
  once from the links on the card (Android: Settings → Security → Encryption & credentials → Install a certificate →
  CA certificate; iPhone: open the profile link in Safari → Settings → Profile Downloaded → Install, then Settings →
  General → About → Certificate Trust Settings → turn it on). Phones then open `https://<PC's address>:8443` at home.
  When the PC's address changes, Atomix remakes its certificate from the same home certificate within a minute: nothing
  to reinstall. The home certificate can only vouch for home names (`.local`, the PC's name) and private addresses, so
  even if `data/certs/own-ca.key` got out it couldn't stand in for a bank's website; still, keep the data folder private.
  Give the PC a fixed address in your router (a DHCP reservation) so phones' saved links keep working.
- On a phone on the plain address, an encrypted channel says it needs the secure address and links to it.
- **On an Android phone** (Chrome or the installed app) on the secure address, encrypted channels play like on a
  computer. The screen stays on while a channel plays, full screen turns the phone to landscape, on mobile data Atomix
  keeps a smaller buffer (10 s), and if the phone refuses the HD keys it plays a lower quality and says so.
- **On an iPhone**, Widevine channels (TVNZ 1/2, DUKE) can't play: the player says so at once. Plain channels play as
  before.

## Player extras and editing details

- **Playback settings** (the sliders button in the player) holds Quality, **Speed** (0.5× to 2×; `[` and `]` step it)
  and **Audio delay** (−5 to +5 s in 0.1 s steps, for a file whose sound is out of sync). The subtitles menu has
  **Subtitle delay** (−10 to +10 s; `Z` earlier, `X` later). Both delays are remembered for each profile and title;
  speed goes back to 1× for the next title. Speed can't change in a Watch together room, and on Live TV only once
  you've paused or rewound.
- **Chapters:** a film with chapters shows small marks on the seek bar and a **Chapters** button listing each one with
  its time (and a picture when the title has seek-bar previews). PageUp and PageDown go to the previous and next
  chapter (on Live TV they still change channel).
- **Edit details** (admins, in a title's **…** menu): change the title, sort title, year, plot, tagline, genres,
  studio or age rating of a film or show; an episode's title, numbers, aired date and plot; an album's title, artist,
  year and genres; an artist's name and biography. Each field you change is **locked**, so **Refresh info** and
  **Fix match** leave it alone; **Unlock** hands it back to TMDB at the next refresh. The **Artwork** tabs pick a
  poster, background or logo from TMDB's choices, an upload (JPEG, PNG or WebP up to 10 MB) or an address.

## Arranging Home

Choose **Arrange home** at the bottom of Home (or in **Settings → Profile → Home screen**). It is one list: Up and Down move along it, OK
picks a row up, Up and Down move it, OK puts it down; each row has a switch to show or hide it, and on a touch screen or
with a mouse you can drag its handle. **Add a row** pins a playlist or smart playlist, a genre in a library, a
collection, a library sort ("Recently added", "Random") or a web app; pinned rows show only what the profile may see.
**Reset to household** goes back to the household's Home.

Admins set the household Home in **Settings → Server → Home screen**, and keep the **Web apps** there: shortcuts with a
name, an address and a picture that open the site (in a new tab; in the same one on a TV). A Kids profile sees only the
web apps marked for Kids. A profile follows the household Home until it changes something.

## Podcasts and audiobooks

- **Podcasts:** add a Podcasts library (its folder is where episodes are kept), then **Subscribe** on its page — paste
  the feed's address or search for the show. Atomix checks the feeds every 6 hours (**Settings → Server**; **Check
  now** on the page) and downloads new episodes one at a time. Each show keeps its newest 10 by default (or all);
  **Keep** protects an episode, and played ones outside that are removed. A feed that can't be reached says so on its
  page for admins. Episodes marked explicit count as 18 for Kids profiles unless an admin gives the show a rating.
- **Audiobooks:** add an Audiobooks library — a folder per book (its files play as one book, in name order) or one
  `.m4b` per book. Author, narrator, cover and chapters come from the files.
- **Listening:** books and episodes play in the music bar, which keeps playing while you browse and on the lock
  screen. It shows the chapter and the time left; **J** / **L** (or Left / Right on a remote) skip back 15 s and
  forward 30 s (**Settings → Profile → Listening** changes them); the speed (0.75× to 3×) is kept for spoken titles
  only; **Sleep timer** stops after 15 to 60 minutes or at the end of the chapter, fading out (**Add 10 min**). Coming
  back after more than 10 minutes starts 5 seconds earlier. **Play unplayed in order** plays a show from its oldest
  unplayed episode. Books and episodes can be downloaded and played offline.
- **Music apps** see podcasts too (not audiobooks).

## Books and comics

- **Books:** add a Books library of `.epub` files. **Read** opens the book full screen (music keeps playing): tap the
  edges, swipe, or use the arrow keys or a remote to turn pages; **Aa** sets the text size, spacing, font, theme
  (light, sepia, dark or the app's) and margins for the profile; **Contents** lists the chapters. The status line says
  "Chapter 3 · 42% · 12 min left in chapter". Your place is kept per profile; opening the book on another device offers
  to **Jump** to where you were. A book's own scripts never run, and links out of it aren't opened.
- **Comics:** add a Comics library of `.cbz` files (or folders of pictures). **Install 7-Zip for .cbr** and `.cb7`
  files (or unrar for `.cbr`); **Settings → Dashboard → Comics** shows whether it was found and takes its path. Comics
  show two pages at a time on a wide screen, right to left for manga (from the comic's ComicInfo.xml, or per series in
  **Edit details**), with pinch or double-tap zoom; OK zooms with a remote, and the menu key (or **M**) opens the bar.
  At the end, **Next issue** opens the next one in the series.
- **Also:** Continue reading on Home, age ratings from ComicInfo or Edit details, search, reading lists, pages and time
  read in Stats, and Downloads (a `.cbr` downloads as a `.cbz`) for reading offline.

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
| [ / ] | Slower / faster |
| Z / X | Subtitles earlier / later (0.1 s) |
| PageUp / PageDown | Previous / next chapter |
| N | Next episode |
| I | Playback info (direct play / remux / transcode and why) |
| Esc / Backspace | Leave the player |

## Configuration

Most settings live in the web UI (**Settings → Server**) — including **Picture cache (MB)**: Orbit fetches artwork as smaller copies Atomix makes once with ffmpeg (WebP when ffmpeg has libwebp) and keeps under the data folder's `cache/thumbs`, least used first out when it's full. Start-up options can be set with environment variables
or an `atomix.config.json` next to `server.js` (see `atomix.config.example.json`):

| Variable | Default | What it does |
| --- | --- | --- |
| `ATOMIX_PORT` | `8787` | Port to listen on |
| `ATOMIX_HOST` | `0.0.0.0` | Interface (`127.0.0.1` = this computer only) |
| `ATOMIX_DATA_DIR` | `./data` | Database, artwork cache, plugin data |
| `ATOMIX_FFMPEG` / `ATOMIX_FFPROBE` | `ffmpeg` / `ffprobe` | Paths if they're not on your PATH |
| `ATOMIX_TRUST_PROXY` | `false` | Set `true` behind Caddy/nginx so HTTPS and client IPs are detected (the last `X-Forwarded-For` hop is the client) |
| `ATOMIX_BODY_TIMEOUT_MS` | `30000` | A request body that takes longer than this is refused |
| `ATOMIX_SESSION_DAYS` | `30` | How long sign-ins last |
| `TMDB_API_KEY` | — | Pre-fills the TMDB key on first start |
| `ATOMIX_LOG_LEVEL` | `info` | `debug` shows every ffmpeg command |
| `ATOMIX_CAST_BASE_URL` | — | The address TVs fetch from (otherwise **Settings → Server → Casting**, or found by itself) |
| `ATOMIX_CAST_DISCOVERY` | `on` | `off` stops looking for TVs on the network (devices added by address still work) |
| `ATOMIX_LIVE_TUNERS` | `on` | `off` plays every Live TV viewer on its own connection, as before 0.19 (no pause/rewind; recordings use their own connection) |

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

## Plugins

Atomix comes with these plugins. Turn them on and fill in their settings in **Settings → Plugins**; a plugin that
needs a key says so on its card until you add one. The info plugins only fill what is still empty — your files,
`.nfo`s, Edit details and TMDB always win — and each keeps working (and tries again later) when its service can't be
reached.

| Plugin | What it does | Needs | On at first |
| --- | --- | --- | --- |
| `more-home-rows` | **Finish what you started**, **Seasonal picks** (Christmas, Halloween, Valentine's, summer) and **On this day** on Home, each following every profile's rules | nothing | yes |
| `nfo-metadata` | Reads Kodi `.nfo` files, so hand-made titles, plots, ratings and artwork win | nothing | yes |
| `random-picks` | A shuffled "Something different" row on Home | nothing | yes |
| `internet-archive` | Browse and stream public-domain films from archive.org (an add-on source) | nothing | yes |
| `iptv-simple` | Live TV from an M3U playlist and an XMLTV guide | a playlist address | yes |
| `fanart-tv` | Fills missing clear logos, backgrounds and posters for films, shows, artists and albums | a free Fanart.tv personal key | no |
| `omdb-ratings` | Adds IMDb, Rotten Tomatoes and Metacritic scores; **Fetch missing scores** for the rest | a free OMDb key (1,000 lookups a day) | no |
| `open-library` | Fills missing descriptions, covers, years and subjects for books and audiobooks | nothing | no |
| `musicbrainz` | Fills missing album covers (Cover Art Archive), years and genres, and finds the ids Fanart.tv uses | nothing (an optional contact email) | no |
| `opensubtitles` | Searches and downloads subtitles from the player | a free OpenSubtitles API key | no |
| `notifications` (**Alerts**) | New films and episodes, and server problems (a missing folder, a server not answering, low disk space…), to ntfy, Telegram, Pushover, Discord, email or a webhook, with a **Send a test message** button | one channel filled in | no |

Write your own with [docs/PLUGINS.md](docs/PLUGINS.md).

## Customising

- **Themes** — pick one in **Settings → Profile**. Make your own by copying `themes/orbit` (or `themes/arctic`, or the simpler `themes/midnight`). See [docs/THEMES.md](docs/THEMES.md).
- **Plugins** — see [Plugins](#plugins) above for the ones included; drop a folder into `plugins/` and restart to add your own ([docs/PLUGINS.md](docs/PLUGINS.md)).

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
- **An HDR film looks grey or washed out** — the browser or TV can't show HDR and this ffmpeg can't convert it: it needs the `zscale` filter (gyan.dev's Windows builds have it) or `libplacebo` with a GPU. The player says so instead of playing it grey.
- **A library vanished after a drive was unplugged** — it doesn't any more: a folder that exists but holds no files keeps its titles and the dashboard says "<folder> looks empty — not removing its titles". Plug the drive back in and scan.
- **Stutters on a small VPS** — transcoding is CPU heavy. Software conversion is capped at **Max software conversion height** (1080p by default, 720p on small CPUs). Store files as H.264/AAC MP4 where you can (direct play costs almost nothing), lower **Max simultaneous conversions**, or enable hardware acceleration.
- **No seek-bar previews yet** — they're made in the background after a scan; **Settings → Dashboard → Background tasks** shows what's left. They wait while someone watches a video the server is converting.
- **Skip intro is missing or in the wrong place** — an admin can fix it on the episode's page (**… → Edit intro** in
  Orbit, or **Edit** next to "Intro" in the other themes), for one episode or the whole season.

## Roadmap ideas

Photo libraries · PDF books · client-side plugins that add pages to the UI.

## About Kodi

Atomix is an independent project. It borrows Kodi's conventions — folder naming, artwork names and the `.nfo`
format documented on the [Kodi wiki](https://kodi.wiki/view/NFO_files) — but contains no Kodi code. The Arctic theme is
an original stylesheet inspired by the look of jurialmunkey's and beatmasterRS's Arctic skins; none of their files or
artwork are included (those skins are licensed for non-commercial use under Creative Commons). (Kodi is
GPL-licensed C++; copying its source would also put Atomix under the GPL.)
