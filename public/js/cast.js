// Casting from the browser: the device picker, the cast state (polled from the server), and the pill that shows
// what is playing on a TV from every page. Atomix itself drives the TV; this page is only the remote.
import { api } from './api.js';
import { h, icon, clear } from './dom.js';
import { art, toast, openDialog } from './components.js';

const listeners = new Set();
let profileId = null;
let session = null; // the live cast session for this profile, as the server last described it
let ended = null; // { ended, deviceName, detail } for 10 s after a session this tab saw ends
let fetchedAt = 0;
let timer = null;
let endedTimer = null;
let fast = false;

/** The live session (or null). Its position moves on between polls while playing. */
export function castState() {
  if (!session) return null;
  const moving = session.state === 'playing' ? (Date.now() - fetchedAt) / 1000 : 0;
  const position = Math.min(session.duration || Infinity, session.position + moving);
  return { ...session, position };
}
export const castEnded = () => ended;
export function onCastChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = () => {
  paintPill();
  for (const fn of listeners) {
    try {
      fn(castState(), ended);
    } catch (err) {
      console.error(err);
    }
  }
};

function apply(r) {
  if (r?.id) {
    session = r;
    fetchedAt = Date.now();
    ended = null;
  } else {
    if (session && r?.ended) {
      ended = { ended: r.ended, deviceName: r.deviceName, detail: r.detail || null };
      clearTimeout(endedTimer);
      endedTimer = setTimeout(() => {
        ended = null;
        emit();
      }, 10_000);
    }
    session = null;
  }
  emit();
}

let inflight = null; // the poll under way: callers share it rather than starting another chain
let again = false; // a poll was asked for while one ran: one more goes right after

/** Ask the server now. Several callers at once share one request and one timer chain. */
export function refreshCast() {
  if (inflight) {
    again = true;
    return inflight;
  }
  clearTimeout(timer);
  const mine = profileId;
  inflight = (async () => {
    try {
      const r = await api.get('/api/cast/sessions/current');
      if (mine === profileId) apply(r);
    } catch {
      // keep the last state on screen; the next poll tries again
    }
  })().finally(() => {
    inflight = null;
    if (profileId == null) return;
    if (mine !== profileId) return void refreshCast(); // the profile changed while this poll ran: start its chain
    if (again) {
      again = false;
      refreshCast();
    } else timer = setTimeout(refreshCast, fast || session?.upNext ? 1000 : 5000);
  });
  return inflight;
}

/** The Remote page polls every second; elsewhere every 5 s is enough for the pill. */
export function setFastPoll(on) {
  fast = Boolean(on);
  if (fast && profileId != null && !inflight) refreshCast();
}

/** Signed in as someone else, or switched profile: forget the cast state and follow that profile's. */
export function setCastProfile(profile) {
  const id = profile?.id ?? null;
  if (id === profileId) return;
  profileId = id;
  session = null;
  ended = null;
  clearTimeout(timer);
  clearTimeout(endedTimer);
  again = false;
  emit();
  if (id != null) refreshCast();
}

/** play, pause, seek {position}, skip {by}, volume {level}, subtitle {id}, audio {index}, next, cancel-up-next, stop */
export async function castCommand(name, args = {}) {
  if (!session) return null;
  try {
    const r = await api.post(`/api/cast/sessions/${session.id}/${name}`, args);
    apply(r?.id || r?.ended ? r : null);
    return r;
  } catch (err) {
    toast(err.message, { type: 'error' });
    if (err.status === 404) refreshCast();
    return null;
  }
}

export async function startCast(body) {
  const r = await api.post('/api/cast/sessions', body);
  apply(r);
  refreshCast();
  return r;
}

// ---- The picker ----

const isAdmin = async () => (await import('./app.js')).canAdmin();

/**
 * Choose a device and cast `target` ({ itemId } or { queue: { itemIds, index } }) to it.
 * `opts.position`, `audioIndex` and `subtitle` carry on from the player; `onStarted` runs once the TV has it.
 */
