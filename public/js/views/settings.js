// Settings: personal profile for everyone, plus admin screens.
import { api } from '../api.js';
import { h, icon, clear, timeAgo, formatClock } from '../dom.js';
import { button, toast, openDialog, confirmDialog, field, toggle, spinner, avatar, AVATAR_NAMES } from '../components.js';
import { state, setTitle, applyTheme, updatePrefs, signOut, refreshLibraries, navigate, refreshView, canAdmin, isKidsProfile, renderNav } from '../app.js';

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
  const themes = state.themes;
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
    section('Appearance', themeGrid, h('div', { class: 'inline-fields' }, field('Accent colour', accent), resetAccent), toggle('Reduce motion', prefs.reduceMotion, (v) => save(() => updatePrefs({ reduceMotion: v })))),
    section(
      'Playback',
      h('div', { class: 'form-grid' }, field('Default quality', quality, 'Lower quality converts video on the server to save bandwidth.'), field('Subtitle size', subSize), field('Preferred subtitle language', subLang, 'Two-letter code. Leave empty to only show forced subtitles.'), field('Preferred audio language', audioLang)),
      toggle('Play the next episode automatically', prefs.autoplayNext !== false, (v) => save(() => updatePrefs({ autoplayNext: v }))),
      toggle('Skip intros automatically', prefs.skipIntros === true, (v) => save(() => updatePrefs({ skipIntros: v }))),
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
  const now = t.running ? `${t.running.job === 'previews' ? 'Making seek-bar previews for' : 'Finding intros in'} ${t.running.title}.` : TASK_PAUSED[t.paused] || 'Nothing running right now.';
  const waiting = [
    t.queued.previews ? `${t.queued.previews} ${t.queued.previews === 1 ? 'title' : 'titles'} waiting for previews` : null,
    t.queued.intros ? `${t.queued.intros} ${t.queued.intros === 1 ? 'season' : 'seasons'} waiting for an intro check` : null,
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
      section(
        'Server',
        h(
          'ul',
          { class: 'plain-list' },
          toolRow('ffmpeg', t.ffmpeg),
          toolRow('ffprobe', t.ffprobe),
          h('li', {}, h('strong', {}, 'H.264 encoders in ffmpeg: '), t.encoders.length ? t.encoders.join(', ') : 'none', h('small', { class: 'muted' }, ' (hardware ones also need a matching GPU)')),
          h('li', {}, h('strong', {}, 'NodeFlix '), d.server.version, ' on Node ', d.server.node, ` · ${d.server.platform}`),
          h('li', {}, h('strong', {}, 'Uptime '), formatClock(d.server.uptime), ` · ${d.server.memoryMb} MB RAM · ${d.server.cpus} CPU threads`),
          h('li', {}, h('strong', {}, 'Data folder '), h('code', {}, d.server.dataDir)),
        ),
        !t.ffmpeg.available
          ? h('p', { class: 'notice' }, icon('info'), ' Install ffmpeg to play MKV/HEVC files and read media info. On Windows: ', h('code', {}, 'winget install Gyan.FFmpeg'), ', then restart NodeFlix.')
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

async function librariesTab(el) {
  const libs = await api.get('/api/libraries');
  el.append(
    h('div', { class: 'panel-head' }, h('p', { class: 'muted' }, 'Point NodeFlix at folders on this computer or server. They are scanned automatically.'), button('Add library', { icon: 'plus', variant: 'primary', autofocus: true, onClick: async () => { if ((await libraryDialog()) === 'ok') { await refreshLibraries(); refreshView(); } } })),
  );
  if (!libs.length) {
    el.append(section(null, h('p', {}, 'No libraries yet. Add your movie folder first, then your TV folder.')));
    return;
  }
  for (const lib of libs) {
    el.append(
      h(
        'section',
        { class: 'panel library-panel' },
        h('div', { class: 'library-panel-head' }, icon(LIBRARY_ICON[lib.type] || 'film', { size: 28 }), h('div', {}, h('h2', {}, lib.name), h('p', { class: 'muted' }, `${lib.count} ${LIBRARY_NOUN[lib.type] || 'items'} · last scanned ${timeAgo(lib.lastScan)}`))),
        h('ul', { class: 'plain-list' }, lib.paths.map((p) => h('li', {}, h('code', {}, p)))),
        h(
          'div',
          { class: 'actions' },
          button('Scan now', { icon: 'refresh', onClick: async () => (await api.post(`/api/libraries/${lib.id}/scan`, {}), toast(`Scanning ${lib.name}…`)) }),
          button('Edit', { icon: 'edit', variant: 'ghost', onClick: async () => { if ((await libraryDialog(lib)) === 'ok') { await refreshLibraries(); refreshView(); } } }),
          button('Delete', {
            icon: 'trash',
            variant: 'ghost danger',
            onClick: async () => {
              if (await confirmDialog(`Delete ${lib.name}?`, 'This removes it from NodeFlix (and everyone’s watch history for it). Your files are not touched.', { confirm: 'Delete', danger: true })) {
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
    h('div', { class: 'panel-head' }, h('p', { class: 'muted' }, 'Plugins live in the ', h('code', {}, 'plugins'), ' folder. Drop a new one in and restart NodeFlix. See docs/PLUGINS.md to write your own.')),
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
  const [s, dash] = await Promise.all([api.get('/api/admin/settings'), api.get('/api/admin/dashboard')]);
  const encoders = dash.tools.encoders;
  const serverName = h('input', { value: s.serverName, maxlength: 60 });
  const loginMessage = h('input', { value: s.loginMessage, maxlength: 200, placeholder: 'Optional note on the sign-in page' });
  const defaultTheme = select(state.themes.map((t) => [t.id, t.name]), s.defaultTheme);
  const scanInterval = h('input', { type: 'number', min: 0, max: 10080, value: s.scanIntervalMinutes });
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

  const form = h(
    'form',
    { class: 'stack' },
    section('General', h('div', { class: 'form-grid' }, field('Server name', serverName), field('Default theme', defaultTheme, 'People can still pick their own in Profile.'), field('Sign-in page message', loginMessage), field('Rescan every (minutes)', scanInterval, '0 turns automatic scanning off.'))),
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
    section(
      'Background tasks',
      h('p', { class: 'muted' }, 'These run one at a time at low priority, and wait while someone watches a video the server is converting.'),
      h('label', { class: 'check' }, previewsOn, h('span', {}, 'Seek-bar previews: small pictures above the seek bar (a few MB per film)')),
      h('label', { class: 'check' }, introsOn, h('span', {}, 'Find TV intros, so viewers can skip them')),
    ),
    h('div', { class: 'actions sticky-actions' }, button('Save settings', { type: 'submit', variant: 'primary', icon: 'check' })),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await save(async () => {
      await api.put('/api/admin/settings', {
        serverName: serverName.value.trim() || 'NodeFlix',
        loginMessage: loginMessage.value.trim(),
        defaultTheme: defaultTheme.value,
        scanIntervalMinutes: Number(scanInterval.value),
        tmdbApiKey: tmdbKey.value.trim(),
        metadataLanguage: language.value.trim() || 'en-US',
        ratingCountry: ratingCountry.value,
        transcodingEnabled: transcoding.checked,
        hwAccel: hwAccel.value,
        x264Preset: preset.value,
        maxTranscodes: Number(maxTranscodes.value),
        defaultQuality: defaultQuality.value,
        vaapiDevice: vaapiDevice.value.trim(),
        previewsEnabled: previewsOn.checked,
        introDetection: introsOn.checked,
      });
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
  return RENDERERS[tab.id](content);
}
