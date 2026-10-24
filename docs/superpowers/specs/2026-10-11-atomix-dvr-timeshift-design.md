# Atomix Round 21 — Live TV recording (DVR) and pause/rewind

Status: design approved in chat (11 Oct 2026: recording from the guide and by series; 30-minute rewind; a recording
takes a slot from a viewer, warned ahead; approach A, a shared tuner per channel; sections 1–3 "looks right").
Version **v0.19.0**.

## Why

Dallas watches Live TV through an IPTV playlist whose provider allows a limited number of streams (often 1–2). He
wants to pause and rewind what's on, record a programme from the guide, and record every episode of a show — without
a recording and the person watching fighting over the provider's streams.

## Hard limits

- **Encrypted channels (Widevine/ClearKey DASH) are never recorded or buffered by Atomix**: that would mean decrypting
  on the server (DRM circumvention). They keep playing through the existing relay; their player gets the same seek
  bar over the window the provider's own manifest offers (`timeShiftBufferDepth`). Their guide sheet offers no
  Record; a series rule never schedules them.
- No dependencies. Older themes stay pixel-identical (`oldthemes-compare.mjs compare` → "all pages match").
- Provider URLs, headers and tokens never reach the browser. Kids never see the Recordings page or admin data.
- New sentences are exactly as written in this spec.

## 1. The tuner (`src/live/tuner.js`)

- **One provider connection per channel.** `TunerPool.acquire(channel, holder)` returns the channel's tuner, starting
  it if needed; `release(holder)` drops a hold. Holders are viewer sessions and recordings. A tuner counts as **one**
  stream toward the source's limit (`LiveStreams.reserve` counts tuners, not viewers) and closes 30 s after its last
  holder leaves.
