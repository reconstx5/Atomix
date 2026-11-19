// Settings: personal profile for everyone, plus admin screens.
import { api } from '../api.js';
import { addDeviceDialog } from '../cast.js';
import { h, icon, clear, timeAgo, formatClock } from '../dom.js';
import { orderLibraries, movePinned, oledMode } from '../appearance-rules.js';
import { button, toast, openDialog, confirmDialog, field, toggle, pillChoice, spinner, avatar, AVATAR_NAMES, rovingRadios, rowActions, moreButton, emptyState, TOASTS } from '../components.js';
import { musicAppsCard, scrobblingCard, lastfmFields, quickConnectCard } from './settings-music.js';
import { installCard } from './settings-install.js';
import { ACCENT_SWATCHES, clampAccent, onAccent } from '../tint.js';
import { httpsCard } from './settings-https.js';
import { downloadAppsCard } from './settings-arr.js';
import { homeCard, householdHomeSection } from './settings-home.js';
import { activityTab } from './settings-activity.js';
import { statsCard, householdSection } from './settings-stats.js';
import { state, setTitle, applyTheme, updatePrefs, signOut, refreshLibraries, navigate, refreshView, canAdmin, isKidsProfile, renderNav, liveAllowed } from '../app.js';

const KIDS_LEVELS = [
  [5, 'Little kids — G only'],
  [10, 'Kids — up to PG'],
  [13, 'Pre-teens — up to 13 (PG-13, R13, 12A)'],
  [16, 'Teens — up to 16 (M, R16, 15)'],
];

/** Checkboxes for picking libraries; returns { el, value() } where value() is null for "all". */
function libraryPicker(libraries, selected, { allLabel = 'All libraries' } = {}) {
  const all = h('input', { type: 'checkbox', checked: selected == null });
  const boxes = (libraries || []).map((l) => ({ id: l.id, box: h('input', { type: 'checkbox', checked: selected == null || selected.includes(l.id), disabled: selected == null }) }));
  all.addEventListener('change', () => {
    for (const b of boxes) {
      b.box.disabled = all.checked;
      if (all.checked) b.box.checked = true;
    }
  });
  const el = h(
    'fieldset',
    { class: 'library-picker' },
    h('legend', {}, 'Libraries'),
    h('label', { class: 'check' }, all, h('span', {}, allLabel)),
    boxes.map((b, i) => h('label', { class: 'check indent' }, b.box, h('span', {}, libraries[i].name))),
  );
  return { el, value: () => (all.checked ? null : boxes.filter((b) => b.box.checked).map((b) => b.id)) };
}

const TABS = [
  { id: 'profile', label: 'Profile', icon: 'user' },
  { id: 'profiles', label: 'Household', icon: 'users', adult: true },
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', admin: true },
  { id: 'libraries', label: 'Libraries', icon: 'folder', admin: true },
  { id: 'users', label: 'Users', icon: 'users', admin: true },
  { id: 'plugins', label: 'Plugins', icon: 'addons', admin: true },
  { id: 'live', label: 'Live TV', icon: 'live', admin: true, live: true },
  { id: 'activity', label: 'Activity', icon: 'list', admin: true },
  { id: 'server', label: 'Server', icon: 'server', admin: true },
];

const select = (options, value, attrs = {}) =>
  h('select', attrs, options.map(([v, label]) => h('option', { value: v, selected: String(value) === String(v) }, label)));

/**
 * Comics in .cbr/.cb7 need 7-Zip or unrar (v0.22): what was found, and where to look. Its own section, so the
 * dashboard's refresh every few seconds doesn't wipe a path being typed.
 */
function archiveSection() {
  const status = h('p', { class: 'archive-status', role: 'status' });
  const input = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '/usr/bin/7z or C:\\Program Files\\7-Zip\\7z.exe' });
  let loaded = false;
  function update(a) {
    if (!loaded) {
      loaded = true;
      api.get('/api/admin/settings').then((s) => (input.value = s.archiveToolPath || '')).catch(() => {});
    }
    const text = a?.available ? `7-Zip found: ${a.kind === 'unrar' ? 'unrar' : '7z'} ${a.version} (${a.path}) — .cbr and .cb7 comics can be read` : '7-Zip or unrar not found — install 7-Zip to read .cbr and .cb7 comics';
    if (status.textContent !== ` ${text}`) status.replaceChildren(h('span', { class: `dot ${a?.available ? 'ok' : 'bad'}` }), ` ${text}`);
  }
  const save = button('Save and look again', {
    variant: 'secondary',
    onClick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        await api.put('/api/admin/settings', { archiveToolPath: input.value.trim() });
        const a = (await api.get('/api/admin/dashboard')).tools.archive;
        update(a);
        toast(a?.available ? '7-Zip found' : '7-Zip or unrar not found', { type: a?.available ? 'info' : 'error' });
      } catch (err) {
        toast(err.message, { type: 'error' });
      } finally {
        b.disabled = false;
      }
    },
  });
  const el = section('Comics', status, field('7-Zip or unrar path', input, 'Leave empty to look for 7z, 7za, 7zz or unrar'), h('div', { class: 'actions' }, save));
  return { el, update };
}

function section(title, ...children) {
  return h('section', { class: 'panel' }, title ? h('h2', {}, title) : null, children);
}

/** v0.29 visual refresh B3: which libraries the menu shows, and in what order. The rest are under "More libraries". */
function menuCard() {
  const box = h('div', { class: 'menu-libraries' });
  const draw = (focus) => {
    clear(box);
    const { pinned, rest } = orderLibraries(state.libraries, state.profile?.prefs?.pinnedLibraries);
    const ids = pinned.map((l) => l.id);
    const set = async (list, again) => {
      await save(() => updatePrefs({ pinnedLibraries: list }), 'Menu updated');
      draw(again);
    };
    for (const l of [...pinned, ...rest]) {
      const i = ids.indexOf(l.id);
      const up = button('Move up', { variant: 'ghost', onClick: () => set(movePinned(ids, l.id, -1), [l.id, 'Move up']), attrs: { disabled: i <= 0 } });
      const down = button('Move down', { variant: 'ghost', onClick: () => set(movePinned(ids, l.id, 1), [l.id, 'Move down']), attrs: { disabled: i < 0 || i >= ids.length - 1 } });
      box.append(h('div', { class: 'menu-library', 'data-library': String(l.id) }, toggle(`Pin ${l.name}`, i >= 0, (v) => set(movePinned(ids, l.id, v ? 'pin' : 'unpin'), [l.id, 'pin'])), up, down));
    }
    if (focus) {
      const row = box.querySelector(`[data-library="${focus[0]}"]`);
      const target = focus[1] === 'pin' ? row?.querySelector('input') : [...(row?.querySelectorAll('button:not([disabled])') || [])].find((b) => b.textContent.trim() === focus[1]) || row?.querySelector('input');
      target?.focus();
    }
  };
  draw();
  return section('Menu', h('p', { class: 'hint' }, 'Pinned libraries show in the menu in this order. The rest are under More libraries.'), box);
}

async function save(fn, message = 'Saved') {
  try {
    const out = await fn();
    toast(message, { type: 'success' });
    return out;
  } catch (err) {
    toast(err.message, { type: 'error' });
    throw err;
  }
}

// ---------------- Accent colour (visual refresh A6) ----------------
// Ten curated colours, "Theme default" and a "Custom…" hex field, in every theme. The colour is stored as chosen; each
// theme clamps it to what reads on it (tint.js clampAccent), and each swatch shows the clamped colour for the theme in
// use. Swatches are plain buttons with aria-pressed and the colour's name, so the arrows reach them like any control.
const BAD_HEX = 'Enter a colour like #3a7bff.';
function accentPicker(prefs, themes, themeId) {
  const schemeOf = (id) => (themes.find((t) => t.id === id)?.colorScheme === 'light' ? 'light' : 'dark');
  let chosen = prefs.accent ? prefs.accent.toLowerCase() : null;
  let scheme = schemeOf(themeId);
  const labelId = `accent-${Math.random().toString(36).slice(2, 9)}`;
  const tick = () => h('span', { class: 'accent-tick', 'aria-hidden': 'true' }, icon('check', { size: 18 }));
  const def = h('button', { type: 'button', class: 'btn btn-ghost accent-default', 'aria-pressed': 'false', onClick: () => pick(null) }, tick(), h('span', {}, 'Theme default'));
  const swatches = ACCENT_SWATCHES.map((s) =>
    h('button', { type: 'button', class: 'accent-swatch', 'aria-pressed': 'false', 'aria-label': s.name, title: s.name, dataset: { hex: s.hex }, onClick: () => pick(s.hex) }, tick()),
  );
  const hexId = `${labelId}-hex`;
  const errorId = `${labelId}-error`;
  const preview = h('span', { class: 'accent-preview', 'aria-hidden': 'true' });
  const hex = h('input', { id: hexId, class: 'accent-hex', type: 'text', inputmode: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: 7, size: 9, placeholder: '#3a7bff', 'aria-describedby': errorId });
  const error = h('p', { class: 'accent-error', id: errorId, role: 'alert' });
  const apply = button('Apply', { variant: 'primary', attrs: { class: 'btn btn-primary accent-apply' }, onClick: () => fromField() });
  hex.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      fromField();
    }
  });
  hex.addEventListener('input', () => showError(false));

  function showError(on) {
    error.textContent = on ? BAD_HEX : '';
    hex.setAttribute('aria-invalid', String(on));
  }
  function fromField() {
    const v = hex.value.trim().toLowerCase();
    const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(v);
    if (!m) return showError(true);
    const full = '#' + (m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]);
    pick(full);
  }
  async function pick(value) {
    showError(false);
    try {
      await save(() => updatePrefs({ accent: value }), value ? 'Accent colour updated' : 'Accent colour: theme default');
    } catch {
      return; // save() has said what went wrong
    }
    chosen = value;
    paint();
  }
  function paint() {
    const custom = chosen && !ACCENT_SWATCHES.some((s) => s.hex === chosen);
    def.setAttribute('aria-pressed', String(!chosen));
    for (const b of swatches) {
      b.style.setProperty('--sw', clampAccent(b.dataset.hex, scheme));
      b.style.setProperty('--sw-ink', onAccent(clampAccent(b.dataset.hex, scheme)));
      b.setAttribute('aria-pressed', String(b.dataset.hex === chosen));
    }
    if (custom && document.activeElement !== hex) hex.value = chosen;
    preview.style.setProperty('--sw', custom ? clampAccent(chosen, scheme) : 'transparent');
    preview.classList.toggle('is-empty', !custom);
  }
  const hintText = (id) => (themes.find((t) => t.id === id)?.artworkTint ? 'Used when a title has no artwork to take its colour from. ' : '') + 'Each colour is adjusted so it stays readable in this theme.';
  const hint = h('p', { class: 'hint' }, hintText(themeId));
  paint();
  const el = h(
    'div',
    { class: 'field accent-picker' },
    h('p', { class: 'field-label', id: labelId }, 'Accent colour'),
    hint,
    h('div', { class: 'accent-swatches', role: 'group', 'aria-labelledby': labelId }, def, swatches),
    h('div', { class: 'accent-custom' }, h('label', { for: hexId, class: 'field-label' }, 'Custom…'), preview, hex, apply),
    error,
  );
  return {
    el,
    repaint(id) {
      scheme = schemeOf(id);
      hint.textContent = hintText(id);
      paint();
    },
  };
}

