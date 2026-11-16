// Building blocks (v0.26): the Preact versions of components.js's art(), posterCard(), squareCard(),
// landscapeCard(), liveCard(), grid() and row(). (An img's src/srcset/sizes are left out rather than null: Preact
// would write them as empty attributes.) Same markup as the helpers (checked in devtools/v026-ui.mjs
// `blocks`); each card registers its element in cardItems, which the backdrop and the spotlight read.
import { html, useState, useRef, useLayoutEffect } from '../ui.js';
import { Icon } from './basics.js';
import { hueFor, episodeLabel } from '../dom.js';
import { cardItems, cardState, itemHref, wideCaption, orbitLayout, eagerTake, ART_TYPE, tintStyle, decoded } from '../components.js';
import { cardInfoLine, cardLabel } from '../card-motion-rules.js';
import { posterFraction } from '../library-rules.js';
import { sizedAttrs } from '../sized.js';
import { reduceMotion } from '../motion.js';
import { mosaic } from '../lists.js';
import { unplayableHere, liveTarget } from '../dash/playable.js';

const remember = (item) => (el) => el && cardItems.set(el, item);

/** art(src, title, { kind, eager, alt }): the placeholder, then the picture once it loads (gone if it fails).
 * Callers key it by its address, so a new picture starts fresh (not loaded, not failed).
 * Card motion v2: decoded first, then a 180 ms fade (CSS); a picture already there when drawn shows at once. */
export function Art({ src, title, kind = 'poster', eager = false, alt = '' }) {
  const [now] = useState(() => (src ? eagerTake(eager) : false)); // a card's place in Home's budget is taken once
  const [loaded, setLoaded] = useState(false); // false, true (faded in) or 'instant' (there when drawn)
  const [failed, setFailed] = useState(false);
  const img = useRef(null);
  useLayoutEffect(() => {
    const el = img.current;
    if (el?.complete && el.naturalWidth) setLoaded('instant'); // before the first paint: no placeholder, no fade
  }, []);
  const sizes = src ? sizedAttrs(src, ART_TYPE[kind] || 'poster', { orbit: orbitLayout(), eager: now, card: !eager }) : null;
  return html`<div class=${`art art-${kind}${loaded ? ' loaded' : ''}${loaded === 'instant' ? ' is-instant' : ''}`}>
    <div class="art-placeholder" style=${{ '--hue': hueFor(title || '') }}><span>${title || ''}</span></div>
    ${src && !failed
      ? html`<img
          loading=${now ? 'eager' : 'lazy'}
          decoding="async"
          width=${kind === 'poster' || kind === 'square' ? 300 : 480}
          height=${kind === 'poster' ? 450 : kind === 'square' ? 300 : 270}
          ...${sizes.srcset ? { sizes: sizes.sizes, srcset: sizes.srcset } : {}}
          src=${sizes.src}
          alt=${alt}
          ref=${img}
          onLoad=${(e) => decoded(e.currentTarget).then(() => setLoaded((was) => was || true))}
          onError=${() => setFailed(true)}
        />`
      : null}
  </div>`;
}

function Badge({ item }) {
  if (item.progress?.watched) return html`<span class="badge badge-watched" title="Watched"><${Icon} name="check" size=${14} label="Watched" /></span>`;
  if (item.kind === 'show' && item.unwatched > 0) return html`<span class="badge" title=${`${item.unwatched} unwatched`}>${String(item.unwatched)}</span>`;
  if (item.kind === 'podcast' && item.newCount > 0) return html`<span class="badge badge-new" title=${`${item.newCount} new`}>${String(item.newCount)}</span>`;
  if (item.needsTool) return html`<span class="badge badge-tool" title=${item.needsTool}>7-Zip</span>`;
  return null;
}

const bar = (cls, pct) => html`<div class=${cls} role="presentation"><span style=${{ width: `${pct}%` }} /></div>`;
function Progress({ item }) {
  // Orbit: a show part-way through carries a line for its episodes watched (shown only on the library page, orbit.css).
  if (orbitLayout() && item.kind === 'show') {
    const f = posterFraction(item);
    return f == null ? null : bar('progress is-show-line', Math.min(100, Math.max(2, f * 100)));
  }
  const p = item.progress;
  if (!p || p.watched || !p.position) return null;
  const dur = p.duration || item.duration;
  if (!dur) return null;
  return bar('progress', Math.min(100, Math.max(2, (p.position / dur) * 100)));
}

const meta = (title, sub, left) => html`<div class="card-meta">
  <span class="card-title">${title}</span>
  ${sub ? html`<span class="card-sub">${String(sub)}</span>` : null}
  ${left ? html`<span class="card-sub card-sub-orbit">${left}</span>` : null}
</div>`;

