// Atomix web client: app shell, routing, theming and session handling.
import { api, setUnauthorizedHandler, setProfileRequiredHandler } from './api.js';
import { h, icon, clear, logoMark } from './dom.js';
import { initNavigation, focusFirst, isKeyboardMode, configureNavigation, openMenu } from './nav.js';
import { toast, spinner, avatar, announce, ensureLiveRegions } from './components.js';
import { music, miniPlayer } from './music.js';
import { castPill, setCastProfile } from './cast.js';
import { backdropLayer, environmentLayer, repaintEnvironment, routeStart, routeEnd } from './backdrop.js';
import { renderOrbitNav, libraryIcon } from './shell.js';
import { FRAME_QUERY, homeBack, pillShown } from './orbit-rules.js';
import { readNote, writeNote, clearNote, gateDecision, startGate, stopGate, rememberReturn, takeReturn, forgetReturn } from './gate.js';
import { showSplash, endSplash, pageReady } from './splash.js';
import { readableAccent, accentInk } from './tint.js';
import { registerWorker } from './offline/install.js';
import { downloads } from './offline/downloader.js';
import { canDownloadHere } from './offline/ui.js';
import { sync, keepSnapshot, readSnapshot, forgetSnapshot } from './offline/sync.js';
import { watchState, notifyState } from './state-events.js';
import { mountView } from './screen.js';

export const state = watchState({
  status: null,
  user: null,
  profile: null, // who's watching
  offline: false, // v0.21: the server can't be reached; only Downloads works
  lastPrefs: null, // the last profile's prefs, for the look while the picker shows
  pickerFor: null, // the profile that was on when the picker came back (anyone else starts at Home)
  playingItemHash: null, // the page to return to from the player
  libraries: [],
  themes: [],
  live: null, // { enabled, sources } for this profile (Live TV menu entry)
}); // v0.26: watched, so Preact components (useAppState in ui.js) re-render when what they read changes

export const isKidsProfile = () => Boolean(state.profile?.kids);
export const canAdmin = () => state.user?.role === 'admin' && !isKidsProfile();
export const addonsAllowed = () => !isKidsProfile() || Boolean(state.profile?.allowUnrated);
/** Live TV shows once a source has channels this profile may see (Kids: only ticked groups). */
export const liveAllowed = () => state.live?.enabled === true;
/** The page uses the Orbit layout (full-screen page, floating menu). */
export const isOrbit = () => document.body.dataset.layout === 'orbit';
/** "Who's watching?" is needed when there is more than one profile or the only one has a PIN. */
const needsPicker = () => Boolean(state.status?.profileRequired) || state.status?.profileCount > 1 || Boolean(state.status?.profilePinned);
/** Video or music playing right now, asked of the elements themselves (a seek swaps the video's src mid-play). */
const mediaPlaying = () => [...document.querySelectorAll('video, audio')].some((m) => !m.paused && !m.ended && m.readyState > 0);
/** Watch for idle time with the current setting; before asking again, the gate re-reads the server's status. */
function watchIdle() {
  startGate({
    idleMinutes: state.status?.pickerIdleMinutes ?? 30,
    needsPicker: needsPicker(),
    onPicker: askWhoIsWatching,
    isMediaPlaying: mediaPlaying,
    onRefresh: async () => {
      state.status = await api.get('/api/status');
      return { idleMinutes: state.status.pickerIdleMinutes, needsPicker: needsPicker() };
    },
  });
}

/** The picker comes back (after idle time): remember where we were, drop the client's profile, render. */
function askWhoIsWatching() {
  if (!state.user || !state.profile) return;
  for (const d of document.querySelectorAll('dialog[open]')) d.close('cancel');
  const { path } = parseHash();
  // From a player, go back to the title's (or the add-on's) page rather than restarting the video.
  const back = /^\/play(-source)?\//.test(path) ? state.playingItemHash || '#/' : location.hash || '#/';
  rememberReturn(back, state.profile.id);
  state.pickerFor = state.profile.id;
  state.lastPrefs = state.profile.prefs || null;
  state.profile = null;
  // No note while the picker shows: a reload must ask again too (the server session still has the profile).
  clearNote();
  stopGate();
  setPlayersProfile(null);
  render();
}

