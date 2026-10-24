// Settings → Server → Secure address (HTTPS) (v0.27): phones need a secure page to play encrypted channels and to
// install Atomix. Tailscale (a real certificate, nothing to install on phones beyond the Tailscale app) or Atomix's
// own home certificate (each phone installs it once), or off. The plain address is never affected.
import { h, icon } from '../dom.js';
import { api } from '../api.js';
import { button, toast, rovingRadios, field } from '../components.js';
import { state } from '../app.js';

const MODES = [
  ['tailscale', 'Use Tailscale (recommended)'],
  ['own', 'Use Atomix’s own certificate'],
  ['off', 'Off'],
];

/** A copy button for `text` (falls back to selecting it when the clipboard isn't available). */
function copyButton(text, target) {
  return button('Copy', {
    variant: 'ghost',
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast('Copied');
      } catch {
        const range = document.createRange();
        range.selectNodeContents(target);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
    },
  });
}

const steps = (items) => h('ol', { class: 'https-steps' }, items.map((t) => h('li', {}, t)));

export function httpsCard() {
  const body = h('div', { class: 'stack' });
  const card = h('section', { class: 'panel https-card' }, h('h2', {}, 'Secure address (HTTPS)'), body);
  let st = null;
  let poll = null;
  const portInput = h('input', { type: 'number', name: 'httpsPort', min: 1, max: 65535, step: 1, class: 'input-year', inputmode: 'numeric', style: 'width: 11ch; max-width: none' }); // five digits, the padding and the spinner
  // The card sits inside the Server tab's form: Enter here saves the port, not the whole form.
  portInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      savePort();
    }
  });
  const portSave = button('Save port', { variant: 'ghost', onClick: () => savePort() });

  /** Ask the server to apply `body` (a mode or a port), with "Starting…" until it answers. */
  async function send(change, focusAfter) {
    setBusy(true);
    try {
      await api.put('/api/admin/settings', change);
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
    await load();
    focusAfter?.()?.focus();
  }
  function setBusy(on) {
    card.setAttribute('aria-busy', String(on));
    for (const r of radios) r.disabled = on;
    let note = body.querySelector('.https-busy');
    if (on && !note) body.prepend((note = h('p', { class: 'https-busy muted', role: 'status' }, 'Starting…')));
    if (!on) note?.remove();
  }
  function savePort() {
    const n = Number(portInput.value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return toast('Pick a port from 1 to 65535', { type: 'error' });
    if (n === st?.port) return;
    send({ httpsPort: n }, () => portInput);
  }
  const radios = MODES.map(([v, label]) => h('button', { type: 'button', role: 'radio', class: 'chip-radio', 'aria-checked': 'false', dataset: { v }, onClick: () => choose(v) }, label));
  const group = rovingRadios(h('div', { role: 'radiogroup', class: 'smart-media', 'aria-label': 'Secure address' }, radios));

  function choose(v) {
    if (st?.mode === v) return;
    send({ httpsMode: v }, () => radios.find((r) => r.dataset.v === v));
  }
  /** After a refusal (Tailscale not signed in, the admin command not run yet): ask again with the same mode. */
  function tryAgain() {
    send({ httpsMode: st.mode }, () => card.querySelector('[data-retry]'));
  }

  function draw() {
    for (const r of radios) {
      r.disabled = false;
      r.setAttribute('aria-checked', String(r.dataset.v === st.mode));
    }
    const secureHere = window.isSecureContext && location.protocol === 'https:';
    const parts = [
      h('p', {}, secureHere ? 'This page is secure.' : 'This page isn’t secure (http://).'),
      h('p', { class: 'muted' }, 'Phones need it to play encrypted channels and to install Atomix. The plain address keeps working as it is.'),
      group,
    ];
    if (st.listening && st.secureUrl) {
      const addr = h('code', { class: 'https-address' }, st.secureUrl);
      parts.push(h('div', { class: 'https-line' }, h('span', {}, 'Secure address: '), addr, copyButton(st.secureUrl, addr)));
    }
    if (st.sentence) {
      parts.push(h('p', { class: 'notice', role: 'status' }, icon('info'), ` ${st.sentence}`));
      if (st.command) {
        const cmd = h('code', { class: 'https-command' }, st.command);
        parts.push(h('div', { class: 'https-line' }, cmd, copyButton(st.command, cmd)));
      }
      if (st.mode !== 'off') parts.push(h('div', {}, button('Try again', { variant: 'secondary', onClick: tryAgain, attrs: { 'data-retry': '' } })));
    }
    portInput.value = String(st.port);
    portInput.readOnly = Boolean(st.portFixed);
    parts.push(
      h(
        'div',
        { class: 'https-line' },
        field('HTTPS port', portInput, st.portFixed ? 'Set by ATOMIX_HTTPS_PORT where Atomix is started.' : 'Phones add it to the address. The plain address keeps its own port.'),
        st.portFixed ? null : portSave,
      ),
    );
    if (st.mode === 'tailscale') {
      parts.push(
        h('h3', {}, 'Tailscale'),
        steps([
          'Install Tailscale on this computer and on each phone, signed in to the same account.',
          'In Tailscale’s admin page, turn on HTTPS certificates (DNS → HTTPS Certificates).',
          'Choose “Use Tailscale” here. Phones then open the secure address above, at home or away.',
        ]),
      );
    }
    if (st.mode === 'own') {
      parts.push(
        h('h3', {}, 'Atomix’s own certificate'),
        h('p', { class: 'muted' }, 'Each phone installs Atomix’s home certificate once, then opens the secure address above while it’s at home.'),
        h('p', {}, h('strong', {}, 'Android: '), h('a', { href: st.own?.caDownload || '/tls/atomix-home-ca.crt' }, 'Download the certificate')),
        steps(['Settings → Security → Encryption & credentials → Install a certificate → CA certificate.', 'Pick the downloaded atomix-home-ca.crt.']),
        h('p', {}, h('strong', {}, 'iPhone: '), h('a', { href: st.own?.profileDownload || '/tls/atomix-home-ca.mobileconfig' }, 'Download the profile'), ' (open this link in Safari)'),
        steps(['Settings → Profile Downloaded → Install.', 'Settings → General → About → Certificate Trust Settings → turn on “Atomix home CA”.']),
      );
    }
    body.replaceChildren(...parts);
  }

  async function load() {
    try {
      st = await api.get('/api/admin/https');
    } catch (err) {
      body.replaceChildren(h('p', { class: 'form-error' }, err.message));
      return;
    }
    if (state.status) state.status.secureUrl = st.listening ? st.secureUrl : null;
    draw();
    setBusy(Boolean(st.busy));
    // Still starting (Atomix just started, or another admin chose a mode): look again shortly, while the card is shown.
    clearTimeout(poll);
    if (st.busy) poll = setTimeout(() => card.isConnected && load(), 2000);
  }
  load();
  return card;
}