- **The buffer.** ffmpeg reads the provider (`liveInputArgs`, the playlist's headers) and writes, **without
  converting** (`-c copy`), a live DASH stream of fragmented-MP4 pieces: `-f dash -seg_duration 4 -window_size 450
  -extra_window_size 5 -use_timeline 1 -use_template 1 -streaming 0`, into `<data>/timeshift/<tunerId>/` (the 450
  pieces = 30 minutes). Every leftover `timeshift/*` folder is deleted at startup.
- **Drops.** A provider drop restarts ffmpeg with the existing budget (3 in 2 minutes); the buffer keeps what it had
  and the new pieces continue after a period break. A tuner that runs out of budget ends for every holder: viewers get
  "This channel stopped sending video.", recordings get a gap mark.
- **Channels that can't be buffered.** If ffmpeg refuses to copy the channel's codecs into fragmented MP4 (rare: the
  first 10 s produce no piece), the tuner reports `unbuffered`. Viewers then get the pre-0.19 per-viewer stream, the
  player says "Rewind isn't available on this channel", and recordings of that channel are copied to MPEG-TS by their
  own connection instead (still counted toward the limit).
- **Radio** uses the same tuner (audio only; the browser plays the audio pieces).

## 2. Watching, pause and rewind

- **A plain channel the browser can play as-is** (the existing caps check: H.264/HEVC/AV1/VP9 video, AAC/MP3/Opus/
  AC-3 audio the browser reports) gets `delivery: 'dash'`: Atomix serves the tuner's manifest and pieces at
  `/api/live/tuner/:sid/manifest.mpd` and `/api/live/tuner/:sid/p/<file>` (the viewer session's id; same checks as
  today's stream routes: the session's owner, no provider address anywhere). The browser plays it with the existing
  `DashPlayer` in a **clear (unencrypted) mode** — no key system, no licence.
- **Otherwise** (MPEG-2, or audio the browser can't decode) a per-viewer ffmpeg converts **from the tuner's buffer**
  (`-i <local manifest>`), as today's conversion does from the provider; rewinding restarts that conversion at the
  chosen point (`-ss` into the buffer).
- **The player** (plain, converted and encrypted alike) shows a seek bar over the available window with the start
  time and "now"; Pause holds the picture; Back 10 s / Forward 30 s and the arrow keys work within the window; a
  **Live** button (and the LIVE badge, when behind) jumps to the live point. Behind live, the time readout says how far
  behind ("−4:12"). Paused past the window's start, playback resumes at the oldest point with the notice "You were
  paused too long — playing from the earliest point kept". Channel up/down always starts the new channel live.
- The guide's "now" and the title line follow what's on screen when behind live (the programme at the playhead).

## 3. Recordings

- **Scheduling.** A TV programme's sheet in the guide (and in search) offers **Record**, **Record series** and, once
  scheduled, **Cancel recording** / **Stop series**. Scheduled programmes carry a small red dot (with visually hidden
  text "Recording scheduled", or "Recording" while it records) in the guide and the channel rows. Encrypted channels and
  radio offer none of these.
- **Padding.** Each recording starts `prePadding` (default 1 min) before and ends `postPadding` (default 3 min) after
  the programme. If the channel's tuner already holds those minutes, the recording starts from the buffer.
- **Recording.** At start time (the scheduler checks every 15 s) the recording acquires the channel's tuner and copies
  pieces into a work folder as they appear; at the end it joins them **without converting** (`-c copy`) into
  `<recordingsDir>/<Show>/<Show> - S01E02 - <Episode title>.mkv`, or `<Show> - 2026-10-11 20-30.mkv` when the guide
  gives no episode number, with a `.nfo` (title, episode title, plot, season/episode, aired date, channel name). Names
  are made safe for Windows (`<>:"/\|?*` removed, trailing dots/spaces trimmed).
- **The Recordings library.** On the first finished recording, a TV library "Recordings" is created over
  `recordingsDir` (if none points there) and scanned; every finished recording triggers a scan of it. Recordings then
  play, resume, cast and show "Continue watching" like any TV show.
- **Series rules.** "Record series" makes a rule: the programme's title (matched case-insensitively, trimmed), on this
  channel or **any channel** (a choice in the sheet), **new episodes only** (skips programmes the guide marks as
  repeats/previously shown) on by default, **keep** all episodes or the last 5/10 (oldest finished recordings of the
  rule deleted, file and item, after a new one finishes). After every guide refresh, rules schedule matching
  programmes in the next 7 days, skipping any already scheduled or recorded (same rule and same episode number, else
  same title + episode title, else same start time and channel).
- **Clashes, at scheduling.** If a new recording would need more tuners at once than the source allows (counting
  other recordings only), the sheet still schedules it and says "Your provider allows N stream(s) at a time — this
  overlaps M other recording(s)". The Recordings page marks clashing entries.
- **Clashes, at start time.** If no slot is free, the recording takes one from a viewer: the newest viewer tuner hold
  on another channel of that source is stopped (the viewer sees "Stopped to record <title>"). A recording never stops
  another recording; if every slot is recording, it fails with "Couldn't record: every stream is recording".
- **Failures.** A provider drop mid-recording: the tuner retries; the finished recording keeps what it got and is
  marked "Has a gap" (with the minutes missing). Atomix restarting mid-recording: on start, a recording still inside
  its window resumes as part 2 (`… (part 2).mkv`). Less than 5 GB free in `recordingsDir`: a recording doesn't start
  ("The recordings folder is full"), and one running is stopped and kept as far as it got. A source removed: its
  scheduled recordings fail with "This channel no longer exists.".
- **Who.** Any grown-up profile can schedule and cancel; the Recordings page shows everyone's (the profile that
  scheduled each is named). Kids don't see the page or the Record actions; they see a recorded show only through the
  library, filtered by their channel groups (the recording's channel must be in a ticked group) and their usual
  rating rules.
- **The Recordings page** (Live TV → Recordings): Scheduled (with clash marks), Recording now (with Stop), Done (with
  Play and Delete — Delete asks in the page, "Delete <title>? The file is removed.", and removes file and item),
  Failed (with the sentence), and Series rules (edit keep/new-only/channel, Stop series).

## 4. Settings, data, Dashboard

- **Settings → Live TV → Recording** (admins): Recordings folder (default `<data>/recordings`; any absolute path,
  checked writable — "Atomix can't write to that folder"), Start early (minutes, 0–30, default 1), End late (0–60,
  default 3). The 5 GB floor is fixed.
- **Migration 18:** `live_recordings` (id, profile_id, source, channel_key, channel_id, programme_id null, title,
  episode_title, season, episode, plot, start, end, pre, post, status `scheduled|recording|done|failed|cancelled`,
  error, gap_seconds, path, item_id, rule_id, created_at) and `live_series_rules` (id, profile_id, source, channel_key
  null = any channel, title, new_only, keep, created_at). It also adds `live_programmes.repeat` (0/1): IPTV Simple's XMLTV reader sets it from `<previously-shown>`, which is what "new episodes only" skips. Season and episode numbers come from the programme's existing `episode` text (`S2 E5` → 2, 5).
- **Dashboard:** "Tuners in use" (channel, who's watching, "recording <title>") and "Next recordings" (the next 3).

## Out of scope

Recording encrypted channels (see Hard limits); converting recordings to smaller files; skipping adverts; recording
from catch-up archives; per-viewer rewind beyond 30 minutes; a separate rewind setting.

## Testing

- Node: the scheduler on a fake clock (padding, series matching and duplicates, new-only, keep-last-N, clash warning,
  stopping a viewer, never stopping a recording, restart → part 2, disk floor, removed source); the tuner with real
  ffmpeg against a local fake provider (sharing, idle close, one stream counted, a drop and restart, the 30-min window
  trimmed, unbuffered fallback); the recorder (join to .mkv, .nfo contents, safe names, Recordings library created and
  scanned); routes (owner checks, no provider host in the manifest).
- Browser (`live-ui.mjs`, new sections `rewind` and `record`, mock-iptv with a 1-stream mode): pause and resume,
  Back 10 s, Live, the behind-live readout, channel change goes live; the guide's Record / Record series / Cancel;
  the red dot; the Recordings page; a recording stopping a viewer on a 1-stream source with "Stopped to record …";
  a finished recording playing from the library.
- `oldthemes-compare.mjs compare` → "all pages match"; pictures of the rewind bar, the guide's Record sheet and the
  Recordings page.
