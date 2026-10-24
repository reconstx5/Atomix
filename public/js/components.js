// Reusable UI pieces: cards, rows, hero banner, dialogs, toasts.
import { scoresText } from './scores.js';
import { reduceMotion } from './motion.js';
import { h, icon, clear, hueFor, episodeLabel, formatRuntime, formatClock, MARK } from './dom.js';
import { posterFraction } from './library-rules.js';
import { listCard } from './lists.js';
import { sizedAttrs } from './sized.js';

// ---- Artwork ----
/** True on Orbit: it asks for artwork at the size shown (v0.24); the older themes keep the originals. */
export const orbitLayout = () => document.body?.dataset.layout === 'orbit';
let eagerBudget = 0;
/** The next `n` cards load at once (Home's first row): what's on screen first comes first. */
export function eagerCards(n) {
  eagerBudget = n;
}
/** Whether a picture loads at once: asked to (eager), or one of the first cards while the budget lasts (v0.26: shared with ui/cards.js). */
export function eagerTake(eager) {
  const now = eager || eagerBudget > 0;
  if (!eager && eagerBudget > 0) eagerBudget--;
  return now;
}
export const ART_TYPE = { poster: 'poster', square: 'square', landscape: 'backdrop' };

export function art(src, title, { kind = 'poster', eager = false, alt = '' } = {}) {
  const hue = hueFor(title || '');
  const placeholder = h('div', { class: 'art-placeholder', style: { '--hue': hue } }, h('span', {}, title || ''));
  const wrap = h('div', { class: `art art-${kind}` }, placeholder);
  if (src) {
    const now = eagerTake(eager);
    // Asked to load at once by its caller (a header cover): not a card. Home's budgeted first cards are cards.
    const sizes = sizedAttrs(src, ART_TYPE[kind] || 'poster', { orbit: orbitLayout(), eager: now, card: !eager });
    const img = h('img', {
      loading: now ? 'eager' : 'lazy',
      decoding: 'async',
      width: kind === 'poster' || kind === 'square' ? 300 : 480,
      height: kind === 'poster' ? 450 : kind === 'square' ? 300 : 270,
      ...(sizes.srcset ? { sizes: sizes.sizes, srcset: sizes.srcset } : {}),
      src: sizes.src,
      alt,
    });
    img.addEventListener('load', () => wrap.classList.add('loaded'));
    img.addEventListener('error', () => img.remove());
    wrap.append(img);
  }
  return wrap;
}

function progressBar(item) {
  // v0.25 (Orbit): a show part-way through carries a line too, for how many of its episodes are watched.
  if (orbitLayout() && item.kind === 'show') {
    const f = posterFraction(item);
    // Shown only on the Movies and TV Shows page (orbit.css); other Orbit pages keep their show posters as they were.
    return f == null ? null : h('div', { class: 'progress is-show-line', role: 'presentation' }, h('span', { style: { width: `${Math.min(100, Math.max(2, f * 100))}%` } }));
  }
  const p = item.progress;
  if (!p || p.watched || !p.position) return null;
  const dur = p.duration || item.duration;
  if (!dur) return null;
  const pct = Math.min(100, Math.max(2, (p.position / dur) * 100));
  return h('div', { class: 'progress', role: 'presentation' }, h('span', { style: { width: `${pct}%` } }));
}

/**
 * What a card shows besides its title, in words — its accessible name replaces everything inside it, so the
 * watched tick, the unwatched count and the time-left line have to be said here: ", watched" | ", 3 unwatched" |
 * ", 23 min left" | "".
 */
export function cardState(item) {
  const p = item.progress;
  if (p?.watched) return ', watched';
  if (item.kind === 'show' && item.unwatched > 0) return `, ${item.unwatched} unwatched`;
  if (item.kind === 'podcast' && item.newCount > 0) return `, ${item.newCount} new`;
  const dur = p?.duration || item.duration;
  if (p && p.position > 30 && dur) return `, ${Math.max(1, Math.ceil((dur - p.position) / 60))} min left`;
  return '';
}

function badge(item) {
  if (item.progress?.watched) return h('span', { class: 'badge badge-watched', title: 'Watched' }, icon('check', { size: 14, label: 'Watched' }));
  if (item.kind === 'show' && item.unwatched > 0) return h('span', { class: 'badge', title: `${item.unwatched} unwatched` }, String(item.unwatched));
  if (item.kind === 'podcast' && item.newCount > 0) return h('span', { class: 'badge badge-new', title: `${item.newCount} new` }, String(item.newCount));
  if (item.needsTool) return h('span', { class: 'badge badge-tool', title: item.needsTool }, '7-Zip'); // v0.22: a CBR waiting for 7-Zip
  return null;
}

export function itemHref(item) {
  if (item.href) return item.href;
  if (item.kind === 'season') return `#/item/${item.showId}?season=${item.id}`;
  return `#/item/${item.id}`;
}