export function openCastPicker(target, { position = null, audioIndex = null, subtitle = null, onStarted } = {}) {
  let dialog;
  const list = h('div', { class: 'cast-picker' });
  openDialog({
    title: 'Cast to',
    actions: [],
    body: (d) => {
      dialog = d;
      return list;
    },
  });
  // Looking for devices again is a network scan: admins only (the list refreshes itself every 5 minutes for everyone).
  let admin = false;
  const refreshRow = () => (admin ? h('button', { type: 'button', class: 'cast-device cast-refresh', onClick: () => load(true) }, icon('refresh', { size: 22 }), h('span', { class: 'cast-device-name' }, 'Find devices again')) : null);

  async function load(refresh) {
    admin = await isAdmin();
    clear(list).append(h('p', { class: 'cast-looking', role: 'status' }, h('span', { class: 'spinner spinner-sm', 'aria-hidden': 'true' }), 'Looking for devices…'));
    let r;
    try {
      r = await api.get(`/api/cast/devices${refresh ? '?refresh=1' : ''}`);
    } catch (err) {
      clear(list).append(h('p', { class: 'cast-empty' }, err.message), refreshRow());
      return;
    }
    clear(list);
    admin = await isAdmin();
    const addRow = () => (admin ? h('button', { type: 'button', class: 'btn btn-secondary', onClick: async () => {
      const d = await addDeviceDialog();
      if (d) load(false);
    } }, 'Add a device by address…') : null);
    if (!r.enabled) {
      list.append(h('p', { class: 'cast-empty' }, 'Casting is turned off on this server.'));
      return;
    }
    if (!r.reachable) {
      list.append(
        h('div', { class: 'cast-empty' }, h('p', { class: 'cast-empty-title' }, 'Casting needs Atomix on the same home network as your TV'), h('p', { class: 'muted' }, admin ? 'Atomix can only see public addresses here. If your TV can reach it anyway, set the address in Settings → Server → Casting.' : 'Ask whoever runs this Atomix to set it up.')),
      );
      return;
    }
    if (!r.devices.length) {
      list.append(
        h('div', { class: 'cast-empty' }, h('p', { class: 'cast-empty-title' }, 'No devices found on your network.'), h('p', { class: 'muted' }, 'Atomix and the TV must be on the same network. Atomix in Docker needs network_mode: host to see them.'), addRow()),
        refreshRow(),
      );
      list.querySelector('button')?.focus();
      return;
    }
    for (const d of r.devices) {
      list.append(
        h(
          'button',
          { type: 'button', class: 'cast-device', 'data-id': d.id, onClick: (e) => pick(d, e.currentTarget) },
          icon(d.kind === 'chromecast' ? 'cast' : 'tv', { size: 24 }),
          h('span', { class: 'cast-device-text' }, h('span', { class: 'cast-device-name' }, d.name), d.busy || d.model ? h('small', { class: 'muted' }, d.busy ? 'In use' : d.model) : null),
        ),
      );
    }
    list.append(refreshRow());
    list.querySelector('.cast-device')?.focus();
  }

  async function pick(d, row) {
    for (const b of list.querySelectorAll('button')) b.disabled = true;
    row.classList.add('is-busy');
    try {
      const body = { deviceId: d.id, ...target };
      if (position != null) body.position = position;
      if (audioIndex != null) body.audioIndex = audioIndex;
      if (subtitle) body.subtitle = subtitle;
      if (target.queue) (await import('./music.js')).music.pause();
      await startCast(body);
      dialog?.close('done');
      onStarted?.();
      const { navigate } = await import('./app.js');
      navigate('#/cast', { replace: Boolean(onStarted) });
    } catch (err) {
      toast(err.message, { type: 'error' });
      for (const b of list.querySelectorAll('button')) b.disabled = false;
      row.classList.remove('is-busy');
    }
  }
  load(false);
}

