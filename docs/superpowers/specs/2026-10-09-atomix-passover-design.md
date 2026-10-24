# Atomix v0.15.0 — "the passover" design

Round 17. Five read-only audits of v0.14.0 (ffmpeg expert, a11y-enforcer, ux-ui-audit live at 1920×1080 and 390×844, consistent-ui, engineering tech-debt/code-review; consolidated in the project note `claude/passover-audit.md`) produced the findings this round fixes. Dallas chose all four packages. Nothing new in scope beyond what an audit named; the audit is the backlog.

Project-wide constraints (unchanged): Node ≥ 22.13, zero dependencies, plain ES-module browser JS, no build step. Tokens travel in headers, never in browser-visible URLs (`?cast=` links excepted). No route returns `servers.secret`/`extra`. Nothing leaves the server except plex.tv, connected servers, local cast devices, LRCLIB and the YouTube embed. Kids profiles never see unrated/adult content or admin data. Older themes stay pixel-identical unless a section says otherwise.

## 1. Server hardening and speed

**Redirects.** `RemoteProvider.request()` (src/remote/provider.js) and `chooseConnection` (src/remote/plextv.js) use `fetchFollowing(url, { sameOriginOnly: true })` instead of `fetch(..., redirect: 'follow')`. A cross-origin redirect fails with the existing `ECROSSORIGIN` → 502 "<server> didn't answer" shape. Token headers never leave the server's origin.

**Setup code.** `needsCode(req)` (src/api/account.js) is true unless the socket address is loopback **and** none of `x-forwarded-for`, `x-forwarded-proto`, `x-real-ip` is present. Log line unchanged. The compare is `timingSafeEqual` on equal-length buffers.

**Rate limiting.** With `trustProxy` on, `auth.clientIp` takes the **last** `X-Forwarded-For` entry.

**Subtitle extraction.** `GET /api/items/:id/subtitles/e<N>.vtt`: `N` must be an index into the probed `media.subtitles` (else 404). Extractions are de-duplicated by cache file (an in-flight `Map`, as images.js does) and run through the playback pool cap (`maxTranscodes`); over cap → 503 "Busy converting other videos; try again in a moment." Extraction also becomes a task-runner job `subtitles` queued at scan for local files with embedded text subtitles (after lyrics in priority); the route serves the cache or runs it on demand within the cap.

**Prune guard.** In `scanLibrary`, a root that `stat`s as a directory but yields zero files while items already exist under it is dropped from `reachable` for that scan; `status.warning = "<root> looks empty — not removing its titles"` and a `log.warn`. Matches sync.js.

**Migration 14.** `CREATE INDEX progress_item ON progress(item_id)`; `CREATE INDEX sessions_profile ON sessions(profile_id)`.

**Picks.** `candidates()` selects `id, kind, year, rating, genres, keywords, people, library_id, min_age, show_id` only; parsed profiles cached per visibility key (cleared with the picks cache); `lists.onChange(() => picks.clear())` removed.

**Capacity.** `checkCapacity()` counts every session with a live `proc` (remux included) against `maxTranscodes`; a user may hold at most 4 live playback sessions — the 5th `POST /api/items/:id/playback` returns 429 "Too many streams open on this account."

**Static files.** `index.html` → `Cache-Control: no-cache`; everything else under `public/` → `public, max-age=3600` with the existing ETag/304 path (the dead ternary in src/app.js:200 becomes this split).

**Kids/admin.** `/api/status` includes `servers` only for `role === 'admin' && !profile?.kids`. `/api/scan/status` returns the full status to admins and `{ running }` to everyone else. `GET /api/collections/:id/image/:type` 404s unless `collections.get(id, ctx.viewer)` returns.

**Minors folded in.** `normaliseUrl` (servers) and `httpUrl` (DLNA add) refuse loopback, link-local (169.254/16, fe80::/10) and `0.0.0.0`; `isSelf` compares resolved IPs. `PUT /api/admin/settings` validates `hwAccel ∈ {none,nvenc,qsv,amf,vaapi}`, `x264Preset ∈ {ultrafast…slow}`, `vaapiDevice` as an absolute path. The task runner no longer idles when previews and intros are off while lyrics or subtitles are pending. DLNA `refresh()` skips when one is in flight. `server.requestTimeout` stays 0 but `readBody` rejects after 30 s. `library.nextUpFor(viewer, showId)` replaces `nextUp(viewer, 50)` on the show page.

