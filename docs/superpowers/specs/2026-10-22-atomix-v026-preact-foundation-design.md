# Atomix Round 28 — v0.26.0: Preact without a build step (the foundation and three pilot screens)

Approved in conversation with Dallas on 22 Oct 2026, section by section ("looks good" to each of the three).

## Intent

Dallas: "I am thinking of having this project built on a framework so it is more app based."

He chose:
- **Not sure what "app based" means:** asked for a recommendation.
- **The main reason:** "I want it easier to build on."
- **The approach:** "Preact, no build".

Understanding:
- Atomix stays the same product: a self-hosted server and a web app, which can still be installed.
- The goal is code that other people (or Dallas) can pick up and extend using a well-known component model (React's, through Preact).
- Orbit and the older themes keep their look.
- The move is gradual: the app works at every step, and each screen moves over on its own.
- Live TV on phones (including encrypted channels) is a separate track. It is not part of this round.

Success:
- The three pilot screens are Preact components that look and behave exactly as they do in v0.25.0. Their existing browser checks pass.
- A contributor can follow CONTRIBUTING.md to write a new screen.
- There is still no `npm install` and no build step.

## Global constraints

- **The dependency rule changes from "zero dependencies" to "no npm install, no build step".** Two MIT libraries, **Preact** (with `preact/hooks`) and **htm**, are kept in the repo. Nothing else is added.
  - They are pinned to exact versions and stored in `public/js/vendor/`, with their licences and a recorded checksum.
  - ARCHITECTURE.md states the rule so it doesn't creep.
- **Imports:**
  - The kept files are rewritten once, by the update script, so that their own imports are relative paths (htm's Preact entry imports `./preact.module.js`, not `preact`).
  - Atomix's files import them by path (`../vendor/htm-preact.module.js`).
  - **No import map is used**, so browsers without import maps (older webOS/Tizen TV browsers) are unaffected.
  - Ruling against Section 3, which offered an import map with a fallback: plain paths need no fallback. Cost if wrong: longer import lines.
- Node ≥ 22.13 on the server; the server is unchanged except for serving the new files (already static).
- **Older themes stay pixel-identical:** `node /home/claude/devtools/oldthemes-compare.mjs compare` → "all pages match".
- **Unchanged:** remote and keyboard navigation (`nav.js`), the CSS and theme classes, the server and its API, the pure rule files, the engines (`dash/`, `reader/`, `offline/`, the service worker), and the Kids rules.
- **No new features this round:** the pilot screens keep every behaviour, sentence and accessible name.

## 1. The foundation

- **`public/js/vendor/`:**
  - `preact.module.js`, `hooks.module.js` and `htm-preact.module.js` (htm bound to Preact);
  - `LICENSES.md`;
  - `checksums.json` (sha256 of each file).
- **`/home/claude/devtools/vendor-update.mjs <preact version> <htm version>`:** fetches the published ES module builds, rewrites their bare imports to relative paths, writes the checksums and prints the sizes. This is a devtools script; it is not shipped.
- **`public/js/ui.js`:** the one place components import from. It re-exports `html`, `render`, the hooks Atomix uses (`useState`, `useEffect`, `useRef`, `useMemo`, `useCallback`, `useLayoutEffect`) and Atomix's own hooks.
- **The router adapter** (in `app.js`'s view mounting):
  - A view module may export `render(el, params, query)`, as today. It may instead export `Screen`, a component taking `{ params, query }`.
  - For `Screen`, the router renders it into the view element and, on leave, unmounts it with `render(null, el)`, which runs every effect cleanup.
  - A component's own `useEffect` cleanups replace the old returned cleanup function.
  - Both kinds can coexist in any order.
- **`useAppState(select)`:**
  - subscribes to the existing `state` in `app.js` (profile, user, status, prefs) through a small change event that `app.js` dispatches where those values change today;
  - returns `select(state)`;
  - re-renders only when the selected value changes (`Object.is`).
- **Building blocks** (`public/js/ui/`): `Button`, `PosterCard`, `Grid`, `Sheet` (it opens today's `openSheet`), `EmptyState`, `Spotlight`, `Toast` (calls today's `toast`), `MoreButton` and the live-page pieces (`ChannelCard`, `LiveSpotlight`, `AzRail`).
  - Each draws **the same elements, classes, attributes and text** as today's helper for the same inputs.
  - Today's helpers stay for the screens not yet converted. They are removed when their last user moves.
  - `cardItems` (the WeakMap the backdrop and spotlight use) keeps working: the card components register their element in it.
- **Focus with the remote:**
  - Components keep a focused element's identity across redraws, using Preact's keyed lists (`key=` the item id).
  - Where today's code restores focus by id after a rebuild, the component does the same in a layout effect.

## 2. What moves this round

- **Live TV** (`views/live.js` + `live-spot.js`): the channel page in every theme (the older themes' rows too, keeping their markup), the Orbit wall and spotlight, the chips, typed channel numbers, the periodic reload, favourites, Record and Cast.
- **Movies and TV Shows, and the other library pages** (`views/library.js`): the whole view, because one module serves every library type.
  - The Orbit shelf (spotlight, bar, sheets, rail), the older themes' toolbar, music's Albums/Artists/Songs tabs, podcasts' New episodes, Collections, Shuffle all, Subscribe and Check now.
  - The subscribe dialog may stay as a call to `openDialog`.
- **Search** (`views/search.js`): recents, tiles, suggestions, results, genre and library tiles; also `views/genre.js` and `views/person.js`, which share its pieces.
- **Done for each screen:**
  - it is a `Screen` component;
  - its old hand-built DOM is gone, except deliberate calls into engines and dialogs;
  - its browser checks pass;
  - the older themes match.
- **Later rounds** (not this one), in this order:
  1. Home, the title page and lists;
  2. Guide and Recordings;
  3. music, podcasts and audiobooks;
  4. books and comics;
  5. Settings (split into smaller components);
  6. the player and the music engine.
- **CONTRIBUTING.md**, a new "How to write an Atomix screen" section:
  - a 30-line example screen using `html`, `useAppState` and two building blocks;
  - the `Screen` export;
  - keys for lists;
  - how the remote finds focus;
  - adding a check to a `devtools/vNNN-ui.mjs`.

## Verification

- **Node tests:** `vendor/checksums.json` matches the files, and the kept files import nothing by bare name (`from 'preact'`).
  - The DOM-dependent checks live in the browser instead, because the test setup has no DOM in Node and adding a fake one would be a new dependency.
- **Browser, new `v026-ui.mjs blocks`:**
  - the adapter mounts both kinds of screen and runs a component's effect cleanups on leave;
  - `useAppState` re-renders on a profile/theme change and not on an unrelated one;
  - each building block's `outerHTML` equals today's helper's for the same inputs, rendered side by side in the page.
- **Browser:**
  - `v025-ui.mjs` (live, livefix, library, libfix) all pass unchanged;
  - so do `v024-ui.mjs` search, `live-ui.mjs`, `a11y-ui.mjs`, `lists-ui.mjs` (Collections), `music-ui.mjs`, `v022-ui.mjs` (podcasts, books libraries), `orbit-sizes.mjs` and `settings-check`;
  - a check written for old markup gets a ledgered ruling, with no change in what it checks.
- **New `devtools/v026-ui.mjs`:**
  - entering and leaving each pilot screen 20 times leaves no extra document/window listeners and no timers (counted by wrapping `addEventListener`/`setTimeout` in an init script);
  - focus is kept across a Live TV reload, a library filter change and a favourite;
  - no console errors at 1920×1080, 1280×720, 1024×768, 820×1180 and 400×860;
  - the network log shows only the three vendor files added to a v0.25.0 page load.
- **Speed:** time to the first card on Live TV and Movies at 1920×1080 (median of 5 cold loads) is no slower than v0.25.0 + 10%, measured the same way on both (v0.25.0 served from a before copy, as in Round 27). The vendor size is recorded.
- `oldthemes-compare`: "all pages match".
- **Pictures (`v026-shots.mjs`):** the pilot screens before and after. They should be the same.
- A fresh review and one fix pass per plan. PC delivery hash-checked against v0.25.0, then the PC tests.

**Not yet verified (listed in build status):** old TV browsers running Preact (ES2017 modules are enough for Preact 10; real webOS/Tizen untested); a contributor actually following CONTRIBUTING.md.

## Plans

- **A:** the foundation (vendor files, the update script, `ui.js`, the adapter, `useAppState`, building blocks with their tests, CONTRIBUTING.md).
- **B:** the three pilot screens, `v026-ui.mjs`, the speed check and v0.26.0.

Native (inline) execution, as before.
