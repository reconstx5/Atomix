// Quick Connect's waiting screen (from the sign-in page): a code in big letters, what to do with it, a countdown to
// a fresh one, and a poll every 2 s; once someone approves it, this screen is signed in like any other.
import { api } from '../api.js';
import { h, logoMark } from '../dom.js';
import { button } from '../components.js';
import { onSignedIn, setTitle } from '../app.js';

const POLL_MS = 2000;

export function renderQuickConnect(el, { serverName = 'Atomix', onBack }) {
  setTitle('Sign in with a code');
  const codeEl = h('p', { class: 'qc-code', 'aria-live': 'polite' }, '······');
  const left = h('p', { class: 'muted qc-left' });
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  let poll = null;
  let expiresAt = 0; // on this device's own clock (from the server's ttlMs: a fast or slow TV clock doesn't matter)
  let busy = false;
  let retryAt = 0;
  let failures = 0;
  let pollTimer = null;
  let tickTimer = null;
  let stopped = false;

  async function fresh() {
    if (busy || Date.now() < retryAt) return;
    busy = true;
    try {
      const s = await api.post('/api/quickconnect', {});
      poll = s.poll;
      expiresAt = Date.now() + (s.ttlMs || 300_000);
      failures = 0;
      codeEl.textContent = `${s.code.slice(0, 3)} ${s.code.slice(3)}`;
      codeEl.setAttribute('aria-label', `Code ${s.code.split('').join(' ')}`);
      error.hidden = true;
      tick();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      poll = null;
      failures++;
      retryAt = Date.now() + Math.min(60_000, 5000 * 2 ** (failures - 1)); // 5 s, 10 s, 20 s… at most a minute
    } finally {
      busy = false;
    }
  }
  function tick() {
    const ms = Math.max(0, expiresAt - Date.now());
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    left.textContent = poll ? `New code in ${m}:${String(s).padStart(2, '0')}` : '';
    if ((ms <= 0 || !poll) && !stopped) fresh();
  }
  async function check() {
    if (!poll || stopped) return;
    try {
      const r = await api.post('/api/quickconnect/poll', { poll });
      if (r.status === 'approved') {
        stop();
        await onSignedIn(r.user);
      } else if (r.status === 'expired') {
        poll = null;
        fresh();
      }
    } catch {
      /* the next poll tries again */
    }
  }
  function stop() {
    stopped = true;
    clearInterval(pollTimer);
    clearInterval(tickTimer);
  }
  pollTimer = setInterval(check, POLL_MS);
  tickTimer = setInterval(tick, 1000);
  fresh();

  el.replaceChildren(
    h(
      'div',
      { class: 'auth-page qc-page' },
      h(
        'div',
        { class: 'auth-card' },
        h('div', { class: 'auth-brand' }, logoMark(44), h('span', {}, serverName)),
        h('h1', {}, 'Sign in with a code'),
        codeEl,
        h('p', {}, "On a device that's signed in, open Settings → Profile → Quick Connect and type this code."),
        left,
        error,
        button('Use a password', { variant: 'ghost', autofocus: true, onClick: () => (stop(), onBack()) }),
      ),
    ),
  );
  return stop;
}
