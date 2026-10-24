// Settings → Activity (admins): what happened on the server, newest first — filter by kind, profile and day, 50 at
// a time.
import { api } from '../api.js';
import { h, clear } from '../dom.js';
import { button, field, toast } from '../components.js';

const TYPES = [
  ['', 'Everything'],
  ['sign-in', 'Sign-ins'],
  ['sign-in-failed', 'Failed sign-ins'],
  ['quick-connect', 'Quick Connect'],
  ['app-password', 'App passwords'],
  ['play', 'Playing'],
  ['download', 'Downloads'],
  ['together', 'Watch together'],
  ['recording', 'Recordings'],
  ['scan', 'Scans'],
  ['settings', 'Settings'],
  ['users', 'Users and profiles'],
];

const when = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export async function activityTab(el) {
  el.classList.add('activity-view');
  // Every account's profiles (whose, when the name doesn't say).
  const profiles = await api.get('/api/admin/profiles').catch(() => api.get('/api/profiles').catch(() => []));
  const type = h('select', { name: 'type' }, TYPES.map(([v, l]) => h('option', { value: v }, l)));
  const profile = h('select', { name: 'profile' }, h('option', { value: '' }, 'Every profile'), profiles.map((p) => h('option', { value: String(p.id) }, p.owner && p.owner !== p.name ? `${p.name} (${p.owner})` : p.name)));
  const day = h('input', { type: 'date', name: 'day' });
  const body = h('tbody');
  const table = h('div', { class: 'table-wrap' }, h('table', { class: 'table activity-table' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'When'), h('th', { scope: 'col' }, 'What'), h('th', { scope: 'col' }, 'Who'), h('th', { scope: 'col' }, 'Address'))), body));
  const footer = h('div', { class: 'actions' });
  const empty = h('p', { class: 'muted activity-empty', hidden: true }, 'Nothing happened on that day.');
  let last = null;

  async function load({ more = false } = {}) {
    const q = new URLSearchParams();
    if (type.value) q.set('type', type.value);
    if (profile.value) q.set('profile', profile.value);
    if (day.value) q.set('day', day.value);
    if (more && last) q.set('before', String(last));
    let page;
    try {
      page = await api.get(`/api/admin/activity?${q}`);
    } catch (err) {
      toast(err.message, { type: 'error' });
      return;
    }
    if (!more) clear(body);
    for (const e of page.entries) body.append(h('tr', {}, h('td', { class: 'nowrap' }, when(e.at)), h('td', {}, e.text), h('td', {}, [e.user, e.profile && e.profile !== e.user ? e.profile : null].filter(Boolean).join(' · ') || '—'), h('td', { class: 'muted' }, e.ip || '—')));
    last = page.entries.at(-1)?.id ?? last;
    empty.hidden = Boolean(body.children.length);
    empty.textContent = day.value ? 'Nothing happened on that day.' : 'Nothing here yet.';
    table.hidden = !body.children.length;
    clear(footer).append(...(page.more ? [button('Load more', { variant: 'secondary', onClick: async (e) => ((e.currentTarget.disabled = true), await load({ more: true })) })] : []));
  }
  for (const c of [type, profile, day]) c.addEventListener('change', () => ((last = null), load()));
  el.append(
    h(
      'section',
      { class: 'panel' },
      h('h2', {}, 'Activity'),
      h('p', { class: 'muted' }, 'Sign-ins, plays, changes and recordings from the last 30 days, newest first.'),
      h('div', { class: 'inline-fields' }, field('Show', type), field('Profile', profile), field('Day', day)),
      empty,
      table,
      footer,
    ),
  );
  await load();
}