/** posterCard(item): films and shows. `role`: "listitem" inside a Grid. */
export function PosterCard({ item, role }) {
  const sub = item.note ? (item.kind === 'episode' && item.showTitle ? `${item.showTitle} · ${item.note}` : item.note) : item.kind === 'episode' ? `${item.showTitle || ''} · ${episodeLabel(item)}` : item.subtitle || (item.kind === 'series' ? 'Series' : item.kind === 'book' ? item.author : null) || item.year || (item.kind === 'season' && item.childCount ? `${item.childCount} episodes` : '');
  const info = cardInfoLine(item);
  return html`<a ref=${remember(item)} class="card poster-card" href=${itemHref(item)} aria-label=${cardLabel(item, cardState(item))} role=${role || null} style=${tintStyle(item, 'poster')}>
    <div class="card-art"><${Art} key=${item.poster || ''} src=${item.poster} title=${item.title} /><${Badge} item=${item} /><${Progress} item=${item} />${info ? html`<span class="card-info">${info}</span>` : null}</div>
    ${meta(item.title, sub)}
  </a>`;
}

/** squareCard(item): albums, artists (round), podcasts and audiobooks. */
export function SquareCard({ item, role }) {
  const isArtist = item.kind === 'artist';
  const count = item.childCount;
  const spoken = item.kind === 'podcast' || item.kind === 'audiobook';
  const by = item.artist || item.author;
  const sub = isArtist ? (count ? `${count} ${count === 1 ? 'album' : 'albums'}` : 'Artist') : [by, item.year].filter(Boolean).join(' · ');
  return html`<a ref=${remember(item)} class=${`card square-card${isArtist ? ' is-artist' : ''}`} href=${itemHref(item)} aria-label=${`${item.title}${!isArtist && by ? ` by ${by}` : ''}${spoken ? cardState(item) : ''}`} role=${role || null}>
    <div class="card-art"><${Art} key=${item.poster || ''} src=${item.poster} title=${item.title} kind="square" />${spoken ? html`<${Badge} item=${item} /><${Progress} item=${item} />` : null}</div>
    ${meta(item.title, sub)}
  </a>`;
}

/** landscapeCard(item, { play }): Continue watching and episodes; `play` makes Enter resume. */
export function LandscapeCard({ item, play = true, role }) {
  const isEp = item.kind === 'episode';
  const image = isEp ? item.poster || item.showBackdrop : item.backdrop || item.poster || item.ownerBackdrop;
  const cap = wideCaption(item);
  const href = item.href || (play ? `#/play/${item.id}` : itemHref(item));
  return html`<a ref=${remember(item)} class="card landscape-card" href=${href} aria-label=${`${play ? 'Play ' : ''}${cap.title}${isEp ? `, ${episodeLabel(item)}, ${item.title}` : ''}${cardState(item)}`} role=${role || null} style=${tintStyle(item, 'landscape')}>
    <div class="card-art">
      <${Art} key=${image || ''} src=${image} title=${cap.title} kind="landscape" />
      ${isEp && episodeLabel(item) ? html`<span class="card-tag" aria-hidden="true">${episodeLabel(item)}</span>` : null}
      ${play ? html`<span class="card-play"><${Icon} name="play" size=${22} /></span>` : null}
      <${Badge} item=${item} /><${Progress} item=${item} />
    </div>
    ${meta(cap.title, cap.sub, cap.left)}
  </a>`;
}