/** The item behind each card element (used by the spotlight and focus-following backdrops). */
export const cardItems = new WeakMap();
const remember = (el, item) => (cardItems.set(el, item), el);

/** Portrait card for movies and shows. */
export function posterCard(item) {
  const sub = item.note ? (item.kind === 'episode' && item.showTitle ? `${item.showTitle} · ${item.note}` : item.note) : item.kind === 'episode' ? `${item.showTitle || ''} · ${episodeLabel(item)}` : item.subtitle || (item.kind === 'series' ? 'Series' : item.kind === 'book' ? item.author : null) || item.year || (item.kind === 'season' && item.childCount ? `${item.childCount} episodes` : '');
  return remember(h(
    'a',
    { class: 'card poster-card', href: itemHref(item), 'aria-label': `${item.title}${item.year ? ` (${item.year})` : ''}${cardState(item)}` },
    h('div', { class: 'card-art' }, art(item.poster, item.title), badge(item), progressBar(item)),
    h('div', { class: 'card-meta' }, h('span', { class: 'card-title' }, item.title), sub ? h('span', { class: 'card-sub' }, String(sub)) : null),
  ), item);
}

/** Square card for albums and artists (artists get a round picture). */
export function squareCard(item) {
  const isArtist = item.kind === 'artist';
  const count = item.childCount;
  const spoken = item.kind === 'podcast' || item.kind === 'audiobook';
  const by = item.artist || item.author; // podcasts and audiobooks (v0.22) carry an author
  const sub = isArtist ? (count ? `${count} ${count === 1 ? 'album' : 'albums'}` : 'Artist') : [by, item.year].filter(Boolean).join(' · ');
  return remember(h(
    'a',
    { class: `card square-card${isArtist ? ' is-artist' : ''}`, href: itemHref(item), 'aria-label': `${item.title}${!isArtist && by ? ` by ${by}` : ''}${spoken ? cardState(item) : ''}` },
    h('div', { class: 'card-art' }, art(item.poster, item.title, { kind: 'square' }), spoken ? badge(item) : null, spoken ? progressBar(item) : null),
    h('div', { class: 'card-meta' }, h('span', { class: 'card-title' }, item.title), sub ? h('span', { class: 'card-sub' }, sub) : null),
  ), item);
}

/**
 * Live TV's wide card ("On now"): what's on, the channel, how far in. Enter plays the channel (a radio station in
 * the music player). Not a library title, so the spotlight doesn't follow it.
 */
export function liveCard(item) {
  const label = item.title && item.title !== item.subtitle ? `Watch ${item.title} on ${item.subtitle}` : `Watch ${item.subtitle}`;
  const pct = Math.round(Math.max(0, Math.min(1, Number(item.progress) || 0)) * 100);
  const play = async (e) => {
    if (!item.radio) return; // the link plays it
    e.preventDefault();
    (await import('./live.js')).playChannel({ id: item.channelId, radio: true, name: item.subtitle, logo: item.logo, now: null });
  };
  return h(
    'a',
    { class: 'card landscape-card live-card', href: `#/live/play/${item.channelId}`, 'aria-label': label, dataset: { channel: item.channelId }, onClick: play },
    h(
      'div',
      { class: `card-art${item.image && item.image === item.logo ? ' is-logo' : ''}` },
      art(item.image, item.subtitle, { kind: 'landscape' }),
      h('span', { class: 'live-badge card-live', 'aria-hidden': 'true' }, item.radio ? 'RADIO' : 'LIVE'),
      h('div', { class: 'progress', role: 'presentation' }, h('span', { style: { width: `${Math.max(2, pct)}%` } })),
    ),
    h('div', { class: 'card-meta' }, h('span', { class: 'card-title' }, item.title), h('span', { class: 'card-sub' }, item.subtitle)),
  );
}

/**
 * A web app's tile (v0.22): the household's shortcut to a site with no API. It opens the site in a new tab (sites
 * like these refuse to be framed); the picture comes from Atomix, or the name's first letter stands in.
 */