**Deferred (documented in the note, not built):** batched sync/scan transactions, `json_each` for variable `IN` lists, splitting the item handler and sessions.js, queued show refresh/identify, size caps on image/subtitle downloads, cast-link reuse, `DELETE /api/libraries/:id` orphan cleanup.

**Tests (node:test).** A fake server that 302s to another port keeps its token (request fails ECROSSORIGIN; the other port never sees `X-Emby-Authorization`); setup with `X-Forwarded-For` on a loopback socket needs the code; forged first-hop XFF still rate-limits; an empty root with items doesn't prune and sets the warning; `EXPLAIN QUERY PLAN` for a delete by item shows `progress_item`; capacity with remux children; `/api/status` kids shape; `/api/scan/status` viewer stub; collection image 404 for a kid; `e99.vtt` → 404; settings enum validation 400s.

## 2. Video pipeline

**Probe additions** (src/library/probe.js summary): `bitDepth` from the pix_fmt suffix (`(\d+)(le|be)?$`, default 8); `rotation` (from `side_data_list[].rotation`, normalised to 0/90/180/270); `dolbyVision: { profile }` when a `DOVI configuration record` is present; `chapters` from `-show_chapters` in the same run (intros.js reads them from the summary; its own ffprobe call goes); `defaultAudio` = index of the stream with `disposition.default`, else 0. Previews use `rotation` to size portrait sources; intro fingerprints use `defaultAudio`.

**HDR.** `decide()` already routes HDR-to-non-HDR sinks to transcode. `buildFfmpegArgs` video chain for that case: `scale=-2:H` (when downscaling) → `zscale=tin=<probe transfer>:pin=<probe primaries>:min=<probe matrix>:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p` → `-color_primaries bt709 -color_trc bt709 -colorspace bt709`. Without `filters.zscale` but with `filters.libplacebo`: `libplacebo=tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:format=yuv420p`. With neither: 422 `"This ffmpeg can't convert HDR video (it needs zscale or libplacebo)."` Dolby Vision profile 5: libplacebo or that 422. Text burn-in runs after the tone map; PGS overlay stays before scale.

**Hardware HLS.** nvenc adds `-forced-idr 1 -b:v 0 -profile:v high -spatial-aq 1`; qsv adds `-forced_idr 1 -look_ahead 0`; all hardware encoders set `-g <segment seconds × fps>`; amf relies on `-g`. libvpx adds `-row-mt 1 -threads <cpus>`.

**Audio.** When `plan.audio.channels > 2` and the sink is stereo: `-af pan=stereo|FL=FC+0.30*FL+0.30*BL+0.30*SL|FR=FC+0.30*FR+0.30*BR+0.30*SR,alimiter=limit=0.95` replaces `-ac 2`. `-c:a copy` whenever the sink can play the track's codec/channels, in transcode mode too. `-map 0:a:N` without `?`; an index outside `media.audio` → 400 "That audio track doesn't exist."

**Starts and seeks.** Progressive fMP4 adds `-frag_duration 500000`. HLS: `-hls_time 2`, `-force_key_frames expr:gte(t,n_forced*2)`, `-hls_init_time 1`, and `-readrate 1.5` before `-i` when ffmpeg ≥ 5 (`detectTools` records the major version; older builds get nothing). Remux (`-c:v copy`) with `start > 0`: `keyframeAtOrBefore(file, start)` runs `ffprobe -select_streams v:0 -read_intervals <start-10>%<start> -show_entries packet=pts_time,flags -of csv=p=0` and the session's `start` (returned to the player, used for `offset`) becomes that keyframe time; on any ffprobe failure the old behaviour stands.

**CPU cap.** When `hwAccel === 'none'`, `targetHeight = min(targetHeight, settings.maxSoftwareHeight)`; `maxSoftwareHeight` defaults to 1080 (720 when `os.cpus().length < 6`), Settings → Server → Playback "Max software conversion height" (720/1080/1440/2160). `-level`: `>1080 → 5.1`, `fps > 30 → 4.2`, else `4.1`.

