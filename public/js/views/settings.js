// Settings: personal profile for everyone, plus admin screens.
import { api } from '../api.js';
import { addDeviceDialog } from '../cast.js';
import { h, icon, clear, timeAgo, formatClock } from '../dom.js';
import { button, toast, openDialog, confirmDialog, field, toggle, spinner, avatar, AVATAR_NAMES } from '../components.js';
import { state, setTitle, applyTheme, updatePrefs, signOut, refreshLibraries, navigate, refreshView, canAdmin, isKidsProfile, renderNav, isOrbit } from '../app.js';

const KIDS_LEVELS = [
  [5, 'Little kids — G only'],
  [10, 'Kids — up to PG'],
  [13, 'Pre-teens — up to 13 (PG-13, R13, 12A)'],
  [16, 'Teens — up to 16 (M, R16, 15)'],
];

/** Checkboxes for picking libraries; returns { el, value() } where value() is null for "all". */
function libraryPicker(libraries, selected, { allLabel = 'All libraries' } = {}) {
  const all = h('input', { type: 'checkbox', checked: selected == null });
  const boxes = libraries.map((l) => ({ id: l.id, box: h('input', { type: 'checkbox', checked: selected == null || selected.includes(l.id), disabled: selected == null }) }));
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
  { id: 'profiles', label: 'Profiles', icon: 'users', adult: true },
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', admin: true },
  { id: 'libraries', label: 'Libraries', icon: 'folder', admin: true },
  { id: 'users', label: 'Users', icon: 'users', admin: true },
  { id: 'plugins', label: 'Plugins', icon: 'addons', admin: true },
  { id: 'server', label: 'Server', icon: 'server', admin: true },
];

const select = (options, value, attrs = {}) =>
  h('select', attrs, options.map(([v, label]) => h('option', { value: v, selected: String(value) === String(v) }, label)));

function section(title, ...children) {
  return h('section', { class: 'panel' }, title ? h('h2', {}, title) : null, children);
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

/** "#abc", "#aabbcc" or "rgb(1, 2, 3)" → "#rrggbb" (colour inputs only take the last form). */
function toHex(value) {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{3}$/i.test(value)) return '#' + [...value.slice(1)].map((c) => c + c).join('');
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(value || '');
  return m ? '#' + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('') : null;
}

