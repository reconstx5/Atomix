// Tiny DOM helpers — no framework, no build step.

/**
 * h('button', { class: 'btn', onClick: fn }, 'Label', childNode, [more])
 * Props: class, style (object, supports --custom-props), dataset, on*, boolean attrs, value/checked.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style' && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          if (v == null) continue;
          if (k.startsWith('--')) el.style.setProperty(k, v);
          else el.style[k] = v;
        }
      } else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'value') el.value = value;
      else if (key === 'checked' || key === 'selected' || key === 'indeterminate') el[key] = Boolean(value);
      else if (key === 'html') el.innerHTML = value; // only ever used with trusted, static markup
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---- Icons (simple 24×24 strokes, drawn for Atomix) ----
const PATHS = {
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  home: '<path d="M4 11l8-6.5 8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
  film: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M7.5 4v16M16.5 4v16M3.5 9h4M3.5 15h4M16.5 9h4M16.5 15h4"/>',
  tv: '<rect x="3" y="6" width="18" height="12.5" rx="2"/><path d="M8.5 21.5h7M9 2.5l3 3.5 3-3.5"/>',
  addons: '<path d="M9 3.5h6v4.5a2 2 0 1 0 4 0h1.5V14H16a2 2 0 1 0 0 4h4.5v2.5h-17V14H8a2 2 0 1 0 0-4H3.5V3.5H9"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  forward: '<path d="M9 5l7 7-7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  replay: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/><text x="12" y="15.2" font-size="6.5" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui,sans-serif" font-weight="700">10</text>',
  skip: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/><text x="12" y="15.2" font-size="6.5" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui,sans-serif" font-weight="700">30</text>',
  forward10: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/><text x="12" y="15.2" font-size="6.5" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui,sans-serif" font-weight="700">10</text>',
  volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  exitFullscreen: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  subtitles: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 12.5h3M12.5 12.5h4.5M7 15.5h6M15 15.5h2"/>',
  audio: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3.5" y="13.5" width="4" height="6.5" rx="1.5"/><rect x="16.5" y="13.5" width="4" height="6.5" rx="1.5"/>',
  quality: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  next: '<path d="M5 5l10 7-10 7z" fill="currentColor"/><path d="M19 5v14"/>',
  logout: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.5L4 8.5M4 13a8 8 0 0 0 14.3 4.5L20 15.5"/><path d="M4 4v4.5h4.5M20 20v-4.5h-4.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  folder: '<path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4.5l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  user: '<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  star: '<path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z" fill="currentColor" stroke="none"/>',
  shuffle: '<path d="M4 7h3.5c5 0 5 10 10 10H20M4 17h3.5c1.6 0 2.7-1 3.5-2.3M14 9.3c.8-1.3 1.9-2.3 3.5-2.3H20"/><path d="M17.5 4.5L20 7l-2.5 2.5M17.5 14.5L20 17l-2.5 2.5"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  archive: '<rect x="3.5" y="4" width="17" height="4.5" rx="1"/><path d="M5 8.5V19a1 1 0 0 1 1 1h12a1 1 0 0 1 1-1V8.5M10 12.5h4"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  dashboard: '<path d="M4 13a8 8 0 1 1 16 0"/><path d="M12 13l4-4"/><path d="M4 17h16"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1-1.6-1-2.7 0-1 .8-1.6 1.8-1.6h2.1a3.8 3.8 0 0 0 3.8-3.8c0-4-3.8-7.2-8.5-7.2z"/><circle cx="7.8" cy="11" r="1.1" fill="currentColor"/><circle cx="10.5" cy="7.5" r="1.1" fill="currentColor"/><circle cx="14.8" cy="7.8" r="1.1" fill="currentColor"/>',
  server: '<rect x="4" y="4" width="16" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="16" height="6.5" rx="1.5"/><path d="M8 7.2h.01M8 16.7h.01"/>',
  sparkle: '<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8-1.8 5.2-1.8-5.2L5 10.5l5.2-1.8z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  music: '<path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  album: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.5"/>',
  prev: '<path d="M19 5L9 12l10 7z" fill="currentColor"/><path d="M5 5v14"/>',
  queue: '<path d="M4 6h12M4 11h12M4 16h7"/><path d="M16 14v6l4-3z" fill="currentColor"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/>',
  eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M4 4l16 16"/><path d="M10.6 6.1A9.8 9.8 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-3.2 3.7M6.6 7.6A15.2 15.2 0 0 0 2.5 12s3.5 6 9.5 6a9.3 9.3 0 0 0 3.4-.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z"/>',
  repeat: '<path d="M5 11V9.5A2.5 2.5 0 0 1 7.5 7H19M16 4l3 3-3 3M19 13v1.5a2.5 2.5 0 0 1-2.5 2.5H5M8 20l-3-3 3-3"/>',
  repeatOne: '<path d="M5 11V9.5A2.5 2.5 0 0 1 7.5 7H19M16 4l3 3-3 3M19 13v1.5a2.5 2.5 0 0 1-2.5 2.5H5M8 20l-3-3 3-3"/><path d="M11 10.5l1.5-1v5" stroke-width="1.6"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  cast: '<path d="M3 9V6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14"/><path d="M3 13a7 7 0 0 1 7 7M3 16.5A3.5 3.5 0 0 1 6.5 20"/><circle cx="3.6" cy="19.4" r="1" fill="currentColor" stroke="none"/>',
  airplay: '<path d="M7 17H5.5A2.5 2.5 0 0 1 3 14.5v-8A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v8a2.5 2.5 0 0 1-2.5 2.5H17"/><path d="M12 14l4.5 6h-9z" fill="currentColor"/>',
  more: '<circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
};

export function icon(name, { size = 20, label } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.classList.add('icon');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  svg.innerHTML = PATHS[name] || '';
  return svg;
}

/**
 * The Atomix mark: a play button as the nucleus, with two orbits crossing in an X
 * behind it and one electron. The orbits stop short of the nucleus rather than
 * being masked, so the same paths work in the loader (components.js) and favicon.
 */