**Subtitles.** At startup, when `filters.subtitles`, a one-off warm-up `ffmpeg -nostdin -f lavfi -i color=s=16x16:d=0.1 -vf subtitles=<warm.vtt> -f null -` runs in the background (logged, never awaited by requests). The subtitles filter gets `:fontsdir=<os fonts dir>` (Windows `C:/Windows/Fonts`, macOS `/Library/Fonts`, Linux `/usr/share/fonts`) with the colon escaped. An `.ass`/`.ssa` sidecar chosen for burn-in is copied as `.ass` into cast-subs and burned with its styling; everything else stays `.vtt`. `toVtt` retries with `-sub_charenc cp1252` when `decodeText` says the file isn't UTF-8.

**Previews / misc.** previews.js: `scale` before the tonemap chain; `-hwaccel auto` before `-i`. `probe.run()` rejects with `EOVERFLOW` when stdout exceeds `maxBuffer` instead of truncating. Album art copies MJPEG streams instead of re-encoding. `serveHls` checks `session.proc` is alive before waiting on a missing segment.

**Deferred:** GPU decode/scale chains (`scale_cuda`, `vpp_qsv`), encoder self-test at startup, VP9-in-HLS for Safari, `-x264-params` tuning, 12-bit handling beyond detection.

**Tests.** `buildFfmpegArgs` unit tests over fake probe/caps (HDR+zscale chain order and output colour flags; HDR without zscale → libplacebo; neither → 422; DV5; 5.1 → pan; AAC stereo → copy in transcode; nvenc flags; level per fps/height; CPU cap; `-frag_duration`; hls flags; readrate gated on version); `keyframeAtOrBefore` on a generated 2-GOP test file; probe summary fields on fixture JSON; previews filter order; warm-up spawn (fake bin); `.ass` burn path in cast-sessions.

## 3. Accessibility and layout

**Sliders.** Seek bars (player, mini/music, Remote, Now Playing) write `aria-valuetext` on `focus`, on every user `input`, and otherwise at most every 10 s while focused; `value` updates continue. Now Playing seek is `min=0 max=duration` seconds with the same `"<pos> of <dur>"` text. Volume sliders (player, mini, Remote, Now Playing) carry `aria-valuetext="<n>%"`. Every `input[type=range]` has a 24 px hit height; drawn tracks stay thin.

**Announcements.** `announce(text, { assertive = false })` in components.js writes to one of two visually hidden regions created at boot (`#live-polite role=status`, `#live-alert role=alert`), clearing and re-setting so repeats are spoken. Error toasts also go to the alert region. Route changes announce the page title after render. The player notice is `role="status"` from creation; when it carries a button it stays until the next control interaction (else 7 s as now). Up next announces `"Up next: <byline> <title>. Starting in 10 seconds"` once when shown. The cast pill text and the Remote status only assign `textContent` when the string changed; the pill text is `aria-live="polite" aria-atomic="true"`. Search results and the cast-device list lose container `aria-live`; a one-line summary node (`"<n> results"` / `"<n> devices found"`) carries it.

**Names and roles.** Lyric lines: `<li><button class="lyric-line" aria-label="Jump to: <text>">`. Playing track row `aria-current="true"`. Now Playing play button renames Play/Pause; repeat button `aria-label` names the mode. `moreButton(title)` → `aria-label="More options for <title>"`. Card labels append `, watched` / `, <n> unwatched` / `, <n> min left` (episode cards and spotlight too). `openDialog` ids `dlg-title-<n>`. Player track menu: `aria-labelledby` the title, `role="separator"`, `menuitem` on "Find subtitles online…", `aria-haspopup="menu"`/`aria-expanded` on the openers; the online search renders as a labelled `role="dialog"` panel outside the menu. Subtitles button `aria-label="Subtitles: <label|off>"` and a polite announcement on change. Season tabs get `aria-controls`/`aria-labelledby` and roving tabindex; theme/avatar radios roving tabindex + arrows. "This film" card `tabindex=-1` + `aria-current`. Spotlight logo `alt=""`. Player overlays use `h2`; `emptyState({ level })`. Collections table `scope="col"`. Chosen accent colour luminance-clamped (0.30–0.62, as tint.js) before use.