// ---------------- Profile ----------------
async function profileTab(el) {
  const user = state.user;
  const profile = state.profile;
  const prefs = profile.prefs || {};
  // The server's default theme first (Orbit, normally); the rest as the server lists them.
  const themes = [...state.themes].sort((a, b) => (b.id === state.status.defaultTheme) - (a.id === state.status.defaultTheme));
  const current = prefs.theme || state.status.defaultTheme;

  const themeGrid = rovingRadios(h('div', { class: 'theme-grid', role: 'radiogroup', 'aria-label': 'Theme' }));
  for (const t of themes) {
    const p = t.preview || {};
    const selected = t.id === current;
    themeGrid.append(
      h(
        'button',
        {
          type: 'button',
          class: 'theme-card',
          role: 'radio',
          'aria-checked': String(selected),
          onClick: async () => {
            await save(() => updatePrefs({ theme: t.id }), `Theme: ${t.name}`);
            accent.repaint(t.id);
            for (const c of themeGrid.children) c.setAttribute('aria-checked', String(c === themeGrid.children[themes.indexOf(t)]));
          },
        },
        h(
          'span',
          { class: 'theme-swatch', style: { '--sw-bg': p.background || '#111', '--sw-surface': p.surface || '#222', '--sw-accent': p.accent || '#f60' } },
          h('span', { class: `sw-nav sw-${t.layout}` }),
          h('span', { class: 'sw-card' }),
          h('span', { class: 'sw-card' }),
          h('span', { class: 'sw-card' }),
        ),
        h('span', { class: 'theme-name' }, t.name),
        h('span', { class: 'theme-desc' }, t.description),
      ),
    );
  }

  const accent = accentPicker(prefs, themes, current);

  const quality = select(
    [
      ['original', 'Original (best)'],
      ['1080', '1080p'],
      ['720', '720p — good for remote/mobile'],
      ['480', '480p — low bandwidth'],
    ],
    prefs.quality || 'original',
  );
  quality.addEventListener('change', () => save(() => updatePrefs({ quality: quality.value })));
  const subSize = select(
    [
      [0.8, 'Small'],
      [1, 'Medium'],
      [1.3, 'Large'],
      [1.7, 'Extra large'],
    ],
    prefs.subtitleSize || 1,
  );
  subSize.addEventListener('change', () => save(() => updatePrefs({ subtitleSize: Number(subSize.value) })));
  const subLang = h('input', { value: prefs.subtitleLanguage || '', placeholder: 'e.g. en', maxlength: 3, size: 6 });
  subLang.addEventListener('change', () => save(() => updatePrefs({ subtitleLanguage: subLang.value.trim().toLowerCase() || null })));
  const audioLang = h('input', { value: prefs.audioLanguage || '', placeholder: 'e.g. en', maxlength: 3, size: 6 });
  audioLang.addEventListener('change', () => save(() => updatePrefs({ audioLanguage: audioLang.value.trim().toLowerCase() || null })));

  const displayName = h('input', { value: user.displayName, maxlength: 40, autocomplete: 'nickname' });
  displayName.addEventListener('change', () =>
    save(async () => {
      state.user = (await api.patch('/api/me', { displayName: displayName.value })).user;
    }),
  );

  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  const confirm = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  const pwForm = h('form', { class: 'stack' }, field('Current password', cur), field('New password', next, 'At least 8 characters.'), field('Confirm new password', confirm), button('Change password', { type: 'submit', variant: 'secondary' }));
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (next.value !== confirm.value) return toast("New passwords don't match", { type: 'error' });
    await save(() => api.post('/api/me/password', { current: cur.value, password: next.value }), 'Password changed. Other devices were signed out.');
    pwForm.reset();
  });

  el.append(
    section(
      'Appearance',
      themeGrid,
      accent.el,
      toggle('Reduce motion', prefs.reduceMotion, (v) => save(() => updatePrefs({ reduceMotion: v })), { hint: 'Nothing grows, slides or zooms. Fades stay, so you can still see what changed.' }),
      pillChoice('Glass', [['clear', 'Clear'], ['tinted', 'Tinted'], ['solid', 'Solid']], document.documentElement.dataset.glass || 'tinted', (v) => save(() => updatePrefs({ glass: v, reduceEffects: null })), { hint: 'How see-through menus and panels are. Solid is easiest to read and fastest on TVs.' }),
      document.documentElement.style.colorScheme === 'light' ? null : toggle('True black (for OLED screens)', oledMode(prefs, themes.find((t) => t.id === current) || { colorScheme: 'dark' }), (v) => save(() => updatePrefs({ oled: v })), { hint: 'A black page with thin edges on panels. Saves power on OLED TVs and phones.' }),
      toggle('More contrast', document.documentElement.dataset.contrast === 'more', (v) => save(() => updatePrefs({ contrast: v ? 'more' : 'normal' })), { hint: 'Stronger text, solid panels and clear edges on buttons and cards.' }),
      pillChoice('Text size', [[1, 'Normal'], [1.15, 'Large'], [1.3, 'Largest']], prefs.textScale || 1, (v) => save(() => updatePrefs({ textScale: v })), { hint: 'Makes the words bigger everywhere in Atomix.' }),
      toggle('Play previews on cards', prefs.cardPreviews !== false, (v) => save(() => updatePrefs({ cardPreviews: v })), { hint: 'After a moment on a title, a few silent seconds of it play on the card. Never on kids profiles or with Reduce motion on.' }),
    ),
    section(
      'Playback',
      h('div', { class: 'form-grid' }, field('Default quality', quality, 'Lower quality converts video on the server to save bandwidth.'), field('Subtitle size', subSize), field('Preferred subtitle language', subLang, 'Two-letter code. Leave empty to only show forced subtitles.'), field('Preferred audio language', audioLang)),
      toggle('Play the next episode automatically', prefs.autoplayNext !== false, (v) => save(() => updatePrefs({ autoplayNext: v }))),
      toggle('Skip intros automatically', prefs.skipIntros === true, (v) => save(() => updatePrefs({ skipIntros: v })), { hint: 'You can still choose Watch it when it skips.' }),
    ),
    menuCard(),
    homeCard(),
    listeningCard(prefs),
    statsCard(),
    musicAppsCard(),
    scrobblingCard(),
    state.status?.quickConnect ? quickConnectCard() : null,
    installCard(),
    isKidsProfile()
      ? section('Profile', h('div', { class: 'profile-line' }, avatar(profile, 48), h('div', {}, h('strong', {}, profile.name), h('p', { class: 'muted' }, 'Kids profile'))), h('div', { class: 'actions' }, button('Switch profile', { icon: 'users', href: '#/profiles' })))
      : section(
          'Account',
          h('div', { class: 'form-grid' }, field('Display name', displayName), h('div', {}, h('p', { class: 'muted' }, `Signed in as ${user.username} (${user.role}) · watching as ${profile.name}`), h('div', { class: 'actions' }, button('Switch profile', { icon: 'users', variant: 'ghost', href: '#/profiles' }), button('Sign out', { icon: 'logout', variant: 'ghost', onClick: signOut })))),
          h('h3', {}, 'Change password'),
          pwForm,
        ),
  );
}

// ---------------- Listening (v0.22): audiobooks and podcasts skip back and forward by these ----------------
function listeningCard(prefs) {
  const pick = (values, current, key, label) => {
    const sel = h('select', {}, values.map((v) => h('option', { value: String(v), selected: v === current }, `${v} seconds`)));
    sel.addEventListener('change', () => save(() => updatePrefs({ [key]: Number(sel.value) })));
    return field(label, sel);
  };
  return section(
    'Listening',
    h('p', { class: 'muted' }, 'For audiobooks and podcasts: the skip buttons, J and L, and Left and Right on the player bar.'),
    h('div', { class: 'form-grid' }, pick([5, 10, 15, 30, 45, 60], prefs.spokenBack ?? 15, 'spokenBack', 'Skip back'), pick([10, 15, 30, 45, 60, 90, 120], prefs.spokenForward ?? 30, 'spokenForward', 'Skip forward')),
    // v0.28: even volume for music.
    toggle('Even out volume between songs', prefs.levelVolume !== false, (v) => save(() => updatePrefs({ levelVolume: v })), { hint: 'Quiet and loud songs play at about the same volume. Not on iPhone or iPad.' }),
  );
}

// ---------------- Profiles ----------------
async function profileDialog(existing) {
  const p = existing || { name: '', avatar: AVATAR_NAMES[Math.floor(Math.random() * AVATAR_NAMES.length)], kids: false, maxAge: 10, allowUnrated: false, libraries: null, hasPin: false };
  const name = h('input', { value: p.name, required: true, maxlength: 30, 'data-autofocus': true });
  let chosenAvatar = p.avatar;
  const avatars = h(
    'div',
    { class: 'avatar-choices', role: 'radiogroup', 'aria-label': 'Colour' },
    AVATAR_NAMES.map((a) => {
      const b = h('button', { type: 'button', role: 'radio', class: 'avatar-choice', 'aria-checked': String(a === chosenAvatar), 'aria-label': a, onClick: () => {
        chosenAvatar = a;
        for (const c of avatars.children) c.setAttribute('aria-checked', String(c === b));
      } }, avatar({ name: name.value || '?', avatar: a }, 40));
      return b;
    }),
  );
  rovingRadios(avatars);
  name.addEventListener('input', () => {
    for (const el of avatars.querySelectorAll('.avatar')) el.textContent = (name.value.trim()[0] || '?').toUpperCase();
  });
  const kids = h('input', { type: 'checkbox', checked: p.kids, disabled: p.isPrimary });
  const level = select(KIDS_LEVELS, p.maxAge ?? 10);
  const unrated = h('input', { type: 'checkbox', checked: p.allowUnrated });
  const kidsOptions = h('div', { class: 'stack kids-options', hidden: !p.kids }, field('Allowed ratings', level, 'Titles rated above this are hidden. Ratings come from TMDB or .nfo files.'), h('label', { class: 'check' }, unrated, h('span', {}, 'Also show titles with no rating (home videos, add-ons)')));
  kids.addEventListener('change', () => (kidsOptions.hidden = !kids.checked));
  const libs = libraryPicker(state.libraries, p.libraries, { allLabel: 'All libraries this account can see' });
  const liveGroups = canAdmin() ? await liveGroupsField(existing) : null;
  // Only on a Kids profile (ticking "Kids profile" brings it in).
  if (liveGroups) {
    if (kids.checked) kidsOptions.append(liveGroups.el);
    kids.addEventListener('change', () => (kids.checked ? kidsOptions.append(liveGroups.el) : liveGroups.el.remove()));
  }
  const pin = h('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]{4,8}', maxlength: 8, autocomplete: 'new-password', placeholder: p.hasPin ? 'Leave empty to keep' : 'Optional' });
  const removePin = p.hasPin ? h('input', { type: 'checkbox' }) : null;

  const body = h(
    'div',
    { class: 'stack' },
    field('Name', name),
    h('div', {}, h('p', { class: 'field-label' }, 'Colour'), avatars),
    h('label', { class: 'check' }, kids, h('span', {}, p.isPrimary ? "Kids profile (the main profile can't be one)" : 'Kids profile')),
    kidsOptions,
    libs.el,
    field('PIN', pin, 'Ask for 4–8 digits before anyone can open this profile. Set one on grown-up profiles so kids can’t switch into them.'),
    removePin ? h('label', { class: 'check' }, removePin, h('span', {}, 'Remove the PIN')) : null,
  );
  return openDialog({
    title: existing ? `Edit ${existing.name}` : 'Add a profile',
    wide: true,
    body,
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: existing ? 'Save' : 'Add profile', value: 'ok', variant: 'primary' },
    ],
    onSubmit: async () => {
      const payload = { name: name.value.trim(), avatar: chosenAvatar, kids: kids.checked, maxAge: Number(level.value), allowUnrated: unrated.checked, libraries: libs.value() };
      if (removePin?.checked) payload.pin = null;
      else if (pin.value) payload.pin = pin.value;
      const saved = existing ? await api.patch(`/api/profiles/${existing.id}`, payload) : await api.post('/api/profiles', payload);
      if (liveGroups && saved.kids) await api.put(`/api/profiles/${saved.id}/live-groups`, liveGroups.value());
      if (saved.id === state.profile.id) {
        state.profile = saved;
        applyTheme();
        renderNav();
      }
      toast(existing ? 'Profile saved' : `${saved.name} added`, { type: 'success' });
      return true;
    },
  });
}

/**
 * A Kids profile's Live TV: a box per group per source; none ticked means no Live TV for them. Null when no live
 * source has channels.
 */
async function liveGroupsField(existing) {
  const status = await api.get('/api/live/status').catch(() => null);
  const sources = (status?.sources || []).filter((s) => s.channels > 0 && s.groups?.length);
  if (!sources.length) return null;
  const ticked = existing?.kids ? await api.get(`/api/profiles/${existing.id}/live-groups`).catch(() => []) : [];
  const on = new Set(ticked.map((g) => `${g.source}\u0000${g.group}`));
  const boxes = [];
  const el = h(
    'fieldset',
    { class: 'stack live-groups-field' },
    h('legend', {}, 'Live TV groups'),
    h('p', { class: 'muted small' }, 'Kids see only the channels in the groups ticked here. None ticked: no Live TV.'),
    sources.map((s) =>
      h(
        'div',
        { class: 'live-groups-source' },
        sources.length > 1 ? h('p', { class: 'field-label' }, s.name) : null,
        h(
          'div',
          { class: 'live-groups-boxes' },
          s.groups.map((g) => {
            const box = h('input', { type: 'checkbox', checked: on.has(`${s.id}\u0000${g}`) });
            boxes.push({ box, source: s.id, group: g });
            return h('label', { class: 'check' }, box, h('span', {}, g));
          }),
        ),
      ),
    ),
  );
  // Only the sources shown here are replaced: ticks for a source not listed (no channels or groups right now) stay.
  return { el, value: () => ({ sources: sources.map((s) => s.id), groups: boxes.filter((b) => b.box.checked).map((b) => ({ source: b.source, group: b.group })) }) };
}

