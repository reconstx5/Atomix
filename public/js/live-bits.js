// Live TV's small pieces for the screens that aren't components yet (the Guide, Recordings, the player): a channel's
// logo, the lock an encrypted channel carries, a row's spoken name and the red recording dot. The Live TV page draws
// the same with ui/live.js.
import { h, icon } from './dom.js';
import { clockTime, recordingWords } from './live.js';

export const initials = (name) => String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

export function channelLogo(c, size = 'md') {
  return h('span', { class: `live-logo live-logo-${size}`, 'aria-hidden': 'true' }, c.logo ? h('img', { src: c.logo, alt: '', loading: 'lazy', onError: (e) => e.target.replaceWith(h('span', { class: 'live-initials' }, initials(c.name))) }) : h('span', { class: 'live-initials' }, initials(c.name)));
}

/** The small lock an encrypted channel carries (rows, the guide, the player's channel list). */
export const lockBadge = (c) => (c.drm ? h('span', { class: 'live-lock', title: 'Encrypted' }, icon('lock', { size: 14 }), h('span', { class: 'visually-hidden' }, 'Encrypted')) : null);

/** "7, TVNZ 1, now 1 News until 7:30 PM" — the row's spoken name. */
export function rowName(c) {
  const head = `${c.number != null ? `${c.number}, ${c.name}` : c.name}${c.drm ? ', encrypted' : ''}`;
  return c.now ? `${head}, now ${c.now.title} until ${clockTime(c.now.end)}${recordingWords(c.now)}` : `${head}, No guide information`;
}

/** The red dot of a programme being recorded or scheduled to be (null otherwise). */
export function recDot(p, { silent = false } = {}) {
  if (!p?.recording) return null;
  const text = p.recording === 'recording' ? 'Recording' : 'Recording scheduled';
  // `silent`: beside words that already say it (the programme sheet), the dot isn't read again.
  return h('span', { class: `rec-dot${p.recording === 'recording' ? ' is-recording' : ''}`, title: text, ...(silent ? { 'aria-hidden': 'true' } : {}) }, silent ? null : h('span', { class: 'visually-hidden' }, text));
}
