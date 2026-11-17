// The title page's show parts (v0.30): the season tabs, a season's episodes as a list (classic layouts) or as Orbit's
// row of wide cards, the story under it following the remote. Same elements as the older page.
import { api } from '../api.js';
import { html, useState, useRef, useLayoutEffect } from '../ui.js';
import { Button, Icon, Spinner } from '../ui/basics.js';
import { Art } from '../ui/cards.js';
import { episodeCaption, cardState } from '../components.js';
import { isOrbit } from '../app.js';
import { followFocus } from '../backdrop.js';
import { resumeInfo, rowStartEpisode } from '../item-rules.js';

/**
 * The Episodes section: a tab per season (one tab stop, Left/Right between them, the panel named by its tab) and the
 * selected season's episodes. `first`: the selected season's answer, fetched with the page. `selected`: a ref the
 * page's "…" reads (Add season to playlist, Download season). Switching fast shows the season picked last.
 */
export function Seasons({ show, seasons, first, rise, selected }) {
  const [sel, setSel] = useState(first?.item.id ?? null);
  const [season, setSeason] = useState(first);
  const want = useRef(sel);
  const tabs = useRef(null);
  selected.current = sel;
  const panelId = `season-panel-${show.id}`;
  const pick = async (s) => {
    want.current = s.id;
    setSel(s.id);
    setSeason(null);
    history.replaceState(null, '', `#/item/${show.id}?season=${s.id}`);
    const sd = await api.get(`/api/items/${s.id}`);
    if (want.current === s.id) setSeason(sd); // an older answer arriving late is dropped
  };
  const onKeyDown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const all = [...tabs.current.children];
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    const next = all[i + (e.key === 'ArrowRight' ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    next.focus();
    next.click();
  };
  const episodes = season?.episodes || [];
  return html`<section class="detail-section" data-rise=${rise}>
    <h2 class="visually-hidden">Episodes</h2>
    <div class="season-tabs" role="tablist" aria-label="Seasons" ref=${tabs} onKeyDown=${onKeyDown}>
      ${seasons.map((s) => {
        const done = s.childCount && !s.unwatched;
        const on = s.id === sel;
        return html`<button key=${s.id} type="button" role="tab" class="season-tab" id=${`season-tab-${s.id}`} aria-controls=${panelId} tabindex=${on ? '0' : '-1'} data-id=${s.id} aria-selected=${String(on)} title=${`${s.childCount || 0} episodes${done ? ', all watched' : ''}`} onClick=${() => pick(s)}>${s.title}${done ? html`<${Icon} name="check" size=${14} label="All watched" />` : null}</button>`;
      })}
    </div>
    <div class="season-panel" role="tabpanel" id=${panelId} aria-labelledby=${sel ? `season-tab-${sel}` : null}>
      ${!sel ? null : !season ? html`<${Spinner} />` : [
        season.item.overview && season.item.overview !== show.overview ? html`<p class="season-overview muted">${season.item.overview}</p>` : null,
        isOrbit() ? html`<${EpisodeRow} key=${sel} episodes=${episodes} />` : html`<${EpisodeList} key=${sel} episodes=${episodes} />`,
      ]}
    </div>
  </section>`;
}

const Watched = () => html`<span class="badge badge-watched"><${Icon} name="check" size=${14} label="Watched" /></span>`;
const Progress = ({ ep }) => {
  const r = resumeInfo(ep);
  return r && ep.duration ? html`<div class="progress"><span style=${{ width: `${Math.min(100, (r.position / ep.duration) * 100)}%` }} /></div>` : null;
};
const playLabel = (ep) => `Play episode ${ep.episode}: ${ep.title}${cardState(ep)}`;

/** The classic layouts: a season's episodes as a list (picture, number and title, date and length, story). */
export function EpisodeList({ episodes }) {
  if (!episodes.length) return html`<p class="muted">No episodes found.</p>`;
  return html`<ol class="episodes" role="list">${episodes.map((ep) => {
    const bits = [ep.airDate ? new Date(ep.airDate).toLocaleDateString() : null, episodeCaption(ep)].filter(Boolean);
    return html`<li key=${ep.id} class=${`episode${ep.progress?.watched ? ' is-watched' : ''}`}>
      <a class="episode-thumb" href=${`#/play/${ep.id}`} aria-label=${playLabel(ep)}>
        <${Art} key=${ep.poster || ''} src=${ep.poster} title=${ep.title} kind="landscape" />
        <span class="card-play"><${Icon} name="play" size=${20} /></span>
        ${ep.progress?.watched ? html`<${Watched} />` : null}
        <${Progress} ep=${ep} />
      </a>
      <div class="episode-info">
        <h3><a href=${`#/item/${ep.id}`}><span class="ep-num">${`${ep.episode}.`}</span>${` ${ep.title}`}</a></h3>
        ${bits.length ? html`<p class="muted small">${bits.join(' · ')}</p>` : null}
        ${ep.overview ? html`<p class="episode-overview">${ep.overview}</p>` : null}
      </div>
    </li>`;
  })}</ol>`;
}

/**
 * Orbit: a season's episodes as a row of wide cards. The selected episode's story shows under the row, next to an
 * Episode details button that Down reaches. OK on a card plays that episode.
 */
export function EpisodeRow({ episodes }) {
  // The episode the story describes at first: the one to resume, else the first unwatched, else the first.
  const start = rowStartEpisode(episodes);
  const [shown, setShown] = useState(start);
  const cards = useRef(null);
  useLayoutEffect(() => {
    const el = cards.current;
    if (!el) return undefined;
    followFocus(el, (card) => episodes[[...el.children].indexOf(card)], (ep) => setShown(ep));
    // Open the row at that episode, so the story matches the card at the start and Down lands on it (it may be far
    // along a long season). Waits for the row to be on the page; gives up after a second.
    if (start === episodes[0]) return undefined;
    let tries = 0;
    let frame = 0;
    const reveal = () => {
      if (!el.isConnected) return void (tries++ < 60 && (frame = requestAnimationFrame(reveal)));
      const card = el.children[episodes.indexOf(start)];
      const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
      el.scrollLeft += card.getBoundingClientRect().left - el.getBoundingClientRect().left - pad;
    };
    frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, []);
  if (!episodes.length) return html`<p class="muted">No episodes found.</p>`;
  return html`<div class="episode-browser">
    <div class="row-scroller row-landscape episode-row" ref=${cards}>
      ${episodes.map((ep) => {
        const length = episodeCaption(ep);
        return html`<a key=${ep.id} class=${`card episode-card${ep.progress?.watched ? ' is-watched' : ''}`} href=${`#/play/${ep.id}`} aria-label=${playLabel(ep)}>
          <div class="card-art"><${Art} key=${ep.poster || ''} src=${ep.poster} title=${ep.title} kind="landscape" />${ep.progress?.watched ? html`<${Watched} />` : null}<${Progress} ep=${ep} /></div>
          <div class="card-meta"><span class="card-title">${`${ep.episode}. ${ep.title}`}</span>${length ? html`<span class="card-sub">${length}</span>` : null}</div>
        </a>`;
      })}
    </div>
    <div class="episode-about">
      <p class="episode-story"><strong>${`${shown.title}.`}</strong>${shown.overview ? ` ${shown.overview}` : ''}</p>
      <${Button} label="Episode details" icon="info" variant="ghost" href=${`#/item/${shown.id}`} attrs=${{ 'aria-label': `Episode details: ${shown.episode}. ${shown.title}` }} />
    </div>
  </div>`;
}