async function profilesTab(el) {
  const profiles = await api.get('/api/profiles');
  el.append(h('div', { class: 'panel-head' }, h('p', { class: 'muted' }, 'Each profile has its own watch history, Continue Watching row and preferences. Kids profiles only see titles up to the rating you choose.'), button('Add profile', { icon: 'plus', variant: 'primary', autofocus: true, onClick: async () => (await profileDialog()) === 'ok' && refreshView() })));
  const list = h('ul', { class: 'profile-list', role: 'list' });
  for (const p of profiles) {
    const level = KIDS_LEVELS.find(([age]) => age === p.maxAge)?.[1] || `up to age ${p.maxAge}`;
    list.append(
      h(
        'li',
        { class: 'panel profile-row' },
        avatar(p, 56),
        h('div', { class: 'profile-row-info' }, h('h2', {}, p.name, p.id === state.profile.id ? h('span', { class: 'chip' }, 'You') : null), h('p', { class: 'muted' }, [p.isPrimary ? 'Main profile' : null, p.kids ? `Kids · ${level}` : null, p.hasPin ? 'PIN set' : null, p.libraries ? `${p.libraries.length} librar${p.libraries.length === 1 ? 'y' : 'ies'}` : null].filter(Boolean).join(' · ') || 'Standard profile')),
        rowActions(p.name, [
          { label: 'Edit', icon: 'edit', title: `Edit ${p.name}`, onSelect: async () => (await profileDialog(p)) === 'ok' && refreshView() },
          p.isPrimary
            ? null
            : {
                label: 'Delete',
                icon: 'trash',
                danger: true,
                title: `Delete ${p.name}`,
                onSelect: async () => {
                  if (await confirmDialog(`Delete ${p.name}?`, 'Their watch history and preferences will be removed.', { confirm: 'Delete', danger: true })) {
                    await api.del(`/api/profiles/${p.id}`);
                    refreshView();
                  }
                },
              },
        ]),
      ),
    );
  }
  el.append(list);
}

// ---------------- Dashboard ----------------
const TASK_PAUSED = {
  converting: 'Paused while someone watches a video the server is converting.',
  'no-ffmpeg': 'Waiting for ffmpeg. Install it to make previews and find intros.',
  disabled: 'Both are turned off in Server settings.',
};

/** What the background jobs are doing, what's left, and anything that failed. */
function backgroundSection(t, reload) {
  const doing = { previews: 'Making seek-bar previews for', thumb: 'Making a thumbnail for', clip: 'Making a preview clip for', lyrics: 'Reading the lyrics in', subtitles: 'Reading the subtitles in', intros: 'Finding intros in' };
  const now = t.running ? `${doing[t.running.job] || 'Working on'} ${t.running.title}.` : TASK_PAUSED[t.paused] || 'Nothing running right now.';
  const waiting = [
    t.queued.previews ? `${t.queued.previews} ${t.queued.previews === 1 ? 'title' : 'titles'} waiting for previews` : null,
    t.queued.intros ? `${t.queued.intros} ${t.queued.intros === 1 ? 'season' : 'seasons'} waiting for an intro check` : null,
    t.queued.thumbs ? `${t.queued.thumbs} ${t.queued.thumbs === 1 ? 'extra' : 'extras'} waiting for a thumbnail` : null,
    t.queued.clips ? `${t.queued.clips} ${t.queued.clips === 1 ? 'title' : 'titles'} waiting for a preview clip` : null,
    t.queued.lyrics ? `${t.queued.lyrics} ${t.queued.lyrics === 1 ? 'song' : 'songs'} waiting for a lyrics check` : null,
    t.queued.subtitles ? `${t.queued.subtitles} ${t.queued.subtitles === 1 ? 'title' : 'titles'} waiting for a subtitle check` : null,
  ].filter(Boolean);
  return section(
    'Background tasks',
    h('p', {}, now, waiting.length ? ` ${waiting.join(', ')}.` : ''),
    t.failed.length
      ? h('ul', { class: 'plain-list' }, t.failed.map((f) => h('li', {}, h('strong', {}, f.title), ` (${{ previews: 'previews', clip: 'preview clip' }[f.job] || 'intro check'}): `, h('span', { class: 'danger-text' }, f.error || 'failed'))))
      : null,
    t.failed.length ? button('Try again', { icon: 'refresh', onClick: async () => (await api.post('/api/admin/tasks/retry', {}), toast('Trying again'), reload()) }) : null,
  );
}

async function dashboardTab(el) {
  const body = h('div');
  const archive = archiveSection();
  el.append(body, archive.el, householdSection());
  async function load() {
    const [d, tasks, live] = await Promise.all([api.get('/api/admin/dashboard'), api.get('/api/admin/tasks'), api.get('/api/live/status').catch(() => null)]);
    const liveErrors = (live?.sources || []).filter((s) => s.error).map((s) => h('p', { class: 'form-error', role: 'status' }, `Live TV: ${s.error}`));
    clear(body);
    const t = d.tools;
    archive.update(t.archive);
    const toolRow = (name, info) => h('li', {}, h('span', { class: `dot ${info.available ? 'ok' : 'bad'}` }), h('strong', {}, name), ' ', info.available ? `v${info.version}` : h('span', { class: 'danger-text' }, `not found (${info.path})`));
    // (a section that isn't there is null: left out, not printed as "null")
    body.append(...[
      h(
        'div',
        { class: 'stat-grid' },
        [
          ['Movies', d.counts.movies],
          ['Shows', d.counts.shows],
          ['Episodes', d.counts.episodes],
          d.counts.albums ? ['Albums', d.counts.albums] : null,
          d.counts.tracks ? ['Songs', d.counts.tracks] : null,
          ['Users', d.counts.users],
        ].filter(Boolean).map(([k, v]) => h('div', { class: 'stat' }, h('span', { class: 'stat-value' }, String(v)), h('span', { class: 'stat-label' }, k))),
      ),
      section(
        'Now playing',
        d.sessions.length
          ? h(
              'table',
              { class: 'table' },
              h('thead', {}, h('tr', {}, ['Who', 'What', 'Mode', 'Position', ''].map((c) => h('th', { scope: 'col' }, c)))),
              h(
                'tbody',
                {},
                d.sessions.map((s) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, s.user, h('br'), h('small', { class: 'muted' }, s.clientIp || '')),
                    h('td', {}, h('a', { href: `#/item/${s.itemId}` }, s.title)),
                    h('td', {}, h('span', { class: `chip mode-${s.mode}` }, s.mode), s.quality !== 'original' ? ` ${s.quality}p` : '', h('br'), h('small', { class: 'muted' }, s.reasons?.join(', ') || '')),
                    h('td', {}, `${formatClock(s.position)}${s.paused ? ' (paused)' : ''}`),
                    h('td', {}, button('', { icon: 'close', variant: 'ghost', title: 'Stop this stream', onClick: async () => (await api.post(`/api/admin/sessions/${s.id}/stop`, {}), load()) })),
                  ),
                ),
              ),
            )
          : emptyState({ title: 'Nobody is watching right now', icon: 'play', level: 3 }),
      ),
      d.tuners?.length
        ? section(
            'Tuners in use',
            h(
              'table',
              { class: 'table' },
              h('thead', {}, h('tr', {}, ['Channel', 'Watching', 'Recording'].map((c) => h('th', { scope: 'col' }, c)))),
              h('tbody', {}, d.tuners.map((t) => h('tr', {}, h('td', {}, t.channel), h('td', {}, t.viewers.length ? t.viewers.join(', ') : '—'), h('td', {}, t.recording ? `Recording ${t.recording}` : '—')))),
            ),
          )
        : null,
      d.downloadsPreparing ? section('Downloads', h('p', {}, `Preparing downloads: ${d.downloadsPreparing}`)) : null,
      d.nextRecordings?.length
        ? section(
            'Next recordings',
            h('ul', { class: 'plain-list' }, d.nextRecordings.map((r) => h('li', {}, h('strong', {}, r.title), ` · ${r.channel} · ${new Date(r.start).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`))),
            h('a', { href: '#/live/recordings' }, 'All recordings'),
          )
        : null,
      section(
        'Library scan',
        h('p', {}, d.scan.running ? `Scanning ${d.scan.library}: ${d.scan.phase} (${d.scan.done}/${d.scan.total || '?'})` : `Idle. Last scan finished ${timeAgo(d.scan.finishedAt)}${d.scan.error ? ` with an error: ${d.scan.error}` : ''}.`),
        d.scan.warning ? h('p', { class: 'form-error', role: 'status' }, `${d.scan.warning}. Is the drive connected?`) : null,
        ...liveErrors,
        h(
          'div',
          { class: 'actions' },
          button('Scan all libraries', { icon: 'refresh', onClick: async () => (await api.post('/api/scan', {}), TOASTS.scanStarted(), setTimeout(load, 800)) }),
          button('Refresh all metadata', {
            icon: 'sparkle',
            variant: 'ghost',
            onClick: async () => {
              if (await confirmDialog('Refresh all metadata?', 'This re-downloads descriptions and artwork for everything. It can take a while for big libraries.', { confirm: 'Refresh' })) {
                await api.post('/api/scan', { refreshMetadata: true });
                TOASTS.refreshStarted();
              }
            },
          }),
        ),
        !d.tmdbConfigured ? h('p', { class: 'notice' }, icon('info'), ' No TMDB API key yet — posters and descriptions will be limited. ', h('a', { href: '#/settings/server' }, 'Add one in Server settings.')) : null,
      ),
      backgroundSection(tasks, load),
      d.servers?.length
        ? section(
            'Connected servers',
            h('ul', { class: 'plain-list servers-card' }, d.servers.map((s) => { const st = serverState(s); return h('li', {}, h('span', { class: `dot ${st.bad ? 'bad' : 'ok'}` }), h('strong', {}, s.name), ' ', h('span', { class: `server-state${st.bad ? ' bad' : ''}` }, st.text)); })),
            h('a', { href: '#/settings/libraries' }, 'Manage in Libraries'),
          )
        : null,
      section(
        'Server',
        h(
          'ul',
          { class: 'plain-list' },
          toolRow('ffmpeg', t.ffmpeg),
          toolRow('ffprobe', t.ffprobe),
          h('li', {}, h('strong', {}, 'H.264 encoders in ffmpeg: '), t.encoders.length ? t.encoders.join(', ') : 'none', h('small', { class: 'muted' }, ' (hardware ones also need a matching GPU)')),
          h('li', {}, h('strong', {}, 'Atomix '), d.server.version, ' on Node ', d.server.node, ` · ${d.server.platform}`),
          h('li', {}, h('strong', {}, 'Uptime '), formatClock(d.server.uptime), ` · ${d.server.memoryMb} MB RAM · ${d.server.cpus} CPU threads`),
          h('li', {}, h('strong', {}, 'Data folder '), h('code', {}, d.server.dataDir)),
        ),
        !t.ffmpeg.available
          ? h('p', { class: 'notice' }, icon('info'), ' Install ffmpeg to play MKV/HEVC files and read media info. On Windows: ', h('code', {}, 'winget install Gyan.FFmpeg'), ', then restart Atomix.')
          : null,
        button('Re-check ffmpeg', { variant: 'ghost', icon: 'refresh', onClick: async () => (await api.post('/api/admin/tools/recheck', {}), load()) }),
      ),
    ].filter(Boolean));
  }
  await load();
  const timer = setInterval(() => load().catch(() => {}), 5000);
  return () => clearInterval(timer);
}

// ---------------- Folder picker ----------------
async function pickFolder(startPath = '') {
  let current = startPath;
  let chosen = null;
  const list = h('ul', { class: 'folder-list', role: 'list' });
  const pathLabel = h('code', { class: 'folder-path' });
  async function open(p) {
    clear(list).append(spinner());
    try {
      const data = await api.get(`/api/admin/fs?path=${encodeURIComponent(p)}`);
      current = data.path;
      pathLabel.textContent = data.path || 'Choose a drive or folder';
      clear(list);
      if (data.parent !== null) list.append(h('li', {}, h('button', { type: 'button', class: 'folder-item', onClick: () => open(data.parent) }, icon('back', { size: 18 }), ' Up one level')));
      for (const d of data.dirs) list.append(h('li', {}, h('button', { type: 'button', class: 'folder-item', onClick: () => open(d.path) }, icon('folder', { size: 18 }), ` ${d.name}`)));
      if (!data.dirs.length) list.append(h('li', { class: 'muted' }, 'No sub-folders here.'));
      list.querySelector('button')?.focus();
    } catch (err) {
      clear(list).append(h('li', { class: 'form-error' }, err.message));
    }
  }
  open(startPath);
  const result = await openDialog({
    title: 'Choose a folder',
    wide: true,
    body: h('div', {}, pathLabel, list),
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Use this folder', value: 'ok', variant: 'primary' },
    ],
    onSubmit: () => {
      if (!current) {
        toast('Open a folder first');
        return false;
      }
      chosen = current;
      return true;
    },
  });
  return result === 'ok' ? chosen : null;
}

