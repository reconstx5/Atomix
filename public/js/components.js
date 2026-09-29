// Reusable UI pieces: cards, rows, hero banner, dialogs, toasts.
import { h, icon, clear, hueFor, episodeLabel, formatRuntime } from './dom.js';

// ---- Artwork ----
export function art(src, title, { kind = 'poster', eager = false, alt = '' } = {}) {
  const hue = hueFor(title || '');
  const placeholder = h('div', { class: 'art-placeholder', style: { '--hue': hue } }, h('span', {}, title || ''));
  const wrap = h('div', { class: `art art-${kind}` }, placeholder);
  if (src) {
    const img = h('img', {
      src,
      alt,
      loading: eager ? 'eager' : 'lazy',
      decoding: 'async',
      width: kind === 'poster' || kind === 'square' ? 300 : 480,
      height: kind === 'poster' ? 450 : kind === 'square' ? 300 : 270,
    });
    img.addEventListener('load', () => wrap.classList.add('loaded'));
    img.addEventListener('error', () => img.remove());
    wrap.append(img);
  }
  return wrap;
}

function progressBar(item) {
  const p = item.progress;
  if (!p || p.watched || !p.position) return null;
  const dur = p.duration || item.duration;
  if (!dur) return null;
  const pct = Math.min(100, Math.max(2, (p.position / dur) * 100));
  return h('div', { class: 'progress', role: 'presentation' }, h('span', { style: { width: `${pct}%` } }));
}

function badge(item) {
  if (item.progress?.watched) return h('span', { class: 'badge badge-watched', title: 'Watched' }, icon('check', { size: 14, label: 'Watched' }));
  if (item.kind === 'show' && item.unwatched > 0) return h('span', { class: 'badge', title: `${item.unwatched} unwatched` }, String(item.unwatched));
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
  const sub = item.kind === 'episode' ? `${item.showTitle || ''} · ${episodeLabel(item)}` : item.subtitle || item.year || (item.kind === 'season' && item.childCount ? `${item.childCount} episodes` : '');
  return remember(h(
    'a',
    { class: 'card poster-card', href: itemHref(item), 'aria-label': `${item.title}${item.year ? ` (${item.year})` : ''}` },
    h('div', { class: 'card-art' }, art(item.poster, item.title), badge(item), progressBar(item)),
    h('div', { class: 'card-meta' }, h('span', { class: 'card-title' }, item.title), sub ? h('span', { class: 'card-sub' }, String(sub)) : null),
  ), item);
}

/** Square card for albums and artists (artists get a round picture). */
export function squareCard(item) {
  const isArtist = item.kind === 'artist';
  const count = item.childCount;
  const sub = isArtist ? (count ? `${count} ${count === 1 ? 'album' : 'albums'}` : 'Artist') : [item.artist, item.year].filter(Boolean).join(' · ');
  return remember(h(
    'a',
    { class: `card square-card${isArtist ? ' is-artist' : ''}`, href: itemHref(item), 'aria-label': `${item.title}${!isArtist && item.artist ? ` by ${item.artist}` : ''}` },
    h('div', { class: 'card-art' }, art(item.poster, item.title, { kind: 'square' })),
    h('div', { class: 'card-meta' }, h('span', { class: 'card-title' }, item.title), sub ? h('span', { class: 'card-sub' }, sub) : null),
  ), item);
}

const cardFor = (style, item, opts) => (style === 'landscape' ? landscapeCard(item, opts) : style === 'square' ? squareCard(item) : posterCard(item));