/** Music and casting both follow who's watching. */
function setPlayersProfile(profile) {
  music.setProfile(profile);
  setCastProfile(profile);
  downloads.setProfile(profile, state.status?.downloads); // v0.21: each profile's own downloads
  // Online: what was watched offline goes to the server and the server checks this profile's downloads.
  if (profile && !state.offline) sync.run();
}

// ---- Offline (v0.21) ----
/** An answer from Atomix itself, not a Wi-Fi sign-in page or a proxy's page standing in for it. */
const isAtomixStatus = (st) => Boolean(st) && typeof st === 'object' && typeof st.version === 'string';
// Where the app may go with no connection: the downloads, playing them, "Who's watching?" and Now Playing.
const OFFLINE_PATHS = [/^\/downloads$/, /^\/profiles$/, /^\/now-playing$/];
const offlineAllowed = (path, query) => OFFLINE_PATHS.some((r) => r.test(path)) || (/^\/play\/\d+$/.test(path) && query.offline != null);
const OFFLINE_REASON = "You're offline — only your downloads work until Atomix is back";

/** The menu offline: Downloads (and switching profile) work; the rest is disabled with the reason. */
function disableForOffline() {
  for (const a of navEl.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (href === '#/downloads' || href === '#/profiles') continue;
    a.setAttribute('aria-disabled', 'true');
    a.title = OFFLINE_REASON;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      toast(OFFLINE_REASON);
    });
  }
}

/** The server can't be reached: open from the device when it has someone's downloads. */
async function offlineBoot() {
  const snap = readSnapshot();
  if (!snap?.user || !('serviceWorker' in navigator)) return false;
  let has = false;
  try {
    const { openStore } = await import('./offline/store.js');
    has = (await (await openStore()).all()).length > 0;
  } catch {
    has = false;
  }
  if (!has) return false;
  state.offline = true;
  state.status = { serverName: snap.serverName, defaultTheme: snap.defaultTheme, downloads: snap.downloads, user: snap.user, offline: true };
  state.themes = snap.themes || [];
  state.user = snap.user;
  state.profile = null;
  state.libraries = [];
  sync.offlineDays = snap.downloads?.offlineDays;
  applyTheme();
  setTitle();
  document.body.classList.add('signed-in');
  renderNav();
  if (!location.hash.startsWith('#/downloads')) history.replaceState(null, '', '#/downloads');
  window.addEventListener('hashchange', render);
  watchForServer();
  await render();
  return true;
}

/** Back online (the browser says so, or a status probe every 30 s answers): the normal open, once nothing plays. */
function watchForServer() {
  let busy = false;
  const probe = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await fetch('/api/status', { credentials: 'same-origin', cache: 'no-store' });
      if (r.ok && isAtomixStatus(await r.json().catch(() => null))) {
        if (mediaPlaying()) return; // never mid-film: the next probe tries again
        location.reload();
      }
    } catch {
      /* still offline */
    } finally {
      busy = false;
    }
  };
  window.addEventListener('online', probe);
  setInterval(probe, 30000);
}

// v0.24: a view's own scripts are fetched together when it opens (the page carries each view's module graph).
const preloaded = new Set();
let moduleGraph = null;
function preloadModules(path) {
  if (!moduleGraph) {
    try {
      moduleGraph = JSON.parse(document.getElementById('module-graph')?.textContent || '{}');
    } catch {
      moduleGraph = {};
    }
  }
  for (const m of moduleGraph[path] || []) {
    if (preloaded.has(m)) continue;
    preloaded.add(m);
    if (document.querySelector(`link[rel="modulepreload"][href="${m}"]`)) continue;
    document.head.append(h('link', { rel: 'modulepreload', href: m }));
  }
}
const lazyView = (file) => () => {
  preloadModules(`/js/${file}`);
  return import(`./${file}`);
};
// v0.26: a Screen's data module (its load(), without Preact), started as the route opens.
const lazyData = (file) => (params, query) => {
  preloadModules(`/js/${file}`);
  return import(`./${file}`).then((m) => m.load(params, query));
};

/** The data starter of the route for `path` (tests: devtools/v026-ui.mjs), or undefined. */
export const routeData = (path) => routes.find((r) => r.pattern.test(path))?.data;

