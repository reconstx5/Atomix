# Handoff: cloud session → Claude Code (17 Nov 2026)

Atomix work from 10–17 Nov 2026 was done in a Claude cloud session and copied into `D:\Nodeflix` with hash checks.
On 17 Nov Dallas moved the project to Claude Code on his PC. This file is what that session knew; `CLAUDE.md` has the
rules and the technical notes for each piece.

## State of the code
- Git: `main` is at d7c36b4. Everything below is **uncommitted** in the working tree. Dallas commits and pushes
  (remote https://github.com/reconstx5/Atomix.git); ask before committing.
- Full test suite at hand-off: 1825 of 1826 pass. The one failure, `test/subsonic-browse.test.js` "artists, albums and
  songs in JSON and XML" (an extra `<replayGain>` in the XML), predates this work. Under heavy parallel load the clip,
  big-guide and timing tests can fail; they pass alone.
- A stray `init.mp4` (written by ffmpeg 9 into the working folder before the iPhone fix) is not part of the project; delete it if it appears at the repo root.

## Done in this stretch (newest last)
1. **ffmpeg on Windows**: found in the winget package folder when it isn't on PATH (`src/windows-tools.js`, `start-windows.bat`).
2. **iPhone playback** (Dallas confirmed films play): ffmpeg runs in the stream's folder (ffmpeg 9 wrote
   `init.mp4` into the working folder), hvc1 for Apple, stereo AAC in HLS, validated in-memory init segment, faster
   start. Diagnostics still on: `data/logs/atomix.log`, `data/logs/hls-sample/`; remove once stable.
3. **Multi-DRM channels**: several key systems per channel, chosen per device; PlayReady; channels a device can't play
   are hidden (switch; iPhone shows "Watch on TV" / the provider's app). Migration 31.
4. **Card motion v2**: lift + glow in the poster's colour, sheen, 5 s preview clips, card-to-page morph, Back restore,
   colour placeholders. Migrations 32, 33.
5. **Visual refresh A** (foundation): token layers in every theme, APCA contrast checks, TV type floor, two-cue focus,
   eased scrim over artwork, accent picker for every theme with a readability clamp, old-TV colour guard.
6. **Visual refresh B** (choices and polish): Settings → Appearance Glass (Clear/Tinted/Solid), True black, More
   contrast, Text size, Menu (pinned libraries); title-page logo box, media chips, badges, flush progress track,
   skeletons.

Gallery pages of A and B (before/after sliders) are private artifacts in Dallas's claude.ai account.

## Refused, and why
- Server-side Widevine decryption so iPhones could watch TVNZ: that is DRM circumvention. Alternatives offered: Watch on
  TV (cast), Android, the TVNZ+ app. Keep refusing; keys are never extracted.

## Decisions taken on Dallas's behalf (still standing)
- Daylight uses a light page-colour wash with dark text over artwork (the spec said dark scrims); dark scrims stay on cards.
- Tinted glass = Orbit's existing glass; Clear thins menus to .12; outside Orbit only Solid looks different.
- `html.reduce-effects` means the profile chose Solid (or the old Reduce effects); a default Solid on TVs keeps card
  motion's sheen and clips.
- True black is offered on dark themes only. More contrast forces Solid glass.
- Unpinning every library shows them all (the menu is never empty). Pin/Unpin/Move live in a library entry's context
  menu and Settings → Menu (no extra "…" button in the rail).
- Orbit keeps its floating progress track; Arctic keeps its artwork-colour fill.
- A grey custom accent stays grey (only its lightness is clamped).

## Deferred minors (not fixed; pick up when convenient)
Plan A:
- Orbit Live TV toolbar pills (Guide, Recordings) are hard to read over a very bright live picture.
- Button ink on the artwork colour (Arctic/Orbit `--tint`) is about APCA Lc 47.
- Daylight's focus ring is weak over the player's black.
- Orbit at 1600–1919 px wide is slightly under the 20 px TV floor (scales with `--px`).
- 75 older `color-mix()`/`oklch()` uses without fallbacks (listed in `test/fixtures/old-browser-colours.json`).
Plan B:
- Orbit: a two-line title is taller than the logo box on a TV; Largest text doesn't grow Orbit's title-page heading.
- Settings: Glass can show "Clear" while More contrast or a browser without blur keep it Solid, with no explanation;
  the True black switch stays after switching to Daylight until reload; the pill choices save on every arrow press.
- True black also makes `--n-2` black (panels lose their lift); card edges hide under a playing preview clip; the
  `::after` edges need Chromium 87+.
- A malformed `pinnedLibraries` (not a list) clears the saved pins; a library under "More libraries" isn't marked current.
- The 7-Zip badge picked up the new badge style; media chips are on the title page only (the spotlight keeps old flags);
  the spotlight still shifts when a logo arrives; no "New season"/"New episode" badges (no data yet).

## Next
1. Done: Plan C merged into `main` and pushed (17 Nov).
2. The title page (`views/item.js`) on Preact: built on branch `title-page-preact` (18 Nov); Dallas decides the merge.
3. A Jellyfin-compatible API so Infuse can connect (Infuse only this round; Swiftfin/Streamyfin/Finamp not yet): built on branch `jellyfin-api` (18 Nov, not merged; `src/jellyfin/`, Settings → Profile → Apps). Waiting on real devices (Infuse first).
4. Remove the iPhone diagnostics once playback is stable.
5. Real-device checks: TV timings and focus rings, Safari/iPhone, old TV browsers.