export function appCard(app) {
  return h(
    'a',
    { class: 'card app-card card-app', href: app.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${app.name} (opens in a new tab)` },
    h('div', { class: 'card-art' }, app.image ? h('img', { src: app.image, alt: '', loading: 'lazy', decoding: 'async' }) : h('span', { class: 'app-letter', 'aria-hidden': 'true' }, (app.name.trim()[0] || '?').toUpperCase())),
    h('div', { class: 'card-meta' }, h('span', { class: 'card-title' }, app.name)),
  );
}

const cardFor = (style, item, opts) => (style === 'apps' ? appCard(item) : item?.kind === 'live' ? liveCard(item) : style === 'list' ? listCard(item) : style === 'landscape' ? landscapeCard(item, opts) : style === 'square' ? squareCard(item) : posterCard(item));

/** Captions for a wide card: the classic line, and Orbit's "S1 · E4, 23m left" (its top area names the episode). */
/**
 * What an episode card says under its title: "Watched", "<n> min left" (past 30 s and not finished), or its length.
 * Returns '' when nothing is known.
 */
export function episodeCaption(ep) {
  const p = ep.progress;
  if (p?.watched) return 'Watched';
  const dur = p?.duration || ep.duration;
  if (p && p.position > 30 && dur) return `${Math.max(1, Math.ceil((dur - p.position) / 60))} min left`;
  return formatRuntime(ep.runtime || (ep.duration ? ep.duration / 60 : null)) || '';
}

export function wideCaption(item) {
  if (item.extraKind) {
    const sub = [item.caption, item.duration ? (item.duration < 60 ? formatClock(item.duration) : formatRuntime(item.duration / 60)) : null].filter(Boolean).join(' · ');
    return { title: item.title, sub, left: sub };
  }
  if (item.kind === 'podcast_episode') {
    const left = episodeCaption(item);
    return { title: item.title, sub: item.showTitle || '', left: [item.showTitle, left].filter(Boolean).join(', ') };
  }
  const isEp = item.kind === 'episode';
  const label = isEp ? episodeLabel(item) : '';
  const title = isEp ? item.showTitle || item.title : item.title;
  // v0.23: a plugin row's note ("4 episodes left") is the card's caption.
  if (item.note) {
    const line = isEp && label ? `${label} · ${item.note}` : item.note;
    return { title, sub: line, left: line };
  }
  const sub = isEp ? `${label} · ${item.title}` : String(item.year || '');
  const p = item.progress;
  const dur = p?.duration || item.duration;
  if (isEp) {
    // Episodes carry the same caption as the season row: Watched, or how much is left (never the plain length here).
    const state = p?.watched ? 'Watched' : p && p.position > 30 && dur ? episodeCaption(item) : '';
    return { title, sub, left: [label, state].filter(Boolean).join(', ') };
  }
  const left = p && !p.watched && p.position > 30 && dur ? `${formatRuntime(Math.max(1, (dur - p.position) / 60))} left` : '';
  return { title, sub, left: left || sub };
}

/** Wide card for "continue watching" and episodes. Clicking resumes playback. */
export function landscapeCard(item, { play = true } = {}) {
  const isEp = item.kind === 'episode';
  const image = isEp ? item.poster || item.showBackdrop : item.backdrop || item.poster || item.ownerBackdrop;
  const cap = wideCaption(item);
  const title = cap.title;
  const href = item.href || (play ? `#/play/${item.id}` : itemHref(item));
  return remember(h(
    'a',
    { class: 'card landscape-card', href, 'aria-label': `${play ? 'Play ' : ''}${title}${isEp ? `, ${episodeLabel(item)}, ${item.title}` : ''}${cardState(item)}` },
    h(
      'div',
      { class: 'card-art' },
      art(image, title, { kind: 'landscape' }),
      isEp && episodeLabel(item) ? h('span', { class: 'card-tag', 'aria-hidden': 'true' }, episodeLabel(item)) : null,
      play ? h('span', { class: 'card-play' }, icon('play', { size: 22 })) : null,
      badge(item),
      progressBar(item),
    ),
    h('div', { class: 'card-meta' }, h('span', { class: 'card-title' }, title), cap.sub ? h('span', { class: 'card-sub' }, cap.sub) : null, cap.left ? h('span', { class: 'card-sub card-sub-orbit' }, cap.left) : null),
  ), item);
}

/** Horizontal scrolling row with keyboard-friendly scroll buttons. */
export function row({ title, subtitle, items, style = 'poster', href, id, inMenu = false }) {
  const scroller = h('div', { class: `row-scroller row-${style}` });
  for (const item of items) scroller.append(cardFor(style, item));
  const scrollBy = (dir) => scroller.scrollBy({ left: dir * scroller.clientWidth * 0.85, behavior: reduceMotion() ? 'auto' : 'smooth' });
  // Orbit's remote moves between cards, so a heading whose page is also in the menu (Home's rows) is for a mouse there;
  // a heading that is the only way somewhere (Part of <collection> on a film) stays in the remote's path.
  const heading = href ? h('a', { href, class: 'row-title-link', tabindex: inMenu && document.body.dataset.layout === 'orbit' ? '-1' : null }, title, icon('forward', { size: 18 })) : title;
  return h(
    'section',
    { class: 'row', dataset: id ? { row: id } : {} },
    h('h2', { class: 'row-title' }, heading),
    subtitle ? h('p', { class: 'row-subtitle muted' }, subtitle) : null,
    h(
      'div',
      { class: 'row-body' },
      h('button', { class: 'row-nav row-prev', type: 'button', tabindex: '-1', 'aria-label': 'Scroll left', onClick: () => scrollBy(-1) }, icon('back')),
      scroller,
      h('button', { class: 'row-nav row-next', type: 'button', tabindex: '-1', 'aria-label': 'Scroll right', onClick: () => scrollBy(1) }, icon('forward')),
    ),
  );
}

export function grid(items, { style = 'poster' } = {}) {
  const g = h('div', { class: `grid grid-${style}`, role: 'list' });
  for (const item of items) {
    const card = cardFor(style, item, { play: false });
    card.setAttribute('role', 'listitem');
    g.append(card);
  }
  return g;
}

/** "Ends at 9:42 pm" for something with `seconds` left to watch. */
export function endsAt(seconds) {
  if (!seconds || seconds < 60) return null;
  const end = new Date(Date.now() + seconds * 1000);
  return `Ends at ${end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

/** Remaining playing time of an item, in seconds (from its progress if it's half-watched). */
export function timeLeft(item) {
  const total = item.progress?.duration || item.duration || (item.runtime ? item.runtime * 60 : 0);
  if (!total) return 0;
  const pos = item.progress && !item.progress.watched ? item.progress.position || 0 : 0;
  return Math.max(0, total - pos);
}

const CHANNELS = { 1: 'Mono', 2: 'Stereo', 6: '5.1', 7: '6.1', 8: '7.1' };
/** Kodi-style media flags from a title's file: 4K · HDR · HEVC · 5.1 · DTS. */
export function mediaFlags(item) {
  const m = item.media;
  if (!m) return [];
  const flags = [];
  if (m.resolution) flags.push(m.resolution);
  if (m.hdr) flags.push('HDR');
  if (m.videoCodec) flags.push({ h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', mpeg2video: 'MPEG-2' }[m.videoCodec] || m.videoCodec.toUpperCase());
  const a = m.audio?.find((t) => t.default) || m.audio?.[0];
  if (a?.channels) flags.push(CHANNELS[a.channels] || `${a.channels}ch`);
  if (a?.codec) flags.push({ aac: 'AAC', ac3: 'Dolby Digital', eac3: 'DD+', truehd: 'TrueHD', dts: 'DTS', flac: 'FLAC', opus: 'Opus', mp3: 'MP3' }[a.codec] || a.codec.toUpperCase());
  if (m.subtitles) flags.push('CC');
  return flags;
}

export function metaLine(item) {
  const bits = [];
  if (item.year) bits.push(h('span', {}, String(item.year)));
  const runtime = formatRuntime(item.runtime || (item.duration ? item.duration / 60 : null));
  if (runtime && item.kind !== 'show') bits.push(h('span', {}, runtime));
  if (item.kind === 'show' && item.seasonCount) bits.push(h('span', {}, `${item.seasonCount} ${item.seasonCount === 1 ? 'season' : 'seasons'}`)); // v0.25: the library spotlight
  else if (item.kind === 'show' && item.episodeCount) bits.push(h('span', {}, `${item.episodeCount} episodes`));
  if (item.rating) bits.push(h('span', { class: 'rating' }, icon('star', { size: 14 }), ` ${item.rating.toFixed(1)}`));
  const scores = scoresText(item.scores); // v0.23: IMDb, Rotten Tomatoes, Metacritic
  if (scores) bits.push(h('span', { class: 'scores' }, scores));
  // Age rating, e.g. "NZ:R16" → R16 (resolution and codecs live in the media flags).
  const cert = item.certification ? String(item.certification).split(':').pop().trim() : '';
  if (cert) bits.push(h('span', { class: 'chip cert', title: `Rated ${item.certification}` }, cert));
  return h('div', { class: 'meta-line' }, bits);
}

export function button(label, { icon: iconName, variant = 'secondary', onClick, href, autofocus, title, type = 'button', attrs = {} } = {}) {
  const content = [iconName ? icon(iconName) : null, label ? h('span', {}, label) : null];
  const cls = `btn btn-${variant}${label ? '' : ' btn-icon'}`;
  if (href) return h('a', { class: cls, href, 'data-autofocus': autofocus || null, title, 'aria-label': label ? null : title, ...attrs }, content);
  return h('button', { class: cls, type, onClick, 'data-autofocus': autofocus || null, title, 'aria-label': label ? null : title, ...attrs }, content);
}

/**
 * Kodi-style spotlight: big info about one title (the featured one, then whatever
 * card has focus). Returns { el, show(item) }. The buttons are updated in place so
 * keyboard focus is never lost.
 */
export function spotlight(initial, { onShow } = {}) {
  const eyebrow = h('p', { class: 'eyebrow spot-eyebrow' });
  // A clear logo (transparent title artwork) replaces the name when there is one.
  const logo = h('img', { class: 'spot-logo', alt: '', decoding: 'async', hidden: true });
  const title = h('h1', { class: 'spot-title' });
  const meta = h('div', { class: 'spot-meta' });
  const genres = h('p', { class: 'spot-genres' });
  const overview = h('p', { class: 'spot-overview' });
  const resumeBar = h('div', { class: 'spot-resume', hidden: true }, h('div', { class: 'spot-resume-track' }, h('span')), h('span', { class: 'spot-resume-text' }));
  const primary = h('a', { class: 'btn btn-primary', 'data-autofocus': true }, icon('play'), h('span', {}, 'Play'));
  const secondary = h('a', { class: 'btn btn-secondary' }, icon('info'), h('span', {}, 'More info'));
  const trailerBtn = h('a', { class: 'btn btn-ghost', hidden: true }, icon('film'), h('span', {}, 'Trailer'));
  const inner = h('div', { class: 'spot-inner' }, eyebrow, logo, title, meta, genres, overview, resumeBar, h('div', { class: 'actions spot-actions' }, primary, secondary, trailerBtn));
  const el = h('section', { class: 'spotlight', 'aria-label': 'Spotlight' }, inner);
  let logoFor = null;
  const setLogo = (src, name, { isEpisode }) => {
    logoFor = src;
    inner.classList.toggle('has-logo', false);
    title.classList.toggle('is-episode', isEpisode);
    if (!src) {
      logo.hidden = true;
      logo.removeAttribute('src');
      return;
    }
    logo.alt = ''; // the (visually hidden) heading names the title; the picture would say it twice
    logo.onload = () => {
      if (logoFor !== src) return;
      logo.hidden = false;
      inner.classList.add('has-logo');
    };
    logo.onerror = () => {
      if (logoFor === src) logo.hidden = true;
    };
    logo.src = sizedAttrs(src, 'logo', { orbit: orbitLayout(), width: Math.min(500, window.innerWidth * 0.62) * (window.devicePixelRatio || 1) }).src;
  };
  const setBtn = (btn, label, href, iconName) => {
    btn.hidden = !href;
    if (!href) return;
    btn.href = href;
    btn.querySelector('span').textContent = label;
    btn.querySelector('svg').replaceWith(icon(iconName));
  };
  let shown = null;

  // quiet: the same title with more details (v0.25: the library's Resume and Trailer); no fade-in again.
  function show(item, { quiet = false } = {}) {
    if (!item || item === shown) return;
    shown = item;
    const isEp = item.kind === 'episode';
    const playable = item.kind === 'movie' || isEp;
    // v0.25: playAs ({ label, href, position, duration }) names the primary button (a show's "Resume S1 · E3").
    const playAs = item.playAs || null;
    const resume = playAs ? Boolean(playAs.position) : item.progress && !item.progress.watched && item.progress.position > 30;
    // Only say where something belongs when it isn't obvious (the show, the artist).
    eyebrow.textContent = isEp ? [item.showTitle, episodeLabel(item)].filter(Boolean).join(' · ') : item.kind === 'album' && item.artist ? item.artist : '';
    eyebrow.hidden = !eyebrow.textContent;
    title.textContent = item.title || '';
    // Episodes: the show's logo on top, the episode's name underneath.
    setLogo(isEp ? item.showLogo : item.logo, isEp ? item.showTitle : item.title, { isEpisode: isEp });
    const line = metaLine(item);
    const left = playable ? endsAt(timeLeft(item)) : null;
    if (left) line.append(h('span', { class: 'ends-at' }, left));
    clear(meta).append(line);
    genres.textContent = (item.genres || []).slice(0, 4).join(' / ');
    genres.hidden = !genres.textContent;
    overview.textContent = item.overview || (!item.kind ? item.subtitle || '' : ''); // plugin cards only have a subtitle
    overview.hidden = !overview.textContent;
    // Half-watched: how far through, and how long is left.
    const pos = playAs ? playAs.position : item.progress?.position;
    const dur = playAs ? playAs.duration : item.progress?.duration || item.duration;
    resumeBar.hidden = !(resume && dur);
    if (resume && dur) {
      resumeBar.querySelector('.spot-resume-track span').style.width = `${Math.min(100, (pos / dur) * 100)}%`;
      resumeBar.querySelector('.spot-resume-text').textContent = `${formatRuntime(Math.max(1, (dur - pos) / 60))} left`;
    }
    const detail = item.href || itemHref(item);
    // The featured title's trailer (cards don't carry one).
    trailerBtn.hidden = !item.trailer;
    if (item.trailer) trailerBtn.href = item.trailer.kind === 'local' ? `#/play/${item.trailer.itemId}?from=${item.id}` : `#/trailer/${item.id}`;
    if (playAs) {
      setBtn(primary, playAs.label, playAs.href, 'play');
      setBtn(secondary, 'More info', detail, 'info');
    } else if (playable) {
      setBtn(primary, resume ? 'Resume' : 'Play', `#/play/${item.id}`, 'play');
      setBtn(secondary, isEp ? 'Go to show' : 'More info', isEp && item.showId ? `#/item/${item.showId}` : detail, 'info');
    } else {
      setBtn(primary, item.kind === 'album' || item.kind === 'artist' ? 'Listen' : 'Open', detail, item.kind === 'album' || item.kind === 'artist' ? 'music' : 'forward');
      setBtn(secondary, '', null);
    }
    // Replay the fade-in.
    if (!quiet) {
      inner.classList.remove('spot-fade');
      void inner.offsetWidth;
      inner.classList.add('spot-fade');
    }
    onShow?.(item);
  }
  show(initial);
  return { el, show, get shown() { return shown; } };
}

const AVATAR_COLORS = { ember: '#ff6b3d', teal: '#14b8a6', violet: '#8b5cf6', gold: '#f5b942', rose: '#f43f5e', sky: '#38bdf8', lime: '#84cc16', slate: '#64748b' };
export const AVATAR_NAMES = Object.keys(AVATAR_COLORS);

/** A round profile picture: the first letter on the profile's colour. */
export function avatar(profile, size = 40) {
  const color = AVATAR_COLORS[profile?.avatar] || AVATAR_COLORS.slate;
  const letter = (profile?.name || '?').trim().charAt(0).toUpperCase() || '?';
  return h('span', { class: 'avatar', style: { '--avatar': color, '--size': `${size}px` }, 'aria-hidden': 'true' }, letter);
}

/** The one empty state: an icon for the kind of thing, a heading (h1 when it is the page), a line, and what to do. */
export function emptyState({ title, text, action, icon: iconName = 'film', level = 2 }) {
  return h('div', { class: 'empty-state' }, h('div', { class: 'empty-icon' }, icon(iconName, { size: 40 })), h(`h${level}`, {}, title), text ? h('p', {}, text) : null, action ? h('div', { class: 'actions' }, action) : null);
}

export const LOADER = `<svg viewBox="0 0 32 32" width="44" height="44" fill="currentColor" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
  <g class="n1"><path d="${MARK.orbits[1]}" fill="none" stroke-width="1.7"/><circle cx="${MARK.electron.cx}" cy="${MARK.electron.cy}" r="${MARK.electron.r}" stroke="none"/></g>
  <path class="n2" d="${MARK.orbits[0]}" fill="none" stroke-width="1.7"/>
  <path class="n3" d="${MARK.nucleus}" stroke-width="1.6"/>
</svg>`;

/**
 * Loading indicator. A page or section shows the Atomix mark (its orbits, then the nucleus, lighting up in turn);
 * `inline` gives the small ring that sits inside a control (the player's buffering, the cast picker's search).
 */
export function spinner(label = 'Loading', { inline = false, size = 18 } = {}) {
  if (inline) return h('span', { class: 'spinner', role: 'status', 'aria-label': label, style: { '--spinner-size': `${size}px` } });
  return h('div', { class: 'spinner-wrap', role: 'status' }, h('span', { class: 'loader', 'aria-hidden': 'true', html: LOADER }), h('span', { class: 'visually-hidden' }, label));
}

/**
 * A row's actions (Edit, Delete…) the same way everywhere: labelled ghost buttons on a wide classic layout, the "…"
 * sheet on Orbit and on phones. `items`: { label, icon, danger, onSelect }.
 */
export function rowActions(title, items) {
  const list = items.filter(Boolean);
  // Both forms, so a window resized across 720 px switches without a redraw; CSS shows one (the other isn't
  // focusable or read: display none).
  const compact = h('span', { class: 'row-actions-compact' }, moreButton(title, list.map((it) => ({ label: it.label, icon: it.icon, danger: it.danger, onSelect: it.onSelect }))));
  // Every row shows the same words, so the spoken name carries the row's title ("Delete Mia"), as the "…" does.
  const wide = h('span', { class: 'row-actions-wide' }, list.map((it) => button(it.label, { icon: it.icon, variant: it.danger ? 'ghost danger' : 'ghost', onClick: it.onSelect, title: it.title || null, attrs: title ? { 'aria-label': `${it.label} ${title}` } : {} })));
  return h('div', { class: 'row-actions' }, wide, compact);
}

/** The toasts background work and saves use, so the same thing is said the same way on every page. */
export const TOASTS = {
  scanStarted: () => toast('Scan started'),
  syncStarted: () => toast('Sync started'),
  refreshStarted: () => toast('Refresh started'),
  saved: (what) => toast(`${what} saved`, { type: 'success' }),
};

/**
 * A radio group with one tab stop: the checked radio (else the first) is reachable with Tab; the arrows move between
 * the radios (the spatial navigation does that for every layout) and Enter/Space picks one. Kept right as
 * aria-checked changes.
 */
export function rovingRadios(group) {
  const sync = () => {
    const radios = [...group.querySelectorAll('[role=radio]')];
    const on = radios.find((r) => r.getAttribute('aria-checked') === 'true') || radios[0];
    for (const r of radios) r.tabIndex = r === on ? 0 : -1;
  };
  new MutationObserver(sync).observe(group, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-checked'] });
  sync();
  return group;
}

// ---- What screen readers hear ----
// Two hidden regions made once at boot (a region made in the same moment as its first message is often not read):
// polite for news (page changes, Up next), alert for errors.
let livePolite = null;
let liveAlert = null;
export function ensureLiveRegions() {
  if (livePolite || typeof document === 'undefined') return;
  livePolite = h('div', { id: 'live-polite', class: 'visually-hidden', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  liveAlert = h('div', { id: 'live-alert', class: 'visually-hidden', role: 'alert', 'aria-live': 'assertive', 'aria-atomic': 'true' });
  document.body.append(livePolite, liveAlert);
}
/**
 * Says `text` once to a screen reader. Each sentence is its own node added a frame later (an addition is read even
 * when the same sentence was just said), so two announcements in one frame are both kept — a toast after an action
 * is never overwritten by whatever else that action said. Old sentences are dropped after a few seconds.
 */
export function announce(text, { assertive = false } = {}) {
  ensureLiveRegions();
  const region = assertive ? liveAlert : livePolite;
  if (!region) return;
  const line = h('p', {}, String(text || ''));
  requestAnimationFrame(() => {
    region.append(line);
    setTimeout(() => line.remove(), 4000);
  });
}

/**
 * Keeps a slider's spoken value current without chattering: while it has focus it is rewritten at most every 10 s
 * (playback moves it 4 times a second); `force` (a scrub, a key press, focus) writes at once. Unchanged text is never
 * rewritten. `focused`/`now` are for tests.
 */
export function sliderText(input, text, { force = false, focused = typeof document !== 'undefined' && document.activeElement === input, now = Date.now() } = {}) {
  // Arriving on the slider: the next write goes through (it is read as the slider is announced).
  if (!input.__sliderWired && typeof input.addEventListener === 'function') {
    input.__sliderWired = true;
    input.addEventListener('focus', () => (input.__spokenAt = null));
  }
  if (input.getAttribute('aria-valuetext') === text) return;
  const last = input.__spokenAt;
  if (focused && !force && last != null && now - last < 10000) return;
  input.setAttribute('aria-valuetext', text);
  input.__spokenAt = now;
}

/** A 0–1 slider (volume) whose spoken value is a percentage, kept right however `.value` is set. */
export function percentSlider(input) {
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const say = () => input.setAttribute('aria-valuetext', `${Math.round(Number(proto.get.call(input)) * 100)}%`);
  Object.defineProperty(input, 'value', {
    get: () => proto.get.call(input),
    set: (v) => {
      proto.set.call(input, v);
      say();
    },
  });
  input.addEventListener('input', say);
  say();
  return input;
}

// ---- Toasts ----
let toastRoot;
export function toast(message, { type = 'info', timeout = 4000 } = {}) {
  if (!toastRoot) {
    // Shown, not spoken: the live regions above do the speaking (an error assertively).
    toastRoot = h('div', { class: 'toasts' });
    document.body.append(toastRoot);
  }
  const el = h('div', { class: `toast toast-${type}` }, message);
  toastRoot.append(el);
  announce(message, { assertive: type === 'error' });
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

// ---- Dialogs (native <dialog>) ----
let dialogCount = 0;
/**
 * openDialog({ title, body, actions: [{ label, value, variant }] }) → Promise<returnValue>
 * `body` may be a node or a function receiving the dialog element.
 */
export function openDialog({ title, body, actions = [{ label: 'Close', value: 'close' }], wide = false, onSubmit }) {
  return new Promise((resolve) => {
    const form = h('form', { method: 'dialog', class: 'dialog-form' });
    const formError = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const titleId = `dlg-title-${++dialogCount}`; // dialogs stack (Browse… over Add a library): each needs its own
    const dialog = h('dialog', { class: `dialog${wide ? ' dialog-wide' : ''}`, 'aria-labelledby': titleId, closedby: 'any' }, form);
    const content = typeof body === 'function' ? body(dialog) : body;
    append(form, [
      // type=button: the first submit button is what Enter presses, and that must not be "close".
      h('header', { class: 'dialog-head' }, h('h2', { id: titleId }, title), h('button', { type: 'button', class: 'btn btn-ghost btn-icon', 'aria-label': 'Close', onClick: () => dialog.close('cancel') }, icon('close'))),
      h('div', { class: 'dialog-body' }, formError, content),
      actions.length
        ? h(
            'footer',
            { class: 'dialog-actions' },
            actions.map((a) => h('button', { class: `btn btn-${a.variant || 'secondary'}`, value: a.value, formnovalidate: a.value === 'cancel' || null }, a.label)),
          )
        : null,
    ]);
    form.addEventListener('submit', async (e) => {
      const value = e.submitter?.value;
      if (onSubmit && value && value !== 'cancel' && value !== 'close') {
        e.preventDefault();
        try {
          formError.hidden = true;
          const ok = await onSubmit(value, form);
          if (ok !== false) dialog.close(value);
        } catch (err) {
          // In the dialog itself: a toast would sit under the modal's backdrop, dimmed and out of reach.
          formError.textContent = err.message;
          formError.hidden = false;
        }
      }
    });
    // Enter in a text field means "OK" (the primary button), not the first button in the form.
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing) return;
      const t = e.target;
      if (t.tagName !== 'INPUT' || ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(t.type)) return;
      const primary = form.querySelector('.dialog-actions .btn-primary, .dialog-actions .btn-danger');
      if (!primary) return;
      e.preventDefault();
      primary.click();
    });
    // Light-dismiss fallback for browsers without closedby support.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close('cancel');
    });
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue || 'cancel');
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    // Browsers focus the first button (the close ×); a field marked data-autofocus is more useful.
    dialog.querySelector('.dialog-body [data-autofocus]')?.focus();
  });
}