const routes = [
  { pattern: /^\/?$/, view: lazyView('views/home.js'), nav: 'home' },
  { pattern: /^\/library\/(\d+)$/, keys: ['id'], view: lazyView('views/library.js'), data: lazyData('views/library-data.js'), nav: (p) => `lib-${p.id}` },
  { pattern: /^\/item\/(\d+)$/, keys: ['id'], view: lazyView('views/item.js') },
  { pattern: /^\/play\/(\d+)$/, keys: ['id'], view: lazyView('views/player.js'), fullscreen: true },
  { pattern: /^\/play-source\/([\w-]+)\/([\w-]+)$/, keys: ['plugin', 'source'], view: lazyView('views/player.js'), fullscreen: true },
  { pattern: /^\/trailer\/(\d+)$/, keys: ['id'], view: lazyView('views/trailer.js'), fullscreen: true },
  { pattern: /^\/read\/(\d+)$/, keys: ['id'], view: lazyView('views/reader.js'), fullscreen: true, keepMusic: true },
  { pattern: /^\/live$/, view: lazyView('views/live.js'), data: lazyData('views/live-data.js'), nav: 'live' },
  { pattern: /^\/live\/guide$/, view: lazyView('views/guide.js'), nav: 'live' },
  { pattern: /^\/live\/recordings$/, view: lazyView('views/recordings.js'), nav: 'live' },
  { pattern: /^\/live\/play\/(\d+)$/, keys: ['live'], view: lazyView('views/player.js'), fullscreen: true },
  { pattern: /^\/live\/catchup\/(\d+)$/, keys: ['catchup'], view: lazyView('views/player.js'), fullscreen: true },
  { pattern: /^\/now-playing$/, view: lazyView('views/nowplaying.js') },
  { pattern: /^\/cast$/, view: lazyView('views/remote.js') },
  { pattern: /^\/lists$/, view: lazyView('views/lists.js'), nav: 'lists' },
  { pattern: /^\/together\/([A-Za-z0-9]{6})$/, keys: ['code'], view: lazyView('views/together.js') },
  { pattern: /^\/lists\/smart\/new$/, view: lazyView('views/smartlist.js'), nav: 'lists' },
  { pattern: /^\/lists\/(\d+)\/rules$/, keys: ['id'], view: lazyView('views/smartlist.js'), nav: 'lists' },
  { pattern: /^\/lists\/(\d+)$/, keys: ['id'], view: lazyView('views/lists.js'), nav: 'lists' },
  { pattern: /^\/collections\/(\d+)$/, keys: ['id'], view: lazyView('views/lists.js') },
  { pattern: /^\/downloads$/, view: lazyView('views/downloads.js'), nav: 'downloads' },
  { pattern: /^\/arrange-home$/, view: lazyView('views/arrange-home.js'), nav: 'home' },
  { pattern: /^\/search$/, view: lazyView('views/search.js'), nav: 'search' },
  { pattern: /^\/genre\/([^/]+)$/, keys: ['name'], view: lazyView('views/genre.js'), nav: 'search' }, // v0.24
  { pattern: /^\/person\/([^/]+)$/, keys: ['name'], view: lazyView('views/person.js'), nav: 'search' },
  { pattern: /^\/addons$/, view: lazyView('views/addons.js'), nav: 'addons' },
  { pattern: /^\/addons\/([\w-]+)\/([\w-]+)$/, keys: ['plugin', 'source'], view: lazyView('views/addons.js'), nav: 'addons' },
  { pattern: /^\/settings(?:\/([\w-]+))?$/, keys: ['tab'], view: lazyView('views/settings.js'), nav: 'settings' },
  { pattern: /^\/profiles$/, view: lazyView('views/profiles.js'), picker: true },
];

let main;
let navEl;
let cleanup = null;
let renderToken = 0;

// ---- Theming ----
let themeLoad = Promise.resolve();
const THEME_WAIT_MS = 600;
/** Resolves once the last theme stylesheet applyTheme() asked for has arrived (or after a short cap). */
export const themeReady = () => themeLoad;

