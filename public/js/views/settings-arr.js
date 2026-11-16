// Settings → Server → Download apps (v0.28): the webhook address Sonarr, Radarr, Lidarr and Readarr call when a
// download lands (Atomix scans that library at once), and the request page "Request it" on Search opens.
// Its own card: it saves as you go, like the secure address card.
import { h } from '../dom.js';
import { api } from '../api.js';
import { button, toast, field } from '../components.js';

async function copy(text, target) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    const range = document.createRange();
    range.selectNodeContents(target);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }
}

export function downloadAppsCard(settings) {
  const address = h('code', { class: 'arr-address' }, '…');
  const request = h('input', { type: 'url', name: 'requestUrl', value: settings.requestUrl || '', placeholder: 'http://192.168.1.20:5055', autocomplete: 'off' });
  // The card sits inside the Server tab's form: Enter here saves this address, not the whole form.
  request.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveRequest();
    }
  });
  const show = (key) => (address.textContent = `${location.origin}/api/hooks/arr?key=${key}`);
  api.get('/api/admin/arr').then((r) => show(r.key), (err) => (address.textContent = err.message));
  async function saveRequest() {
    try {
      await api.put('/api/admin/settings', { requestUrl: request.value.trim() });
      toast(request.value.trim() ? 'Request address saved' : 'Request button turned off');
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  }
  return h(
    'section',
    { class: 'panel arr-card' },
    h('h2', {}, 'Download apps'),
    h('p', { class: 'muted' }, 'Sonarr, Radarr, Lidarr and Readarr can tell Atomix when a download lands, so it shows up straight away instead of at the next scan. In each app go to Settings → Connect → + → Webhook, paste this address, tick On Import, On Rename and On Delete, then press Test and Save.'),
    h('div', { class: 'arr-address-row' }, address),
    h(
      'div',
      { class: 'actions' },
      button('Copy address', { icon: 'check', variant: 'ghost', onClick: () => copy(address.textContent, address) }),
      button('Make a new address', {
        icon: 'refresh',
        variant: 'ghost',
        onClick: async () => {
          try {
            show((await api.post('/api/admin/arr/key', {})).key);
            toast('The old address no longer works. Paste the new one into your download apps.');
          } catch (err) {
            toast(err.message, { type: 'error' });
          }
        },
      }),
    ),
    field('Request address', request, 'Where “Request it” on Search sends people: your Seerr, Overseerr, Jellyseerr or Ombi page. Leave it empty for no button.'),
    h('div', { class: 'actions' }, button('Save request address', { variant: 'ghost', onClick: () => saveRequest() })),
  );
}