// ---------------- Libraries ----------------
const LIBRARY_HINTS = {
  movies: 'Example: Movies/Movie Title (2010)/Movie Title (2010).mkv — one folder per movie is best, but loose files work too.',
  tv: 'Example: TV/Show Name (2019)/Season 01/Show Name S01E01.mkv',
  music: 'Example: Music/Artist/Album (2004)/01 - Song.flac — artist, album and track numbers are read from the tags when the files have them. Put cover.jpg in the album folder for artwork.',
  podcasts: 'A folder for the episodes Atomix downloads. Add podcasts from the library page with Subscribe.',
  audiobooks: 'Example: Audiobooks/Author/Book Title/01.mp3 — a folder of files is one book; a single .m4b is one book with its chapters.',
  books: 'Example: Books/Author/Book Title.epub — the title, author, series and cover are read from the book.',
  comics: 'Example: Comics/Series Name/Series Name 012.cbz — a folder of pictures is one comic too. .cbr and .cb7 need 7-Zip (Settings → Dashboard).',
};
const LIBRARY_ICON = { movies: 'film', tv: 'tv', music: 'music', podcasts: 'mic', audiobooks: 'book', books: 'book', comics: 'book' };
const LIBRARY_NOUN = { movies: 'movies', tv: 'shows', music: 'albums', podcasts: 'podcasts', audiobooks: 'books', books: 'books', comics: 'comics' };

async function libraryDialog(lib) {
  const name = h('input', { value: lib?.name || '', required: true, maxlength: 60, placeholder: 'e.g. Movies' });
  if (lib?.serverId) {
    // A connected server's library: the server owns its folders and media, so only the name is ours to change.
    return openDialog({
      title: `Edit ${lib.name}`,
      body: h('div', { class: 'stack' }, field('Name', name, `On ${lib.serverName}. What it holds is set on that server.`)),
      actions: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Save', value: 'ok', variant: 'primary' },
      ],
      onSubmit: async () => {
        await api.put(`/api/libraries/${lib.id}`, { name: name.value.trim() });
        TOASTS.saved('Library');
        return true;
      },
    });
  }
  const type = select(
    [
      ['movies', 'Movies'],
      ['tv', 'TV shows'],
      ['music', 'Music'],
      ['podcasts', 'Podcasts'],
      ['audiobooks', 'Audiobooks'],
      ['books', 'Books (EPUB)'],
      ['comics', 'Comics (CBZ, CBR, CB7)'],
    ],
    lib?.type || 'movies',
    { disabled: Boolean(lib) },
  );
  const paths = [...(lib?.paths || [])];
  const list = h('ul', { class: 'path-list', role: 'list' });
  const newPath = h('input', { placeholder: 'D:\\Movies  or  /media/movies', 'aria-label': 'Folder path' });
  const previews = h('input', { type: 'checkbox', checked: lib?.options?.previews !== false });
  const previewsRow = h('label', { class: 'check', hidden: !['movies', 'tv'].includes(type.value) }, previews, h('span', {}, 'Make seek-bar previews'));
  function renderPaths() {
    clear(list);
    if (!paths.length) list.append(h('li', { class: 'muted' }, 'No folders yet.'));
    paths.forEach((p, i) =>
      list.append(h('li', {}, icon('folder', { size: 18 }), h('code', {}, p), button('', { icon: 'trash', variant: 'ghost', title: `Remove ${p}`, onClick: () => (paths.splice(i, 1), renderPaths()) }))),
    );
  }
  renderPaths();
  const addPath = () => {
    const v = newPath.value.trim();
    if (v && !paths.includes(v)) paths.push(v);
    newPath.value = '';
    renderPaths();
  };
  newPath.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addPath();
    }
  });
  const body = h(
    'div',
    { class: 'stack' },
    h('div', { class: 'form-grid' }, field('Name', name), field('Type', type, lib ? "Type can't be changed after creation." : 'TV expects Show/Season folders; music is sorted by its tags.')),
    h('div', {}, h('p', { class: 'field-label', id: 'folders-label' }, 'Folders'), list, h('div', { class: 'inline-fields' }, newPath, button('Add', { icon: 'plus', onClick: addPath }), button('Browse…', { icon: 'folder', onClick: async () => { const p = await pickFolder(paths[paths.length - 1] || ''); if (p && !paths.includes(p)) { paths.push(p); renderPaths(); } } }))),
    previewsRow,
    h('p', { class: 'hint' }, LIBRARY_HINTS[type.value]),
  );
  type.addEventListener('change', () => {
    body.querySelector('.hint').textContent = LIBRARY_HINTS[type.value];
    previewsRow.hidden = !['movies', 'tv'].includes(type.value);
  });
  return openDialog({
    title: lib ? `Edit ${lib.name}` : 'Add a library',
    wide: true,
    body,
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: lib ? 'Save' : 'Add and scan', value: 'ok', variant: 'primary' },
    ],
    onSubmit: async () => {
      if (newPath.value.trim()) addPath();
      const payload = { name: name.value.trim(), type: type.value, paths, options: { previews: previews.checked } };
      if (lib) await api.put(`/api/libraries/${lib.id}`, payload);
      else await api.post('/api/libraries', payload);
      toast(lib ? 'Library saved' : 'Library added — scanning now', { type: 'success' });
      return true;
    },
  });
}

// ---------------- Connected servers (admins) ----------------
const SERVER_KINDS = [
  ['jellyfin', 'Jellyfin'],
  ['emby', 'Emby'],
  ['plex', 'Plex'],
  ['atomix', 'Atomix'],
];
const kindName = (k) => SERVER_KINDS.find(([id]) => id === k)?.[1] || k;

/** "Synced 2 h ago", "Sign in again", "Can't reach <name>" — one line for a server's state. */
function serverState(s) {
  if (s.status === 'unauthorized') return { text: 'Sign in again', bad: true };
  if (s.status === 'unreachable') return { text: `Can't reach ${s.name}`, bad: true };
  return { text: s.lastSync ? `Synced ${timeAgo(s.lastSync)}` : 'Not synced yet', bad: false };
}

function serversPanel(servers) {
  const rows = servers.map((s) => {
    const st = serverState(s);
    const address = s.url.replace(/^https?:\/\//, '');
    const gone = s.libraries.filter((l) => l.gone);
    return h(
      'div',
      { class: 'server-row', 'data-id': s.id },
      icon('server', { size: 28 }),
      h(
        'div',
        { class: 'server-info' },
        h('h3', {}, s.name),
        h('p', { class: 'muted' }, `${kindName(s.kind)} · ${address} · ${s.libraries.length ? s.libraries.map((l) => l.name).join(', ') : 'no libraries added'}${s.relay ? ' · via Plex relay (slow)' : ''}`),
        h('p', { class: `server-state${st.bad ? ' bad' : ''}` }, st.bad ? icon('info', { size: 16 }) : null, st.text, gone.length ? ` · No longer on ${s.name}: ${gone.map((l) => l.name).join(', ')}` : ''),
      ),
      h(
        'div',
        { class: 'actions' },
        s.status === 'unauthorized'
          ? button('Sign in again', { icon: 'lock', variant: 'primary', onClick: async () => { if ((await reconnectDialog(s)) === 'ok') refreshView(); } })
          : button('Sync now', { icon: 'refresh', onClick: async () => (await api.post(`/api/servers/${s.id}/sync`, {}), toast(`Syncing ${s.name}…`)) }),
        button('Libraries…', { icon: 'grid', variant: 'ghost', onClick: async () => { if ((await chooseLibrariesDialog(s)) === 'ok') { await refreshLibraries(); refreshView(); } } }),
        button('Remove', {
          icon: 'trash',
          variant: 'ghost danger',
          onClick: async () => {
            if (await confirmDialog(`Remove ${s.name}?`, 'Its libraries leave Atomix, with everyone’s watch history for them. Nothing changes on that server.', { confirm: 'Remove', danger: true })) {
              await api.del(`/api/servers/${s.id}`);
              await refreshLibraries();
              refreshView();
            }
          },
        }),
      ),
    );
  });
  return h(
    'section',
    { class: 'panel servers-panel' },
    h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, 'Connected servers'), h('p', { class: 'muted' }, 'A Jellyfin, Emby, Plex or Atomix server you already run. Its libraries appear beside your own and play through this Atomix.')), button('Connect a server…', { icon: 'plus', variant: 'primary', onClick: async () => { if ((await connectServerDialog()) === 'ok') { await refreshLibraries(); refreshView(); } } })),
    rows.length ? h('div', { class: 'server-list' }, rows) : emptyState({ title: 'No servers connected', icon: 'cloud', level: 3 }),
  );
}

/** The kind pills act as one radio group: Left/Right move the choice (and focus) within the group. */
function kindPills(initial = 'jellyfin') {
  let value = initial;
  const group = h('div', { class: 'kind-pills', role: 'radiogroup', 'aria-label': 'Kind of server' });
  const pick = (k, focus = false) => {
    value = k;
    for (const b of group.children) {
      b.setAttribute('aria-checked', String(b.dataset.kind === k));
      b.tabIndex = b.dataset.kind === k ? 0 : -1;
      if (focus && b.dataset.kind === k) b.focus();
    }
    group.dispatchEvent(new Event('change'));
  };
  for (const [k, label] of SERVER_KINDS) {
    group.append(h('button', { type: 'button', role: 'radio', class: 'pill', 'data-kind': k, 'aria-checked': String(k === value), tabindex: k === value ? 0 : -1, onClick: () => pick(k) }, label));
  }
  group.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const i = SERVER_KINDS.findIndex(([k]) => k === value);
    pick(SERVER_KINDS[(i + (e.key === 'ArrowRight' ? 1 : SERVER_KINDS.length - 1)) % SERVER_KINDS.length][0], true);
  });
  return { el: group, get value() { return value; } };
}

/**
 * The plex.tv link code: a big code to type at plex.tv/link, polled every 2 s while the dialog is open.
 * `onLinked(pinId, servers)` is called once linked. Returns { el, start(), stop() }.
 */
function plexLinkStep({ onLinked }) {
  const el = h('div', { class: 'plex-link stack', 'aria-live': 'polite' });
  let timer = null;
  let live = false;
  let pinId = null;
  let linked = false;
  let failures = 0; // polls that failed in a row: plex.tv hiccups are retried quietly up to three times
  const stop = () => {
    live = false;
    clearTimeout(timer);
  };
  const show = (...children) => {
    clear(el);
    el.append(...children);
  };
  const problem = (text, label) => show(h('p', { class: 'danger-text plex-problem' }, icon('info', { size: 16 }), ' ', text), button(label, { icon: 'refresh', onClick: () => start() }));
  async function poll() {
    if (!live || !el.isConnected) return stop();
    try {
      const r = await api.get(`/api/servers/plex/pins/${pinId}`);
      if (!live || !el.isConnected) return stop();
      failures = 0;
      if (r.expired) return (stop(), problem('That code has expired', 'New code'));
      if (r.linked) {
        stop();
        linked = true;
        if (!r.servers.length) return show(h('p', { class: 'muted' }, 'This Plex account has no servers.'));
        return onLinked(pinId, r.servers);
      }
    } catch (err) {
      if (!live) return;
      if (++failures < 3) {
        timer = setTimeout(poll, 2000);
        return;
      }
      stop();
      return problem(err.message.startsWith("Couldn't reach plex.tv") ? err.message : `Couldn't reach plex.tv: ${err.message}`, 'Try again');
    }
    timer = setTimeout(poll, 2000);
  }
  /** Back on the Plex pill with a code still waiting: carry on polling it (no new code). */
  function resume() {
    if (live || linked || !pinId) return false;
    live = true;
    poll();
    return true;
  }
  async function start() {
    stop();
    live = true;
    linked = false;
    pinId = null;
    failures = 0;
    show(spinner());
    try {
      const pin = await api.post('/api/servers/plex/pins', {});
      if (!live) return;
      pinId = pin.pinId;
      show(
        h('p', { class: 'plex-code', 'aria-label': `Code ${pin.code.split('').join(' ')}` }, pin.code),
        h('p', { class: 'plex-howto' }, 'Go to ', h('strong', {}, 'plex.tv/link'), ' on your phone or computer and enter this code'),
        h('p', { class: 'muted plex-waiting' }, h('span', { class: 'plex-dot', 'aria-hidden': 'true' }), ' Waiting for Plex…'),
      );
      timer = setTimeout(poll, 2000);
    } catch (err) {
      if (live) problem(err.message.startsWith("Couldn't reach plex.tv") ? err.message : `Couldn't reach plex.tv: ${err.message}`, 'Try again');
      live = false;
    }
  }
  return { el, start, stop, show, resume };
}

