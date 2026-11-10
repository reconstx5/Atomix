// How much moves (v0.28, "Capture"): one attribute on the page, data-motion = full | reduce | none, from the system's
// Reduce motion setting, the profile's own (Settings), and whether the browser can do the motion at all (old TV
// browsers can't: there the focus ring simply appears). html.reduce-motion stays set whenever it isn't 'full', for
// the rules written against it. The rules themselves are in motion-rules.js.
import { motionTier, SETTLE_EASING } from './motion-rules.js';

let profileReduce = false;
let watching = false;
const systemQuery = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null);
const modern = () => typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('translate', '1px');

/** The current tier: 'full', 'reduce' or 'none'. */
export function motionLevel() {
  return motionTier({ systemReduce: Boolean(systemQuery()?.matches), profileReduce, modern: modern() });
}

/** Whether to hold back movement (anything but 'full'). */
export function reduceMotion() {
  return motionLevel() !== 'full';
}

function paint() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const tier = motionLevel();
  root.dataset.motion = tier;
  root.classList.toggle('reduce-motion', tier !== 'full');
  // The signature curve, where the browser has linear() (otherwise the stylesheet's plain curve stands).
  if (CSS.supports?.('transition-timing-function', 'linear(0, 1)')) root.style.setProperty('--ease-settle', SETTLE_EASING);
}

/** Set (or re-set, when the profile changes) the motion for this page. */
export function applyMotion({ profileReduce: reduce = profileReduce } = {}) {
  profileReduce = Boolean(reduce);
  paint();
  const q = systemQuery();
  if (q && !watching) {
    watching = true;
    q.addEventListener?.('change', paint);
  }
}
