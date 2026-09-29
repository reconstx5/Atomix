#!/bin/sh
# NodeFlix launcher for macOS / Linux.
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed — get the LTS from https://nodejs.org"; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || echo "[warning] ffmpeg not found — install it (brew install ffmpeg / sudo apt install ffmpeg) for MKV/HEVC playback."
exec node --disable-warning=ExperimentalWarning server.js