// ---------------- Profile ----------------
async function profileTab(el) {
  const user = state.user;
  const profile = state.profile;
  const prefs = profile.prefs || {};
  // The server's default theme first (Orbit, normally); the rest as the server lists them.
  const themes = [...state.themes].sort((a, b) => (b.id === state.status.defaultTheme) - (a.id === state.status.defaultTheme));
  const current = prefs.theme || state.status.defaultTheme;

  const themeGrid = h('div', { class: 'theme-grid', role: 'radiogroup', 'aria-label': 'Theme' });
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

  const accent = h('input', { type: 'color', value: prefs.accent || toHex(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()) || '#ff6b3d', 'aria-label': 'Accent colour' });
  accent.addEventListener('change', () => save(() => updatePrefs({ accent: accent.value }), 'Accent colour updated'));
  const resetAccent = button('Use theme colour', { variant: 'ghost', onClick: () => save(() => updatePrefs({ accent: null }), 'Accent reset').then(() => refreshView()) });

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
      h('div', { class: 'inline-fields' }, field('Accent colour', accent, isOrbit() ? 'Used when a title has no artwork to take its colour from.' : undefined), resetAccent),
      toggle('Reduce motion', prefs.reduceMotion, (v) => save(() => updatePrefs({ reduceMotion: v })), { hint: 'Nothing grows or slides.' }),
      toggle('Reduce effects', prefs.reduceEffects, (v) => save(() => updatePrefs({ reduceEffects: v })), { hint: 'Solid panels instead of glass and blur. Try this if your TV feels slow.' }),
    ),
    section(
      'Playback',
      h('div', { class: 'form-grid' }, field('Default quality', quality, 'Lower quality converts video on the server to save bandwidth.'), field('Subtitle size', subSize), field('Preferred subtitle language', subLang, 'Two-letter code. Leave empty to only show forced subtitles.'), field('Preferred audio language', audioLang)),
      toggle('Play the next episode automatically', prefs.autoplayNext !== false, (v) => save(() => updatePrefs({ autoplayNext: v }))),
      toggle('Skip intros automatically', prefs.skipIntros === true, (v) => save(() => updatePrefs({ skipIntros: v })), { hint: 'You can still choose Watch it when it skips.' }),
    ),
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
  name.addEventListener('input', () => {
    for (const el of avatars.querySelectorAll('.avatar')) el.textContent = (name.value.trim()[0] || '?').toUpperCase();
  });
  const kids = h('input', { type: 'checkbox', checked: p.kids, disabled: p.isPrimary });
  const level = select(KIDS_LEVELS, p.maxAge ?? 10);
  const unrated = h('input', { type: 'checkbox', checked: p.allowUnrated });
  const kidsOptions = h('div', { class: 'stack kids-options', hidden: !p.kids }, field('Allowed ratings', level, 'Titles rated above this are hidden. Ratings come from TMDB or .nfo files.'), h('label', { class: 'check' }, unrated, h('span', {}, 'Also show titles with no rating (home videos, add-ons)')));
  kids.addEventListener('change', () => (kidsOptions.hidden = !kids.checked));
  const libs = libraryPicker(state.libraries, p.libraries, { allLabel: 'All libraries this account can see' });
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
        h(
          'div',
          { class: 'row-actions' },
          button('', { icon: 'edit', variant: 'ghost', title: `Edit ${p.name}`, onClick: async () => (await profileDialog(p)) === 'ok' && refreshView() }),
          p.isPrimary
            ? null
            : button('', {
                icon: 'trash',
                variant: 'ghost',
                title: `Delete ${p.name}`,
                onClick: async () => {
                  if (await confirmDialog(`Delete ${p.name}?`, 'Their watch history and preferences will be removed.', { confirm: 'Delete', danger: true })) {
                    await api.del(`/api/profiles/${p.id}`);
                    refreshView();
                  }
                },
              }),
        ),
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
  const doing = { previews: 'Making seek-bar previews for', thumb: 'Making a thumbnail for', lyrics: 'Reading the lyrics in', intros: 'Finding intros in' };
  const now = t.running ? `${doing[t.running.job] || 'Working on'} ${t.running.title}.` : TASK_PAUSED[t.paused] || 'Nothing running right now.';
  const waiting = [
    t.queued.previews ? `${t.queued.previews} ${t.queued.previews === 1 ? 'title' : 'titles'} waiting for previews` : null,
    t.queued.intros ? `${t.queued.intros} ${t.queued.intros === 1 ? 'season' : 'seasons'} waiting for an intro check` : null,
    t.queued.thumbs ? `${t.queued.thumbs} ${t.queued.thumbs === 1 ? 'extra' : 'extras'} waiting for a thumbnail` : null,
    t.queued.lyrics ? `${t.queued.lyrics} ${t.queued.lyrics === 1 ? 'song' : 'songs'} waiting for a lyrics check` : null,
  ].filter(Boolean);
  return section(
    'Background tasks',
    h('p', {}, now, waiting.length ? ` ${waiting.join(', ')}.` : ''),
    t.failed.length
      ? h('ul', { class: 'plain-list' }, t.failed.map((f) => h('li', {}, h('strong', {}, f.title), ` (${f.job === 'previews' ? 'previews' : 'intro check'}): `, h('span', { class: 'danger-text' }, f.error || 'failed'))))
      : null,
    t.failed.length ? button('Try again', { icon: 'refresh', onClick: async () => (await api.post('/api/admin/tasks/retry', {}), toast('Trying again'), reload()) }) : null,
  );
}