function append(el, children) {
  for (const c of children) if (c) el.append(c);
}

export async function confirmDialog(title, text, { confirm = 'OK', danger = false } = {}) {
  const v = await openDialog({
    title,
    body: h('p', {}, text),
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: confirm, value: 'ok', variant: danger ? 'danger' : 'primary' },
    ],
  });
  return v === 'ok';
}

/**
 * A short list of actions in a small panel: the "…" menu, a song's menu. Items are
 * { label, icon, onSelect } or, for links, { label, icon, href, download }. Falsy items are skipped;
 * the first one has the focus, and choosing one closes the panel.
 */
export function openSheet(title, items) {
  const entry = (it, i) => {
    // v0.25: `current` marks the choice in force (a sort, a genre) with a tick.
    const content = [icon(it.current ? 'check' : it.icon, { size: 22 }), h('span', {}, it.label)];
    const close = (e) => e.currentTarget.closest('dialog')?.close('done');
    if (it.href) return h('a', { class: 'sheet-item', href: it.href, download: it.download || null, 'data-autofocus': i === 0 || null, onClick: close }, content);
    return h('button', { type: 'button', class: `sheet-item${it.danger ? ' danger' : ''}${it.current ? ' is-current' : ''}`, 'aria-current': it.current ? 'true' : null, 'data-autofocus': i === 0 || null, onClick: (e) => (close(e), it.onSelect()) }, content);
  };
  return openDialog({ title, body: h('div', { class: 'sheet' }, items.filter(Boolean).map(entry)), actions: [] });
}

