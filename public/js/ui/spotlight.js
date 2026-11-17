// Building block (v0.26): the Preact version of components.js's spotlight() — big info about one title, with Play
// (or `playAs`, e.g. "Resume S1 · E3"), More info and Trailer. Same markup as the helper for the same item
// (checked in devtools/v026-ui.mjs `blocks`). Preact keeps the buttons' elements between titles, so the remote's
// focus stays put as the spotlight follows it.
import { html, useState, useLayoutEffect, useRef } from '../ui.js';
import { Icon } from './basics.js';
import { episodeLabel, formatRuntime } from '../dom.js';
import { itemHref, endsAt, timeLeft, orbitLayout } from '../components.js';
import { scoresText } from '../scores.js';
import { sizedAttrs } from '../sized.js';

/** metaLine(item): year · runtime or seasons/episodes · rating · scores · age rating. `rise`: the title page's data-rise. */
export function MetaLine({ item, extra = null, rise = null }) {
  const runtime = formatRuntime(item.runtime || (item.duration ? item.duration / 60 : null));
  const scores = scoresText(item.scores);
  const cert = item.certification ? String(item.certification).split(':').pop().trim() : '';
  return html`<div class="meta-line" data-rise=${rise}>
    ${item.year ? html`<span>${String(item.year)}</span>` : null}
    ${runtime && item.kind !== 'show' ? html`<span>${runtime}</span>` : null}
    ${item.kind === 'show' && item.seasonCount ? html`<span>${`${item.seasonCount} ${item.seasonCount === 1 ? 'season' : 'seasons'}`}</span>` : item.kind === 'show' && item.episodeCount ? html`<span>${`${item.episodeCount} episodes`}</span>` : null}
    ${item.rating ? html`<span class="rating"><${Icon} name="star" size=${14} />${` ${item.rating.toFixed(1)}`}</span>` : null}
    ${scores ? html`<span class="scores">${scores}</span>` : null}
    ${cert ? html`<span class="chip cert" title=${`Rated ${item.certification}`}>${cert}</span>` : null}
    ${extra}
  </div>`;
}

/** A spotlight button: hidden with no address (its label and icon stay, as the helper's do). */
const Btn = ({ cls, label, href, icon, autofocus = false }) => html`<a class=${cls} data-autofocus=${autofocus ? '' : null} href=${href || null} hidden=${!href}><${Icon} name=${icon} /><span>${label}</span></a>`;

/** spotlight(item, { onShow }) as a component. `quiet`: the same title with more details, no fade-in again.
 * `hidden`: the section is hidden and gives up the page's first focus (no data-autofocus on Play). */
export function Spotlight({ item, onShow, quiet = false, hidden = false }) {
  const inner = useRef(null);
  const [logoReady, setLogoReady] = useState(null); // the logo address that has loaded
  useLayoutEffect(() => {
    // Replay the fade-in for a new title (the helper does this on every show).
    const el = inner.current;
    if (!el || quiet) return;
    el.classList.remove('spot-fade');
    void el.offsetWidth;
    el.classList.add('spot-fade');
  }, [item]);
  useLayoutEffect(() => {
    if (item) onShow?.(item); // before paint, as the helper did at once
  }, [item]);
  if (!item) return html`<section class="spotlight" aria-label="Spotlight" hidden=${hidden}><div ref=${inner} class="spot-inner" /></section>`;
  const isEp = item.kind === 'episode';
  const playable = item.kind === 'movie' || isEp;
  const playAs = item.playAs || null;
  const resume = playAs ? Boolean(playAs.position) : item.progress && !item.progress.watched && item.progress.position > 30;
  const eyebrow = isEp ? [item.showTitle, episodeLabel(item)].filter(Boolean).join(' · ') : item.kind === 'album' && item.artist ? item.artist : '';
  const logoSrc = isEp ? item.showLogo : item.logo;
  const logoUrl = logoSrc ? sizedAttrs(logoSrc, 'logo', { orbit: orbitLayout(), width: Math.min(500, window.innerWidth * 0.62) * (window.devicePixelRatio || 1) }).src : null;
  const hasLogo = Boolean(logoUrl && logoReady === logoUrl);
  const left = playable ? endsAt(timeLeft(item)) : null;
  const genres = (item.genres || []).slice(0, 4).join(' / ');
  const overview = item.overview || (!item.kind ? item.subtitle || '' : '');
  const pos = playAs ? playAs.position : item.progress?.position;
  const dur = playAs ? playAs.duration : item.progress?.duration || item.duration;
  const showResume = Boolean(resume && dur);
  const detail = item.href || itemHref(item);
  const trailerHref = item.trailer ? (item.trailer.kind === 'local' ? `#/play/${item.trailer.itemId}?from=${item.id}` : `#/trailer/${item.id}`) : null;
  let primary;
  let secondary;
  if (playAs) {
    primary = { label: playAs.label, href: playAs.href, icon: 'play' };
    secondary = { label: 'More info', href: detail, icon: 'info' };
  } else if (playable) {
    primary = { label: resume ? 'Resume' : 'Play', href: `#/play/${item.id}`, icon: 'play' };
    secondary = { label: isEp ? 'Go to show' : 'More info', href: isEp && item.showId ? `#/item/${item.showId}` : detail, icon: 'info' };
  } else {
    const music = item.kind === 'album' || item.kind === 'artist';
    primary = { label: music ? 'Listen' : 'Open', href: detail, icon: music ? 'music' : 'forward' };
    secondary = { label: 'More info', href: null, icon: 'info' };
  }
  return html`<section class="spotlight" aria-label="Spotlight" hidden=${hidden}>
    <div ref=${inner} class=${`spot-inner spot-fade${hasLogo ? ' has-logo' : ''}`}>
      <p class="eyebrow spot-eyebrow" hidden=${!eyebrow}>${eyebrow}</p>
      <img class="spot-logo" alt="" decoding="async" hidden=${!hasLogo} ...${logoUrl ? { src: logoUrl } : {}} key=${logoUrl || 'none'} onLoad=${() => setLogoReady(logoUrl)} onError=${() => setLogoReady(null)} />
      <h1 class=${`spot-title${isEp ? ' is-episode' : ''}`}>${item.title || ''}</h1>
      <div class="spot-meta"><${MetaLine} item=${item} extra=${left ? html`<span class="ends-at">${left}</span>` : null} /></div>
      <p class="spot-genres" hidden=${!genres}>${genres}</p>
      <p class="spot-overview" hidden=${!overview}>${overview}</p>
      <div class="spot-resume" hidden=${!showResume}>
        <div class="spot-resume-track"><span style=${showResume ? { width: `${Math.min(100, (pos / dur) * 100)}%` } : null} /></div>
        <span class="spot-resume-text">${showResume ? `${formatRuntime(Math.max(1, (dur - pos) / 60))} left` : ''}</span>
      </div>
      <div class="actions spot-actions">
        <${Btn} cls="btn btn-primary" autofocus=${!hidden} ...${primary} />
        <${Btn} cls="btn btn-secondary" ...${secondary} />
        <${Btn} cls="btn btn-ghost" label="Trailer" href=${trailerHref} icon="film" />
      </div>
    </div>
  </section>`;
}
