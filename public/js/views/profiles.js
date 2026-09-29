// "Who's watching?" — pick a profile after signing in (or to switch).
import { api } from '../api.js';
import { h, icon, logoMark } from '../dom.js';
import { avatar, openDialog, field, toast } from '../components.js';
import { state, onProfileSelected, setTitle, signOut } from '../app.js';

async function askPin(profile) {
  const input = h('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off', maxlength: 8, class: 'pin-input', 'aria-label': `PIN for ${profile.name}`, 'data-autofocus': true });
  let chosen = null;
  const result = await openDialog({
    title: `Enter ${profile.name}'s PIN`,
    body: h('div', { class: 'stack' }, h('div', { class: 'pin-avatar' }, avatar(profile, 72)), field('PIN', input)),
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Continue', value: 'ok', variant: 'primary' },
    ],
    onSubmit: async () => {
      chosen = await api.post(`/api/profiles/${profile.id}/select`, { pin: input.value });
      return true;
    },
  });
  return result === 'ok' ? chosen : null;
}

export async function render(el) {
  setTitle("Who's watching?");
  const profiles = await api.get('/api/profiles');

  async function choose(profile) {
    try {
      const selected = profile.hasPin ? await askPin(profile) : await api.post(`/api/profiles/${profile.id}/select`, {});
      if (selected) await onProfileSelected(selected);
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  }

  el.append(
    h(
      'div',
      { class: 'picker-page' },
      h('div', { class: 'picker-brand' }, logoMark(36), h('span', {}, state.status?.serverName || 'NodeFlix')),
      h('h1', {}, "Who's watching?"),
      h(
        'ul',
        { class: 'picker-grid', role: 'list' },
        profiles.map((p, i) =>
          h(
            'li',
            {},
            h(
              'button',
              { type: 'button', class: 'picker-profile', onClick: () => choose(p), 'data-autofocus': (state.profile ? p.id === state.profile.id : i === 0) || null, 'aria-label': `${p.name}${p.kids ? ', kids profile' : ''}${p.hasPin ? ', needs PIN' : ''}` },
              avatar(p, 112),
              h('span', { class: 'picker-name' }, p.name),
              h('span', { class: 'picker-tags' }, p.kids ? h('span', { class: 'chip chip-kids' }, 'Kids') : null, p.hasPin ? icon('lock', { size: 16, label: 'PIN' }) : null),
            ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'picker-actions' },
        state.profile && !state.profile.kids ? h('a', { class: 'btn btn-ghost', href: '#/settings/profile' }, icon('edit'), h('span', {}, 'Manage profiles')) : null,
        h('button', { class: 'btn btn-ghost', type: 'button', onClick: signOut }, icon('logout'), h('span', {}, 'Sign out')),
      ),
    ),
  );
}
