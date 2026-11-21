# Contributing to Atomix

Atomix runs with no `npm install` and no build step: Node.js ≥ 22.13 and ffmpeg on the server, plain ES modules in the browser. Start it with `npm start` (or `start-windows.bat`) and open http://localhost:8787.

- Tests: `npm test` (Node's own test runner).
- Docs: how the pieces fit together is in `docs/ARCHITECTURE.md`; themes are in `docs/THEMES.md`, plugins in `docs/PLUGINS.md`.

## How to write an Atomix screen

Since v0.26 new screens are **Preact** components, written with **htm** tagged templates (`` html`…` `` instead of JSX), so no compiler is needed. Both libraries are kept in `public/js/vendor/`. Import from `public/js/ui.js`, never from the vendor files directly.

### A screen

A view module exports `Screen`, a component that receives `{ params, query, data, view }` from its route (`view` is the page's own element, for page-wide classes such as `is-compact`). It can also export `load(params, query)`:
- the router waits for it, then draws the `Screen` with what it returned as `data`;
- the page's name is announced, the remote's first focus placed and the page scrolled only once the content is there;
- a `load` that fails shows the app's usual "Something went wrong" or "Nothing here" page (an API 404).

```js
// public/js/views/recent.js
import { html, useAppState } from '../ui.js';
import { Grid } from '../ui/cards.js';
import { EmptyState } from '../ui/basics.js';
import { api } from '../api.js';
import { setTitle } from '../app.js';

export async function load(params) {
  setTitle('Recently added'); // before the page is announced
  return (await api.get(`/api/libraries/${params.id}/items?sort=added&limit=24`)).items;
}

export function Screen({ data: items }) {
  const name = useAppState((s) => s.profile?.name); // re-renders when the profile changes
  return html`
    <header class="page-head"><h1>New for ${name}</h1></header>
    ${items.length ? html`<${Grid} items=${items} />` : html`<${EmptyState} title="Nothing here yet" />`}
  `;
}
```

Later changes (a filter, a refresh) live in the component's own state and effects. Effects' cleanups run when the page is left.

**Anything outside your screen** (a `window` key listener, a document scroll listener, a class on `view` or `body`) goes in `useLayoutEffect`: its cleanup runs as the page is left, while a `useEffect` cleanup runs a frame later, after the next page has started.

A screen whose data takes several requests can keep `load()` in a module of its own (`views/live-data.js` is one) and re-export it from the screen; naming that module in the route (`data: lazyData('views/live-data.js')`) lets the router start fetching while the screen's code is still arriving.

Add its route to the `routes` list in `public/js/app.js`:

```js
{ pattern: /^\/recent\/(\d+)$/, keys: ['id'], view: lazyView('views/recent.js') },
```

The smallest real screen is `public/js/views/genre.js`; Live TV (`views/live.js`), the libraries (`views/library.js`), the title page (`views/item.js`, with `item-show.js` and `item-music.js`), the Live TV guide (`views/guide.js`, its keyboard rules in `guide-rules.js`) and Now Playing (`views/nowplaying.js`, its rules in `nowplaying-rules.js`) are the larger ones. The song rows (`TrackList`) and the queue dialog's list (`QueueList`) live in `ui/music.js`; the music engine (`music.js`) stays plain code and exposes `music.started` and the song's state to them. The title page also shows how to hand a kind of page to an older module that hasn't moved yet: `load()` renders it into a detached element and the screen adopts its nodes.

Older screens still export `render(el, params, query)`. The router mounts both kinds, so a screen can move over on its own.

### Building blocks

`public/js/ui/` has the pieces most screens need:

- `Button`, `Icon`, `EmptyState`, `MoreButton` and `Spinner` (`basics.js`);
- `PosterCard`, `SquareCard`, `LandscapeCard`, `LiveCard`, `Grid` and `Row` (`cards.js`); `Row`'s `card(item, i)` draws one card differently (return a vnode; `undefined` keeps the usual card), as the title page does for the film you're on in its collection;
- `MediaChips`, `DetailMeta`, `TitleArt`, `Genres`, `WatchlistButton`, `DownloadButton` and `RatingControl` (`detail.js`), the title page's pieces;
- `Spotlight` and `MetaLine` (`spotlight.js`);
- `Island` (`basics.js`): an element whose children come from older DOM-building code (an older helper's cards, say) until that code becomes a component. Preact leaves those children alone.

Each draws exactly what the older helper in `components.js` draws, so the themes style it the same way. Dialogs, sheets and toasts stay plain function calls: `openDialog`, `openSheet` and `toast` from `components.js`.

### Lists and focus with a remote

- **Give list items a key** (`key=${item.id}`). Preact then keeps each element when the list redraws, so the remote's focus stays on the same card.
- **Spatial navigation (`nav.js`) works on whatever is on the page.** Arrow keys move to the nearest focusable element, so use real buttons and links.
  - `data-autofocus` marks the control that should get focus first.
  - `data-focus-now` marks one that must be focused and scrolled into view when the page opens (a deep link). The
    router does it, also behind the splash (it waits until the page is no longer inert) and never after the person has
    moved the focus themselves (`focus-now-rules.js`).
- **State that comes from the server** (the profile, the theme, the server's status) comes through `useAppState((s) => …)`. Don't keep your own copy.

### Looks

- Use the existing classes (`page-head`, `card`, `btn`…) and theme tokens; colours live in each theme's `theme.css`, layout in `public/css/`.
- **Anything Orbit-only goes under `body[data-layout="orbit"]` or `themes/orbit/theme.css`:** the older themes must stay pixel-identical.

### Checks

- Pure rules (no page) go in their own module with a Node test in `test/`.
- Browser behaviour is checked with the maintainers' Playwright scripts (`vNNN-ui.mjs`, kept outside this repo). They cover the remote, sizes from 400 px phones to 1080p TVs, contrast, screen-reader names and no console errors; describe what a change should be checked for in its pull request.
- The older themes are compared pixel by pixel before and after a change.

### The libraries

The only libraries are Preact and htm, kept in `public/js/vendor/` with `LICENSES.md` and `checksums.json`. Update them with `node scripts/vendor-update.mjs <preact> <htm>` (it needs the system `tar`); that script rewrites their imports to relative paths. Adding any other library means changing the rule in `docs/ARCHITECTURE.md` first.
