// Card motion (v0.28): when the remote or the mouse rests on a film, episode or show card, a few silent seconds of the
// title play inside the card (its 5 s preview clip, card motion v2), then it settles back on its poster. With no clip
// (or one that won't play) the card flips once through pictures from the title itself (its seek-bar preview sheets: at
// most two picture downloads) instead. Full motion only, never while an arrow is held, and it stops the moment focus or
// the pointer moves on, a key is pressed, the page scrolls or changes, or the page is hidden.
import { flipFrames } from './previews.js';
import { motionLevel } from './motion.js';
import { cardItems } from './components.js';
import { api } from './api.js';
import { sheenLedger, previewMode, FLIP_FRAMES, FLIP_FRAME_MS } from './card-motion-rules.js';
import { state, isKidsProfile } from './app.js'; // read at run time only (app.js imports this module)

const REST_MS = 1200; // how long the card must be rested on before it moves
const CLIP_MS = 5000; // a clip plays once, at most this long (WCAG 2.2.2: no pause control needed)
const CLIP_OUT_MS = 250; // its fade back to the poster at the end (the 200 ms fade in is CSS: .card-clip)
const CLIP_STALL_MS = 2500; // a clip not playing this long after its src is set is given up (the flip instead)
// The flip: FLIP_FRAMES pictures, FLIP_FRAME_MS each (card-motion-rules.js: within 5 s, then back to the poster).
const KINDS = new Set(['movie', 'episode', 'show']);
const manifests = new Map(); // item id → Promise<manifest | null>
const sheets = new Map(); // sheet url → Promise<void> (decoded)
let current = null; // { card, timer, overlay, video, stopped }

const root = () => document.documentElement;
const tier = () => root().dataset.motion || motionLevel(); // as painted on the page (motion.js)
const allowed = () => motionLevel() === 'full' && !root().classList.contains('nav-held') && !root().classList.contains('reduce-effects');

/**
 * What a rested card may do now: 'clip', 'flip' (Kids: the still-frame flip only) or 'none' (the pref off, data saver,
 * a 2g connection, a held arrow…: nothing at all, not even the manifest). The rules are in card-motion-rules.js.
 */
function mode() {
  if (!allowed()) return 'none';
  const c = navigator.connection;
  return previewMode({
    motion: motionLevel(),
    saveData: c?.saveData,
    effectiveType: c?.effectiveType,
    kids: isKidsProfile(),
    pref: state.profile?.prefs?.cardPreviews,
    hidden: document.hidden,
  });
}

function manifestFor(id) {
  if (!manifests.has(id)) manifests.set(id, api.get(`/api/items/${id}/previews`).catch(() => null));
  return manifests.get(id);
}
function sheet(url) {
  if (!sheets.has(url)) {
    const img = new Image();
    img.src = url;
    sheets.set(url, (img.decode ? img.decode() : Promise.resolve()).catch(() => sheets.delete(url)));
  }
  return sheets.get(url);
}

/** Where tile `f` sits when the sheet is scaled to cover a box of w × h (centred, like object-fit: cover). */
function placement(f, w, h) {
  const s = Math.max(w / f.width, h / f.height);
  const dx = (w - f.width * s) / 2;
  const dy = (h - f.height * s) / 2;
  return { size: `${f.sheetWidth * s}px ${f.sheetHeight * s}px`, pos: `${dx - f.x * s}px ${dy - f.y * s}px` };
}

/** Let go of a clip's video: no more downloading or decoding, then out of the page. */
function dropVideo(video) {
  video.pause();
  video.removeAttribute('src');
  try {
    video.load();
  } catch {}
  video.remove();
}

function stop() {
  if (!current) return;
  const { timer, overlay, video } = current;
  current.stopped = true;
  clearTimeout(timer);
  clearTimeout(current.clipTimer);
  clearTimeout(current.stallTimer);
  if (video) dropVideo(video); // at once: the poster is right under it
  if (overlay) {
    overlay.classList.remove('is-on');
    setTimeout(() => overlay.remove(), 320);
  }
  current = null;
}