export function applyTheme() {
  notifyState('prefs'); // the prefs may have changed inside the profile, which the state wrapper can't see
  // While "Who's watching?" shows (the client has no profile, the server still does), keep the last
  // profile's look rather than jumping to the default: the splash and the picker stay in their colours.
  const prefs = state.profile?.prefs || (state.user && state.lastPrefs) || {};
  const themeId = prefs.theme || state.status?.defaultTheme || 'orbit';
  const theme = state.themes.find((t) => t.id === themeId) || state.themes.find((t) => t.id === 'orbit') || state.themes[0];
  const link = document.getElementById('theme-css');
  if (theme && link.getAttribute('href') !== theme.css) {
    link.setAttribute('href', theme.css);
    // The splash waits for this (capped), so an uncached load doesn't flash the previous theme's colours.
    themeLoad = new Promise((resolve) => {
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, THEME_WAIT_MS);
    });
  }
  const layout = theme?.layout || 'top';
  const layoutChanged = document.body.dataset.layout !== layout;
  document.body.dataset.layout = layout;
  document.documentElement.dataset.layout = layout;
  document.documentElement.style.colorScheme = theme?.colorScheme || 'dark';
  const root = document.documentElement.style;
  // A chosen colour is also used as text (labels, the playing song): on a dark theme it's lifted first if it's too
  // dark to read; a light theme keeps the colour as chosen (dark reads fine there).
  const light = theme?.colorScheme === 'light';
  const accent = prefs.accent ? (light ? prefs.accent : readableAccent(prefs.accent)) : null;
  if (accent) root.setProperty('--accent', accent);
  else root.removeProperty('--accent');
  // Arctic takes its colour from the artwork; a chosen accent is the light for pages without any.
  if (accent) root.setProperty('--tint-default', accent);
  else root.removeProperty('--tint-default');
  if (accent) root.setProperty('--accent-text', accentInk(accent));
  else root.removeProperty('--accent-text');
  root.setProperty('--subtitle-scale', String(prefs.subtitleSize || 1));
  document.documentElement.classList.toggle('reduce-motion', Boolean(prefs.reduceMotion));
  document.documentElement.classList.toggle('reduce-effects', Boolean(prefs.reduceEffects));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && theme?.preview?.background) meta.setAttribute('content', theme.preview.background);
  // Orbit and the older layouts build different menus.
  if (layoutChanged && navEl) {
    renderNav();
    repaintEnvironment();
  }
}


// ---- Shell ----
// A clock in the corner, as on a TV media centre.
const clockTime = h('span', { class: 'nav-clock-time' });
const clockDate = h('span', { class: 'nav-clock-date' });
const clockEl = h('time', { class: 'nav-clock' }, clockTime, clockDate);
function tick() {
  const now = new Date();
  clockTime.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  clockDate.textContent = now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  clockEl.setAttribute('datetime', now.toISOString());
}
tick();
setInterval(tick, 15000);

function navLink(id, href, label, iconName) {
  return h('a', { class: 'nav-link', href, dataset: { nav: id } }, icon(iconName, { size: 20 }), h('span', { class: 'nav-label' }, label));
}