/** Add a Chromecast or DLNA TV by its address (admins). Resolves to the device, or null. */
export function addDeviceDialog() {
  const kinds = [['chromecast', 'Chromecast'], ['dlna', 'DLNA TV']];
  let kind = 'chromecast';
  const pills = h('div', { class: 'kind-pills', role: 'radiogroup', 'aria-label': 'Kind of device' });
  const address = h('input', { name: 'address', required: true, autocomplete: 'off', spellcheck: 'false', placeholder: '192.168.1.40' });
  const name = h('input', { name: 'name', maxlength: 80, placeholder: 'Optional' });
  const hint = h('p', { class: 'hint' });
  const paint = () => {
    for (const b of pills.children) {
      b.setAttribute('aria-checked', String(b.dataset.kind === kind));
      b.tabIndex = b.dataset.kind === kind ? 0 : -1;
    }
    address.placeholder = kind === 'chromecast' ? '192.168.1.40' : 'http://192.168.1.50:7676/description.xml';
    hint.textContent = kind === 'chromecast' ? "The Chromecast's address on your network (port 8009 unless you say otherwise)." : "The address of the TV's description file, from the TV's network settings or your router.";
  };
  for (const [k, label] of kinds) pills.append(h('button', { type: 'button', role: 'radio', class: 'pill', 'data-kind': k, onClick: () => ((kind = k), paint()) }, label));
  pills.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    kind = kind === 'chromecast' ? 'dlna' : 'chromecast';
    paint();
    pills.querySelector('[aria-checked=true]')?.focus();
  });
  paint();
  let added = null;
  return openDialog({
    title: 'Add a device',
    body: h('div', { class: 'stack' }, pills, h('div', { class: 'field' }, h('label', {}, 'Address', address), hint), h('div', { class: 'field' }, h('label', {}, 'Name', name))),
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Add', value: 'add', variant: 'primary' },
    ],
    onSubmit: async () => {
      added = await api.post('/api/cast/devices', { kind, address: address.value.trim(), name: name.value.trim() || undefined });
      toast(`Added ${added.name}`, { type: 'success' });
    },
  }).then(() => added);
}

// ---- The pill: what is playing on a TV, from every page ----

const pillArt = h('span', { class: 'cast-pill-art', 'aria-hidden': 'true' });
const pillLabel = h('span', { class: 'cast-pill-label' });
const pillTitle = h('span', { class: 'cast-pill-title' });
const pillPlay = h('button', { type: 'button', class: 'mbtn mbtn-play cast-pill-play', 'aria-label': 'Pause', onClick: () => castCommand(session?.state === 'playing' ? 'pause' : 'play') }, icon('pause', { size: 20 }));
const pillNext = h('button', { type: 'button', class: 'mbtn cast-pill-next', 'aria-label': 'Next', hidden: true, onClick: () => castCommand('next') }, icon('next', { size: 20 }));
export const castPill = h(
  'div',
  { class: 'cast-pill', hidden: true, role: 'region', 'aria-label': 'Casting' },
  h('a', { class: 'cast-pill-open', href: '#/cast' }, pillArt, h('span', { class: 'cast-pill-text' }, pillLabel, pillTitle)),
  h('div', { class: 'cast-pill-buttons' }, pillPlay, pillNext),
);
let pillImage = null;

function paintPill() {
  const s = castState();
  const show = Boolean(s || ended);
  castPill.hidden = !show;
  castPill.classList.toggle('is-ended', !s && Boolean(ended));
  document.documentElement.classList.toggle('has-cast', show);
  if (!show) return;
  if (s) {
    pillLabel.textContent = `Playing on ${s.deviceName}`;
    pillTitle.textContent = s.upNext ? `Up next: ${s.upNext.title}` : s.title;
    if (pillImage !== s.image) {
      pillImage = s.image;
      clear(pillArt).append(art(s.image, s.title, { kind: 'square', eager: true }));
    }
    const playing = s.state === 'playing' || s.state === 'buffering';
    pillPlay.hidden = false;
    pillPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    clear(pillPlay).append(icon(playing ? 'pause' : 'play', { size: 20 }));
    pillNext.hidden = !(s.upNext || (s.queue && s.queue.index + 1 < s.queue.items.length));
  } else {
    pillLabel.textContent = `Casting ended on ${ended.deviceName}`;
    pillTitle.textContent = ended.detail || (ended.ended === 'finished' ? 'It finished.' : '');
    pillPlay.hidden = true;
    pillNext.hidden = true;
  }
}