/**
 * Play the title's clip inside the card: one muted video, unseen until its first frame plays, then a 200 ms fade in;
 * at its end (or 5 s) a 250 ms fade back to the poster. Resolves true once it plays, false when it can't (play()
 * refused, e.g. iOS Low Power Mode, the clip won't load, or it hasn't started playing 2.5 s after its src was set) so
 * the caller can flip through pictures instead.
 */
function playClip(run, url) {
  const art = run.card.querySelector('.card-art .art');
  if (!art) return Promise.resolve(false);
  const video = document.createElement('video');
  video.className = 'card-clip';
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.preload = 'auto';
  for (const a of ['muted', 'playsinline', 'disablepictureinpicture', 'disableremoteplayback']) video.setAttribute(a, '');
  video.setAttribute('aria-hidden', 'true');
  video.setAttribute('tabindex', '-1');
  video.src = url;
  run.video = video;
  art.append(video);
  return new Promise((resolve) => {
    let started = false;
    let failed = false;
    const fail = () => {
      if (started) return finish();
      if (failed) return;
      failed = true;
      clearTimeout(run.stallTimer);
      if (run.video === video) run.video = null;
      dropVideo(video);
      resolve(false);
    };
    // The end (or 5 s): fade back to the poster, then the run is over.
    const finish = () => {
      if (run.stopped || run.video !== video) return;
      clearTimeout(run.clipTimer);
      video.classList.remove('is-on');
      video.classList.add('is-off');
      run.clipTimer = setTimeout(() => current === run && stop(), CLIP_OUT_MS);
    };
    video.addEventListener(
      'playing',
      () => {
        if (run.stopped || started) return;
        started = true;
        clearTimeout(run.stallTimer);
        video.classList.add('is-on');
        run.clipTimer = setTimeout(finish, CLIP_MS);
        resolve(true);
      },
      { once: true },
    );
    video.addEventListener('ended', finish, { once: true });
    video.addEventListener('error', fail, { once: true });
    // A clip that never answers (a stalled request, a sleeping drive): not left waiting in the card.
    run.stallTimer = setTimeout(() => !run.stopped && !started && fail(), CLIP_STALL_MS);
    const p = video.play();
    if (p?.catch) p.catch(() => !run.stopped && fail());
  });
}

async function play(run, item) {
  if (mode() === 'none') return; // nothing asked for at all (the pref or the connection may have changed)
  const m = await manifestFor(item.id);
  if (run.stopped) return;
  // A show's manifest comes from one of its episodes, so its clip address is given rather than built here.
  if (m?.clip && m.clipUrl && mode() === 'clip') {
    const played = await playClip(run, m.clipUrl);
    if (played || run.stopped) return;
  }
  const frames = flipFrames(m, FLIP_FRAMES);
  if (run.stopped || frames.length < 3) return;
  await Promise.all([...new Set(frames.map((f) => f.url))].map(sheet));
  const art = run.card.querySelector('.card-art .art');
  if (run.stopped || !art || mode() === 'none') return;
  const { width: w, height: h } = art.getBoundingClientRect();
  const overlay = document.createElement('span');
  overlay.className = 'card-flip';
  overlay.setAttribute('aria-hidden', 'true');
  const layers = [document.createElement('i'), document.createElement('i')];
  overlay.append(...layers);
  art.append(overlay);
  run.overlay = overlay;
  let k = 0;
  const show = () => {
    if (run.stopped) return;
    if (k >= frames.length) return stop(); // one pass, then back to the poster
    const f = frames[k];
    const layer = layers[k % 2];
    const { size, pos } = placement(f, w, h);
    layer.style.backgroundImage = `url("${f.url}")`;
    layer.style.backgroundSize = size;
    layer.style.backgroundPosition = pos;
    layer.classList.add('on');
    layers[(k + 1) % 2].classList.remove('on');
    if (k === 0) requestAnimationFrame(() => overlay.classList.add('is-on'));
    k++;
    run.timer = setTimeout(show, FLIP_FRAME_MS);
  };
  show();
}

function rest(card) {
  if (current?.card === card) return;
  stop();
  const item = card && cardItems.get(card);
  // The one decision: no preview at all (no clip, no flip, no manifest or sheet request), the flip only, or the clip.
  if (!item || !KINDS.has(item.kind) || mode() === 'none') return;
  const run = { card, timer: null, clipTimer: null, stallTimer: null, overlay: null, video: null, stopped: false };
  current = run;
  run.timer = setTimeout(() => play(run, item), REST_MS);
}