export function renderNav() {
  if (isOrbit()) {
    renderOrbitNav(navEl, {
      serverName: state.status?.serverName || 'Atomix',
      libraries: state.libraries,
      profile: state.profile,
      addons: addonsAllowed(),
      live: liveAllowed(),
      downloads: canDownloadHere() || state.offline, // v0.21 (older themes reach it from Settings → Profile)
      settingsLabel: canAdmin() ? 'Settings' : 'Profile',
      clock: clockEl,
    });
    if (state.offline) disableForOffline();
    configureNavigation({ menu: navEl.querySelector('.orbit-menu'), rowAlign: 'start' });
    highlightNav();
    return;
  }
  configureNavigation();
  clear(navEl);
  const libs = state.libraries.map((l) => navLink(`lib-${l.id}`, `#/library/${l.id}`, l.name, libraryIcon(l.type)));
  navEl.append(
    h('a', { class: 'brand', href: '#/', 'aria-label': `${state.status?.serverName || 'Atomix'} home` }, logoMark(30), h('span', { class: 'brand-name' }, state.status?.serverName || 'Atomix')),
    h(
      'ul',
      { class: 'nav-links', role: 'list' },
      [navLink('home', '#/', 'Home', 'home'), ...libs, navLink('lists', '#/lists', 'Lists', 'list'), liveAllowed() ? navLink('live', '#/live', 'Live TV', 'live') : null, addonsAllowed() ? navLink('addons', '#/addons', 'Add-ons', 'addons') : null, state.offline ? navLink('downloads', '#/downloads', 'Downloads', 'download') : null].filter(Boolean).map((a) => h('li', {}, a)),
    ),
    h(
      'ul',
      { class: 'nav-tools', role: 'list' },
      h('li', {}, navLink('search', '#/search', 'Search', 'search')),
      h('li', {}, navLink('settings', '#/settings', canAdmin() ? 'Settings' : 'Profile', 'settings')),
      state.profile
        ? h(
            'li',
            {},
            h(
              'a',
              { class: 'nav-link nav-profile', href: '#/profiles', title: `Watching as ${state.profile.name} — switch profile`, 'aria-label': `Switch profile (now ${state.profile.name})` },
              avatar(state.profile, 28),
              h('span', { class: 'nav-label' }, state.profile.name),
            ),
          )
        : null,
      h('li', { class: 'nav-clock-item' }, clockEl),
    ),
  );
  if (state.offline) disableForOffline();
  highlightNav();
}

let currentNav = null;
function highlightNav() {
  for (const a of navEl.querySelectorAll('.nav-link')) {
    if (a.dataset.nav && a.dataset.nav === currentNav) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  // Orbit's phone dock: a page that is only in More (Lists, a fourth library) marks More instead, for the eye and
  // for screen readers (the entry itself is hidden in the dock). The framed rail hides More, so it never shows there.
  const more = navEl.querySelector('.orbit-more-btn');
  if (more && currentNav && !navEl.querySelector(`.orbit-dock [data-nav="${currentNav}"]`)) more.setAttribute('aria-current', 'page');
}

export async function refreshLibraries() {
  const [libraries, live] = await Promise.all([api.get('/api/libraries'), api.get('/api/live/status').catch(() => null)]);
  state.libraries = libraries;
  state.live = live;
  renderNav();
}

// ---- Routing ----
export function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(query)) };
}

// Remember where we've been inside the app so "Back" never leaves Atomix.
const visited = [location.hash || '#/'];

export function navigate(hash, { replace = false } = {}) {
  if (replace) {
    history.replaceState(null, '', hash);
    visited[visited.length - 1] = hash;
    render();
  } else location.hash = hash;
}

window.addEventListener('hashchange', () => {
  const now = location.hash || '#/';
  if (visited.length > 1 && visited[visited.length - 2] === now) visited.pop();
  else if (visited[visited.length - 1] !== now) visited.push(now);
});

export function goBack(fallback = '#/') {
  if (visited.length > 1) history.back();
  else navigate(fallback, { replace: true });
}
/** Whether the page before this one is `hash` (its query aside: a title's page may have picked a season). */
const samePage = (a, b) => a.split('?')[0] === b.split('?')[0];
const cameFrom = (hash) => visited.length > 1 && samePage(visited[visited.length - 2], hash);

// On TVs and laptops Orbit's pages scroll inside `main` (a fixed, full-screen box), not the document.
const framed = matchMedia(FRAME_QUERY);
function pageScroller() {
  return isOrbit() && document.body.dataset.view === 'page' && framed.matches ? main : document.scrollingElement || document.documentElement;
}

/** Back (the remote's Back, Backspace), once dialogs and the menu have had their turn. */
function onBackKey() {
  if (!state.profile && state.user) return; // "Who's watching?" is not a page to go back from
  const onHome = parseHash().path === '/';
  const row = document.activeElement?.closest?.('.home-rows .row');
  const atTop = !row || row === main.querySelector('.home-rows .row');
  const action = homeBack({ hasMenu: isOrbit() && framed.matches, onHome, atTop });
  if (action === 'menu') openMenu();
  else if (action === 'top') {
    // The full top area first: its buttons are hidden while it is compact, and Play takes the focus.
    main.querySelector('.home-view')?.classList.remove('is-compact');
    main.querySelector('.home-rows')?.scrollTo({ top: 0 });
    pageScroller().scrollTo(0, 0);
    focusFirst(main);
  } else goBack();
}

