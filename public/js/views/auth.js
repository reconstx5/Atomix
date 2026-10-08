// Sign-in and first-run setup screens.
import { api } from '../api.js';
import { h, logoMark } from '../dom.js';
import { field } from '../components.js';
import { state, onSignedIn, setTitle } from '../app.js';

function errorBox() {
  return h('p', { class: 'form-error', role: 'alert', hidden: true });
}

function showError(box, message) {
  box.textContent = message;
  box.hidden = false;
}

export async function render(el, { setup }) {
  const serverName = state.status?.serverName || 'Atomix';
  setTitle(setup ? 'Welcome' : 'Sign in');
  const error = errorBox();

  if (setup) {
    const username = h('input', { name: 'username', autocomplete: 'username', required: true, minlength: 2, maxlength: 32, pattern: '[A-Za-z0-9._\\-]+', 'data-autofocus': !state.status?.setupCodeRequired || null });
    const password = h('input', { name: 'password', type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
    const confirm = h('input', { name: 'confirm', type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
    const name = h('input', { name: 'serverName', value: 'Atomix', maxlength: 60 });
    const tmdb = h('input', { name: 'tmdb', autocomplete: 'off', spellcheck: 'false' });
    const code = state.status?.setupCodeRequired ? h('input', { name: 'setupCode', required: true, autocomplete: 'off', spellcheck: 'false', maxlength: 8, class: 'code-input', 'data-autofocus': true }) : null;
    const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Create admin account');
    const form = h(
      'form',
      { class: 'auth-form' },
      code ? field('Setup code', code, 'Shown in the Atomix terminal window or `docker compose logs` — it proves you own this server.') : null,
      field('Server name', name, 'Shown in the menu bar and browser tab.'),
      field('Admin username', username),
      field('Password', password, 'At least 8 characters.'),
      field('Confirm password', confirm),
      field('TMDB API key (optional)', tmdb, 'Free from themoviedb.org → Settings → API. Used for posters and descriptions. You can add it later.'),
      error,
      submit,
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.hidden = true;
      if (password.value !== confirm.value) return showError(error, "The passwords don't match.");
      submit.disabled = true;
      try {
        const { user } = await api.post('/api/setup', {
          username: username.value.trim(),
          password: password.value,
          serverName: name.value.trim(),
          tmdbApiKey: tmdb.value.trim(),
          setupCode: code?.value.trim(),
        });
        location.hash = '#/settings/libraries';
        await onSignedIn(user);
      } catch (err) {
        showError(error, err.message);
        submit.disabled = false;
      }
    });
    el.append(
      h(
        'div',
        { class: 'auth-page' },
        h(
          'div',
          { class: 'auth-card auth-card-wide' },
          h('div', { class: 'auth-brand' }, logoMark(44), h('span', {}, 'Atomix')),
          h('h1', {}, 'Welcome to your media hub'),
          h('p', { class: 'muted' }, "Let's create the admin account. Next you'll point Atomix at your movie and TV folders."),
          form,
        ),
      ),
    );
    return;
  }

  const username = h('input', { name: 'username', autocomplete: 'username', required: true, 'data-autofocus': true });
  const password = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Sign in');
  const form = h('form', { class: 'auth-form' }, field('Username', username), field('Password', password), error, submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    try {
      const { user } = await api.post('/api/auth/login', { username: username.value.trim(), password: password.value });
      await onSignedIn(user);
    } catch (err) {
      showError(error, err.message);
      submit.disabled = false;
      password.select();
    }
  });
  el.append(
    h(
      'div',
      { class: 'auth-page' },
      h(
        'div',
        { class: 'auth-card' },
        h('div', { class: 'auth-brand' }, logoMark(44), h('span', {}, serverName)),
        h('h1', {}, 'Sign in'),
        state.status?.loginMessage ? h('p', { class: 'muted' }, state.status.loginMessage) : null,
        form,
      ),
    ),
  );
}