export const MARK = {
  orbits: ['M8.57 14.11A12.6 4.6 45 0 1 14.29 8.68M23.51 18A12.6 4.6 45 0 1 16.27 22.32', 'M14.29 23.32A12.6 4.6 -45 0 1 8.57 17.89M16.27 9.68A12.6 4.6 -45 0 1 23.51 14'],
  nucleus: 'M13.6 11.5L21.4 16L13.6 20.5Z',
  electron: { cx: 24.91, cy: 7.09, r: 2.2 },
};

let logoCount = 0;
export function logoMark(size = 28) {
  const wrap = document.createElement('span');
  wrap.className = 'logo-mark';
  // Themes can paint the tile with a gradient via --logo-a / --logo-b (both default to the accent).
  const id = `atomix-logo-${++logoCount}`;
  const ink = 'var(--accent-text)';
  const { cx, cy, r } = MARK.electron;
  wrap.innerHTML = `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" style="stop-color: var(--logo-a, var(--accent))"/><stop offset="1" style="stop-color: var(--logo-b, var(--accent))"/>
    </linearGradient></defs>
    <rect width="32" height="32" rx="8" fill="url(#${id})"/>
    <path d="${MARK.orbits.join('')}" fill="none" stroke="${ink}" stroke-width="1.7" stroke-linecap="round"/>
    <path d="${MARK.nucleus}" fill="${ink}" stroke="${ink}" stroke-width="1.6" stroke-linejoin="round"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${ink}"/>
  </svg>`;
  return wrap;
}

// ---- Formatting ----
export function formatClock(seconds, { tenths = false } = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const hr = Math.floor(seconds / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  // tenths: "0:42.5" when the value isn't whole (the intro editor), "0:42" when it is.
  const frac = tenths && Math.round((seconds % 1) * 10) % 10 ? `.${Math.round((seconds % 1) * 10)}` : '';
  return hr ? `${hr}:${pad(m)}:${pad(s)}${frac}` : `${m}:${pad(s)}${frac}`;
}

export function formatRuntime(minutes) {
  if (!minutes) return null;
  const m = Math.round(minutes);
  const hr = Math.floor(m / 60);
  return hr ? `${hr}h ${m % 60}m` : `${m}m`;
}

export function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function timeAgo(ts) {
  if (!ts) return 'never';
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

export function episodeLabel(item) {
  if (item.season == null || item.episode == null) return '';
  return item.season === 0 ? `Special ${item.episode}` : `S${item.season} · E${item.episode}`;
}

/** A stable colour from a string, for placeholder artwork. */
export function hueFor(text) {
  let hash = 0;
  for (const ch of String(text)) hash = (hash * 31 + ch.codePointAt(0)) | 0;
  return Math.abs(hash) % 360;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