**Contrast.** app.css input/toggle borders `color-mix(in srgb, var(--text) 38%, transparent)`; Orbit input edge `rgba(255,255,255,.30)` and toggle edge the same; `.toast-error` `color: #2a0007`; seek/mini/volume rails `rgba(255,255,255,.4)`; player top bar gets a top-down gradient scrim (`rgba(0,0,0,.55) → 0` over 120 px) and the control glass darkens to `--glass-player` at .72 alpha. PIN dialog: `"Wrong PIN."` inline as `<p class="form-error" role="alert">`, field cleared and refocused, `aria-invalid` set.

**Zoom.** Orbit `--px: clamp(0.72px, calc(0.052vw + 0.02rem), 2px)`; floors (`max(12px, …)`) become `max(0.75rem, …)`; orbit-sizes re-baselines. Older themes untouched.

**Server checkboxes.** The five native checkboxes on Settings → Server become `toggle()` switches: names "Convert video when needed", "Seek-bar previews", "Find TV intros", "Online trailers", "Online lyrics"; the old sentence becomes the hint.

**Reduce motion.** `reduceMotion()` helper = media query OR `html.reduce-motion`; used by `scroller.scrollBy` and nav.js; `html.reduce-motion` CSS gains `animation-iteration-count: 1` and `scroll-behavior: auto`.

**Phone and TV layout.** Player control row wraps below 480 px; Quality, Cast and Full screen fold into a "…" sheet there. Orbit dock drops the current entry's label at ≤ 390 px (icon stays highlighted). Orbit `.toasts` bottom = dock height + 16 px on phones (+ mini-player height when `has-mini`). Settings tab strip gets edge fade masks (`mask-image` linear gradients) when it overflows. `.home-rows` gets `scroll-snap-type: y proximity` with `scroll-snap-align: start` and `scroll-margin-top: 24px` on each row heading. Settings forms pad the bottom by the Save bar height; `field()` hints get `min-height: 2.6em` so inputs share a baseline.

**Empty states and copy.** `emptyState({ icon, title, text, action })`: Lists → "Browse Movies"; Search no-results → "Open Add-ons" (admins) / "Browse Movies"; home with no libraries → "Add a library". Watchlist button `aria-label`/`title` "Add to watchlist"/"In your watchlist". Copy: "movie(s)" and "collection(s)" everywhere a film/series was said (Lists hint: "Collections appear here as your movies are matched."); the music queue is "Queue" everywhere and excludes the playing song; switch "Enable casting"; Settings tab "Profiles" → "Household"; not-found pages: "This title/library/collection no longer exists." with a single "Go home"; "Direct play"/"Converting"/"Remuxing" badge with an info icon and the same `title`; Remote forward skip 30 s to match the player; subtitles menu shows "Online subtitles are off — turn them on in Settings → Plugins" for admins when the plugin is off; toasts lose trailing full stops; "Collection saved" becomes success.

**Tests.** `devtools/a11y-ui.mjs` (Playwright): valuetext write count on a focused playing seek bar ≤ 2 in 5 s; live-region text after a route change, an error toast, a notice, Up next, a cast state change; unique dialog ids with two stacked dialogs; player menu roles; PIN inline error; 24 px ranges; server switches. orbit-sizes gains phone checks (controls inside 390 px; dock scrollWidth ≤ clientWidth; toast bottom ≤ dock top; Home second-row heading intact). qol-ui copy checks ("movie", "Queue", "Household"). a11y-enforcer `a11y_scan.py` and `contrast.py` on the changed tokens recorded in the ledger. Older-theme screenshots unchanged except where this section names a token change (field edges, toast-error, rails).

## 4. CSS tokens and component consolidation

**Orbit tokens** (themes/orbit/theme.css): `--focus-bg: #ffffff`, `--focus-fg: #0b0b16`, `--glass-solid: rgba(24,24,36,.94)`, `--glass-panel-edge: rgba(255,255,255,.12)`, `--text-tinted: rgba(226,230,255,.72)`, `--radius-sm: calc(10*var(--px))`, `--radius-md: var(--radius)`, `--radius-xl: calc(44*var(--px))`, `--pill: 999px`, `--space-1…8` = 8/12/16/24/32/48/64/96 ×px, `--rating: #ffd166`. Every literal of those values in theme.css and orbit.css is replaced; the seven "deep space" blacks collapse to `--bg` and `--bg-2`.