/** A round "…" button that opens `items` in a sheet (see openSheet). */
export function moreButton(title, items) {
  // "More options for <title>": forty rows of plain "More" can't be told apart by ear.
  return button('', { icon: 'more', title: 'More', onClick: () => openSheet(title, items), attrs: { 'aria-haspopup': 'dialog', 'aria-label': title ? `More options for ${title}` : 'More options' } });
}

export function field(label, input, hint) {
  const id = input.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  const hintId = hint ? `${id}-hint` : null;
  if (hintId) input.setAttribute('aria-describedby', hintId);
  return h('div', { class: 'field' }, h('label', { for: id }, label), hint ? h('p', { class: 'hint', id: hintId }, hint) : null, input);
}

/** A switch. `hint` adds a line under the label saying what it does. */
export function toggle(label, checked, onChange, { hint } = {}) {
  const id = `t-${Math.random().toString(36).slice(2, 9)}`;
  const input = h('input', { type: 'checkbox', id, role: 'switch', checked, 'aria-describedby': hint ? `${id}-hint` : null, onChange: (e) => onChange?.(e.target.checked) });
  const text = hint ? h('span', { class: 'toggle-text' }, h('span', {}, label), h('span', { class: 'toggle-hint', id: `${id}-hint` }, hint)) : h('span', {}, label);
  return h('label', { class: 'toggle', for: id }, input, h('span', { class: 'toggle-track', 'aria-hidden': 'true' }), text);
}

export { clear };

/**
 * Where an empty list's "Browse …" button goes: the movies library for video lists (the Watchlist, a mixed
 * playlist), a music library for music lists; null when there is no library of that kind (no button then).
 */
export function browseTarget(libraries, kind) {
  const want = kind === 'music' ? 'music' : 'movies';
  const lib = (libraries || []).find((l) => l.type === want);
  if (!lib) return null;
  return want === 'music' ? { label: 'Browse Music', href: `#/library/${lib.id}`, icon: 'music' } : { label: 'Browse Movies', href: `#/library/${lib.id}`, icon: 'film' };
}
