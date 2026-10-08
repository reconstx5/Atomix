# Deploying Atomix

## 1. On your own PC (simplest)

Follow the Quick start in the README: install Node.js LTS and ffmpeg, then `npm start` or `start-windows.bat`.
To keep it running in the background on Windows you can create a Task Scheduler task that runs
`start-windows.bat` "At log on", or use a service wrapper such as NSSM.

To only allow this computer (not your network), set `ATOMIX_HOST=127.0.0.1`.

## 2. On your home network (Docker)

```sh
cp .env.example .env
# edit MEDIA_MOVIES / MEDIA_TV / MEDIA_MUSIC to your folders, set ATOMIX_TRUST_PROXY=false
docker compose up -d
```

Open `http://<machine-ip>:8787`. In **Settings → Libraries**, add `/media/movies` (Movies), `/media/tv` (TV) and
`/media/music` (Music) — those are the paths *inside* the container.

## 3. On a VPS as your own streaming site

### What you need

- A VPS (2+ vCPU, 2+ GB RAM is comfortable; transcoding 1080p in software needs roughly one modern core per stream).
- A domain name with an **A record** (and AAAA for IPv6) pointing at the VPS, e.g. `media.example.com`.
- Your media on the VPS (upload with `rsync`/`scp`, or mount storage) — or a storage box mounted with `rclone mount`.

### Steps (Ubuntu / Debian)

```sh
# 1. Install Docker
curl -fsSL https://get.docker.com | sh

# 2. Firewall: allow SSH and web only
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw allow 443/udp
sudo ufw enable

# 3. Get Atomix onto the server (git, or scp the folder)
cd /opt && sudo git clone <your repo> atomix && cd atomix

# 4. Configure
sudo cp .env.example .env
sudo nano .env          # ATOMIX_DOMAIN, ATOMIX_TRUST_PROXY=true, MEDIA_MOVIES, MEDIA_TV, MEDIA_MUSIC, TMDB_API_KEY

# 5. Start Atomix + Caddy (automatic HTTPS)
sudo docker compose --profile https up -d
sudo docker compose logs -f
```

Visit `https://media.example.com` and create the admin account. Because the page is public, setup from another
device asks for a one-time **setup code** — find it with `sudo docker compose logs atomix | grep "setup code"`.

Hardening tips:

- Remove the `ports: - "8787:8787"` lines from `docker-compose.yml` so Atomix is only reachable through Caddy.
- Leave `ATOMIX_TRUST_PROXY=true` only when a proxy is in front — otherwise clients could fake their IP.
- Give each person their own **Viewer** account; keep only yourself as **Admin**.
- Set **Max simultaneous conversions** and a default quality of 720p in **Settings → Server** to protect a small VPS
  and slow connections.
- Prefer MP4 (H.264 + AAC) files: they direct-play everywhere and cost the server almost nothing.

### Hardware transcoding

- **Intel / AMD (VAAPI)**: uncomment the `devices: /dev/dri` lines in `docker-compose.yml`, add
  `mesa-va-gallium intel-media-driver` to the `apk add` line in the `Dockerfile`, rebuild
  (`docker compose build`), then choose **VAAPI** in **Settings → Server**.
- **NVIDIA**: install the NVIDIA Container Toolkit, add `deploy.resources.reservations.devices` for the GPU, use an
  ffmpeg build with NVENC, and choose **NVENC**.
- On Windows without Docker, Gyan's ffmpeg build already includes NVENC, Quick Sync and AMF — just pick the one for your GPU.

### Using nginx instead of Caddy

See `deploy/nginx.conf.example`. The important parts are `proxy_buffering off`, long timeouts, and passing
`Host`/`X-Forwarded-*` headers. Set `ATOMIX_TRUST_PROXY=true`.

## Backups and updates

Everything Atomix knows lives in the data folder (`./data` or the `/data` volume):

- `atomix.db` (+ `-wal`/`-shm`) — users, profiles, libraries, watch history, settings
- `images/` — downloaded and extracted artwork (re-downloadable)
- `subtitles/` — subtitles downloaded from the player or by the OpenSubtitles plugin
- `plugin-data/` — plugin storage

Back up `atomix.db` while Atomix is stopped, or with `sqlite3 atomix.db ".backup backup.db"` while it runs.

To update: replace the code (e.g. `git pull`), then `docker compose build && docker compose --profile https up -d`
(or just restart `npm start`). Database migrations run automatically.

Updating from NodeFlix (Atomix's old name): the Compose service and containers are now called `atomix` and
`atomix-caddy`, so add `--remove-orphans` the first time (`docker compose --profile https up -d --remove-orphans`)
to replace the old `nodeflix` ones. Your `.env` can keep its `NODEFLIX_` names, or rename them to `ATOMIX_`.
The database file is renamed to `atomix.db` on the first start. Caddy keeps its certificates only if the folder
(and so the Compose project name) stays the same; otherwise it simply fetches new ones.

## A word on content

Running your own streaming site is great for your own recordings, home videos and media you have the rights to.
Sharing copyrighted films or shows with people outside your household is illegal in most countries (including
New Zealand under the Copyright Act 1994), and hosting providers will shut down servers that do it.
