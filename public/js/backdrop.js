// The full-screen artwork behind every page (Kodi-style "fanart"). Views set
// it for the title on screen; home and library pages make it follow focus.
// Each picture also sets --tint: the colour it would cast into a dark room,
// which themes use for glows, progress bars and highlights.
import { h } from './dom.js';
import { ambientColour } from './tint.js';

const layer = h('div', { class: 'backdrop', 'aria-hidden': 'true' });
const imgs = [h('img', { alt: '', decoding: 'async' }), h('img', { alt: '', decoding: 'async' })];
layer.append(...imgs);
let front = 0;
let current = null;
let token = 0;
let setThisRoute = false;

export const backdropLayer = layer;

const tintCache = new Map();
const sampler = document.createElement('canvas');
sampler.width = 48;
sampler.height = 27;

/** Read the artwork's ambient colour (null if it has none, or the image is from another site). */
function tintOf(img) {
  if (tintCache.has(img.src)) return tintCache.get(img.src);
  let colour = null;
  try {
    const ctx = sampler.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, sampler.width, sampler.height);
    colour = ambientColour(ctx.getImageData(0, 0, sampler.width, sampler.height).data);
  } catch {
    colour = null; // cross-origin artwork can't be read; keep the theme's colour
  }
  tintCache.set(img.src, colour);
  if (tintCache.size > 200) tintCache.delete(tintCache.keys().next().value);
  return colour;
}

function setTint(colour) {
  const root = document.documentElement.style;
  if (colour) root.setProperty('--tint', colour);
  else root.removeProperty('--tint');
}

/** Show `url` behind the page (null → plain background). Cross-fades between images. */
export function setBackdrop(url) {
  setThisRoute = true;
  url = url || null;
  if (url === current) return;
  current = url;
  const my = ++token;
  if (!url) {
    for (const img of imgs) img.classList.remove('is-on');
    layer.classList.remove('has-art');
    setTint(null);
    return;
  }
  const next = imgs[1 - front];
  next.onload = () => {
    if (my !== token) return;
    setTint(tintOf(next));
    next.classList.add('is-on');
    imgs[front].classList.remove('is-on');
    front = 1 - front;
    layer.classList.add('has-art');
  };
  next.onerror = () => {
    if (my === token && current === url) current = null;
  };
  next.src = url;
}

/** Called by the router: views that don't set a backdrop get a plain one. */
export function routeStart() {
  setThisRoute = false;
}
export function routeEnd() {
  if (!setThisRoute) setBackdrop(null);
}

export const artFor = (item) => item?.backdrop || item?.showBackdrop || item?.poster || item?.albumPoster || null;

/**
 * Update something (the backdrop, a spotlight…) when a card inside `root` gets focus or the mouse.
 * `lookup(card)` returns the item for a card element.
 */
export function followFocus(root, lookup, onItem = (item) => setBackdrop(artFor(item))) {
  let timer = null;
  let last = null;
  const pick = (card, delay) => {
    const item = card && lookup(card);
    if (!item || item === last) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      last = item;
      onItem(item);
    }, delay);
  };
  root.addEventListener('focusin', (e) => pick(e.target.closest?.('.card'), 120));
  root.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'mouse') pick(e.target.closest?.('.card'), 260);
  });
}
