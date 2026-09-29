// NodeFlix web client: app shell, routing, theming and session handling.
import { api, setUnauthorizedHandler, setProfileRequiredHandler } from './api.js';
import { h, icon, clear, logoMark } from './dom.js';
import { initNavigation, focusFirst, isKeyboardMode } from './nav.js';
import { toast, spinner, avatar } from './components.js';
import { music, miniPlayer } from './music.js';
import { backdropLayer, routeStart, routeEnd } from './backdrop.js';

export const state = {
  status: null,
  user: null,
  profile: null, // who's watching
  libraries: [],
  themes: [],
};

export const isKidsProfile = () => Boolean(state.profile?.kids);
export const canAdmin = () => state.user?.role === 'admin' && !isKidsProfile();
export const addonsAllowed = () => !isKidsProfile() || Boolean(state.profile?.allowUnrated);

const routes = [
  { pattern: /^\/?$/, view: () => import('./views/home.js'), nav: 'home' },
  { pattern: /^\/library\/(\d+)$/, keys: ['id'], view: () => import('./views/library.js'), nav: (p) => `lib-${p.id}` },
  { pattern: /^\/item\/(\d+)$/, keys: ['id'], view: () => import('./views/item.js') },
  { pattern: /^\/play\/(\d+)$/, keys: ['id'], view: () => import('./views/player.js'), fullscreen: true },
  { pattern: /^\/play-source\/([\w-]+)\/([\w-]+)$/, keys: ['plugin', 'source'], view: () => import('./views/player.js'), fullscreen: true },
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
export function applyTheme() {
  const prefs = state.profile?.prefs || {};
  const themeId = prefs.theme || state.status?.defaultTheme || 'arctic';
  const theme = state.themes.find((t) => t.id === themeId) || state.themes.find((t) => t.id === 'arctic') || state.themes[0];
  const link = document.getElementById('theme-css');
  if (theme && link.getAttribute('href') !== theme.css) link.setAttribute('href', theme.css);
  document.body.dataset.layout = theme?.layout || 'top';
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
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && theme?.preview?.background) meta.setAttribute('content', theme.preview.background);
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
  clear(navEl);
  const libs = state.libraries.map((l) => navLink(`lib-${l.id}`, `#/library/${l.id}`, l.name, l.type === 'tv' ? 'tv' : l.type === 'music' ? 'music' : 'film'));
  navEl.append(
    h('a', { class: 'brand', href: '#/', 'aria-label': `${state.status?.serverName || 'NodeFlix'} home` }, logoMark(30), h('span', { class: 'brand-name' }, state.status?.serverName || 'NodeFlix')),
    h(
      'ul',
      { class: 'nav-links', role: 'list' },
      [navLink('home', '#/', 'Home', 'home'), ...libs, addonsAllowed() ? navLink('addons', '#/addons', 'Add-ons', 'addons') : null].filter(Boolean).map((a) => h('li', {}, a)),
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

// Remember where we've been inside the app so "Back" never leaves NodeFlix.
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
    window.scrollTo(0, 0);
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
        h('p', {}, err instanceof TypeError && /fetch|network/i.test(err.message) ? "Can't reach the NodeFlix server. Check it's still running, then try again." : err.message),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', onClick: () => render() }, 'Try again'), h('a', { class: 'btn btn-ghost', href: '#/' }, 'Go home')),
      ),
    );
  }
}

/** Re-render the current view (e.g. after marking something watched). */
export function refreshView() {
  const y = window.scrollY;
  return render().then(() => window.scrollTo(0, y));
}

export function setTitle(title) {
  const server = state.status?.serverName || 'NodeFlix';
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
  music.setProfile(state.profile);
  applyTheme();
  document.body.classList.add('signed-in');
  if (state.profile) await refreshLibraries();
  render();
}

/** Called by the "Who's watching?" screen once a profile is chosen. */
export async function onProfileSelected(profile) {
  state.profile = profile;
  music.setProfile(profile);
  applyTheme();
  await refreshLibraries();
  const { path } = parseHash();
  if (path === '/profiles') navigate('#/', { replace: true });
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
  music.setProfile(null);
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
  initNavigation({ onBack: () => goBack() });
  document.body.prepend(backdropLayer);
  // Themes can give the header a solid background once the page scrolls under it.
  window.addEventListener('scroll', () => document.documentElement.classList.toggle('scrolled', window.scrollY > 8), { passive: true });
  document.body.append(miniPlayer);
  setProfileRequiredHandler(() => {
    if (!state.profile) return;
    state.profile = null;
    music.setProfile(null);
    render();
  });
  setUnauthorizedHandler(() => {
    if (!state.user) return;
    state.user = null;
    state.profile = null;
    music.setProfile(null);
    document.body.classList.remove('signed-in');
    toast('Your session ended — please sign in again.', { type: 'error' });
    render();
  });

  try {
    [state.status, state.themes] = await Promise.all([api.get('/api/status'), api.get('/api/themes')]);
  } catch (err) {
    main.append(h('div', { class: 'empty-state' }, h('h1', {}, "Can't reach the NodeFlix server"), h('p', {}, err.message)));
    return;
  }
  state.user = state.status.user;
  state.profile = state.status.profile;
  music.setProfile(state.profile);
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
  window.addEventListener('hashchange', render);
  render();
}

boot();