/** Pick a server: one row per server ("Yours" / "Shared by <owner>"); Up/Down move, Enter or a click picks. */
function plexServerList(servers, onPick) {
  const group = h('div', { class: 'plex-servers', role: 'radiogroup', 'aria-label': 'Pick a server' });
  servers.forEach((sv, i) => {
    group.append(
      h('button', { type: 'button', role: 'radio', class: 'plex-server', 'data-id': sv.id, 'aria-checked': String(i === 0), tabindex: i === 0 ? 0 : -1, 'data-autofocus': i === 0 || null, onClick: () => onPick(sv) },
        icon('server', { size: 22 }), h('span', { class: 'plex-server-name' }, sv.name), h('span', { class: 'muted' }, sv.owned ? 'Yours' : `Shared by ${sv.owner}`)),
    );
  });
  group.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const rows = [...group.children];
    const i = Math.max(0, rows.indexOf(document.activeElement));
    const next = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    for (const r of rows) { r.setAttribute('aria-checked', String(r === next)); r.tabIndex = r === next ? 0 : -1; }
    next.focus();
  });
  return group;
}

/** Step one of Connect a server…: kind, address, sign-in. A good sign-in goes straight to the libraries step. */
async function connectServerDialog() {
  const kind = kindPills('jellyfin');
  const url = h('input', { name: 'url', required: true, placeholder: 'jellyfin.local:8096', autocomplete: 'off', 'data-autofocus': true });
  const username = h('input', { name: 'username', required: true, autocomplete: 'off' });
  const password = h('input', { name: 'password', type: 'password', required: true, autocomplete: 'new-password' });
  const httpNote = h('p', { class: 'hint http-note', hidden: true }, icon('info', { size: 16 }), ' Sign-ins travel unencrypted over http. Fine on your own network; use https across the internet.');
  const hint = h('p', { class: 'hint kind-hint' });
  const hints = { jellyfin: 'Your Jellyfin account on that server.', emby: 'Your Emby account on that server.', atomix: 'An account on that Atomix with a profile that has no PIN.', plex: '' };
  url.addEventListener('input', () => (httpNote.hidden = !/^\s*http:\/\//i.test(url.value)));
  let connected = null;
  let pickedPin = null;
  let picked = null;
  // Plex: no address or password — a link code, then the account's servers.
  let busy = false;
  let posting = null; // the pick being posted (the dialog may be cancelled before it answers)
  const plexConnect = async (sv) => {
    if (busy) return; // a double press posts once
    busy = true;
    picked = sv;
    plexStep.el.querySelector('.plex-problem')?.remove();
    plexStep.el.querySelector('.plex-servers')?.setAttribute('aria-busy', 'true');
    try {
      posting = api.post('/api/servers', { kind: 'plex', pinId: pickedPin, serverId: sv.id });
      connected = await posting;
      plexStep.el.closest('dialog')?.close('ok');
    } catch (e) {
      plexStep.el.append(h('p', { class: 'danger-text plex-problem' }, icon('info', { size: 16 }), ' ', e.message));
    } finally {
      busy = false;
      posting = null;
      plexStep.el.querySelector('.plex-servers')?.removeAttribute('aria-busy');
    }
  };
  const plexStep = plexLinkStep({
    onLinked: (pinId, servers) => {
      pickedPin = pinId;
      plexStep.show(h('p', { class: 'field-label' }, 'Pick a server'), plexServerList(servers, plexConnect));
      plexStep.el.querySelector('[data-autofocus]')?.focus();
    },
  });
  const signIn = h(
    'div',
    { class: 'stack' },
    field('Address', url, 'With the port if it has one. https is assumed when you leave it out.'),
    httpNote,
    h('div', { class: 'form-grid' }, field('Username', username), field('Password', password)),
  );
  const setKind = () => {
    hint.textContent = hints[kind.value];
    const plex = kind.value === 'plex';
    signIn.hidden = plex;
    for (const i of [url, username, password]) i.required = !plex;
    plexStep.el.hidden = !plex;
    if (plex && !pickedPin && !plexStep.el.childElementCount) plexStep.start();
    else if (plex && !pickedPin) plexStep.resume();
    if (!plex) plexStep.stop();
  };
  kind.el.addEventListener('change', setKind);
  const body = h(
    'div',
    { class: 'stack' },
    h('div', {}, h('p', { class: 'field-label' }, 'Kind'), kind.el),
    signIn,
    plexStep.el,
    hint,
  );
  setKind();
  const r = await openDialog({
    title: 'Connect a server…',
    wide: true,
    body,
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Connect', value: 'ok', variant: 'primary' },
    ],
    onSubmit: async () => {
      if (kind.value === 'plex') {
        // Connect with a Plex server row chosen (the checked one); before the code is linked there is nothing to do.
        const row = plexStep.el.querySelector('.plex-server[aria-checked="true"]');
        if (row) await plexConnect({ id: row.dataset.id });
        else if (!pickedPin) {
          plexStep.el.querySelector('.plex-first')?.remove();
          plexStep.el.append(h('p', { class: 'danger-text plex-first', role: 'alert' }, icon('info', { size: 16 }), ' Enter the code at plex.tv/link first'));
        }
        return false;
      }
      connected = await api.post('/api/servers', { kind: kind.value, url: url.value.trim(), username: username.value.trim(), password: password.value });
      return true;
    },
  });
  plexStep.stop();
  // Cancelled while a pick was still posting: once it answers, the panel still has to show the new server.
  if (r !== 'ok' && posting) {
    await posting.catch(() => null);
    return connected ? 'ok' : r;
  }
  if (r !== 'ok' || !connected) return r;
  await chooseLibrariesDialog(connected, connected.available);
  return 'ok'; // the server exists either way: the panel must show it even when the libraries step was cancelled
}

/** Step two (and Libraries… later): tick the server's libraries to show in Atomix. */
async function chooseLibrariesDialog(server, available = null) {
  const list = h('div', { class: 'stack lib-choices' }, spinner());
  const dialog = openDialog({
    title: available ? `Add libraries from ${server.name}` : `Libraries on ${server.name}`,
    body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Ticked libraries appear beside your own, for everyone, under the same access and kids rules.'), list),
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: available ? 'Add' : 'Save', value: 'ok', variant: 'primary' },
    ],
    onSubmit: async () => {
      const remoteIds = [...list.querySelectorAll('input[name=lib]:checked')].map((c) => c.value);
      await api.put(`/api/servers/${server.id}/libraries`, { remoteIds });
      toast(remoteIds.length ? `Syncing from ${server.name}…` : 'Libraries saved', { type: 'success' });
      return true;
    },
  });
  try {
    const libs = available || (await api.get(`/api/servers/${server.id}/available`));
    const have = new Set((server.libraries || []).map((l) => l.remoteId));
    clear(list);
    if (!libs.length) list.append(h('p', { class: 'muted' }, `${server.name} has no movie, TV or music libraries that this account can see.`));
    libs.forEach((l, i) =>
      list.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'lib', value: l.remoteId, checked: available ? true : have.has(l.remoteId), 'data-autofocus': i === 0 || null }), h('span', {}, `${l.name} `, h('small', { class: 'muted' }, LIBRARY_NOUN[l.type] ? `(${l.type === 'tv' ? 'TV shows' : l.type})` : '')))),
    );
    for (const l of server.libraries || []) if (l.gone && !libs.some((x) => x.remoteId === l.remoteId)) list.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'lib', value: l.remoteId, checked: true }), h('span', {}, `${l.name} `, h('small', { class: 'muted' }, `(no longer on ${server.name})`))));
    list.querySelector('[data-autofocus]')?.focus();
  } catch (err) {
    clear(list);
    list.append(h('p', { class: 'danger-text' }, err.message));
  }
  return dialog;
}

/** Sign in again: a new token or password for a server that stopped accepting the stored one. */
async function reconnectDialog(server) {
  if (server.kind === 'plex') {
    // A fresh link code; once linked, the same server is reached again with that account's token.
    const msg = h('div');
    const step = plexLinkStep({
      onLinked: async (pinId) => {
        step.show(h('p', { class: 'muted plex-waiting' }, h('span', { class: 'plex-dot', 'aria-hidden': 'true' }), ` Signing in to ${server.name}…`));
        try {
          await api.post(`/api/servers/${server.id}/reconnect`, { pinId });
          toast(`Signed in to ${server.name}`, { type: 'success' });
          step.el.closest('dialog')?.close('ok');
        } catch (e) {
          step.show(h('p', { class: 'danger-text plex-problem' }, icon('info', { size: 16 }), ' ', e.message), button('New code', { icon: 'refresh', onClick: () => step.start() }));
        }
      },
    });
    const done = openDialog({
      title: `Sign in to ${server.name}`,
      body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, `${server.name} no longer accepts the saved sign-in.`), step.el, msg),
      actions: [{ label: 'Cancel', value: 'cancel' }],
    });
    step.start();
    const r = await done;
    step.stop();
    return r;
  }
  const username = h('input', { name: 'username', value: server.username, required: true, autocomplete: 'off' });
  const password = h('input', { name: 'password', type: 'password', required: true, autocomplete: 'new-password', 'data-autofocus': true });
  return openDialog({
    title: `Sign in to ${server.name}`,
    body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, `${server.name} no longer accepts the saved sign-in. Enter the password again (or a different account).`), h('div', { class: 'form-grid' }, field('Username', username), field('Password', password))),
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Sign in', value: 'ok', variant: 'primary' },
    ],
    onSubmit: async () => {
      await api.post(`/api/servers/${server.id}/reconnect`, { username: username.value.trim(), password: password.value });
      toast(`Signed in to ${server.name}`, { type: 'success' });
      return true;
    },
  });
}

/** "Remove missing titles": count them, ask in the library's own panel, then remove them. */
async function removeMissing(lib, panel) {
  if (!panel || panel.querySelector('.library-confirm')) return;
  const { count } = await api.post(`/api/admin/libraries/${lib.id}/remove-missing`, { dryRun: true });
  if (!count) return toast('No missing titles in this library');
  const ask = h('div', { class: 'library-confirm', role: 'group', 'aria-label': 'Remove missing titles' });
  const done = () => {
    ask.remove();
    panel.querySelector('.actions button')?.focus();
  };
  const remove = button('Remove', {
    variant: 'danger',
    onClick: async () => {
      remove.disabled = true;
      const r = await api.post(`/api/admin/libraries/${lib.id}/remove-missing`, {}).catch((err) => (toast(err.message, { type: 'error' }), null));
      ask.remove();
      if (r) {
        toast(r.removed === 1 ? 'Removed 1 title' : `Removed ${r.removed} titles`);
        await refreshLibraries();
        refreshView();
      }
    },
  });
  ask.append(h('p', {}, count === 1 ? 'Remove 1 title whose file is gone?' : `Remove ${count} titles whose files are gone?`), h('div', { class: 'actions' }, remove, button('Cancel', { variant: 'ghost', onClick: done })));
  panel.append(ask);
  remove.focus();
}

async function librariesTab(el) {
  const panels = new Map();
  const panelOf = (lib) => panels.get(lib.id);
  const [libs, servers] = await Promise.all([api.get('/api/libraries'), api.get('/api/servers')]);
  el.append(
    h('div', { class: 'panel-head' }, h('p', { class: 'muted' }, 'Point Atomix at folders on this computer or server, or connect a media server you already run. They are scanned automatically.'), button('Add library', { icon: 'plus', variant: 'primary', autofocus: true, onClick: async () => { if ((await libraryDialog()) === 'ok') { await refreshLibraries(); refreshView(); } } })),
    serversPanel(servers),
  );
  if (!libs.length) {
    el.append(section(null, emptyState({ title: 'No libraries yet', text: 'Add your movie folder first, then your TV folder.', icon: 'film', level: 2 })));
    return;
  }
  const gone = new Set(servers.flatMap((s) => s.libraries.filter((l) => l.gone).map((l) => l.id)));
  for (const lib of libs) {
    const caption = lib.serverId
      ? gone.has(lib.id) ? `No longer on ${lib.serverName} · ${lib.count} ${LIBRARY_NOUN[lib.type] || 'items'} kept` : `On ${lib.serverName} · ${lib.count} ${LIBRARY_NOUN[lib.type] || 'items'} · synced ${timeAgo(lib.lastScan)}`
      : `${lib.count} ${LIBRARY_NOUN[lib.type] || 'items'} · last scanned ${timeAgo(lib.lastScan)}`;
    const panel = h(
        'section',
        { class: `panel library-panel${lib.serverId ? ' library-remote' : ''}` },
        h('div', { class: 'library-panel-head' }, icon(lib.serverId ? 'cloud' : LIBRARY_ICON[lib.type] || 'film', { size: 28 }), h('div', {}, h('h2', {}, lib.name), h('p', { class: 'muted' }, caption))),
        lib.serverId ? null : h('ul', { class: 'plain-list' }, lib.paths.map((p) => h('li', {}, h('code', {}, p)))),
        h(
          'div',
          { class: 'actions' },
          button(lib.serverId ? 'Sync now' : 'Scan now', { icon: 'refresh', onClick: async () => (await api.post(`/api/libraries/${lib.id}/scan`, {}), (lib.serverId ? TOASTS.syncStarted() : TOASTS.scanStarted())) }),
          button('Edit', { icon: 'edit', variant: 'ghost', onClick: async () => { if ((await libraryDialog(lib)) === 'ok') { await refreshLibraries(); refreshView(); } } }),
          lib.serverId ? null : moreButton(lib.name, [{ label: 'Remove missing titles', icon: 'trash', onSelect: () => removeMissing(lib, panelOf(lib)) }]),
          lib.serverId ? null : button('Delete', {
            icon: 'trash',
            variant: 'ghost danger',
            onClick: async () => {
              if (await confirmDialog(`Delete ${lib.name}?`, 'This removes it from Atomix (and everyone’s watch history for it). Your files are not touched.', { confirm: 'Delete', danger: true })) {
                await api.del(`/api/libraries/${lib.id}`);
                await refreshLibraries();
                refreshView();
              }
            },
          }),
        ),
      );
    panels.set(lib.id, panel);
    el.append(panel);
  }
  el.append(await collectionsPanel());
}

