// Settings → Profile: Apps (app passwords for Subsonic and Jellyfin apps) and Scrobbling (ListenBrainz, Last.fm); and the
// Last.fm fields of Settings → Server. Every profile has its own (Kids included); none of it shows another profile's.
import { api } from '../api.js';
import { h, clear, timeAgo } from '../dom.js';
import { button, toast, announce, field } from '../components.js';

const panel = (cls, title, ...children) => h('section', { class: `panel ${cls}` }, h('h2', {}, title), children);
const when = (ms) => (ms ? timeAgo(ms) : null);

/** Copy text; when the browser won't, select it so the person can copy it themselves. */
async function copy(text, el, done = 'Password copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    const r = document.createRange();
    r.selectNodeContents(el);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    toast('Press Ctrl+C (or Cmd+C) to copy it');
  }
}

export function musicAppsCard() {
  const list = h('ul', { class: 'app-list', role: 'list' });
  const made = h('div', { class: 'app-made' });
  const name = h('input', { type: 'text', name: 'appName', maxlength: '60', autocomplete: 'off', placeholder: 'Symfonium on my phone' });
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });

  async function load(focusKey = null) {
    let rows;
    try {
      rows = await api.get('/api/me/app-passwords');
    } catch (err) {
      clear(list).append(h('li', { class: 'muted' }, err.message));
      return;
    }
    clear(list).append(...(rows.length ? rows.map(row) : [h('li', { class: 'muted app-none' }, 'No app passwords yet.')]));
    if (focusKey) (list.querySelector(`[data-key="${focusKey}"]`) || name).focus();
  }

  function row(p) {
    const actions = h('div', { class: 'actions' });
    const revoke = button('Revoke', { variant: 'ghost', attrs: { class: 'btn btn-ghost', 'data-key': `revoke:${p.id}`, 'aria-label': `Revoke ${p.name}` }, onClick: () => ask() });
    actions.append(revoke);
    function ask() {
      const no = h('button', { type: 'button', class: 'btn btn-secondary' }, 'Cancel');
      const yes = h('button', { type: 'button', class: 'btn btn-danger' }, 'Revoke');
      const box = h('div', { class: 'app-confirm', role: 'group', 'aria-label': `Revoke ${p.name}?` }, h('p', {}, `Revoke ${p.name}? That app will be signed out.`), h('div', { class: 'actions' }, no, yes));
      no.addEventListener('click', () => {
        actions.replaceChildren(revoke);
        revoke.focus();
      });
      box.addEventListener('keydown', (e) => e.key === 'Escape' && (e.stopPropagation(), no.click()));
      yes.addEventListener('click', async () => {
        yes.disabled = true;
        try {
          await api.del(`/api/me/app-passwords/${p.id}`);
          toast(`Revoked ${p.name}`);
          announce(`Revoked ${p.name}`);
          const next = li.nextElementSibling?.querySelector('[data-key]')?.dataset.key || li.previousElementSibling?.querySelector('[data-key]')?.dataset.key;
          await load(next || 'none');
        } catch (err) {
          yes.disabled = false;
          toast(err.message, { type: 'error' });
        }
      });
      actions.replaceChildren(box);
      no.focus();
    }
    const li = h('li', { class: 'app-row' }, h('div', {}, h('strong', {}, p.name), h('span', { class: 'muted small' }, p.lastUsedAt ? `Last used ${when(p.lastUsedAt)}` : 'Not used yet')), actions);
    return li;
  }

  const form = h(
    'form',
    {
      class: 'app-new',
      onSubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        try {
          const m = await api.post('/api/me/app-passwords', { name: name.value });
          name.value = '';
          const value = h('code', { class: 'secret-value' }, m.secret);
          const jellyfin = h('code', {}, m.jellyfin);
          clear(made).append(
            h(
              'div',
              { class: 'app-secret', role: 'status' },
              h('dl', {}, h('dt', {}, 'Server'), h('dd', {}, h('code', {}, m.server)), h('dt', {}, 'Jellyfin address'), h('dd', {}, jellyfin), h('dt', {}, 'Username'), h('dd', {}, h('code', {}, m.username)), h('dt', {}, 'Password'), h('dd', {}, value)),
              h('p', { class: 'muted small' }, 'This password is shown once.'),
              h('p', { class: 'muted small' }, `In Infuse, add a Jellyfin server with the address ${m.jellyfin}, your username ${m.username} and this password. Music apps use the address ${m.server}.`),
              h(
                'div',
                { class: 'actions' },
                button('Copy password', { icon: 'check', variant: 'secondary', onClick: () => copy(m.secret, value) }),
                button('Copy Jellyfin address', { icon: 'check', variant: 'secondary', onClick: () => copy(m.jellyfin, jellyfin, 'Address copied') }),
              ),
            ),
          );
          await load();
          made.querySelector('button')?.focus();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          name.focus();
        }
      },
    },
    error,
    h('div', { class: 'inline-fields' }, field('Name', name), button('Make password', { type: 'submit', variant: 'primary', icon: 'plus' })),
  );
  load();
  return panel(
    'music-apps',
    'Apps',
    h('p', { class: 'muted' }, 'Sign in to other apps with an app password. Music apps such as Symfonium, Amperfy or play:Sub use it as a Subsonic server. Infuse uses it as a Jellyfin server. Each app gets its own password, and revoking one signs that app out.'),
    form,
    made,
    list,
  );
}