let announcedPath = null;
async function render() {
  document.documentElement.classList.remove('pill-hidden'); // every page starts with the pill shown
  const token = ++renderToken;
  // A dialog left open by the browser's Back button would cover the next page.
  for (const d of document.querySelectorAll('dialog[open]')) d.close('cancel');
  if (cleanup) {
    try {
      cleanup();
    } catch (err) {
      console.error(err);
    }
    cleanup = null;
  }
  if (!state.user) return renderAuth(token);

  const { path, query } = parseHash();
  if (state.offline && state.profile && !offlineAllowed(path, query)) {
    navigate('#/downloads', { replace: true });
    return;
  }
  // No profile chosen yet on this device: show "Who's watching?" first.
  const route = !state.profile ? routes.find((r) => r.picker) : routes.find((r) => r.pattern.test(path));
  if (!route) {
    navigate('#/', { replace: true });
    return;
  }
  const m = route.pattern.exec(path);
  const params = {};
  (route.keys || []).forEach((k, i) => (params[k] = m[i + 1]));

  document.body.dataset.view = route.fullscreen ? 'player' : route.picker ? 'auth' : 'page';
  // Videos and music don't play over each other.
  if (route.fullscreen && !route.keepMusic) music.suspend(); // (reading leaves the music playing)
  else music.resume();
  currentNav = typeof route.nav === 'function' ? route.nav(params) : route.nav || null;
  highlightNav();

  clear(main);
  main.append(spinner());
  routeStart();
  try {
    // v0.26: a Screen's data starts now, beside its modules; a failure is reported by mountView, not left unhandled.
    const early = route.data ? route.data(params, query) : undefined;
    early?.catch(() => {});
    const mod = await route.view();
    if (token !== renderToken) return;
    const container = h('div', { class: 'view' });
    const leave = await mountView(container, mod, params, query, early); // v0.26: an old render(el) view or a Preact Screen
    if (token !== renderToken) {
      if (leave) leave();
      return;
    }
    cleanup = leave;
    clear(main);
    main.append(container);
    routeEnd();
    // A new page is news to a screen reader: its name, once per address (an in-page refresh says nothing — the
    // action that caused it speaks for itself; the full-screen player says its own things).
    if (!route.fullscreen && announcedPath !== path) announce(document.title.split(' · ')[0] || document.title);
    announcedPath = path;
    // A page opened on one particular thing (a deep link such as the guide's ?channel=) marks it data-focus-now: it
    // gets the focus and stays in view, keyboard or not.
    const opened = !route.fullscreen && main.querySelector('[data-focus-now]');
    if (opened) {
      opened.removeAttribute('data-focus-now');
      opened.focus({ preventScroll: true });
      opened.scrollIntoView({ block: 'center', inline: 'nearest' });
    } else pageScroller().scrollTo(0, 0);
    if (!route.fullscreen && !opened) {
      if (isKeyboardMode()) focusFirst(main);
      else main.focus({ preventScroll: true });
    }
  } catch (err) {
    if (token !== renderToken) return;
    // Reloading or leaving the page cancels requests that are still loading ("Failed to fetch").
    // Wait a moment: if the page is going away this never runs, so no error page flashes up.
    if (err instanceof TypeError) await new Promise((resolve) => setTimeout(resolve, 400));
    if (token !== renderToken) return;
    console.error(err);
    routeEnd();
    clear(main);
    main.append(
      h(
        'div',
        { class: 'empty-state' },
        h('h1', {}, err.status === 404 ? 'Nothing here' : 'Something went wrong'),
        h('p', {}, err instanceof TypeError && /fetch|network/i.test(err.message) ? "Can't reach the Atomix server. Check it's still running, then try again." : err.message),
        // Something that no longer exists won't come back with "Try again": only the way home.
        h('div', { class: 'actions' }, err.status === 404 ? null : h('button', { class: 'btn btn-primary', type: 'button', onClick: () => render() }, 'Try again'), h('a', { class: err.status === 404 ? 'btn btn-primary' : 'btn btn-ghost', href: '#/' }, 'Go home')),
      ),
    );
  }
}