/** Wide card for "continue watching" and episodes. Clicking resumes playback. */
export function landscapeCard(item, { play = true } = {}) {
  const isEp = item.kind === 'episode';
  const image = isEp ? item.poster || item.showBackdrop : item.backdrop || item.poster;
  const title = isEp ? item.showTitle || item.title : item.title;
  const sub = isEp ? `${episodeLabel(item)} · ${item.title}` : item.year || '';
  const href = item.href || (play ? `#/play/${item.id}` : itemHref(item));
  return remember(h(
    'a',
    { class: 'card landscape-card', href, 'aria-label': `${play ? 'Play ' : ''}${title}${isEp ? `, ${episodeLabel(item)}, ${item.title}` : ''}` },
    h(
      'div',
      { class: 'card-art' },
      art(image, title, { kind: 'landscape' }),
      isEp && episodeLabel(item) ? h('span', { class: 'card-tag', 'aria-hidden': 'true' }, episodeLabel(item)) : null,
      play ? h('span', { class: 'card-play' }, icon('play', { size: 22 })) : null,
      badge(item),
      progressBar(item),
    ),
    h('div', { class: 'card-meta' }, h('span', { class: 'card-title' }, title), sub ? h('span', { class: 'card-sub' }, String(sub)) : null),
  ), item);
}

/** Horizontal scrolling row with keyboard-friendly scroll buttons. */
export function row({ title, items, style = 'poster', href }) {
  const scroller = h('div', { class: `row-scroller row-${style}` });
  for (const item of items) scroller.append(cardFor(style, item));
  const scrollBy = (dir) => scroller.scrollBy({ left: dir * scroller.clientWidth * 0.85, behavior: 'smooth' });
  const heading = href ? h('a', { href, class: 'row-title-link' }, title, icon('forward', { size: 18 })) : title;
  return h(
    'section',
    { class: 'row' },
    h('h2', { class: 'row-title' }, heading),
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
  if (item.kind === 'show' && item.episodeCount) bits.push(h('span', {}, `${item.episodeCount} episodes`));
  if (item.rating) bits.push(h('span', { class: 'rating' }, icon('star', { size: 14 }), ` ${item.rating.toFixed(1)}`));
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
  const inner = h('div', { class: 'spot-inner' }, eyebrow, logo, title, meta, genres, overview, resumeBar, h('div', { class: 'actions spot-actions' }, primary, secondary));
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
    logo.alt = name || '';
    logo.onload = () => {
      if (logoFor !== src) return;
      logo.hidden = false;
      inner.classList.add('has-logo');
    };
    logo.onerror = () => {
      if (logoFor === src) logo.hidden = true;
    };
    logo.src = src;
  };
  const setBtn = (btn, label, href, iconName) => {
    btn.hidden = !href;
    if (!href) return;
    btn.href = href;
    btn.querySelector('span').textContent = label;
    btn.querySelector('svg').replaceWith(icon(iconName));
  };
  let shown = null;

  function show(item) {
    if (!item || item === shown) return;
    shown = item;
    const isEp = item.kind === 'episode';
    const playable = item.kind === 'movie' || isEp;
    const resume = item.progress && !item.progress.watched && item.progress.position > 30;
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
    const dur = item.progress?.duration || item.duration;
    resumeBar.hidden = !(resume && dur);
    if (resume && dur) {
      resumeBar.querySelector('.spot-resume-track span').style.width = `${Math.min(100, (item.progress.position / dur) * 100)}%`;
      resumeBar.querySelector('.spot-resume-text').textContent = `${formatRuntime(Math.max(1, (dur - item.progress.position) / 60))} left`;
    }
    const detail = item.href || itemHref(item);
    if (playable) {
      setBtn(primary, resume ? 'Resume' : 'Play', `#/play/${item.id}`, 'play');
      setBtn(secondary, isEp ? 'Go to show' : 'More info', isEp && item.showId ? `#/item/${item.showId}` : detail, 'info');
    } else {
      setBtn(primary, item.kind === 'album' || item.kind === 'artist' ? 'Listen' : 'Open', detail, item.kind === 'album' || item.kind === 'artist' ? 'music' : 'forward');
      setBtn(secondary, '', null);
    }
    // Replay the fade-in.
    inner.classList.remove('spot-fade');
    void inner.offsetWidth;
    inner.classList.add('spot-fade');
    onShow?.(item);
  }
  show(initial);
  return { el, show };
}

