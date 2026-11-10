# Atomix (NodeFlix) — notes for Claude Code

Atomix is a self-hosted media hub in the spirit of Kodi: films, TV, music and Live TV
(IPTV), served by a Node server to browsers, phones (installable web app) and TVs
(casting). It runs on a home PC or on its own server/VPS. Owner: Dallas (GitHub reconstx5).

## Hard constraints
- Node >= 22.13 (uses built-in `node:sqlite`) plus ffmpeg on PATH.
- No `npm install`, no bundler, no build step. Do not add dependencies.
- Front end is Preact 11 + htm vendored in `public/js/vendor`; screens import through
  `public/js/ui.js` (see CONTRIBUTING.md, "How to write an Atomix screen").
- No DRM circumvention. Encrypted channels are only relayed to the device's own
  EME/FairPlay; keys are never extracted.
- Provider addresses, keys and tokens never reach browsers, TVs or logs.
- Older themes must stay pixel-identical when new UI work lands.
- Kids profile rules and per-account stream caps must keep working.

## Layout
- `src/` server (`src/app.js` routes; `src/live/` Live TV + HLS relay; `src/cast/` casting
  and cast tokens; `src/tls/` HTTPS setup)
- `public/js/` web app (`views/` screens, `dash/` DASH/EME/FairPlay helpers)
- `plugins/`, `themes/`, `test/`
- Docs: `docs/ARCHITECTURE.md`, `THEMES.md`, `PLUGINS.md`, `CONTRIBUTING.md`
- Design specs and plans: `docs/superpowers/specs/`, `docs/superpowers/plans/`

## Commands
- Run: `npm start` (Windows: `start-windows.bat`); dev: `npm run dev`
- Tests: `npm test` (= `node --test test/*.test.js`, ~1489 tests). Live-tuner tests are slow;
  run them on their own if the full run times out.
- Reset a password: `npm run reset-password`

## How we work
- Test first: write the failing test, watch it fail, then fix (RED -> GREEN), then full suite.
- Bigger features: brainstorm -> spec -> plan -> execute, then one fresh review and one fix pass.
- Messages shown to users are plain-English sentences that say what happened and what to do.
- Git: Dallas decides when to commit and push. Remote: https://github.com/reconstx5/Atomix.git
  Commit trailer used so far:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Current state (v0.27.0, commit fa1c28d)
v0.27 added: HTTPS address (Plan A), phone Live TV incl. FairPlay on iPhone (Plan B),
Watch on TV / casting encrypted channels to Chromecast (Plan C).
Still to verify on real hardware: iPhone FairPlay, Chromecast with encrypted channels.

## Motion ("Capture", v0.28 work, uncommitted)
- Follow the `web-animation` skill for any animation work.
- One attribute decides how much moves: `html[data-motion]` = full | reduce | none (`public/js/motion.js`, rules in
  `public/js/motion-rules.js`, tested in `test/motion-rules.test.js`). `html.reduce-motion` is still set when not full.
- Signatures: the settle spring (`--ease-settle`, scale only), the focus orbit + press ring, and depth-aware screen
  changes with a poster morph (`public/js/transitions.js`, CSS at the end of `public/css/app.css`).
- Focus rings and shadows never transition; only transform/opacity tween. Hover effects sit behind
  `@media (hover: hover) and (pointer: fine)`. A held arrow (`html.nav-held`) stops all tweens.
- Not yet checked on real hardware: timings on a TV, view transitions on a long page, Safari.

## Open issue: films and TV won't play on iPhone
- iPhone Safari at the Tailscale Serve address (https://<pc>.ts.net, no port).
  Every film fails with "The stream stopped unexpectedly…".
- Through Tailscale Serve every request arrives from 127.0.0.1.
- Hypothesis: Safari's media player (AppleCoreMedia) fetches the video without the sign-in
  cookie, so `/api/items/:id/file`, `/api/stream/…` or `/api/hls/…` answers 401.
- Diagnostic code is in place (uncommitted): `src/app.js` logs `[media] …` lines with cookie
  names, Range and user agent for media requests and any 4xx; `public/js/views/player.js`
  shows a "Details: …" line under the player error.
- Next step: read those lines from an iPhone attempt. If they show "sign-in cookie: none"
  and a 401, give the player short-lived per-session media tokens in the URL, the same way
  cast links work (`src/cast/tokens.js`), with tests first. Remove the diagnostics afterwards
  or keep them behind debug logging.

## Lost tooling
Earlier rounds used browser test suites and mock servers (mock IPTV, mock Chromecast,
Playwright UI checks) that lived only in a cloud workspace and no longer exist. Recreate
them under `devtools/` if browser-level checks are needed again.