// ---------------- Collections (admins) ----------------
async function collectionsPanel() {
  const cols = await api.get('/api/collections?all=1');
  const rows = cols.map((c) =>
    h(
      'tr',
      {},
      h('td', {}, c.name),
      h('td', { class: 'muted' }, `${c.owned} of ${c.total}`),
      h('td', { class: 'muted' }, c.manual ? 'Hand-made' : 'TMDB', c.hidden ? ' · hidden' : ''),
      h(
        'td',
        { class: 'row-actions' },
        c.manual ? button('Edit', { icon: 'edit', variant: 'ghost', onClick: async () => { if ((await collectionDialog(c)) === 'ok') refreshView(); } }) : null,
        button('Rename', { icon: 'edit', variant: 'ghost', onClick: () => renameCollection(c) }),
        c.manual
          ? button('Delete', { icon: 'trash', variant: 'ghost', onClick: async () => { if (await confirmDialog('Delete this collection?', `“${c.name}” goes; the films stay.`, { confirm: 'Delete', danger: true })) { await api.del(`/api/collections/${c.id}`); refreshView(); } } })
          : button(c.hidden ? 'Show' : 'Hide', { icon: c.hidden ? 'eye' : 'eyeOff', variant: 'ghost', onClick: async () => { await api.patch(`/api/collections/${c.id}`, { hidden: !c.hidden }); refreshView(); } }),
      ),
    ),
  );
  return h(
    'section',
    { class: 'panel collections-panel' },
    h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, 'Collections'), h('p', { class: 'muted' }, 'Film series come from TMDB as your films are matched. Make your own from films and shows.')), button('New collection', { icon: 'plus', variant: 'primary', onClick: async () => { if ((await collectionDialog(null)) === 'ok') refreshView(); } })),
    cols.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Name'), h('th', { scope: 'col' }, 'In your library'), h('th', { scope: 'col' }, 'From'), h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, 'Actions')))), h('tbody', {}, rows))) : emptyState({ title: 'No collections yet', icon: 'list', level: 3 }),
  );
}

function renameCollection(c) {
  const name = h('input', { type: 'text', name: 'name', value: c.name, maxlength: '80', required: true, 'data-autofocus': true });
  openDialog({
    title: 'Rename collection',
    body: field('Name', name),
    actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Save', value: 'ok', variant: 'primary' }],
    onSubmit: async () => {
      await api.patch(`/api/collections/${c.id}`, { name: name.value });
      TOASTS.saved('Collection');
      refreshView();
    },
  });
}

/** New or edit a hand-made collection: a name, a search box that adds films and shows, the members in order. */
async function collectionDialog(existing) {
  const full = existing ? await api.get(`/api/collections/${existing.id}?all=1`) : null;
  const members = full ? full.items.map((i) => ({ id: i.id, title: i.title, year: i.year })) : [];
  const name = h('input', { type: 'text', name: 'name', value: existing?.name || '', maxlength: '80', required: true, 'data-autofocus': true });
  const overview = h('textarea', { name: 'overview', rows: '2' }, existing?.overview || '');
  const search = h('input', { type: 'search', placeholder: 'Find a film or show', 'aria-label': 'Find a film or show', autocomplete: 'off' });
  // Enter here picks the first hit (or does nothing); it must not save and close the dialog.
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    results.querySelector('button')?.click();
  });
  const results = h('div', { class: 'pick-results' });
  const list = h('ol', { class: 'pick-members', role: 'list' });
  const artwork = h('select', { 'aria-label': 'Artwork from' });
  function drawMembers() {
    clear(list);
    members.forEach((m, i) => {
      list.append(
        h(
          'li',
          {},
          h('span', { class: 'pick-title' }, `${m.title}${m.year ? ` (${m.year})` : ''}`),
          button('', { icon: 'up', variant: 'ghost', title: 'Move up', onClick: () => { if (i > 0) { members.splice(i - 1, 0, members.splice(i, 1)[0]); drawMembers(); } } }),
          button('', { icon: 'chevronDown', variant: 'ghost', title: 'Move down', onClick: () => { if (i < members.length - 1) { members.splice(i + 1, 0, members.splice(i, 1)[0]); drawMembers(); } } }),
          button('', { icon: 'close', variant: 'ghost', title: 'Remove', onClick: () => { members.splice(i, 1); drawMembers(); } }),
        ),
      );
    });
    clear(artwork).append(h('option', { value: '' }, 'First title'), members.map((m) => h('option', { value: String(m.id) }, m.title)));
  }
  drawMembers();
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = search.value.trim();
      clear(results);
      if (q.length < 2) return;
      const r = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
      const hits = [...r.movies, ...r.shows].filter((i) => !members.some((m) => m.id === i.id)).slice(0, 12);
      const nodes = hits.map((i) => button(`${i.title}${i.year ? ` (${i.year})` : ''}`, { icon: 'plus', variant: 'ghost', onClick: () => { members.push({ id: i.id, title: i.title, year: i.year }); drawMembers(); clear(results); search.value = ''; } }));
      results.append(...(nodes.length ? nodes : [h('p', { class: 'muted small' }, 'Nothing matches.')]));
    }, 250);
  });
  return openDialog({
    title: existing ? 'Edit collection' : 'New collection',
    wide: true,
    body: h('div', { class: 'stack' }, field('Name', name), field('Description', overview), field('Add titles', search), results, h('div', { class: 'field' }, h('label', {}, 'Titles, in order'), list), field('Artwork from', artwork)),
    actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Save', value: 'ok', variant: 'primary' }],
    onSubmit: async () => {
      const body = { name: name.value, overview: overview.value, itemIds: members.map((m) => m.id) };
      if (artwork.value) body.artworkFrom = Number(artwork.value);
      if (existing) await api.patch(`/api/collections/${existing.id}`, body);
      else await api.post('/api/collections', body);
      TOASTS.saved('Collection');
    },
  });
}

// ---------------- Users ----------------
async function userDialog(user) {
  const username = h('input', { value: user?.username || '', required: true, disabled: Boolean(user), autocomplete: 'off', pattern: '[A-Za-z0-9._\\-]{2,32}' });
  const displayName = h('input', { value: user?.displayName || '', maxlength: 40 });
  const password = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: !user, placeholder: user ? 'Leave empty to keep' : '' });
  const role = select(
    [
      ['user', 'Viewer'],
      ['admin', 'Admin (can change settings)'],
    ],
    user?.role || 'user',
  );
  const allLibraries = await api.get('/api/libraries');
  const access = libraryPicker(allLibraries, user?.libraryAccess ?? null);
  // v0.21: downloads to the app on this person's devices (admins always may).
  const dlSw = toggle('Can download', Boolean(user?.canDownload), null, { hint: 'Download films, episodes and music into the Atomix app to watch offline.' });
  const dlOn = dlSw.querySelector('input');
  dlOn.name = 'canDownload';
  const dlNote = h('p', { class: 'muted small', id: `dl-note-${Math.random().toString(36).slice(2, 8)}`, hidden: true }, 'Admins can always download.');
  dlOn.setAttribute('aria-describedby', [dlOn.getAttribute('aria-describedby'), dlNote.id].filter(Boolean).join(' '));
  // Admin forces it on; back to Viewer puts back what it was (a demoted admin's own setting, off for someone new).
  let chosen = user ? user.role !== 'admin' && Boolean(user.canDownload) : false;
  dlOn.addEventListener('change', () => (chosen = dlOn.checked));
  const syncDownloads = () => {
    const admin = role.value === 'admin';
    dlOn.disabled = admin;
    dlOn.checked = admin || chosen;
    dlNote.hidden = !admin;
  };
  role.addEventListener('change', syncDownloads);
  syncDownloads();
  return openDialog({
    title: user ? `Edit ${user.username}` : 'Add a person',
    wide: true,
    body: h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, field('Username', username), field('Display name', displayName), field(user ? 'New password' : 'Password', password, 'At least 8 characters.'), field('Role', role)), h('div', {}, dlSw, dlNote), access.el),
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: user ? 'Save' : 'Add', value: 'ok', variant: 'primary' },
    ],
    onSubmit: async () => {
      if (user) {
        const body = { displayName: displayName.value, role: role.value, libraryAccess: access.value(), canDownload: role.value === 'admin' || chosen };
        if (password.value) body.password = password.value;
        await api.patch(`/api/users/${user.id}`, body);
      } else {
        await api.post('/api/users', { username: username.value.trim(), displayName: displayName.value.trim(), password: password.value, role: role.value, libraryAccess: access.value(), canDownload: dlOn.checked });
      }
      toast('Saved', { type: 'success' });
      return true;
    },
  });
}