/** Re-render the current view (e.g. after marking something watched). */
export function refreshView() {
  const y = pageScroller().scrollTop;
  return render().then(() => pageScroller().scrollTo(0, y));
}

export function setTitle(title) {
  const server = state.status?.serverName || 'Atomix';
  document.title = title ? `${title} · ${server}` : server;
}

async function renderAuth(token) {
  document.body.dataset.view = 'auth';
  const mod = await import('./views/auth.js');
  if (token !== renderToken) return;
  const container = h('div', { class: 'view' });
  await mod.render(container, { setup: state.status?.setupRequired });
  if (token !== renderToken) return;
  clear(main);
  main.append(container);
  focusFirst(container);
}

export async function onSignedIn(user) {
  state.user = user;
  state.status = await api.get('/api/status');
  keepSnapshot({ status: state.status, themes: state.themes });
  state.profile = state.status.profile;
  applyTheme(); // the person's own theme first, so the splash plays in its colours
  // Signing in is a fresh open (no note yet): the splash plays while the rest is fetched behind it.
  let splash = null;
  if (!readNote()) {
    await themeReady();
    splash = showSplash({ name: state.status.serverName || 'Atomix' });
  }
  setPlayersProfile(state.profile);
  document.body.classList.add('signed-in');
  if (state.profile) {
    // One PIN-less profile came back with the sign-in: it is the note from now on, and the idle watch starts.
    writeNote(state.profile.id);
    watchIdle();
    try {
      await refreshLibraries();
    } catch {
      /* handled by the 401/428 handlers; the page still renders and the splash still ends */
    }
  }
  await render();
  await settleSplash(splash);
}

/** Once the page behind the splash is ready: let the animation finish, fade the layer, put focus where it belongs. */
async function settleSplash(splash) {
  if (!splash) return;
  pageReady();
  await splash;
  await endSplash();
  // The page was inert while the splash showed, so its own autofocus was lost: focus it as render() would.
  if (isKeyboardMode() || !state.profile) focusFirst(main);
  else main.focus({ preventScroll: true });
}