/** liveCard(item): Live TV's "On now" card; a radio station plays in the music player. Not in cardItems (not a title). */
export function LiveCard({ item, role }) {
  const label = (item.title && item.title !== item.subtitle ? `Watch ${item.title} on ${item.subtitle}` : `Watch ${item.subtitle}`) + (item.unplayable ? ", can't play here" : '');
  const pct = Math.round(Math.max(0, Math.min(1, Number(item.progress) || 0)) * 100);
  const play = async (e) => {
    if (!item.radio && !unplayableHere(item.drm)) return; // the link plays it
    e.preventDefault();
    if (!item.radio) return (await import('../live.js')).playChannel(liveTarget(item)); // v0.28: the card saying why
    (await import('../live.js')).playChannel({ id: item.channelId, radio: true, name: item.subtitle, logo: item.logo, now: null });
  };
  // v0.28: a channel this device can't play, shown with the switch on: dimmed, with "Can't play here".
  return html`<a class=${`card landscape-card live-card${item.unplayable ? ' is-unplayable' : ''}`} href=${`#/live/play/${item.channelId}`} aria-label=${label} data-channel=${item.channelId} onClick=${play} role=${role || null}>
    <div class=${`card-art${item.image && item.image === item.logo ? ' is-logo' : ''}`}>
      <${Art} key=${item.image || ''} src=${item.image} title=${item.subtitle} kind="landscape" />
      <span class="live-badge card-live" aria-hidden="true">${item.radio ? 'RADIO' : 'LIVE'}</span>
      ${item.unplayable ? html`<span class="chip live-cant card-cant" aria-hidden="true">Can't play here</span>` : null}
      ${bar('progress', Math.max(2, pct))}
    </div>
    ${meta(item.title, item.subtitle)}
  </a>`;
}

/** listCard(list) (lists.js): a playlist card, the name over a 2 × 2 mosaic of its first posters. v0.28. */
export function ListCard({ list }) {
  const songs = list.kind === 'music' || (list.kind === 'smart' && list.media === 'music');
  const count = (songs ? `${list.count} ${list.count === 1 ? 'song' : 'songs'}` : `${list.count} ${list.count === 1 ? 'title' : 'titles'}`) + (list.kind === 'smart' ? ' · Smart playlist' : '');
  return html`<a class="card card-list" href=${`#/lists/${list.id}`} data-id=${list.id}>
    <div class="card-art list-mosaic">${[0, 1, 2, 3].map((i) => (list.posters[i] ? html`<img key=${i} loading="lazy" decoding="async" ...${mosaic(list.posters[i])} alt="" />` : html`<span key=${i} class="list-blank" />`))}${list.kind === 'watchlist' ? html`<${Icon} name="plus" size=${28} />` : null}</div>
    <div class="card-meta"><span class="card-title">${list.name}</span><span class="card-sub">${`${count}${list.own ? '' : ` · ${list.ownerName}`}`}</span></div>
  </a>`;
}

/** appCard(app) (components.js): a web app's tile, opening the site in a new tab. v0.28. */
export function AppCard({ app }) {
  return html`<a class="card app-card card-app" href=${app.url} target="_blank" rel="noopener noreferrer" aria-label=${`${app.name} (opens in a new tab)`}>
    <div class="card-art">${app.image ? html`<img src=${app.image} alt="" loading="lazy" decoding="async" />` : html`<span class="app-letter" aria-hidden="true">${(app.name.trim()[0] || '?').toUpperCase()}</span>`}</div>
    <div class="card-meta"><span class="card-title">${app.name}</span></div>
  </a>`;
}

const keyOf = (item, i) => item?.id ?? `i${i}`;
/** The card for a style, as components.js's cardFor (the `list` and `apps` styles arrive with their screens). */
function Card({ style, item, play, role }) {
  if (style === 'apps') return html`<${AppCard} app=${item} />`;
  if (item?.kind === 'live') return html`<${LiveCard} item=${item} role=${role} />`;
  if (style === 'list') return html`<${ListCard} list=${item} />`;
  if (style === 'landscape') return html`<${LandscapeCard} item=${item} play=${play} role=${role} />`;
  if (style === 'square') return html`<${SquareCard} item=${item} role=${role} />`;
  return html`<${PosterCard} item=${item} role=${role} />`;
}

/** grid(items, { style }). */
export function Grid({ items, style = 'poster' }) {
  return html`<div class=${`grid grid-${style}`} role="list">${items.map((item, i) => html`<${Card} key=${keyOf(item, i)} style=${style} item=${item} play=${false} role="listitem" />`)}</div>`;
}

/** row({ title, subtitle, items, style, href, id, inMenu }): a scrolling row with mouse scroll buttons. */
export function Row({ title, subtitle, items, style = 'poster', href, id, inMenu = false }) {
  const scroller = useRef(null);
  const scrollBy = (dir) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.85, behavior: reduceMotion() ? 'auto' : 'smooth' });
  // Orbit's remote moves between cards: a heading whose page is in the menu too is for a mouse there.
  const heading = href ? html`<a href=${href} class="row-title-link" tabindex=${inMenu && document.body.dataset.layout === 'orbit' ? '-1' : null}>${title}<${Icon} name="forward" size=${18} /></a>` : title;
  return html`<section class="row" data-row=${id || null}>
    <h2 class="row-title">${heading}</h2>
    ${subtitle ? html`<p class="row-subtitle muted">${subtitle}</p>` : null}
    <div class="row-body">
      <button class="row-nav row-prev" type="button" tabindex="-1" aria-label="Scroll left" onClick=${() => scrollBy(-1)}><${Icon} name="back" /></button>
      <div ref=${scroller} class=${`row-scroller row-${style}`}>${items.map((item, i) => html`<${Card} key=${keyOf(item, i)} style=${style} item=${item} play=${true} />`)}</div>
      <button class="row-nav row-next" type="button" tabindex="-1" aria-label="Scroll right" onClick=${() => scrollBy(1)}><${Icon} name="forward" /></button>
    </div>
  </section>`;
}
