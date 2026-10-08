// Atomix web client: app shell, routing, theming and session handling.
import { api, setUnauthorizedHandler, setProfileRequiredHandler } from './api.js';
import { h, icon, clear, logoMark } from './dom.js';
import { initNavigation, focusFirst, isKeyboardMode, configureNavigation, openMenu } from './nav.js';
import { toast, spinner, avatar } from './components.js';
import { music, miniPlayer } from './music.js';
import { castPill, setCastProfile } from './cast.js';
import { backdropLayer, environmentLayer, repaintEnvironment, routeStart, routeEnd } from './backdrop.js';
import { renderOrbitNav } from './shell.js';
import { FRAME_QUERY, homeBack } from './orbit-rules.js';
import { readNote, writeNote, clearNote, gateDecision, startGate, stopGate, rememberReturn, takeReturn, forgetReturn } from './gate.js';
import { showSplash, endSplash, pageReady } from './splash.js';

export const state = {
  status: null,
  user: null,
  profile: null, // who's watching
  lastPrefs: null, // the last profile's prefs, for the look while the picker shows
  pickerFor: null, // the profile that was on when the picker came back (anyone else starts at Home)
  playingItemHash: null, // the page to return to from the player
  libraries: [],
  themes: [],
};

export const isKidsProfile = () => Boolean(state.profile?.kids);
export const canAdmin = () => state.user?.role === 'admin' && !isKidsProfile();
export const addonsAllowed = () => !isKidsProfile() || Boolean(state.profile?.allowUnrated);
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
}