**Classic tokens** (app.css): `--space-1…7` = 4/8/12/16/24/32/48px, `--dur-fast: .15s`, `--dur: .22s`, `--dur-slow: .35s` (with `var(--ease)`), `--z-player: 60`, `--z-mini: 38`, `--z-pill: 39`, `--z-header: 40`, `--z-phone-nav: 41`, `--z-skip: 100`, `--z-toast: 200`, `--z-splash: 300`, `--focus-ring: 3px solid var(--accent)`, `--pill: 999px`, `--rating: #f5c518`. Existing rules that use those exact values switch to the token; no value changes.

**File responsibilities.** Colour leaves orbit.css for theme.css; `.environment`, `.card-sub-orbit`, `.upnext-*`, `.sw-orbit` and the `var(--accent-text, #0b0b16)` fallbacks leave app.css for orbit.css/theme.css.

**Components.** `.icon-btn` (+ `.icon-btn-sm` 40, default 44, `.icon-btn-lg` 56) replaces `.btn-icon`, `.pbtn`, `.mbtn`, `.rbtn`, `.watchlist-btn`, `.orbit-tool` (old class names kept as aliases on the elements for one release so devtools selectors keep working; CSS targets the new one). `.range` replaces the six slider recipes. `.option-row` replaces `.menu-item`, `.sheet-item`, `.cast-device`, `.folder-item`, `.identify-option`, `.plex-server`, `.track-main`, `.queue-main` (selected state: Orbit white pill, classic accent edge). `.float-pill` (+ `.float-pill-cast`) for the mini-player and cast pills; the cast pill's shadow/glass moves to theme.css. item.js episode rows use `landscapeCard`. `spinner({ inline })` yields the ring for in-control busy states, the mark for pages. `emptyState()` is the only empty state (the library toast and the plain `<p>`s go). A `TOASTS` table in components.js names type + phrasing; call sites use it.

**Row actions and detail actions.** Settings profiles/users/libraries/servers and Lists rows: labelled ghost buttons (Edit, Delete as `ghost danger`) on wide classic layouts, `moreButton` under Orbit and on phones. `moreItems(item)` in item.js builds the full action list once (Refresh info, Fix match, Download, Edit intro, Cast to…, From the start, Add to playlist…); classic renders the first two inline and the rest in "…", Orbit all in "…".

**Polish.** Weights 650/750/850 → 600/700. Orbit type literals → `--t-*` (card-title → `--t-body`, menu/dialog titles → `--t-page`, picker h1 → `--t-display`…). Dead CSS removed: `.hero*` blocks, `.detail-backdrop*`, `.spinner-wrap .spinner`, the first `.nav-clock`, `--backdrop-*`, daylight's hero rule; icons bell/globe/palette removed, `cloud` added. `.btn-sm` 44 px tall in the player notice. `btn-secondary` styled as the default `.btn`.

**Guardrail.** Every browser suite green; older-theme screenshots byte-identical to the v0.14.0 baselines except where §3 names a change; Orbit re-baselined once after §3 and §4. `hardcoded.py` and `deadcss.py` re-run; before/after counts in the ledger (target: Orbit hex ≤ 20, white/ink literals 0, dead selectors 0).

**Deferred:** rounding every existing spacing value onto the scale; Arctic's `--focus/--halo` rename.

## Delivery

Two plans under this spec: plan A (§1 server, §2 video), plan B (§3, §4). Each plan ends with the fresh sonnet review and fix pass; delivery to the PC once at the end as v0.15.0 (package.json, README "Added in v0.15.0", ARCHITECTURE notes for the new jobs/tokens/`announce`). Not yet verified on real hardware stays in the project note: HDR tone mapping on a real HDR file and TV, nvenc/qsv IDR alignment, the libass warm-up time on Dallas's Windows ffmpeg, screen-reader behaviour with NVDA/VoiceOver.