// ---- Selecting a card (card motion v2): the row's other cards dim, and a sheen crosses the card once per visit ----
// The lift, glow and info strip are CSS (app.css "Card motion v2"); this only marks the row and starts the sheen.
const FILM_CARD = 'a.card.poster-card, a.card.landscape-card:not(.live-card)';
const SHEEN_MS = 450;
const sheens = sheenLedger();
let hovered = null; // the film card under a fine pointer
let dimmedRow = null; // the row carrying .has-selected
const filmCard = (el) => el?.closest?.(FILM_CARD) || null;
const focusVisible = (el) => {
  try {
    return el.matches(':focus-visible');
  } catch {
    return root().classList.contains('kbd'); // browsers without :focus-visible: the remote's focus
  }
};
/** The selected card: the one under the mouse, else the one the remote is on. */
function selected() {
  if (hovered?.isConnected) return hovered;
  const a = document.activeElement;
  return a && a.matches?.(FILM_CARD) && focusVisible(a) ? a : null;
}
/** Dim the selected card's row-mates (full motion only; the CSS keeps the selected card and the hovered one bright). */
function markRow() {
  const card = selected();
  const row = card && tier() === 'full' && card.parentElement?.classList.contains('row-scroller') ? card.parentElement : null;
  // Same row and still marked: nothing to do. (A row Preact re-rendered drops the class; a replaced one is gone.)
  if (row === dimmedRow && (!row || (row.isConnected && row.classList.contains('has-selected')))) return;
  dimmedRow?.classList.remove('has-selected');
  row?.classList.add('has-selected');
  dimmedRow = row;
}
/** The first time a card is selected on this page: one soft highlight across its art. Never on a held key. */
function shine(card) {
  if (tier() !== 'full' || root().classList.contains('nav-held') || root().classList.contains('reduce-effects')) return;
  const item = cardItems.get(card);
  if (!item || !KINDS.has(item.kind) || !sheens.take(item.id)) return;
  card.classList.add('is-sheen');
  setTimeout(() => card.classList.remove('is-sheen'), SHEEN_MS + 50);
}
function select(card) {
  markRow();
  if (card) shine(card);
}

/** Start card motion. Once, at boot. */
export function initCardMotion() {
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  document.addEventListener('focusin', (e) => {
    const card = e.target.closest?.('a.card');
    if (card && root().classList.contains('kbd')) rest(card);
    else if (!card) stop();
    const film = filmCard(e.target);
    select(film && focusVisible(film) ? film : null);
  });
  document.addEventListener('focusout', (e) => {
    if (current && e.target === current.card && root().classList.contains('kbd')) stop();
    if (!filmCard(e.relatedTarget)) queueMicrotask(markRow); // focus left the cards (or the page)
  });
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse' || !fine.matches) return;
    const card = e.target.closest?.('a.card');
    if (card) rest(card);
    else if (current && !current.card.contains(e.target)) stop();
    const film = filmCard(e.target);
    if (film === hovered) return;
    hovered = film;
    select(film);
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'mouse' && hovered && !e.relatedTarget) (hovered = null), markRow(); // the mouse left the window
  });
  // Any key stops it (an arrow then rests on the card it moves to; a held arrow never gets that far).
  document.addEventListener('keydown', () => stop());
  // A held arrow let go (html.nav-held clears): the card it landed on rests like any other (and previews after 1.2 s).
  let wasHeld = root().classList.contains('nav-held');
  new MutationObserver(() => {
    const held = root().classList.contains('nav-held');
    if (wasHeld && !held) {
      const a = document.activeElement;
      if (a?.matches?.('a.card') && root().classList.contains('kbd')) rest(a);
    }
    wasHeld = held;
  }).observe(root(), { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('scroll', () => current && !current.card.matches(':focus') && stop(), { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => document.hidden && stop());
  window.addEventListener('hashchange', () => {
    stop();
    sheens.reset(); // a new page visit: every card may shine once again
    hovered = null;
    markRow();
  });
}