const routes = [
  { pattern: /^\/?$/, view: () => import('./views/home.js'), nav: 'home' },
  { pattern: /^\/library\/(\d+)$/, keys: ['id'], view: () => import('./views/library.js'), nav: (p) => `lib-${p.id}` },
  { pattern: /^\/item\/(\d+)$/, keys: ['id'], view: () => import('./views/item.js') },
  { pattern: /^\/play\/(\d+)$/, keys: ['id'], view: () => import('./views/player.js'), fullscreen: true },
  { pattern: /^\/play-source\/([\w-]+)\/([\w-]+)$/, keys: ['plugin', 'source'], view: () => import('./views/player.js'), fullscreen: true },
  { pattern: /^\/trailer\/(\d+)$/, keys: ['id'], view: () => import('./views/trailer.js'), fullscreen: true },
  { pattern: /^\/now-playing$/, view: () => import('./views/nowplaying.js') },
  { pattern: /^\/cast$/, view: () => import('./views/remote.js') },
  { pattern: /^\/lists$/, view: () => import('./views/lists.js'), nav: 'lists' },
  { pattern: /^\/lists\/(\d+)$/, keys: ['id'], view: () => import('./views/lists.js'), nav: 'lists' },
  { pattern: /^\/collections\/(\d+)$/, keys: ['id'], view: () => import('./views/lists.js') },
  { pattern: /^\/search$/, view: () => import('./views/search.js'), nav: 'search' },
  { pattern: /^\/addons$/, view: () => import('./views/addons.js'), nav: 'addons' },
  { pattern: /^\/addons\/([\w-]+)\/([\w-]+)$/, keys: ['plugin', 'source'], view: () => import('./views/addons.js'), nav: 'addons' },
  { pattern: /^\/settings(?:\/([\w-]+))?$/, keys: ['tab'], view: () => import('./views/settings.js'), nav: 'settings' },
  { pattern: /^\/profiles$/, view: () => import('./views/profiles.js'), picker: true },
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
  if (prefs.accent) root.setProperty('--accent', prefs.accent);
  else root.removeProperty('--accent');
  // Arctic takes its colour from the artwork; a chosen accent is the light for pages without any.
  if (prefs.accent) root.setProperty('--tint-default', prefs.accent);
  else root.removeProperty('--tint-default');
  if (prefs.accent) root.setProperty('--accent-text', contrastText(prefs.accent));
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

function contrastText(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.4 ? '#111111' : '#ffffff';
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
      settingsLabel: canAdmin() ? 'Settings' : 'Profile',
      clock: clockEl,
    });
    configureNavigation({ menu: navEl.querySelector('.orbit-menu'), rowAlign: 'start' });
    highlightNav();
    return;
  }
  configureNavigation();
  clear(navEl);
  const libs = state.libraries.map((l) => navLink(`lib-${l.id}`, `#/library/${l.id}`, l.name, l.type === 'tv' ? 'tv' : l.type === 'music' ? 'music' : 'film'));
  navEl.append(
    h('a', { class: 'brand', href: '#/', 'aria-label': `${state.status?.serverName || 'Atomix'} home` }, logoMark(30), h('span', { class: 'brand-name' }, state.status?.serverName || 'Atomix')),
    h(
      'ul',
      { class: 'nav-links', role: 'list' },
      [navLink('home', '#/', 'Home', 'home'), ...libs, navLink('lists', '#/lists', 'Lists', 'list'), addonsAllowed() ? navLink('addons', '#/addons', 'Add-ons', 'addons') : null].filter(Boolean).map((a) => h('li', {}, a)),
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
  highlightNav();
}

let currentNav = null;
function highlightNav() {
  for (const a of navEl.querySelectorAll('.nav-link')) {
    if (a.dataset.nav === currentNav) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

export async function refreshLibraries() {
  state.libraries = await api.get('/api/libraries');
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

async function render() {
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
  if (route.fullscreen) music.suspend();
  else music.resume();
  currentNav = typeof route.nav === 'function' ? route.nav(params) : route.nav || null;
  highlightNav();

  clear(main);
  main.append(spinner());
  routeStart();
  try {
    const mod = await route.view();
    if (token !== renderToken) return;
    const container = h('div', { class: 'view' });
    const result = await mod.render(container, params, query);
    if (token !== renderToken) {
      if (typeof result === 'function') result();
      return;
    }
    cleanup = typeof result === 'function' ? result : null;
    clear(main);
    main.append(container);
    routeEnd();
    pageScroller().scrollTo(0, 0);
    if (!route.fullscreen) {
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
        h('h1', {}, 'Something went wrong'),
        h('p', {}, err instanceof TypeError && /fetch|network/i.test(err.message) ? "Can't reach the Atomix server. Check it's still running, then try again." : err.message),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', onClick: () => render() }, 'Try again'), h('a', { class: 'btn btn-ghost', href: '#/' }, 'Go home')),
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
  setPlayersProfile(null);
  document.body.classList.remove('signed-in');
  applyTheme();
  location.hash = '#/';
  render();
}

export async function updatePrefs(prefs) {
  const res = await api.patch('/api/me', { prefs });
  state.user = res.user;
  state.profile = res.profile;
  applyTheme();
  return state.profile;
}

async function boot() {
  main = document.getElementById('main');
  navEl = document.getElementById('nav');
  initNavigation({ onBack: onBackKey });
  document.body.prepend(environmentLayer, backdropLayer);
  // Themes can give the header a solid background once the page scrolls under it.
  window.addEventListener('scroll', () => document.documentElement.classList.toggle('scrolled', window.scrollY > 8), { passive: true });
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
  } catch (err) {
    main.append(h('div', { class: 'empty-state' }, h('h1', {}, "Can't reach the Atomix server"), h('p', {}, err.message)));
    return;
  }
  // A fresh open (no note in this tab) plays the splash while the rest of the boot happens behind it. Only when
  // signed in: the sign-in screen is not a moment for it. (The session cookie is HttpOnly, so this waits for
  // /api/status, which is one quick request; `main` is empty until then, so nothing shows before the splash.)
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
  window.addEventListener('hashchange', render);
  await render();
  await settleSplash(splash);
}

boot();
