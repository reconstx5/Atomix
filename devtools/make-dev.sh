#!/bin/bash
# A dev Atomix with made-up media for the browser checks in this folder.
#   devtools/make-dev.sh /path/to/devdir   (needs ffmpeg; then the server runs on :8787)
set -e
DEV=${1:?give a folder for the dev media and data}
CODE=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$DEV/media/Movies" "$DEV/media/TV/Harbour Lights/Season 01" "$DEV/data"
i=0
for t in "Red Canyon (2019)" "Blue Harbour (2021)" "Night Train (2018)" "Paper Moon Rising (2022)" "The Glass Field (2020)" "Lantern Bay (2017)" "Iron Orchard (2023)" "Quiet Signal (2016)"; do
  i=$((i+1)); mkdir -p "$DEV/media/Movies/$t"
  [ -f "$DEV/media/Movies/$t/$t.mp4" ] || ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=1280x720:rate=24,hue=h=$((i*40))" -f lavfi -i "sine=frequency=$((300+i*50))" -t 40 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest "$DEV/media/Movies/$t/$t.mp4"
done
for e in 1 2 3 4; do
  f="$DEV/media/TV/Harbour Lights/Season 01/Harbour Lights - S01E0$e.mp4"
  [ -f "$f" ] || ffmpeg -loglevel error -y -f lavfi -i "smptebars=size=1280x720:rate=24" -f lavfi -i "sine=frequency=500" -t 30 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest "$f"
done
cd "$CODE"
ATOMIX_DATA_DIR="$DEV/data" ATOMIX_PORT=8787 ATOMIX_CAST_DISCOVERY=off nohup node --disable-warning=ExperimentalWarning server.js > "$DEV/server.log" 2>&1 &
for n in $(seq 1 40); do curl -s localhost:8787/api/status >/dev/null && break; sleep 0.5; done
C="$DEV/cookies"; J='content-type: application/json'
curl -s -c "$C" -H "$J" -d '{"username":"dallas","password":"atomix-dev-1","serverName":"Dev"}' localhost:8787/api/setup >/dev/null || true
curl -s -b "$C" -c "$C" -H "$J" -d '{"username":"dallas","password":"atomix-dev-1"}' localhost:8787/api/auth/login >/dev/null
curl -s -b "$C" -H "$J" -d "{\"name\":\"Movies\",\"type\":\"movies\",\"paths\":[\"$DEV/media/Movies\"]}" localhost:8787/api/libraries >/dev/null
curl -s -b "$C" -H "$J" -d "{\"name\":\"TV Shows\",\"type\":\"tv\",\"paths\":[\"$DEV/media/TV\"]}" localhost:8787/api/libraries >/dev/null
echo "Dev Atomix on http://localhost:8787 (dallas / atomix-dev-1)"
