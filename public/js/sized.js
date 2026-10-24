// Artwork at the size it is shown (v0.24, Orbit): an Atomix picture address becomes src/srcset/sizes so the
// browser fetches a smaller copy (the server makes it once). Pure — no DOM — so the rules are tested under Node.
// The older themes keep the full-size originals (they must look exactly as they did).

export const LADDERS = {
  poster: [200, 300, 450, 600],
  square: [200, 300, 450, 600],
  backdrop: [480, 960, 1280, 1920],
  logo: [400, 800],
};

// How wide Orbit's cards are (orbit.css: --poster-w 196 × --px, --wide-w 336, --square-w 220, with --px clamped
// 0.72–2 px over 1/1920 of the width; 116 / 240 / 132 px on phones and portrait screens), for browsers without
// `sizes=auto` and for cards loaded at once (review fix: a flat 200px picked copies 1.7× too big on phones).
const card = (phone, n) => `(max-width: 999px) ${phone}px, (orientation: portrait) ${phone}px, clamp(${Math.round(n * 0.72)}px, ${+((n / 1920) * 100).toFixed(2)}vw, ${n * 2}px)`;
const FALLBACK = { poster: card(116, 196), square: card(132, 220), backdrop: card(240, 336), logo: '500px' };

/** An item's or a collection's picture address (the ones the server can size). */
export const isArtworkUrl = (url) => typeof url === 'string' && /^\/api\/(items|collections)\/\d+\/image\/[a-z]+(\?|$)/.test(url);

const withW = (url, w) => `${url}${url.includes('?') ? '&' : '?'}w=${w}`;

/**
 * @param {string|null} url
 * @param {'poster'|'square'|'backdrop'|'logo'} type
 * @param {{ orbit: boolean, eager?: boolean, width?: number|null, card?: boolean }} o width: the shown width × devicePixelRatio,
 *   known; card: one of Orbit's row cards (Home's first ones load at once with the card widths)
 * @returns {{ src: string|null, srcset?: string, sizes?: string }}
 */
export function sizedAttrs(url, type, { orbit, eager = false, width = null, card = false } = {}) {
  if (!orbit || !isArtworkUrl(url)) return { src: url };
  const ladder = LADDERS[type] || LADDERS.poster;
  if (width != null && Number(width) > 0) return { src: withW(url, ladder.find((s) => s >= Number(width)) ?? ladder.at(-1)) };
  // Loaded at once and not a card (a big header cover, Now Playing): the largest copy, never a blurry small one.
  if (eager && !card) return { src: withW(url, ladder.at(-1)) };
  return {
    src: withW(url, ladder[Math.floor((ladder.length - 1) / 2)]),
    srcset: ladder.map((w) => `${withW(url, w)} ${w}w`).join(', '),
    // `auto` (the laid-out width) works only on lazy images; eager ones get the plain guess.
    sizes: eager ? FALLBACK[type] || FALLBACK.poster : `auto, ${FALLBACK[type] || FALLBACK.poster}`,
  };
}