const AVATAR_COLORS = { ember: '#ff6b3d', teal: '#14b8a6', violet: '#8b5cf6', gold: '#f5b942', rose: '#f43f5e', sky: '#38bdf8', lime: '#84cc16', slate: '#64748b' };
export const AVATAR_NAMES = Object.keys(AVATAR_COLORS);

/** A round profile picture: the first letter on the profile's colour. */
export function avatar(profile, size = 40) {
  const color = AVATAR_COLORS[profile?.avatar] || AVATAR_COLORS.slate;
  const letter = (profile?.name || '?').trim().charAt(0).toUpperCase() || '?';
  return h('span', { class: 'avatar', style: { '--avatar': color, '--size': `${size}px` }, 'aria-hidden': 'true' }, letter);
}

export function emptyState({ title, text, action }) {
  return h('div', { class: 'empty-state' }, h('div', { class: 'empty-icon' }, icon('film', { size: 40 })), h('h2', {}, title), text ? h('p', {}, text) : null, action || null);
}

const LOADER = `<svg viewBox="0 0 32 32" width="44" height="44"><path d="M11 9.5 L23 16 L11 22.5 Z" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.6" stroke-linejoin="round"/><circle class="n1" cx="11" cy="9.5" r="2.6"/><circle class="n2" cx="23" cy="16" r="2.6"/><circle class="n3" cx="11" cy="22.5" r="2.6"/></svg>`;

/** Loading indicator: the NodeFlix mark's three nodes lighting up in turn. */
export function spinner(label = 'Loading') {
  return h('div', { class: 'spinner-wrap', role: 'status' }, h('span', { class: 'loader', 'aria-hidden': 'true', html: LOADER }), h('span', { class: 'visually-hidden' }, label));
}

// ---- Toasts ----
let toastRoot;
export function toast(message, { type = 'info', timeout = 4000 } = {}) {
  if (!toastRoot) {
    toastRoot = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastRoot);
  }
  const el = h('div', { class: `toast toast-${type}` }, message);
  toastRoot.append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

// ---- Dialogs (native <dialog>) ----
/**
 * openDialog({ title, body, actions: [{ label, value, variant }] }) → Promise<returnValue>
 * `body` may be a node or a function receiving the dialog element.
 */
export function openDialog({ title, body, actions = [{ label: 'Close', value: 'close' }], wide = false, onSubmit }) {
  return new Promise((resolve) => {
    const form = h('form', { method: 'dialog', class: 'dialog-form' });
    const dialog = h('dialog', { class: `dialog${wide ? ' dialog-wide' : ''}`, 'aria-labelledby': 'dlg-title', closedby: 'any' }, form);
    const content = typeof body === 'function' ? body(dialog) : body;
    append(form, [
      // type=button: the first submit button is what Enter presses, and that must not be "close".
      h('header', { class: 'dialog-head' }, h('h2', { id: 'dlg-title' }, title), h('button', { type: 'button', class: 'btn btn-ghost btn-icon', 'aria-label': 'Close', onClick: () => dialog.close('cancel') }, icon('close'))),
      h('div', { class: 'dialog-body' }, content),
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
          const ok = await onSubmit(value, form);
          if (ok !== false) dialog.close(value);
        } catch (err) {
          toast(err.message, { type: 'error' });
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

export function field(label, input, hint) {
  const id = input.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  const hintId = hint ? `${id}-hint` : null;
  if (hintId) input.setAttribute('aria-describedby', hintId);
  return h('div', { class: 'field' }, h('label', { for: id }, label), hint ? h('p', { class: 'hint', id: hintId }, hint) : null, input);
}

export function toggle(label, checked, onChange) {
  const id = `t-${Math.random().toString(36).slice(2, 9)}`;
  const input = h('input', { type: 'checkbox', id, role: 'switch', checked, onChange: (e) => onChange?.(e.target.checked) });
  return h('label', { class: 'toggle', for: id }, input, h('span', { class: 'toggle-track', 'aria-hidden': 'true' }), h('span', {}, label));
}

export { clear };
