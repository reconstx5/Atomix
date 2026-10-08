// The splash: the Atomix mark draws itself (the two orbits sketch in, the electron makes a lap, the play
// button pops in), the name rises, then it all lifts away. Built from the logo's own paths (MARK) in the
// theme's colours. It never blocks: the app boots behind it and it ends at the later of the animation or
// the boot. Any key, click or tap ends it early. Under Reduce motion it is a short fade of the finished mark.
import { MARK } from './dom.js';
import { enterKeyboardMode, isKeyboardModeKey } from './nav.js';

const ANIMATION_MS = 1950; // the last thing (the name) has settled; the lift starts here
const MAX_WAIT_MS = 10_000; // a hung boot never leaves the page stuck behind the splash
const STILL_MS = 700; // reduced motion: fade in, hold a moment
const SKIP_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab']);
// The electron's orbit: MARK's ellipse (12.6 × 4.6, tilted -45°), starting at its resting spot top-right.
const LAP = 'M28.6 16A12.6 4.6 0 1 1 3.4 16A12.6 4.6 0 1 1 28.6 16';

let layer = null;
let finished = null; // resolves when the animation has run or was skipped
let gone = null; // resolves when the layer is hidden again
let resolveFinished;
let resolveGone;
let cap = null; // the hung-boot cap
let wait = null; // the "keep circling" timer, for a slow boot only

const stillMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduce-motion');

function build(name, still) {
  const { cx, cy, r } = MARK.electron;
  const electron = still
    ? `<circle class="splash-electron" cx="${cx}" cy="${cy}" r="${r}"/>`
    : `<g transform="rotate(-45 16 16)"><g transform="translate(28.6 16)"><circle class="splash-electron splash-park" r="${r}"><set attributeName="opacity" to="0" begin="0.45s" fill="freeze"/></circle></g>
        <circle class="splash-electron" r="${r}" opacity="0"><set attributeName="opacity" to="1" begin="0.45s" fill="freeze"/>
        <animateMotion path="${LAP}" begin="0.45s" dur="1.3s" fill="freeze" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines="0.45 0 0.25 1"/></circle></g>`;
  return `<div class="splash-inner"><svg class="splash-mark" viewBox="0 0 32 32" aria-hidden="true">
      <path class="splash-orbit one" pathLength="1" d="${MARK.orbits[0]}"/>
      <path class="splash-orbit two" pathLength="1" d="${MARK.orbits[1]}"/>
      ${still ? '' : '<circle class="splash-flare" cx="16.8" cy="16" r="0"/>'}
      <path class="splash-nucleus" d="${MARK.nucleus}"/>
      ${electron}
    </svg><div class="splash-name"></div></div>`;
}

/** Show the splash. Resolves when its animation has run its course (or a key ended it). */
export function showSplash({ name = 'Atomix' } = {}) {
  layer = document.getElementById('splash');
  if (!layer || finished) return finished || Promise.resolve();
  const still = stillMotion();
  document.documentElement.classList.toggle('splash-still', still);
  layer.innerHTML = build(name, still);
  layer.querySelector('.splash-name').textContent = name;
  layer.hidden = false;
  for (const el of document.querySelectorAll('body > :not(#splash)')) el.inert = true;
  finished = new Promise((r) => (resolveFinished = r));
  gone = new Promise((r) => (resolveGone = r));
  const timer = setTimeout(resolveFinished, still ? STILL_MS : ANIMATION_MS);
  cap = setTimeout(() => endSplash({ quick: true }), MAX_WAIT_MS);
  // Once the lap is over, keep the electron circling in case the boot is slow (pageReady() cancels this).
  wait = setTimeout(() => {
    if (!layer.hidden && !still) {
      layer.classList.add('splash-wait');
      layer.querySelector('animateMotion')?.setAttribute('repeatCount', 'indefinite');
      layer.querySelector('animateMotion')?.beginElement();
    }
  }, 1800);
  const skip = (e) => {
    if (e.type === 'keydown' && (SKIP_KEYS.has(e.key) || e.ctrlKey || e.altKey || e.metaKey || /^F\d+$/.test(e.key))) return; // shortcuts stay the browser's
    e.preventDefault();
    e.stopPropagation();
    // The key never reaches the page, but a remote's first arrow still counts: the page starts in keyboard mode.
    if (e.type === 'keydown' && isKeyboardModeKey(e.key)) enterKeyboardMode();
    clearTimeout(timer);
    clearTimeout(wait);
    resolveFinished();
    // A tap held past the fade would click whatever is under the finger: swallow that one click.
    if (e.type === 'pointerdown') {
      const eat = (c) => { c.preventDefault(); c.stopPropagation(); };
      window.addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 500);
    }
    endSplash({ quick: true });
  };
  window.addEventListener('keydown', skip, { capture: true });
  window.addEventListener('pointerdown', skip, { capture: true });
  // The skip keys stay live for as long as the layer is up (a slow boot keeps it past the animation).
  gone.then(() => {
    window.removeEventListener('keydown', skip, { capture: true });
    window.removeEventListener('pointerdown', skip, { capture: true });
    clearTimeout(wait);
  });
  return finished;
}

/** The page behind the splash is ready: the electron need not keep circling once its lap is done. */
export function pageReady() {
  clearTimeout(wait);
}

/** Fade the splash out (the mark lifts away first unless `quick`). Safe to call more than once. */
export function endSplash({ quick = false } = {}) {
  clearTimeout(cap);
  if (!layer || layer.hidden || layer.classList.contains('is-ending')) return gone || Promise.resolve();
  const still = document.documentElement.classList.contains('splash-still');
  layer.classList.add('is-ending');
  const lift = quick || still ? 0 : 500;
  setTimeout(() => {
    layer.classList.add('is-leaving');
    setTimeout(() => {
      layer.hidden = true;
      layer.innerHTML = '';
      layer.classList.remove('is-ending', 'is-leaving', 'splash-wait');
      for (const el of document.querySelectorAll('body > [inert]')) el.inert = false;
      document.documentElement.classList.remove('splash-still');
      resolveGone?.();
    }, quick ? 200 : 400);
  }, lift);
  return gone;
}

/** Resolves once the splash has gone (at once when it never showed). */
export const splashDone = () => gone || Promise.resolve();
