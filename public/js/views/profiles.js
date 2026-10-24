// "Who's watching?" — pick a profile after signing in (or to switch).
import { api } from '../api.js';
import { h, icon, logoMark } from '../dom.js';
import { avatar, openDialog, field, toast } from '../components.js';
import { state, onProfileSelected, setTitle, signOut } from '../app.js';
import { openStore } from '../offline/store.js';
import { secure } from '../offline/install.js';

// v0.21: the profiles (and a PIN's salted hash) are kept on the device after an online pick, so "Who's watching?" still
// asks offline — and a PIN still guards a profile from the others there.
const kept = () => (secure() && typeof indexedDB !== 'undefined' ? openStore().catch(() => null) : Promise.resolve(null));
function waitText(ms) {
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `Wait ${sec} seconds and try again.`;
  const min = Math.ceil(sec / 60);
  return `Wait ${min} ${min === 1 ? 'minute' : 'minutes'} and try again.`;
}
async function checkOffline(profile, pin) {
  const store = await kept();
  const p = store && (await store.keptProfiles()).find((x) => x.id === profile.id);
  if (!p?.pinHash) throw new Error('Connect to Atomix once to use this profile offline.');
  // v0.22: tries are limited offline too (the server can't count them): 5, then a wait that grows.
  const left = await store.pinWaitLeft(profile.id);
  if (left > 0) throw new Error(waitText(left));
  if (!(await store.checkPin(profile.id, pin))) {
    const wait = await store.pinFailed(profile.id);
    throw new Error(wait ? waitText(wait) : 'Wrong PIN.');
  }
  await store.pinPassed(profile.id);
  return { ...p, pinHash: undefined, pinSalt: undefined };
}

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
      try {
        const pin = input.value;
        chosen = state.offline ? await checkOffline(profile, pin) : await api.post(`/api/profiles/${profile.id}/select`, { pin });
        if (!state.offline) kept().then((s) => s?.setPinHash(profile.id, pin)).catch(() => {});
      } catch (err) {
        // Wrong: said in the dialog (above the backdrop, read at once), the field emptied and ready for another try.
        input.value = '';
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        throw err;
      }
      return true;
    },
  });
  return result === 'ok' ? chosen : null;
}

export async function render(el) {
  setTitle("Who's watching?");
  let profiles;
  if (state.offline) {
    const store = await kept();
    profiles = ((store && (await store.keptProfiles())) || []).map(({ pinHash, pinSalt, ...p }) => p);
  } else {
    profiles = await api.get('/api/profiles');
    kept().then((s) => s?.keepProfiles(profiles)).catch(() => {});
  }

  async function choose(profile) {
    try {
      const selected = profile.hasPin ? await askPin(profile) : state.offline ? profile : await api.post(`/api/profiles/${profile.id}/select`, {});
      if (selected) await onProfileSelected(selected);
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  }

  el.append(
    h(
      'div',
      { class: 'picker-page' },
      h('div', { class: 'picker-brand' }, logoMark(36), h('span', {}, state.status?.serverName || 'Atomix')),
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
        state.profile && !state.profile.kids && !state.offline ? h('a', { class: 'btn btn-ghost', href: '#/settings/profile' }, icon('edit'), h('span', {}, 'Manage profiles')) : null,
        state.offline ? null : h('button', { class: 'btn btn-ghost', type: 'button', onClick: signOut }, icon('logout'), h('span', {}, 'Sign out')),
      ),
    ),
  );
}