async function usersTab(el) {
  const users = await api.get('/api/users');
  el.append(
    h('div', { class: 'panel-head' }, h('p', { class: 'muted' }, 'Everyone gets their own watch history and preferences.'), button('Add person', { icon: 'plus', variant: 'primary', onClick: async () => (await userDialog()) === 'ok' && refreshView() })),
    h(
      'section',
      { class: 'panel' },
      h(
        'table',
        { class: 'table' },
        h('thead', {}, h('tr', {}, ['Name', 'Role', 'Last sign-in', ''].map((c) => h('th', { scope: 'col' }, c)))),
        h(
          'tbody',
          {},
          users.map((u) =>
            h(
              'tr',
              {},
              h('td', {}, h('strong', {}, u.displayName), h('br'), h('small', { class: 'muted' }, u.username)),
              h('td', {}, u.role === 'admin' ? 'Admin' : 'Viewer', u.libraryAccess ? h('br') : null, u.libraryAccess ? h('small', { class: 'muted' }, `${u.libraryAccess.length} librar${u.libraryAccess.length === 1 ? 'y' : 'ies'}`) : null, u.role !== 'admin' && u.canDownload ? [h('br'), h('small', { class: 'muted' }, 'Downloads')] : null),
              h('td', {}, timeAgo(u.lastLogin)),
              h(
                'td',
                { class: 'row-actions-cell' },
                rowActions(u.username, [
                  { label: 'Edit', icon: 'edit', title: `Edit ${u.username}`, onSelect: async () => (await userDialog(u)) === 'ok' && refreshView() },
                  u.id !== state.user.id
                    ? {
                        label: 'Delete',
                        icon: 'trash',
                        danger: true,
                        title: `Delete ${u.username}`,
                        onSelect: async () => {
                          if (await confirmDialog(`Delete ${u.username}?`, 'Their watch history will be removed too.', { confirm: 'Delete', danger: true })) {
                            await api.del(`/api/users/${u.id}`);
                            refreshView();
                          }
                        },
                      }
                    : null,
                ]),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

// ---------------- Plugins ----------------
function pluginSettingsForm(plugin) {
  if (!plugin.settings.length) return null;
  const inputs = {};
  const fields = plugin.settings.map((s) => {
    let input;
    const value = plugin.config[s.key];
    if (s.type === 'boolean') {
      input = h('input', { type: 'checkbox', checked: Boolean(value) });
      inputs[s.key] = () => input.checked;
      return h('label', { class: 'check' }, input, h('span', {}, s.label));
    }
    if (s.type === 'select') input = select((s.options || []).map((o) => (typeof o === 'object' ? [o.value, o.label || o.value] : [o, o])), value);
    else if (s.type === 'textarea') input = h('textarea', { rows: 5 }, value ?? '');
    else input = h('input', { type: s.type === 'number' ? 'number' : s.type === 'password' ? 'password' : 'text', value: value ?? '' });
    inputs[s.key] = () => input.value;
    return field(s.label, input, s.help);
  });
  const form = h('form', { class: 'stack plugin-form' }, fields, button('Save settings', { type: 'submit' }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = {};
    for (const [k, get] of Object.entries(inputs)) values[k] = get();
    await save(() => api.put(`/api/admin/plugins/${plugin.id}/config`, values), `${plugin.name} settings saved`);
  });
  return h('details', { class: 'plugin-settings' }, h('summary', {}, 'Settings'), form);
}

/** A plugin's live source on its card: the last refresh (or why it failed), channels without guide, Refresh now. */
function liveSourceBlock(source, status) {
  const st = status?.sources?.find((s) => s.id === source.key) || null;
  if (!st?.lastRefresh && !st?.error) return null; // not set up yet: its settings below are the next step
  const line = st?.lastRefresh ? `Last refresh: ${timeAgo(st.lastRefresh)}${st.summary ? ` · ${st.summary}` : ''}` : 'Not refreshed yet';
  const unmatched = st?.unmatched || [];
  const radio = { count: st?.unmatchedRadio?.count || 0, names: st?.unmatchedRadio?.names || [] };
  const refresh = button('Refresh now', {
    icon: 'refresh',
    variant: 'secondary',
    attrs: { class: 'btn btn-secondary plugin-live-refresh' },
    onClick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const r = await api.post(`/api/live/sources/${encodeURIComponent(source.key)}/refresh`, {});
        if (r.ok) toast(`Refreshed — ${r.channels} ${r.channels === 1 ? 'channel' : 'channels'}`, { type: 'success' });
        else toast(r.error || "Couldn't refresh", { type: 'error', timeout: 9000 });
        refreshLibraries?.();
      } catch (err) {
        toast(err.message, { type: 'error' });
      } finally {
        btn.disabled = false;
        refreshView();
      }
    },
  });
  return h(
    'div',
    { class: 'plugin-live stack' },
    h('p', {}, h('strong', {}, `${source.name}: `), line),
    st?.error ? h('p', { class: 'form-error', role: 'status' }, st.error) : null,
    st?.warning ? h('p', { class: 'muted' }, st.warning) : null,
    unmatched.length ? h('details', {}, h('summary', {}, `Channels without guide (${unmatched.length})`), h('p', { class: 'muted small' }, unmatched.slice(0, 20).join(', ') + (unmatched.length > 20 ? ` and ${unmatched.length - 20} more` : ''))) : null,
    // Radio stations rarely have a guide: folded, after the TV list, so they don't bury it.
    radio.count ? h('details', {}, h('summary', {}, `Radio without guide (${radio.count})`), h('p', { class: 'muted small' }, radio.names.slice(0, 20).join(', ') + (radio.count > 20 ? ` and ${radio.count - Math.min(20, radio.names.length)} more` : ''))) : null,
    h('div', { class: 'actions' }, refresh),
  );
}

async function pluginsTab(el) {
  const plugins = await api.get('/api/admin/plugins');
  const liveStatus = plugins.some((p) => p.provides.live?.length) ? await api.get('/api/live/status').catch(() => null) : null;
  el.append(
    h('div', { class: 'panel-head' }, h('p', { class: 'muted' }, 'Plugins live in the ', h('code', {}, 'plugins'), ' folder. Drop a new one in and restart Atomix. See docs/PLUGINS.md to write your own.')),
  );
  if (!plugins.length) el.append(section(null, h('p', {}, 'No plugins found.')));
  for (const p of plugins) {
    const provides = [
      ...p.provides.sources.map((s) => `Source: ${s}`),
      ...(p.provides.subtitles || []).map((s) => `Subtitles: ${s}`),
      ...p.provides.homeRows.map((s) => `Home row: ${s}`),
      ...p.provides.metadata.map((s) => `Metadata: ${s}`),
      ...(p.provides.routes.length ? [`${p.provides.routes.length} API route${p.provides.routes.length === 1 ? '' : 's'}`] : []),
    ];
    el.append(
      h(
        'section',
        { class: 'panel plugin-panel' },
        h(
          'div',
          { class: 'plugin-head' },
          h('div', {}, h('h2', {}, p.name, ' ', h('small', { class: 'muted' }, `v${p.version}`)), h('p', {}, p.description), p.author ? h('p', { class: 'muted small' }, `by ${p.author}`) : null),
          toggle(p.enabled ? 'On' : 'Off', p.enabled, async (v) => {
            await save(() => api.post(`/api/admin/plugins/${p.id}/enabled`, { enabled: v }), `${p.name} ${v ? 'enabled' : 'disabled'}`);
            refreshView();
          }),
        ),
        p.error ? h('p', { class: 'form-error' }, `Failed to load: ${p.error}`) : null,
        p.enabled && p.status ? h('p', { class: 'muted small plugin-status' }, p.status) : null,
        provides.length ? h('ul', { class: 'chips', role: 'list' }, provides.map((x) => h('li', { class: 'chip' }, x))) : null,
        p.enabled && p.actions?.some((a) => a.available)
          ? h(
              'div',
              { class: 'actions plugin-actions' },
              p.actions.filter((a) => a.available).map((a) =>
                button(a.label, {
                  icon: 'sparkle',
                  variant: 'ghost',
                  onClick: async (e) => {
                    const btn = e.currentTarget;
                    btn.disabled = true;
                    try {
                      const r = await api.post(`/api/admin/plugins/${p.id}/actions/${a.id}`, {});
                      toast(r.message, { type: /failed/i.test(r.message) ? 'error' : 'success', timeout: 7000 });
                    } catch (err) {
                      toast(err.message, { type: 'error' });
                    } finally {
                      btn.disabled = false;
                    }
                  },
                }),
              ),
            )
          : null,
        p.enabled ? (p.provides.live || []).map((src) => liveSourceBlock(src, liveStatus)) : null,
        pluginSettingsForm(p),
      ),
    );
  }
}

// ---------------- Server ----------------
async function serverTab(el) {
  const [s, dash, castInfo] = await Promise.all([api.get('/api/admin/settings'), api.get('/api/admin/dashboard'), api.get('/api/cast/devices').catch(() => null)]);
  const encoders = dash.tools.encoders;
  const serverName = h('input', { value: s.serverName, maxlength: 60 });
  const loginMessage = h('input', { value: s.loginMessage, maxlength: 200, placeholder: 'Optional note on the sign-in page' });
  const defaultTheme = select(state.themes.map((t) => [t.id, t.name]), s.defaultTheme);
  const scanInterval = h('input', { type: 'number', min: 0, max: 10080, value: s.scanIntervalMinutes });
  const remoteSync = h('input', { type: 'number', min: 0, max: 168, value: s.remoteSyncHours ?? 6 });
  const thumbCache = h('input', { type: 'number', min: 100, max: 100000, value: s.thumbCacheMB ?? 2048 });
  const tmdbKey = h('input', { type: 'password', value: s.tmdbApiKey, autocomplete: 'off', spellcheck: 'false' });
  const lastfm = lastfmFields(s);
  const language = h('input', { value: s.metadataLanguage, maxlength: 10, placeholder: 'en-US' });
  const ratingCountry = select(
    [
      ['NZ', 'New Zealand'],
      ['AU', 'Australia'],
      ['GB', 'United Kingdom'],
      ['IE', 'Ireland'],
      ['US', 'United States'],
      ['CA', 'Canada'],
    ],
    s.ratingCountry,
  );
  // Switches with a short name and the longer sentence as their hint (a screen reader reads both, separately).
  const transcodingSw = toggle('Convert video when needed', s.transcodingEnabled, null, { hint: 'Let the server convert videos the browser can’t play.' });
  const transcoding = transcodingSw.querySelector('input');
  const hwLabel = (id, label, enc) => [id, `${label}${enc && !encoders.includes(enc) ? ' (not detected)' : ''}`];
  const hwAccel = select(
    [
      ['none', 'None — CPU (libx264)'],
      hwLabel('nvenc', 'NVIDIA NVENC', 'h264_nvenc'),
      hwLabel('qsv', 'Intel Quick Sync', 'h264_qsv'),
      hwLabel('vaapi', 'VAAPI (Linux Intel/AMD)', 'h264_vaapi'),
      hwLabel('amf', 'AMD AMF (Windows)', 'h264_amf'),
      hwLabel('videotoolbox', 'Apple VideoToolbox', 'h264_videotoolbox'),
    ],
    s.hwAccel,
  );
  const preset = select(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'].map((p) => [p, p]), s.x264Preset);
  const maxTranscodes = h('input', { type: 'number', min: 1, max: 32, value: s.maxTranscodes });
  const maxSoftwareHeight = select([[720, '720p'], [1080, '1080p'], [1440, '1440p'], [2160, '2160p (4K)']], String(s.maxSoftwareHeight || 1080));
  const pickerIdle = select(
    [
      ['15', '15 minutes'],
      ['30', '30 minutes'],
      ['60', '1 hour'],
      ['240', '4 hours'],
      ['0', 'Never'],
    ],
    String(s.pickerIdleMinutes ?? 30),
  );
  pickerIdle.name = 'pickerIdleMinutes';
  const podcastHours = h('input', { name: 'podcastCheckHours', type: 'number', min: 0, max: 168, step: 1, value: s.podcastCheckHours ?? 6, class: 'input-year', inputmode: 'numeric' });
  const defaultQuality = select(
    [
      ['original', 'Original'],
      ['1080', '1080p'],
      ['720', '720p'],
      ['480', '480p'],
    ],
    s.defaultQuality,
  );
  const vaapiDevice = h('input', { value: s.vaapiDevice });
  const previewsSw = toggle('Seek-bar previews', s.previewsEnabled, null, { hint: 'Small pictures above the seek bar and for extras (a few MB per movie).' });
  const clipsSw = toggle('Make preview clips for cards', s.cardClips !== false, null, { hint: 'A silent 5-second clip of each title (a few hundred KB) that cards play after a moment. Needs seek-bar previews on.' });
  const introsSw = toggle('Find TV intros, recaps and credits', s.introDetection, null, { hint: 'So viewers can skip them, and Up next comes up as the credits start.' });
  // v0.28: TheIntroDB (sends a show's TMDB id, season and episode numbers and the file's length).
  const communitySw = toggle('Use shared skip times from TheIntroDB', s.communityTimestamps !== false, null, { hint: 'Fills in recaps and anything the files can’t tell. Atomix sends only the show’s TMDB number, the season and episode numbers and the episode’s length.' });
  const trailersSw = toggle('Online trailers', s.onlineTrailers !== false, null, { hint: 'Play the movie’s YouTube trailer when there is no local one (never on kids profiles).' });
  const lyricsSw = toggle('Online lyrics', s.onlineLyrics !== false, null, { hint: 'Ask LRCLIB for lyrics your files don’t have (only the song’s name, artist, album and length are sent).' });
  const qcSw = toggle('Quick Connect', s.quickConnect !== false, null, { hint: 'TVs can sign in by showing a code that someone signed in approves.' });
  const [previewsOn, clipsOn, introsOn, trailersOn, lyricsOn, qcOn, communityOn] = [previewsSw, clipsSw, introsSw, trailersSw, lyricsSw, qcSw, communitySw].map((sw) => sw.querySelector('input'));
  qcOn.name = 'quickConnect';
  // v0.21 downloads: phone-sized copies the Atomix app keeps on a device.
  const dlEnabledSw = toggle('Allow downloads', s.downloadsEnabled !== false, null, { hint: 'People you allow can download titles into the Atomix app to watch offline.' });
  const dlEnabled = dlEnabledSw.querySelector('input');
  dlEnabled.name = 'downloadsEnabled';
  const dlDir = h('input', { name: 'downloadsDir', value: s.downloadsDir || '', placeholder: 'In the data folder', spellcheck: 'false', autocomplete: 'off' });
  const dlCache = h('input', { name: 'downloadsCacheGb', type: 'number', min: 1, max: 2000, value: s.downloadsCacheGb ?? 50, class: 'input-year' });
  const dlQuality = select([['480', '480p (smallest)'], ['720', '720p'], ['1080', '1080p (largest)']], String(s.downloadQuality || '720'));
  dlQuality.name = 'downloadQuality';
  const dlDays = h('input', { name: 'downloadOfflineDays', type: 'number', min: 7, max: 90, value: s.downloadOfflineDays ?? 30, class: 'input-year' });
  const dlDevice = h('input', { name: 'downloadDeviceGb', type: 'number', min: 1, max: 500, value: s.downloadDeviceGb ?? 20, class: 'input-year' });
  const downloadsCard = h(
    'section',
    { class: 'panel downloads-card' },
    h('h2', {}, 'Downloads'),
    dlEnabledSw,
    h(
      'div',
      { class: 'form-grid' },
      field('Folder for prepared copies', dlDir, 'Leave empty for the data folder.'),
      field('Keep prepared copies under (GB)', dlCache, 'The oldest are removed first; unused ones after 7 days.'),
      field('Default quality', dlQuality),
      field('Downloads last offline (days)', dlDays, 'After this long without reaching Atomix, a device stops playing them.'),
      field('Space per device (GB)', dlDevice),
    ),
  );

  // Casting: the switch, the address TVs fetch from, and the devices (found, or added by address).
  const castOn = toggle('Enable casting', s.castEnabled !== false, null, { hint: 'Play on Chromecasts and DLNA TVs on your home network, with this page or a phone as the remote.' });
  const castInput = castOn.querySelector('input');
  const castBase = h('input', { name: 'castBaseUrl', value: s.castBaseUrl || '', placeholder: castInfo?.baseUrl || 'http://192.168.1.20:8787', inputmode: 'url', spellcheck: 'false', autocomplete: 'off' });
  const castList = h('div', { class: 'cast-devices' });
  const castSummary = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });
  async function drawCastDevices(refresh = false) {
    clear(castList).append(h('p', { class: 'muted' }, 'Looking for devices…'));
    const r = await api.get(`/api/cast/devices${refresh ? '?refresh=1' : ''}`).catch((err) => ({ error: err.message }));
    clear(castList);
    if (r.error) return castList.append(h('p', { class: 'error-text' }, r.error));
    if (!r.enabled) return castList.append(h('p', { class: 'muted' }, 'Casting is off. Turn it on and save to look for devices.'));
    castSummary.textContent = r.devices.length ? `${r.devices.length} ${r.devices.length === 1 ? 'device' : 'devices'} found` : 'No devices found';
    if (!r.devices.length) castList.append(emptyState({ title: 'No devices found on your network', text: 'Atomix and the TV must be on the same network; Atomix in Docker needs network_mode: host to see them.', icon: 'cast', level: 3 }));
    for (const d of r.devices) {
      const removable = d.id.startsWith('manual:');
      castList.append(
        h(
          'div',
          { class: 'cast-device-row' },
          icon(d.kind === 'chromecast' ? 'cast' : 'tv', { size: 24 }),
          h('div', { class: 'cast-device-text' }, h('strong', {}, d.name), h('span', { class: 'muted' }, [d.kind === 'chromecast' ? 'Chromecast' : 'DLNA TV', d.model, d.id.startsWith('manual:') ? 'Added by address' : d.id.startsWith('env:') ? 'From ATOMIX_CAST_DEVICES' : null, d.busy ? 'In use' : null].filter(Boolean).join(' · '))),
          removable
            ? button('Remove', {
                icon: 'trash',
                variant: 'ghost',
                onClick: async () => {
                  if (!(await confirmDialog(`Remove ${d.name}?`, 'It goes off the list. Devices on your network come back when Atomix finds them.', { confirm: 'Remove', danger: true }))) return;
                  await save(() => api.del(`/api/cast/devices/${encodeURIComponent(d.id)}`), 'Removed');
                  drawCastDevices();
                },
              })
            : null,
        ),
      );
    }
  }
  const castPanel = h(
    'section',
    { class: 'panel cast-panel' },
    h('h2', {}, 'Casting'),
    castOn,
    field('Address the TV uses', castBase, `Change this if your TV can't load videos (it must be this computer's address on your home network).${castInfo?.baseUrl && !s.castBaseUrl ? ` Found: ${castInfo.baseUrl}` : ''}`),
    h('h3', { class: 'cast-devices-title' }, 'Devices'),
    castList,
    castSummary,
    h(
      'div',
      { class: 'actions' },
      button('Find devices again', { icon: 'refresh', onClick: () => drawCastDevices(true) }),
      button('Add a device by address…', {
        icon: 'plus',
        onClick: async () => {
          if (await addDeviceDialog()) drawCastDevices();
        },
      }),
    ),
  );
  drawCastDevices();

  const form = h(
    'form',
    { class: 'stack' },
    section('General', h('div', { class: 'form-grid' }, field('Server name', serverName), field('Default theme', defaultTheme, 'People can still pick their own in Profile.'), field("Ask who's watching after", pickerIdle, 'How long Atomix can sit untouched before it asks again. Playing a video or music counts as being there.'), field('Sign-in page message', loginMessage), field('Rescan every (minutes)', scanInterval, '0 turns automatic scanning off.'), field('Sync connected servers every (hours)', remoteSync, '0 turns automatic syncing off; Sync now in Libraries still works.'), field('Check podcast feeds every (hours)', podcastHours, '0 checks them only when someone presses Check now on a podcasts library.'), field('Picture cache (MB)', thumbCache, "Smaller copies of artwork for faster pages. The least used go first when it's full."))),
    httpsCard(), // v0.27: the secure address phones need (its own card: it saves as you choose)
    section(
      'Metadata',
      h(
        'div',
        { class: 'form-grid' },
        field('TMDB API key', tmdbKey, 'Get a free key at themoviedb.org → Settings → API (either the "API Key" or the "Read Access Token" works).'),
        field('Language', language, 'For titles and descriptions, e.g. en-US, en-NZ, fr-FR.'),
        field('Age ratings from', ratingCountry, 'Used for Kids profiles. If a title has no rating for this country, the US rating is used.'),
      ),
      button('Test key', {
        icon: 'check',
        variant: 'ghost',
        onClick: async () => {
          try {
            const r = await api.post('/api/admin/metadata/test', {});
            toast(r.ok ? `Key works — found “${r.sample}”` : 'Key accepted, but no results came back', { type: r.ok ? 'success' : 'info' });
          } catch (err) {
            toast(err.message, { type: 'error' });
          }
        },
      }),
    ),
    section(
      'Playback & transcoding',
      transcodingSw,
      h(
        'div',
        { class: 'form-grid' },
        field('Hardware acceleration', hwAccel, encoders.length ? `Your ffmpeg includes: ${encoders.join(', ')}. Hardware options also need a matching GPU and drivers.` : 'ffmpeg not found — install it to enable conversion.'),
        field('CPU encoder speed', preset, 'Faster presets use less CPU but look slightly worse.'),
        field('Max simultaneous conversions', maxTranscodes, 'Protects a small VPS from overload.'),
        field('Max software conversion height', maxSoftwareHeight, 'Without a hardware encoder, bigger pictures are scaled down to keep up; hardware encoders ignore this.'),
        field('Default quality for everyone', defaultQuality),
        field('VAAPI device', vaapiDevice, 'Only used with VAAPI.'),
      ),
    ),
    castPanel,
    section(
      'Background tasks',
      h('p', { class: 'muted' }, 'These run one at a time at low priority, and wait while someone watches a video the server is converting.'),
      previewsSw,
      clipsSw,
      introsSw,
      communitySw,
    ),
    section(
      'Online extras',
      trailersSw,
      lyricsSw,
    ),
    section('Signing in', qcSw),
    downloadsCard,
    downloadAppsCard(s), // v0.28: Sonarr/Radarr webhook and the request page (its own card: it saves as you go)
    lastfm.el,
    h('div', { class: 'actions sticky-actions' }, button('Save settings', { type: 'submit', variant: 'primary', icon: 'check' })),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await save(async () => {
      await api.put('/api/admin/settings', {
        serverName: serverName.value.trim() || 'Atomix',
        loginMessage: loginMessage.value.trim(),
        defaultTheme: defaultTheme.value,
        scanIntervalMinutes: Number(scanInterval.value),
        remoteSyncHours: Number(remoteSync.value),
        thumbCacheMB: Number(thumbCache.value),
        tmdbApiKey: tmdbKey.value.trim(),
        metadataLanguage: language.value.trim() || 'en-US',
        ratingCountry: ratingCountry.value,
        transcodingEnabled: transcoding.checked,
        hwAccel: hwAccel.value,
        x264Preset: preset.value,
        maxTranscodes: Number(maxTranscodes.value),
        maxSoftwareHeight: Number(maxSoftwareHeight.value),
        defaultQuality: defaultQuality.value,
        pickerIdleMinutes: Number(pickerIdle.value),
        podcastCheckHours: Number(podcastHours.value),
        vaapiDevice: vaapiDevice.value.trim(),
        previewsEnabled: previewsOn.checked,
        cardClips: clipsOn.checked,
        introDetection: introsOn.checked,
        communityTimestamps: communityOn.checked,
        onlineTrailers: trailersOn.checked,
        onlineLyrics: lyricsOn.checked,
        quickConnect: qcOn.checked,
        downloadsEnabled: dlEnabled.checked,
        downloadsDir: dlDir.value.trim(),
        downloadsCacheGb: Number(dlCache.value),
        downloadQuality: dlQuality.value,
        downloadOfflineDays: Number(dlDays.value),
        downloadDeviceGb: Number(dlDevice.value),
        castEnabled: castInput.checked,
        castBaseUrl: castBase.value.trim(),
        ...lastfm.values(),
      });
      drawCastDevices();
      state.status = await api.get('/api/status');
      applyTheme();
      document.querySelector('.brand-name').textContent = state.status.serverName;
    });
  });
  el.append(form, await householdHomeSection());
}

// ---------------- Live TV ----------------
/** Settings → Live TV: the Recording card (where recordings go, how early they start and how late they end). */
async function liveTab(el) {
  const s = await api.get('/api/admin/settings');
  const dir = h('input', { name: 'recordingsDir', value: s.recordingsDir || '', placeholder: s.recordingsDirDefault || '', spellcheck: 'false', autocomplete: 'off' });
  const pre = h('input', { name: 'recordPre', type: 'number', min: 0, max: 30, step: 1, value: s.recordPre ?? 1, inputmode: 'numeric' });
  const post = h('input', { name: 'recordPost', type: 'number', min: 0, max: 60, step: 1, value: s.recordPost ?? 3, inputmode: 'numeric' });
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const form = h(
    'form',
    { class: 'stack' },
    field('Recordings folder', dir, 'Any folder on this server. Leave it empty for the default shown. Recordings appear as the "Recordings" TV library.'),
    field('Start early (minutes)', pre, '0 to 30. A recording starts this long before its programme.'),
    field('End late (minutes)', post, '0 to 60. A recording ends this long after its programme.'),
    h('p', { class: 'muted small' }, 'Recordings stop when the folder has less than 5 GB free.'),
    error,
    h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    const say = (text, input) => {
      error.textContent = text;
      error.hidden = false;
      input.focus();
    };
    // An emptied field isn't 0 minutes: it is refused, and its field takes the focus.
    const blank = [pre, post].find((i) => i.value.trim() === '' || !Number.isFinite(Number(i.value)));
    if (blank) return say('Start early and End late need a number of minutes', blank);
    try {
      const out = await api.put('/api/admin/settings', { recordingsDir: dir.value.trim(), recordPre: Number(pre.value), recordPost: Number(post.value) });
      pre.value = out.recordPre;
      post.value = out.recordPost;
      toast('Recording settings saved', { type: 'success' });
    } catch (err) {
      // The field the message names (the folder's, unless it speaks of minutes).
      say(err.message, /minute|early|late/i.test(err.message) ? pre : dir);
    }
  });
  el.append(h('section', { class: 'panel rec-settings' }, h('h2', {}, 'Recording'), form));
}

const RENDERERS = { profile: profileTab, profiles: profilesTab, dashboard: dashboardTab, libraries: librariesTab, users: usersTab, plugins: pluginsTab, live: liveTab, activity: activityTab, server: serverTab };

export async function render(el, params) {
  const isAdmin = canAdmin();
  const tabs = TABS.filter((t) => (!t.admin || isAdmin) && (!t.adult || !isKidsProfile()) && (!t.live || liveAllowed()));
  const tab = tabs.find((t) => t.id === params.tab) || tabs[0];
  if (params.tab && tab.id !== params.tab) navigate('#/settings', { replace: true });
  setTitle(tab.label);
  const content = h('div', { class: 'settings-content' });
  el.append(
    h('header', { class: 'page-head' }, h('h1', {}, isAdmin ? 'Settings' : 'Profile')),
    h(
      'div',
      { class: 'settings-layout' },
      tabs.length > 1
        ? h('nav', { class: 'settings-tabs', 'aria-label': 'Settings sections' }, tabs.map((t) => h('a', { href: `#/settings/${t.id}`, class: 'settings-tab', 'aria-current': t.id === tab.id ? 'page' : null }, icon(t.icon, { size: 18 }), h('span', {}, t.label))))
        : null,
      content,
    ),
  );
  // On phones the sections are a chip row: keep the chosen chip in view (the row is rebuilt on every tab change).
  // The view is put on the page once the section has rendered, so the scroll waits for the frame after that.
  const showChip = () => {
    const cur = el.querySelector('.settings-tab[aria-current="page"]');
    const nav = cur?.parentElement;
    if (!nav || nav.scrollWidth <= nav.clientWidth) return;
    const c = cur.getBoundingClientRect();
    const n = nav.getBoundingClientRect();
    nav.scrollLeft += c.left - n.left - (n.width - c.width) / 2;
  };
  return Promise.resolve(RENDERERS[tab.id](content)).then((result) => {
    requestAnimationFrame(showChip);
    return result;
  });
}