async function dashboardTab(el) {
  const body = h('div');
  el.append(body);
  async function load() {
    const [d, tasks] = await Promise.all([api.get('/api/admin/dashboard'), api.get('/api/admin/tasks')]);
    clear(body);
    const t = d.tools;
    const toolRow = (name, info) => h('li', {}, h('span', { class: `dot ${info.available ? 'ok' : 'bad'}` }), h('strong', {}, name), ' ', info.available ? `v${info.version}` : h('span', { class: 'danger-text' }, `not found (${info.path})`));
    body.append(
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
          : h('p', { class: 'muted' }, 'Nobody is watching right now.'),
      ),
      section(
        'Library scan',
        h('p', {}, d.scan.running ? `Scanning ${d.scan.library}: ${d.scan.phase} (${d.scan.done}/${d.scan.total || '?'})` : `Idle. Last scan finished ${timeAgo(d.scan.finishedAt)}${d.scan.error ? ` with an error: ${d.scan.error}` : ''}.`),
        h(
          'div',
          { class: 'actions' },
          button('Scan all libraries', { icon: 'refresh', onClick: async () => (await api.post('/api/scan', {}), toast('Scan started'), setTimeout(load, 800)) }),
          button('Refresh all metadata', {
            icon: 'sparkle',
            variant: 'ghost',
            onClick: async () => {
              if (await confirmDialog('Refresh all metadata?', 'This re-downloads descriptions and artwork for everything. It can take a while for big libraries.', { confirm: 'Refresh' })) {
                await api.post('/api/scan', { refreshMetadata: true });
                toast('Metadata refresh started');
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
    );
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
        toast('Open a folder first.');
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
};
const LIBRARY_ICON = { movies: 'film', tv: 'tv', music: 'music' };
const LIBRARY_NOUN = { movies: 'movies', tv: 'shows', music: 'albums' };

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
        toast('Library saved', { type: 'success' });
        return true;
      },
    });
  }
  const type = select(
    [
      ['movies', 'Movies'],
      ['tv', 'TV shows'],
      ['music', 'Music'],
    ],
    lib?.type || 'movies',
    { disabled: Boolean(lib) },
  );
  const paths = [...(lib?.paths || [])];
  const list = h('ul', { class: 'path-list', role: 'list' });
  const newPath = h('input', { placeholder: 'D:\\Movies  or  /media/movies', 'aria-label': 'Folder path' });
  const previews = h('input', { type: 'checkbox', checked: lib?.options?.previews !== false });
  const previewsRow = h('label', { class: 'check', hidden: type.value === 'music' }, previews, h('span', {}, 'Make seek-bar previews'));
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
    previewsRow.hidden = type.value === 'music';
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
    rows.length ? h('div', { class: 'server-list' }, rows) : h('p', { class: 'muted' }, 'No servers connected.'),
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

async function librariesTab(el) {
  const [libs, servers] = await Promise.all([api.get('/api/libraries'), api.get('/api/servers')]);
  el.append(
    h('div', { class: 'panel-head' }, h('p', { class: 'muted' }, 'Point Atomix at folders on this computer or server, or connect a media server you already run. They are scanned automatically.'), button('Add library', { icon: 'plus', variant: 'primary', autofocus: true, onClick: async () => { if ((await libraryDialog()) === 'ok') { await refreshLibraries(); refreshView(); } } })),
    serversPanel(servers),
  );
  if (!libs.length) {
    el.append(section(null, h('p', {}, 'No libraries yet. Add your movie folder first, then your TV folder.')));
    return;
  }
  const gone = new Set(servers.flatMap((s) => s.libraries.filter((l) => l.gone).map((l) => l.id)));
  for (const lib of libs) {
    const caption = lib.serverId
      ? gone.has(lib.id) ? `No longer on ${lib.serverName} · ${lib.count} ${LIBRARY_NOUN[lib.type] || 'items'} kept` : `On ${lib.serverName} · ${lib.count} ${LIBRARY_NOUN[lib.type] || 'items'} · synced ${timeAgo(lib.lastScan)}`
      : `${lib.count} ${LIBRARY_NOUN[lib.type] || 'items'} · last scanned ${timeAgo(lib.lastScan)}`;
    el.append(
      h(
        'section',
        { class: `panel library-panel${lib.serverId ? ' library-remote' : ''}` },
        h('div', { class: 'library-panel-head' }, icon(lib.serverId ? 'cloud' : LIBRARY_ICON[lib.type] || 'film', { size: 28 }), h('div', {}, h('h2', {}, lib.name), h('p', { class: 'muted' }, caption))),
        lib.serverId ? null : h('ul', { class: 'plain-list' }, lib.paths.map((p) => h('li', {}, h('code', {}, p)))),
        h(
          'div',
          { class: 'actions' },
          button(lib.serverId ? 'Sync now' : 'Scan now', { icon: 'refresh', onClick: async () => (await api.post(`/api/libraries/${lib.id}/scan`, {}), toast(lib.serverId ? `Syncing ${lib.name}…` : `Scanning ${lib.name}…`)) }),
          button('Edit', { icon: 'edit', variant: 'ghost', onClick: async () => { if ((await libraryDialog(lib)) === 'ok') { await refreshLibraries(); refreshView(); } } }),
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
      ),
    );
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
    cols.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'In your library'), h('th', {}, 'From'), h('th', {}, ''))), h('tbody', {}, rows))) : h('p', { class: 'muted' }, 'No collections yet.'),
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
      toast('Collection saved');
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
      toast('Collection saved');
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
  return openDialog({
    title: user ? `Edit ${user.username}` : 'Add a person',
    wide: true,
    body: h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, field('Username', username), field('Display name', displayName), field(user ? 'New password' : 'Password', password, 'At least 8 characters.'), field('Role', role)), access.el),
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: user ? 'Save' : 'Add', value: 'ok', variant: 'primary' },
    ],
    onSubmit: async () => {
      if (user) {
        const body = { displayName: displayName.value, role: role.value, libraryAccess: access.value() };
        if (password.value) body.password = password.value;
        await api.patch(`/api/users/${user.id}`, body);
      } else {
        await api.post('/api/users', { username: username.value.trim(), displayName: displayName.value.trim(), password: password.value, role: role.value, libraryAccess: access.value() });
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
              h('td', {}, u.role === 'admin' ? 'Admin' : 'Viewer', u.libraryAccess ? h('br') : null, u.libraryAccess ? h('small', { class: 'muted' }, `${u.libraryAccess.length} librar${u.libraryAccess.length === 1 ? 'y' : 'ies'}`) : null),
              h('td', {}, timeAgo(u.lastLogin)),
              h(
                'td',
                { class: 'row-actions' },
                button('', { icon: 'edit', variant: 'ghost', title: `Edit ${u.username}`, onClick: async () => (await userDialog(u)) === 'ok' && refreshView() }),
                u.id !== state.user.id
                  ? button('', {
                      icon: 'trash',
                      variant: 'ghost',
                      title: `Delete ${u.username}`,
                      onClick: async () => {
                        if (await confirmDialog(`Delete ${u.username}?`, 'Their watch history will be removed too.', { confirm: 'Delete', danger: true })) {
                          await api.del(`/api/users/${u.id}`);
                          refreshView();
                        }
                      },
                    })
                  : null,
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

async function pluginsTab(el) {
  const plugins = await api.get('/api/admin/plugins');
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
  const tmdbKey = h('input', { type: 'password', value: s.tmdbApiKey, autocomplete: 'off', spellcheck: 'false' });
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
  const transcoding = h('input', { type: 'checkbox', checked: s.transcodingEnabled });
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
  const previewsOn = h('input', { type: 'checkbox', checked: s.previewsEnabled });
  const introsOn = h('input', { type: 'checkbox', checked: s.introDetection });
  const trailersOn = h('input', { type: 'checkbox', checked: s.onlineTrailers !== false });
  const lyricsOn = h('input', { type: 'checkbox', checked: s.onlineLyrics !== false });

  // Casting: the switch, the address TVs fetch from, and the devices (found, or added by address).
  const castOn = toggle('Casting', s.castEnabled !== false, null, { hint: 'Play on Chromecasts and DLNA TVs on your home network, with this page or a phone as the remote.' });
  const castInput = castOn.querySelector('input');
  const castBase = h('input', { name: 'castBaseUrl', value: s.castBaseUrl || '', placeholder: castInfo?.baseUrl || 'http://192.168.1.20:8787', inputmode: 'url', spellcheck: 'false', autocomplete: 'off' });
  const castList = h('div', { class: 'cast-devices', 'aria-live': 'polite' });
  async function drawCastDevices(refresh = false) {
    clear(castList).append(h('p', { class: 'muted' }, 'Looking for devices…'));
    const r = await api.get(`/api/cast/devices${refresh ? '?refresh=1' : ''}`).catch((err) => ({ error: err.message }));
    clear(castList);
    if (r.error) return castList.append(h('p', { class: 'error-text' }, r.error));
    if (!r.enabled) return castList.append(h('p', { class: 'muted' }, 'Casting is off. Turn it on and save to look for devices.'));
    if (!r.devices.length) castList.append(h('p', { class: 'muted' }, 'No devices found on your network. Atomix and the TV must be on the same network; Atomix in Docker needs network_mode: host to see them.'));
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
    section('General', h('div', { class: 'form-grid' }, field('Server name', serverName), field('Default theme', defaultTheme, 'People can still pick their own in Profile.'), field("Ask who's watching after", pickerIdle, 'How long Atomix can sit untouched before it asks again. Playing a video or music counts as being there.'), field('Sign-in page message', loginMessage), field('Rescan every (minutes)', scanInterval, '0 turns automatic scanning off.'), field('Sync connected servers every (hours)', remoteSync, '0 turns automatic syncing off; Sync now in Libraries still works.'))),
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
      h('label', { class: 'check' }, transcoding, h('span', {}, 'Allow the server to convert videos the browser can’t play')),
      h(
        'div',
        { class: 'form-grid' },
        field('Hardware acceleration', hwAccel, encoders.length ? `Your ffmpeg includes: ${encoders.join(', ')}. Hardware options also need a matching GPU and drivers.` : 'ffmpeg not found — install it to enable conversion.'),
        field('CPU encoder speed', preset, 'Faster presets use less CPU but look slightly worse.'),
        field('Max simultaneous conversions', maxTranscodes, 'Protects a small VPS from overload.'),
        field('Default quality for everyone', defaultQuality),
        field('VAAPI device', vaapiDevice, 'Only used with VAAPI.'),
      ),
    ),
    castPanel,
    section(
      'Background tasks',
      h('p', { class: 'muted' }, 'These run one at a time at low priority, and wait while someone watches a video the server is converting.'),
      h('label', { class: 'check' }, previewsOn, h('span', {}, 'Seek-bar previews and extra thumbnails: small pictures above the seek bar and for extras (a few MB per film)')),
      h('label', { class: 'check' }, introsOn, h('span', {}, 'Find TV intros, so viewers can skip them')),
    ),
    section(
      'Online extras',
      h('label', { class: 'check' }, trailersOn, h('span', {}, "Online trailers: play the film's YouTube trailer when there is no local one (never on kids profiles)")),
      h('label', { class: 'check' }, lyricsOn, h('span', {}, 'Online lyrics: ask LRCLIB for lyrics your files don’t have (only the song’s name, artist, album and length are sent)')),
    ),
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
        tmdbApiKey: tmdbKey.value.trim(),
        metadataLanguage: language.value.trim() || 'en-US',
        ratingCountry: ratingCountry.value,
        transcodingEnabled: transcoding.checked,
        hwAccel: hwAccel.value,
        x264Preset: preset.value,
        maxTranscodes: Number(maxTranscodes.value),
        defaultQuality: defaultQuality.value,
        pickerIdleMinutes: Number(pickerIdle.value),
        vaapiDevice: vaapiDevice.value.trim(),
        previewsEnabled: previewsOn.checked,
        introDetection: introsOn.checked,
        onlineTrailers: trailersOn.checked,
        onlineLyrics: lyricsOn.checked,
        castEnabled: castInput.checked,
        castBaseUrl: castBase.value.trim(),
      });
      drawCastDevices();
      state.status = await api.get('/api/status');
      applyTheme();
      document.querySelector('.brand-name').textContent = state.status.serverName;
    });
  });
  el.append(form);
}

const RENDERERS = { profile: profileTab, profiles: profilesTab, dashboard: dashboardTab, libraries: librariesTab, users: usersTab, plugins: pluginsTab, server: serverTab };

export async function render(el, params) {
  const isAdmin = canAdmin();
  const tabs = TABS.filter((t) => (!t.admin || isAdmin) && (!t.adult || !isKidsProfile()));
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