/** Called by the "Who's watching?" screen once a profile is chosen. */
export async function onProfileSelected(profile) {
  state.profile = profile;
  setPlayersProfile(profile);
  applyTheme();
  if (state.offline) {
    sync.expire(profile.id).catch(() => {}); // past the offline days: no playing (worked out with no connection)
    renderNav();
    state.pickerFor = null;
    navigate('#/downloads', { replace: true });
    return;
  }
  await refreshLibraries();
  writeNote(profile.id);
  watchIdle();
  // Back to where this profile was; anyone else starts at Home (a kid must not land on a grown-up's page).
  const back = takeReturn(profile.id);
  const wasOn = state.pickerFor;
  state.pickerFor = null;
  const { path } = parseHash();
  if (back && back !== '#/profiles') {
    // Leaving a player for the page it was opened from: go back to it, so Back afterwards isn't a second copy.
    if (/^\/play(-source)?\//.test(path) && cameFrom(back)) history.back();
    else navigate(back, { replace: true });
  } else if (path === '/profiles' || (wasOn != null && wasOn !== profile.id)) navigate('#/', { replace: true });
  else render();
}

export async function signOut() {
  try {
    await api.post('/api/auth/logout');
  } catch {
    /* ignore */
  }
  state.user = null;
  state.profile = null;
  state.lastPrefs = null;
  clearNote();
  stopGate();
  forgetReturn();
  forgetSnapshot(); // signed out: this device doesn't open offline as them
  setPlayersProfile(null);
  // …and keeps none of their downloads (nobody else could see, play or remove them).
  import('./offline/store.js').then(({ openStore }) => openStore()).then((s) => s.clearAll()).catch(() => {});
  document.body.classList.remove('signed-in');
  applyTheme();
  location.hash = '#/';
  render();
}

export async function updatePrefs(prefs) {
  const res = await api.patch('/api/me', { prefs });
  state.user = res.user;
  state.profile = res.profile;
  music.setProfile(res.profile); // the same profile: only its prefs (v0.22 speed and skips) are taken
  applyTheme();
  return state.profile;
}

async function boot() {
  ensureLiveRegions();
  main = document.getElementById('main');
  navEl = document.getElementById('nav');
  initNavigation({ onBack: onBackKey });
  document.body.prepend(environmentLayer, backdropLayer);
  // Themes can give the header a solid background once the page scrolls under it.
  window.addEventListener('scroll', () => document.documentElement.classList.toggle('scrolled', window.scrollY > 8), { passive: true });
  // Orbit on a phone: the profile pill slides away while scrolling down and comes back on any scroll up (v0.24).
  let lastY = window.scrollY;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    const root = document.documentElement;
    if (isOrbit() && !framed.matches) root.classList.toggle('pill-hidden', !pillShown({ y, lastY, shown: !root.classList.contains('pill-hidden') }));
    else root.classList.remove('pill-hidden');
    lastY = y;
  }, { passive: true });
  document.body.append(miniPlayer, castPill);
  setProfileRequiredHandler(() => {
    if (!state.profile) return;
    state.profile = null;
    setPlayersProfile(null);
    render();
  });
  setUnauthorizedHandler(() => {
    if (!state.user) return;
    state.user = null;
    state.profile = null;
    state.lastPrefs = null;
    clearNote();
    stopGate();
    forgetReturn();
    setPlayersProfile(null);
    document.body.classList.remove('signed-in');
    toast('Your session ended — please sign in again.', { type: 'error' });
    render();
  });

  try {
    [state.status, state.themes] = await Promise.all([api.get('/api/status'), api.get('/api/themes')]);
    if (!isAtomixStatus(state.status) || !Array.isArray(state.themes)) throw new TypeError("Something other than Atomix answered (a Wi-Fi sign-in page?)");
  } catch (err) {
    // No connection (or the server down behind its proxy): open from the device when it has downloads.
    if ((err instanceof TypeError || err.status >= 500) && (await offlineBoot().catch(() => false))) return;
    main.append(h('div', { class: 'empty-state' }, h('h1', {}, "Can't reach the Atomix server"), h('p', {}, err.message)));
    return;
  }
  keepSnapshot({ status: state.status, themes: state.themes });
  // A fresh open (no note in this tab) plays the splash while the rest of the boot happens behind it. Only when
  // signed in: the sign-in screen is not a moment for it. (The session cookie is HttpOnly, so this waits for
  // /api/status, which is one quick request; `main` is empty until then, so nothing shows before the splash.)
  registerWorker(); // v0.21: the offline helper (secure addresses only; it never blocks the boot)
  state.user = state.status.user;
  state.profile = state.status.profile;
  state.lastPrefs = state.profile?.prefs || null;
  applyTheme(); // the person's own theme first, so the splash plays in its colours
  const splashing = Boolean(state.status.user) && !readNote();
  if (splashing) await themeReady();
  const splash = splashing ? showSplash({ name: state.status.serverName || 'Atomix' }) : null;
  // The gate: a fresh open or a stale note means "Who's watching?" first, even though the server session
  // still has a profile. The server keeps enforcing PINs; this only decides what this tab shows.
  if (state.user && state.profile) {
    const decision = gateDecision({ note: readNote(), now: Date.now(), idleMinutes: state.status.pickerIdleMinutes, needsPicker: needsPicker(), profileId: state.profile.id });
    if (decision === 'splash+picker' || decision === 'picker') {
      rememberReturn(/^#\/play/.test(location.hash) ? '#/' : location.hash || '#/', state.profile.id); // never back into a player
      state.pickerFor = state.profile.id;
      state.profile = null;
    } else if (decision === 'splash' || (decision === 'nothing' && !readNote())) {
      writeNote(state.profile.id); // one PIN-less profile: it is the note from now on
    }
  }
  setPlayersProfile(state.profile);
  applyTheme();
  setTitle();
  if (state.user) {
    document.body.classList.add('signed-in');
    if (state.profile) {
      try {
        await refreshLibraries();
      } catch {
        /* handled by the 401/428 handlers */
      }
    }
  }
  if (state.user && state.profile) watchIdle();
  // v0.21: the connection back while the app stayed open — send what happened offline and check the downloads.
  window.addEventListener('online', () => !state.offline && state.profile && sync.run());
  window.addEventListener('hashchange', render);
  await render();
  await settleSplash(splash);
}

boot();
