// Building blocks (v0.26): Live TV's pieces as components — a channel's logo, the lock and recording dot, the older
// themes' row, Orbit's glass card and Orbit's spotlight. Each draws what v0.25's views/live.js and live-spot.js drew
// for the same channel (checked against v0.25's pages by devtools/v026-dom.mjs). The other screens use the same
// pieces as h() helpers from live-bits.js.
import { html, useState, useRef, useLayoutEffect } from '../ui.js';
import { Icon, MoreButton } from './basics.js';
import { initials, rowName } from '../live-bits.js';
import { clockTime, programmeProgress, castableDrm } from '../live.js';
import { channelTint, nextLine, minutesLeft } from '../live-rules.js';
import { setBackdrop } from '../backdrop.js';

/** The channel's logo, or its initials (also when the logo fails to load). */
export function ChannelLogo({ c, size = 'md' }) {
  const [failed, setFailed] = useState(null); // the logo address that failed
  const ok = c.logo && failed !== c.logo;
  return html`<span class=${`live-logo live-logo-${size}`} aria-hidden="true">${ok ? html`<img key=${c.logo} src=${c.logo} alt="" loading="lazy" onError=${() => setFailed(c.logo)} />` : html`<span class="live-initials">${initials(c.name)}</span>`}</span>`;
}

/** The small lock an encrypted channel carries. */
export const LockBadge = ({ c }) => (c.drm ? html`<span class="live-lock" title="Encrypted"><${Icon} name="lock" size=${14} /><span class="visually-hidden">Encrypted</span></span>` : null);

/** The red dot of a programme being recorded or scheduled to be. `silent`: not read again beside words that say it. */
export function RecDot({ p, silent = false }) {
  if (!p?.recording) return null;
  const text = p.recording === 'recording' ? 'Recording' : 'Recording scheduled';
  return html`<span class=${`rec-dot${p.recording === 'recording' ? ' is-recording' : ''}`} title=${text} aria-hidden=${silent ? 'true' : null}>${silent ? null : html`<span class="visually-hidden">${text}</span>`}</span>`;
}

const Bar = ({ p, now }) => (p ? html`<span class="live-bar" aria-hidden="true"><span style=${`--p:${programmeProgress(p, now)}`} /></span>` : null);
const Radio = ({ c }) => (c.radio ? html`<span class="chip live-radio">Radio</span>` : null);
// v0.28: a channel this device can't play, listed with the switch on: dimmed (the item's class) with this tag.
const CantTag = ({ c }) => (c.unplayable ? html`<span class="chip live-cant">Can't play here</span>` : null);
const itemClass = (c) => (c.unplayable ? 'live-item is-unplayable' : 'live-item');
const spoken = (c) => (c.unplayable ? `${rowName(c)}, can't play here` : rowName(c));

// Channels with Widevine, PlayReady or ClearKey can go to a Chromecast (v0.28; FairPlay-only ones can't); on a phone
// (which may not play them) that's "Watch on TV".
const castable = (c) => !c.radio && (!c.drm || castableDrm(c.drm));
const touch = () => Boolean(globalThis.matchMedia?.('(pointer: coarse)').matches);
const castLabel = (c) => (c?.drm && touch() ? 'Watch on TV' : 'Cast to…');

/** The older themes' row: logo, number, name, what's on (with its bar) and what's next, then "…". */
export function ChannelRow({ c, onPlay, onFavourite, onGuide, onCast, castOk, onAppLink = null }) {
  const now = Date.now();
  const more = [
    c.favourite ? { label: 'Remove from favourites', icon: 'check', onSelect: () => onFavourite(c, false) } : { label: 'Add to favourites', icon: 'plus', onSelect: () => onFavourite(c, true) },
    { label: 'Guide for this channel', icon: 'guide', onSelect: () => onGuide(c) },
    castOk && castable(c) ? { label: castLabel(c), icon: 'cast', onSelect: () => onCast(c) } : null,
    onAppLink ? { label: 'Provider app link…', icon: 'edit', onSelect: () => onAppLink(c) } : null, // admins (v0.28)
  ].filter(Boolean);
  return html`<li class=${itemClass(c)} data-id=${c.id}>
    <button type="button" class="live-row" aria-label=${spoken(c)} data-id=${c.id} onClick=${() => onPlay(c)}>
      <${ChannelLogo} c=${c} />
      <span class="live-num">${c.number != null ? String(c.number) : ''}</span>
      <span class="live-main">
        <span class="live-name">${c.name}<${Radio} c=${c} /><${LockBadge} c=${c} /><${CantTag} c=${c} /></span>
        ${c.now ? html`<span class="live-now"><span class="live-title">${c.now.title}</span><${RecDot} p=${c.now} /><span class="muted small">${`until ${clockTime(c.now.end)}`}</span></span>` : html`<span class="live-now muted">No guide information</span>`}
        <${Bar} p=${c.now} now=${now} />
      </span>
      <span class="live-next muted small">${c.next ? [`Next: ${clockTime(c.next.start)} ${c.next.title}`, html`<${RecDot} p=${c.next} />`] : ''}</span>
    </button>
    <${MoreButton} title=${c.name} items=${more} />
  </li>`;
}

