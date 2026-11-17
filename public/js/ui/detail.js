// Building blocks for the title page (v0.30): the Preact versions of components.js's mediaChips() and metaLine()
// (with the "Ends at" time), item.js's logo box, the genre chips, lists.js's watchlistButton(), offline/ui.js's
// downloadButton() and rating.js's ratingControl(). Each draws the same elements, classes, attributes and text as
// the older helper for the same inputs (checked in devtools/item-blocks.mjs).
import { html, useState, useRef, useEffect } from '../ui.js';
import { Icon, Island } from './basics.js';
import { MetaLine } from './spotlight.js';
import { api } from '../api.js';
import { toast, mediaChipWords } from '../components.js';
import { sizedAttrs } from '../sized.js';
import { ratingControl } from '../rating.js';
import { downloads } from '../offline/downloader.js';
import { canDownloadHere, stateLabel, manage } from '../offline/ui.js';

/** mediaChips(item): 4K, the HDR kind, Atmos, 5.1/7.1, Subtitles as outlined chips; nothing when there's nothing to say. */
export function MediaChips({ item }) {
  const words = mediaChipWords(item);
  if (!words.length) return null;
  return html`<ul class="media-flags media-chips" aria-label="Picture and sound">${words.map((w) => html`<li>${w}</li>`)}</ul>`;
}

/** The title page's meta line: metaLine(item), then "Ends at …" when `ends` is set. `rise`: its data-rise. */
export function DetailMeta({ item, ends, rise }) {
  return html`<${MetaLine} item=${item} extra=${ends ? html`<span class="ends-at">${ends}</span>` : null} rise=${rise} />`;
}

/**
 * The title as its clear logo when there is one (v0.29 B4: in a fixed-height logo box, so nothing moves when it
 * arrives). The typed title shows in the box until the logo has loaded, and stays if it fails; it stays for screen
 * readers either way.
 */
export function TitleArt({ logo, title }) {
  if (!logo) return html`<h1 class="detail-title">${title}</h1>`;
  return html`<${LogoBox} key=${logo} logo=${logo} title=${title} />`;
}

function LogoBox({ logo, title }) {
  const [shown, setShown] = useState('waiting'); // waiting | loaded | failed
  const [src] = useState(() => sizedAttrs(logo, 'logo', { orbit: document.body?.dataset.layout === 'orbit', width: Math.min(600, window.innerWidth * 0.8) * (window.devicePixelRatio || 1) }).src);
  const on = shown === 'loaded';
  return html`<div class=${`logo-box${on ? ' has-logo' : ''}`}>
    ${shown === 'failed' ? null : html`<img class="detail-logo" hidden=${!on} src=${src} alt="" decoding="async" onLoad=${() => setShown('loaded')} onError=${() => setShown('failed')} />`}
    <h1 class=${`detail-title${on ? ' visually-hidden' : ''}`}>${title}</h1>
  </div>`;
}

/** A title's genres as chips. */
export function Genres({ genres }) {
  if (!genres?.length) return null;
  return html`<ul class="genres" role="list">${genres.map((g) => html`<li class="chip">${g}</li>`)}</ul>`;
}

/** watchlistButton(item, initialIn): a round button whose name stays "Watchlist"; aria-pressed says which. */
export function WatchlistButton({ item, initialIn }) {
  const [on, setOn] = useState(Boolean(initialIn));
  const [busy, setBusy] = useState(false);
  const going = useRef(false); // a press while the last one is on its way: aria-pressed must match the server
  const press = async () => {
    if (going.current) return;
    going.current = true;
    setBusy(true);
    try {
      if (on) await api.del(`/api/watchlist/${item.id}`);
      else await api.put(`/api/watchlist/${item.id}`, {});
      setOn(!on);
      toast(!on ? 'Added to your watchlist' : 'Removed from your watchlist');
    } catch (err) {
      toast(err.message, { type: 'error' });
    } finally {
      going.current = false;
      setBusy(false);
    }
  };
  return html`<button class="btn btn-ghost btn-icon watchlist-btn" type="button" onClick=${press} title=${on ? 'In your watchlist' : 'Add to watchlist'} aria-label="Watchlist" aria-pressed=${String(on)} aria-busy=${busy ? 'true' : null}><${Icon} name=${on ? 'check' : 'plus'} /></button>`;
}

/** downloadButton(item): Download into the app, its label following the download (none where downloads can't happen). */
export function DownloadButton({ item }) {
  const [st, setSt] = useState(undefined); // undefined until the first answer
  useEffect(() => {
    let live = true;
    const draw = async () => {
      const now = await downloads.state(item.id);
      if (live) setSt(now ?? null);
    };
    const onChange = (e) => e.detail.itemId === item.id && draw();
    downloads.events.addEventListener('change', onChange);
    draw();
    return () => {
      live = false;
      downloads.events.removeEventListener('change', onChange);
    };
  }, [item.id]);
  if (!canDownloadHere()) return null;
  return html`<button type="button" class="btn btn-ghost download-btn" data-status=${st === undefined ? null : st?.status || 'none'} onClick=${() => manage(item)}><span>${st === undefined ? 'Download' : stateLabel(st)}</span></button>`;
}

/** ratingControl(item): the heart and the stars. The older control, hosted as it is (its own listeners and events). */
export function RatingControl({ item }) {
  return html`<${Island} tag="div" class="my-rating" make=${() => [...ratingControl(item).childNodes]} deps=${[item]} />`;
}
