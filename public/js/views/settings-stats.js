// Stats: Settings → Profile's card (this profile's hours, top lists and the day × hour grid) and Dashboard → Household
// (every profile's hours, for admins).
import { api } from '../api.js';
import { h, clear, append } from '../dom.js';
import { rovingRadios } from '../components.js';

const RANGES = [['week', 'This week'], ['month', 'This month'], ['year', 'This year']];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hourName = (hr) => `${hr % 12 || 12} ${hr < 12 ? 'AM' : 'PM'}`;
const hoursText = (n) => `${n} ${n === 1 ? 'hour' : 'hours'}`;

export function statsCard() {
  let range = 'week';
  const body = h('div', { class: 'stack' });
  const radios = RANGES.map(([v, label]) => h('button', { type: 'button', role: 'radio', class: 'chip-radio', 'aria-checked': String(v === range), dataset: { v }, onClick: () => pick(v) }, label));
  const group = rovingRadios(h('div', { role: 'radiogroup', class: 'smart-media', 'aria-label': 'Stats for' }, radios));
  function pick(v) {
    range = v;
    for (const r of radios) r.setAttribute('aria-checked', String(r.dataset.v === v));
    load();
  }
  const list = (title, items) =>
    h('div', { class: 'stats-top' }, h('h3', {}, title), items.length ? h('ol', {}, items.map((t) => h('li', {}, h('a', { href: `#/item/${t.id}` }, t.title), h('span', { class: 'muted' }, ` · ${t.plays} ${t.plays === 1 ? 'play' : 'plays'}`)))) : h('p', { class: 'muted' }, 'Nothing yet.'));
  async function load() {
    let s;
    try {
      // The zone by name, so each play is placed at its own date's offset (summer time); the offset as a fallback.
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      s = await api.get(`/api/me/stats?range=${range}&tz=${new Date().getTimezoneOffset()}&zone=${encodeURIComponent(zone)}`);
    } catch (err) {
      clear(body).append(h('p', { class: 'form-error' }, err.message));
      return;
    }
    const label = RANGES.find((r) => r[0] === range)[1].toLowerCase();
    const max = Math.max(0.0001, ...s.grid.flat());
    const grid = h(
      'div',
      { class: 'table-wrap stats-grid-wrap' },
      h(
        'table',
        { class: 'stats-grid' },
        h('caption', { class: 'visually-hidden' }, `When you watched and listened, ${label}`),
        h('tbody', {}, s.grid.map((day, d) => h('tr', {}, h('th', { scope: 'row' }, DAYS[d]), day.map((v, hr) => h('td', { style: { '--level': String(v / max) } }, h('span', { class: 'visually-hidden' }, `${DAYS[d]} ${hourName(hr)}: ${hoursText(v)}`)))))),
      ),
    );
    const nothing = !s.watchedHours && !s.listenedHours;
    append(clear(body), [
      h('div', { class: 'stats-numbers' }, h('p', {}, h('strong', {}, String(s.watchedHours)), ` ${s.watchedHours === 1 ? 'hour' : 'hours'} watched`), h('p', {}, h('strong', {}, String(s.listenedHours)), ` ${s.listenedHours === 1 ? 'hour' : 'hours'} listened`)),
      nothing ? h('p', { class: 'muted' }, `Nothing played yet ${label}.`) : null,
      h('div', { class: 'stats-lists' }, list('Films', s.topFilms), list('Shows', s.topShows), list('Artists', s.topArtists), list('Songs', s.topSongs)),
      grid,
    ]); // append() skips the empty line when something was played (Element.append would write "null")
  }
  load();
  return h('section', { class: 'panel stats-card' }, h('h2', {}, 'Stats'), group, body);
}

export function householdSection() {
  const body = h('div', { class: 'table-wrap' }, h('p', { class: 'muted' }, 'Loading…'));
  api
    .get('/api/admin/stats')
    .then((rows) =>
      clear(body).append(
        h(
          'table',
          { class: 'table' },
          h('thead', {}, h('tr', {}, ['Profile', 'This week', 'This month', 'This year'].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.name), h('td', {}, hoursText(r.week)), h('td', {}, hoursText(r.month)), h('td', {}, hoursText(r.year))))),
        ),
      ),
    )
    .catch((err) => clear(body).append(h('p', { class: 'form-error' }, err.message)));
  return h('section', { class: 'panel household' }, h('h2', {}, 'Household'), h('p', { class: 'muted' }, 'Hours watched and listened by each profile.'), body);
}