/** Orbit's glass card: the programme picture (or the logo on its tint), the number, what's on and what's next. */
export function ChannelCard({ c, onPlay }) {
  const now = Date.now();
  const [failed, setFailed] = useState(null); // the programme picture that failed: the logo art instead
  const picture = c.now?.image && !c.radio ? c.now.image : null;
  const art =
    picture && failed !== picture
      ? html`<span class="live-card-art"><img key=${picture} class="is-programme" src=${picture} alt="" loading="lazy" decoding="async" onError=${() => setFailed(picture)} /></span>`
      : html`<span class="live-card-art is-logo"><${ChannelLogo} c=${c} size="xl" /></span>`;
  return html`<li class=${itemClass(c)} data-id=${c.id}>
    <button type="button" class=${`live-card${c.radio ? ' is-radio' : ''}`} style=${`--tint:${channelTint(c.name)}`} aria-label=${spoken(c)} data-id=${c.id} onClick=${() => onPlay(c)}>
      ${art}
      <span class="live-card-shade" aria-hidden="true" />
      ${picture ? html`<span class="live-card-logo"><${ChannelLogo} c=${c} size="sm" /></span>` : null}
      <span class="live-card-num">${c.number != null ? String(c.number) : ''}</span>
      <span class="live-card-text">
        <span class="live-card-name">${c.name}<${Radio} c=${c} /><${LockBadge} c=${c} /><${CantTag} c=${c} /></span>
        <span class="live-card-title">${c.now ? c.now.title : 'No guide information'}<${RecDot} p=${c.now} /></span>
        <${Bar} p=${c.now} now=${now} />
        ${c.next ? html`<span class="live-card-next">${nextLine(c.next, clockTime)}<${RecDot} p=${c.next} /></span>` : null}
      </span>
    </button>
  </li>`;
}

const SpotBtn = ({ cls, icon, label, onClick, hidden = false, btnRef }) => html`<button ref=${btnRef} type="button" class=${`btn ${cls}`} onClick=${onClick} hidden=${hidden}><${Icon} name=${icon} /><span>${label}</span></button>`;

/**
 * Orbit's spotlight: the channel the remote is on, large, with its programme picture behind the page (on `view`).
 * Its buttons keep their elements between channels, so the one holding focus is never replaced; one about to hide
 * while it holds focus hands focus to Watch live.
 */
export function LiveSpotlight({ c, onWatch, onRecord, onFavourite, onGuide, onCast, castOff = false, kids = false, view, onAppLink = null }) {
  const watch = useRef(null);
  const record = useRef(null);
  const guide = useRef(null);
  const now = Date.now();
  const p = c?.now || null;
  // Record only what the server will record: not for Kids, radio, encrypted channels or a programme that has ended.
  const noRecord = Boolean(c) && (!p || kids || c.radio || Boolean(c.drm) || p.end <= now);
  const noGuide = Boolean(c) && !p;
  // Read before the DOM changes: which button holds focus now.
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  const handOff = (noRecord && active && active === record.current) || (noGuide && active && active === guide.current);
  useLayoutEffect(() => {
    if (handOff) watch.current?.focus({ preventScroll: true });
  });
  useLayoutEffect(() => {
    if (!c) return;
    // The page's wash: the programme picture behind the page, or the channel's colour when there is none.
    const picture = p?.image && !c.radio ? p.image : null;
    view?.style.setProperty('--spot-tint', channelTint(c.name));
    view?.classList.toggle('has-picture', Boolean(picture));
    setBackdrop(picture);
  }, [c]);
  const where = c ? [c.number != null ? `Channel ${c.number}` : null, c.groups?.[0] || null].filter(Boolean).join(' · ') : '';
  const extra = p ? [p.subtitle, p.episode].filter(Boolean).join(' · ') : '';
  const desc = c ? (p ? p.description || '' : 'No guide information') : '';
  const recLabel = p?.recording === 'recording' ? 'Recording' : p?.recording === 'scheduled' ? 'Recording scheduled' : 'Record';
  const act = (fn) => () => c && fn(c);
  return html`<section class="live-spot" aria-label="Spotlight">
    <div class="live-spot-inner">
      <div class="live-spot-top"><span class="live-spot-logo">${c ? html`<${ChannelLogo} key=${c.id} c=${c} />` : null}</span><span class="live-tag">LIVE</span><span class="live-spot-where">${where}</span></div>
      <h2 class="live-spot-title">${c ? (p ? p.title : c.name) : ''}</h2>
      <p class="live-spot-sub" hidden=${Boolean(c) && !extra}>${extra}</p>
      <div class="live-spot-time" hidden=${Boolean(c) && !p}>
        <span class="live-spot-start">${p ? clockTime(p.start) : ''}</span>
        <span class="live-bar" aria-hidden="true"><span style=${p ? `--p:${programmeProgress(p, now)}` : null} /></span>
        <span class="live-spot-left">${p ? minutesLeft(p, now) : ''}</span>
      </div>
      <p class="live-spot-desc" hidden=${Boolean(c) && !desc}>${desc}</p>
      <div class="actions live-spot-actions">
        <${SpotBtn} btnRef=${watch} cls="btn-primary live-spot-watch" icon="play" label="Watch live" onClick=${act(onWatch)} />
        <${SpotBtn} btnRef=${record} cls=${`btn-secondary live-spot-record${p?.recording ? ' is-marked' : ''}`} icon="recording" label=${recLabel} onClick=${act(onRecord)} hidden=${noRecord} />
        <button type="button" class="btn btn-secondary btn-icon live-spot-fav" aria-label="Favourite" aria-pressed=${String(Boolean(c?.favourite))} onClick=${act(onFavourite)}><${Icon} name="star" /></button>
        <${SpotBtn} btnRef=${guide} cls="btn-ghost live-spot-guide" icon="guide" label="Guide" onClick=${act(onGuide)} hidden=${noGuide} />
        <${SpotBtn} cls="btn-ghost live-spot-cast" icon="cast" label=${castLabel(c)} onClick=${act(onCast)} hidden=${Boolean(c) && (!castable(c) || castOff)} />
        ${onAppLink && c ? html`<${MoreButton} title=${c.name} items=${[{ label: 'Provider app link…', icon: 'edit', onSelect: () => onAppLink(c) }]} />` : null}
      </div>
    </div>
  </section>`;
}
