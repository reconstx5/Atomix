# Writing Atomix plugins

A plugin is a folder inside `plugins/` with two files:

```
plugins/
  my-plugin/
    plugin.json     manifest
    index.js        ES module exporting setup(api)
```

Restart Atomix (or use **Settings → Plugins → turn off/on**) to load it. Plugins run inside the server with
full access to the machine, so only install code you trust.

## plugin.json

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "description": "What it does, shown in Settings → Plugins.",
  "author": "You",
  "main": "index.js",
  "enabledByDefault": true,
  "settings": [
    { "key": "greeting", "label": "Greeting text", "type": "text", "default": "Hello" },
    { "key": "count", "label": "How many", "type": "number", "default": 10 },
    { "key": "loud", "label": "Shout it", "type": "boolean", "default": false },
    { "key": "mode", "label": "Mode", "type": "select", "default": "a",
      "options": [{ "value": "a", "label": "Option A" }, { "value": "b", "label": "Option B" }] },
    { "key": "token", "label": "API token", "type": "password", "default": "", "help": "Shown under the field." },
    { "key": "list", "label": "One per line", "type": "textarea", "default": "" }
  ],
  "actions": [{ "id": "test", "label": "Send a test message" }]
}
```

`id` must be lowercase letters, numbers and dashes. Settings get an auto-generated form in the UI; `help` adds a
hint under a field. `password` values are never sent back to the browser (it shows `••••••` instead), and saving the
form without retyping them keeps the stored value.

`actions` become buttons on the plugin's card in **Settings → Plugins** (admins only). Handle them with
`api.registerAction()` — see below.

## index.js

```js
export function setup(api) {
  api.log.info(`Hello, ${api.config.greeting}`);

  // Optional: return a function to clean up when the plugin is disabled.
  return () => api.log.info('Bye');
}
```

`setup` may be `async`.

## The `api` object

| Member | Description |
| --- | --- |
| `api.id`, `api.manifest`, `api.folder` | Plugin identity and location |
| `api.version`, `api.serverName` | The Atomix version, and the server name set in Settings |
| `api.config` | Current settings (defaults merged with saved values). Read it each time — it updates live. |
| `api.onConfigChange(fn)` | Called with the new config after an admin saves settings |
| `api.log.debug/info/warn/error(...)` | Logging, prefixed with the plugin id |
| `api.storage.get(key, fallback)` / `.set(key, value)` / `.delete(key)` / `.all()` | Small persistent JSON store (`data/plugin-data/<id>/storage.json`) |
| `api.dataDir` | A folder you can write files to |
| `api.fetch(url, init)` | The global `fetch` |
| `api.route(method, path, handler, { auth })` | Add an endpoint at `/api/plugins/<id><path>`. `auth`: `'user'` (default), `'admin'` or `'none'`. |
| `api.on(event, fn)` | Subscribe to server events (below) |
| `api.registerMetadataProvider(provider)` | Supply titles, plots, artwork, age ratings… |
| `api.registerHomeRow(row)` | Add a row to the home screen |
| `api.registerSource(source)` | Add a browsable content source under **Add-ons** |
| `api.registerSubtitleProvider(provider)` | Offer subtitles to search and download from the player |
| `api.registerAction(id, handler)` | Handle a button listed in `plugin.json` → `actions` |
| `api.subtitles.list(item)`, `.save(item, subtitle)` | Subtitles an item already has; save a downloaded one |
| `api.library.get(id)`, `.list(filters)`, `.recentlyAdded(opts)`, `.libraries(viewer)`, `.serialize(rows, viewer)`, `.canSee(viewer, item)` | Read the media library |
| `api.HttpError` | `throw new api.HttpError(404, 'Not found')` from handlers |

### Viewers (profiles and Kids limits)

Everything a person sees is filtered for a **viewer**: `{ userId, profileId, kids, maxAge, allowUnrated, libraryIds }`.
Route handlers get it as `ctx.viewer` (and the account and profile as `ctx.user` and `ctx.profile`); home rows
receive it as their argument. Pass it on to `api.library.list({ viewer, … })`, `.serialize(rows, viewer)` and
`.libraries(viewer)` so a Kids profile never sees titles above its age rating or libraries it isn't allowed. Use
`api.library.canSee(viewer, item)` before returning an item you fetched with `get()`.

### Routes

```js
api.route('GET', '/hello/:name', (ctx) => {
  // ctx.params, ctx.query, ctx.user, ctx.profile, ctx.viewer, await ctx.body() for JSON
  return { message: `Hi ${ctx.params.name}` }; // returned values are sent as JSON
});
```

Routes (other than `auth: 'none'`) need a chosen profile; admin routes are refused while a Kids profile is active.

Mutating requests from browsers must send `Content-Type: application/json`.

### Events

| Event | Payload |
| --- | --- |
| `server:ready` | `{ port }` |
| `scan:start` | `{ library }` |
| `scan:complete` | `{ library, added, removed, firstScan }` |
| `item:added` | `{ item, library, firstScan }` — each new movie, episode or song after a scan. `firstScan` is true while a brand-new library is filling up (the alerts plugin skips those). |
| `metadata:updated` | `{ item }` |
| `playback:start` | `{ session, user, item }` |
| `playback:progress` | `{ user, viewer, item, position, watched }` — also sent when a song finishes (good for scrobblers) |
| `playback:stop` | `{ session, reason }` |
| `user:login` | `{ user }` |

A failing handler is logged and never breaks the server.

### Metadata providers

```js
api.registerMetadataProvider({
  id: 'my-meta',
  name: 'My metadata',
  priority: 20,                          // lower runs first; local artwork 5, NFO 10, TMDB 50
  kinds: ['movie', 'show', 'episode'],   // also 'season', 'album', 'artist'
  async fetch(item, ctx) {
    // item: DB row (title, year, path, season, episode, tmdb_id…)
    // ctx.merged: fields found so far by earlier providers; ctx.show: the show row for seasons/episodes
    return {
      title, originalTitle, year, overview, tagline, genres: ['Drama'], rating: 7.4, runtime: 102,
      airDate: '2020-05-01', tmdbId: 123, imdbId: 'tt0123456',
      certification: 'NZ:R16',           // "COUNTRY:LABEL", or just "PG-13"; used for Kids profiles
      poster: 'https://…/poster.jpg',    // or an absolute local file path
      backdrop: 'https://…/fanart.jpg',
    }; // return null (or omit fields) for anything you don't know
  },
});
```

Earlier providers win; later ones only fill gaps. Returning a `tmdbId` lets the TMDB provider fetch the exact match.

### Home rows

```js
api.registerHomeRow({
  id: 'favourites',
  title: 'Family favourites',   // may be a getter
  style: 'poster',              // 'landscape' or 'square' (albums)
  position: 40,                 // plugin rows are sorted by this
  items(viewer) {
    // Return DB rows from api.library.list(...) — or plain cards:
    // { id, title, poster, subtitle, href: '#/item/42' }
    return api.library.list({ viewer, kind: 'movie', genre: 'Family', sort: 'rating', limit: 20 });
  },
});
```

Rows are filtered with `canSee()` afterwards as a safety net, and plain cards (which can't be age-checked) are left
out for Kids profiles.

`api.library.list()` filters: `viewer`, `libraryId`, `kind` (string or array: `movie`, `show`, `season`, `episode`,
`artist`, `album`, `track`), `parentId`, `showId`, `genre`, `unwatched`, `search`,
`sort` (`title`, `added`, `year`, `rating`, `random`, `episode`, `track`), `limit`, `offset`.
For music, a track's `parent_id` is its album and `show_id` its album artist; `season`/`episode` hold the disc and
track numbers and `artist` the song's own artist.

### Subtitle providers

```js
api.registerSubtitleProvider({
  id: 'my-subs',
  name: 'My subtitle site',
  async search(item, ctx) {
    // item: the movie/episode row; ctx.languages: ['en', 'mi'] (may be empty); ctx.show for episodes
    return [{ id: '123', language: 'en', label: 'Show.S01E01.WEB', downloads: 5400, hearingImpaired: false, hashMatch: true }];
  },
  async download(item, id, ctx) {
    return { content: '1\n00:00:01,000 --> 00:00:03,000\nKia ora\n', format: 'srt', language: 'en', label: 'English' };
  },
});
```

Results from every provider are merged in the player's **Find subtitles online…** panel (exact file-hash matches
first). Downloads are kept in `data/subtitles/<item id>/` in their own format and converted to WebVTT when played. To fetch subtitles yourself
(for example for every new title), call `api.subtitles.save(item, { content, format, language, label })`.
`plugins/opensubtitles` is a complete example, including the OpenSubtitles "moviehash".

### Actions (buttons in Settings)

```js
api.registerAction('test', async (ctx) => {
  // ctx.user is the admin who pressed it
  await sendSomething();
  return { message: 'Sent!' }; // shown to the admin; throw an HttpError to show an error instead
});
```

### Sources (Kodi-style add-ons)

```js
api.registerSource({
  id: 'streams',
  name: 'My streams',
  description: 'Shown on the Add-ons page',
  icon: 'tv',              // archive | film | tv | folder | sparkle
  searchable: true,        // shows a search box; the query arrives as ctx.query.q
  async browse(path, ctx) {
    if (!path) {
      return { title: 'My streams', items: [
        { id: 'news', path: 'news', kind: 'folder', title: 'News', poster: 'https://…' },
      ] };
    }
    return {
      title: 'News',
      items: [{ id: 'clip-1', kind: 'video', title: 'Morning bulletin', poster: 'https://…', overview: '…' }],
      next: null,           // or a path for the "Load more" button
    };
  },
  async resolve(id, ctx) {
    return { url: 'https://example.com/clip-1.mp4', title: 'Morning bulletin', duration: 600 };
  },
});
```

`resolve()` must return a URL the browser can play directly (MP4/WebM/HLS on Safari). See
`plugins/internet-archive` for a complete example.

## Tips

- Keep network calls cached (see the Internet Archive plugin) and time-limited (`AbortSignal.timeout`).
- Use `api.log.debug` generously and run with `ATOMIX_LOG_LEVEL=debug`.
- Saving a plugin file doesn't reload it — toggle it off and on in Settings, or restart.