export function scrobblingCard() {
  const body = h('div', { class: 'stack' });
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const fail = (err) => {
    error.textContent = err.message;
    error.hidden = false;
  };

  const lastLine = (s) => [s.lastOk ? `Last sent ${when(s.lastOk)}` : null, s.lastError && !s.stopped ? s.lastError : null].filter(Boolean).join(' · ');

  async function load() {
    let st;
    try {
      st = await api.get('/api/me/scrobblers');
    } catch (err) {
      return fail(err);
    }
    const lbs = st.services.find((x) => x.service === 'listenbrainz');
    const lfs = st.services.find((x) => x.service === 'lastfm');
    const token = h('input', { type: 'password', name: 'lbToken', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'ListenBrainz user token' });
    const lbRow = h(
      'div',
      { class: 'scrobble-row listenbrainz-row' },
      h('h3', {}, 'ListenBrainz'),
      lbs.connected && !lbs.stopped
        ? h('div', { class: 'inline-fields' }, h('p', {}, `Connected${lbs.username ? ` as ${lbs.username}` : ''}`), button('Disconnect', { variant: 'ghost', onClick: () => disconnect('listenbrainz') }))
        : h(
            'form',
            {
              class: 'inline-fields',
              onSubmit: async (e) => {
                e.preventDefault();
                error.hidden = true;
                try {
                  await api.put('/api/me/scrobblers/listenbrainz', { token: token.value });
                  toast('Connected to ListenBrainz');
                  await load();
                } catch (err) {
                  fail(err);
                  token.focus();
                }
              },
            },
            lbs.stopped ? h('p', { class: 'rec-warn' }, 'Connect again') : null,
            field('User token', token, 'From listenbrainz.org → Settings → User token.'),
            button('Connect', { type: 'submit', variant: 'primary' }),
          ),
      lastLine(lbs) ? h('p', { class: 'muted small' }, lastLine(lbs)) : null,
    );
    const lfRow = h(
      'div',
      { class: 'scrobble-row lastfm-row' },
      h('h3', {}, 'Last.fm'),
      !st.lastfmReady
        ? h('p', { class: 'muted' }, 'An admin needs to add a Last.fm API key first (Settings → Server).')
        : lfs.connected && !lfs.stopped
          ? h('div', { class: 'inline-fields' }, h('p', {}, `Connected${lfs.username ? ` as ${lfs.username}` : ''}`), button('Disconnect', { variant: 'ghost', onClick: () => disconnect('lastfm') }))
          : h(
              'div',
              { class: 'inline-fields' },
              lfs.stopped ? h('p', { class: 'rec-warn' }, 'Connect again') : null,
              button('Connect to Last.fm', {
                variant: 'primary',
                onClick: async () => {
                  try {
                    location.href = (await api.post('/api/me/scrobblers/lastfm/start', {})).url;
                  } catch (err) {
                    fail(err);
                  }
                },
              }),
            ),
      lastLine(lfs) ? h('p', { class: 'muted small' }, lastLine(lfs)) : null,
    );
    clear(body).append(lbRow, lfRow);
  }
  async function disconnect(service) {
    try {
      await api.del(`/api/me/scrobblers/${service}`);
      toast(service === 'lastfm' ? 'Disconnected from Last.fm' : 'Disconnected from ListenBrainz');
      await load();
    } catch (err) {
      fail(err);
    }
  }
  // Back from Last.fm's sign-in page.
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  if (q.get('lastfm') === 'ok') toast('Connected to Last.fm', { type: 'success' });
  if (q.get('lastfm') === 'failed') toast("Last.fm didn't connect. Try again.", { type: 'error' });
  load();
  return panel('scrobbling', 'Scrobbling', h('p', { class: 'muted' }, 'Send the songs you listen to — here and in music apps — to ListenBrainz or Last.fm.'), error, body);
}

/** Settings → Server: the Last.fm API account (saved with the rest of the server settings). */
export function lastfmFields(s) {
  const key = h('input', { type: 'text', name: 'lastfmApiKey', value: s.lastfmApiKey || '', autocomplete: 'off', spellcheck: 'false' });
  const secret = h('input', { type: 'password', name: 'lastfmSecret', value: s.lastfmSecret || '', autocomplete: 'off', spellcheck: 'false' });
  const el = h(
    'section',
    { class: 'panel lastfm-card' },
    h('h2', {}, 'Last.fm scrobbling'),
    h('p', { class: 'muted' }, 'Lets each profile connect its Last.fm account. ', h('a', { href: 'https://www.last.fm/api/account/create', target: '_blank', rel: 'noopener' }, 'Make an API account at last.fm'), ', then paste its key and shared secret here.'),
    h('div', { class: 'form-grid' }, field('API key', key), field('Shared secret', secret)),
  );
  return { el, values: () => ({ lastfmApiKey: key.value.trim(), lastfmSecret: secret.value.trim() }) };
}

/** Settings → Profile → Quick Connect: type the code a TV shows to sign it in to this account. */
export function quickConnectCard() {
  const input = h('input', { type: 'text', name: 'qcCode', maxlength: '7', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', class: 'code-input' });
  input.addEventListener('input', () => (input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '')));
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const form = h(
    'form',
    {
      onSubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        try {
          const r = await api.post('/api/quickconnect/approve', { code: input.value });
          input.value = '';
          toast(`Signed in ${r.device}`, { type: 'success' });
          announce(`Signed in ${r.device}`);
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          input.select();
        }
      },
    },
    error,
    h('div', { class: 'inline-fields' }, field('Code', input, 'The 6 letters and numbers the TV shows after Sign in with a code.'), button('Approve', { type: 'submit', variant: 'primary' })),
  );
  return panel('quick-connect', 'Quick Connect', h('p', { class: 'muted' }, 'Sign a TV or another screen in to this account without typing a password.'), form);
}
