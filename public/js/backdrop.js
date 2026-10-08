// The full-screen artwork behind every page (Kodi-style "fanart"). Views set
// it for the title on screen; home and library pages make it follow focus.
// Each picture also sets --tint: the colour it would cast into a dark room,
// which themes use for glows, progress bars and highlights.
import { h } from './dom.js';
import { ambientColour } from './tint.js';
import { coverRect } from './orbit-rules.js';

const layer = h('div', { class: 'backdrop', 'aria-hidden': 'true' });
const imgs = [h('img', { alt: '', decoding: 'async' }), h('img', { alt: '', decoding: 'async' })];
layer.append(...imgs);
let front = 0;
let current = null;
let token = 0;
let setThisRoute = false;

export const backdropLayer = layer;

// Orbit's "environment": the same artwork behind the sign-in, picker and music pages, drawn tiny (64 × 36) and stretched to
// the whole screen, so it looks blurred without a full-screen blur filter. Two canvases cross-fade.
const ENV_W = 64;
const ENV_H = 36;
const envLayer = h('div', { class: 'environment', 'aria-hidden': 'true' });
const envCanvases = [0, 1].map(() => h('canvas', { width: ENV_W, height: ENV_H }));
envLayer.append(...envCanvases);
let envFront = 0;
export const environmentLayer = envLayer;

function paintEnvironment(img) {
  if (document.documentElement.dataset.layout !== 'orbit' || !img?.naturalWidth) return;
  const canvas = envCanvases[1 - envFront];
  const ctx = canvas.getContext('2d');
  const r = coverRect(img.naturalWidth, img.naturalHeight, ENV_W, ENV_H);
  if (!ctx || !r) return;
  ctx.clearRect(0, 0, ENV_W, ENV_H);
  ctx.filter = 'blur(2px) saturate(1.5)'; // where supported; the stretch alone already blurs it
  ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, 0, 0, ENV_W, ENV_H);
  canvas.classList.add('is-on');
  envCanvases[envFront].classList.remove('is-on');
  envFront = 1 - envFront;
}
function clearEnvironment() {
  for (const c of envCanvases) c.classList.remove('is-on');
}
/** The layout just changed: paint (or clear) the environment for the artwork already showing. */
export function repaintEnvironment() {
  if (current && imgs[front].classList.contains('is-on')) paintEnvironment(imgs[front]);
  else clearEnvironment();
}

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
    clearEnvironment();
    return;
  }
  const next = imgs[1 - front];
  next.onload = () => {
    if (my !== token) return;
    setTint(tintOf(next));
    paintEnvironment(next);
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
