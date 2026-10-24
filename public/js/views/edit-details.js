// Edit details (v0.20, admins): one field per editable detail. Saving writes only what changed and locks it, so a
// refresh and Fix match leave it as it is; a locked field shows "Locked" and Unlock (at once).
import { scoresText } from '../scores.js';
import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { openDialog, field, toast, announce, button } from '../components.js';
import { refreshView } from '../app.js';

/** What each field is called for each kind (an artist's title is its Name, its plot a Biography). */
function labelFor(key, kind) {
  if (kind === 'artist') return { title: 'Name', overview: 'Biography' }[key];
  if (kind === 'show' && key === 'releaseDate') return 'First aired';
  if (kind === 'episode' && key === 'overview') return 'Plot';
  return {
    title: 'Title',
    sortTitle: 'Sort title',
    originalTitle: 'Original title',
    year: 'Year',
    releaseDate: 'Release date',
    airDate: 'Aired',
    overview: 'Plot',
    tagline: 'Tagline',
    genres: 'Genres',
    studio: 'Studio',
    certification: 'Age rating',
    season: 'Season',
    episode: 'Episode',
    albumArtist: 'Album artist',
  }[key];
}
const HINTS = {
  sortTitle: 'How it sorts in lists, e.g. "matrix" for The Matrix.',
  releaseDate: 'Written 2024-05-31.',
  airDate: 'Written 2024-05-31.',
  genres: 'Separated by commas.',
  certification: 'As your country writes it, e.g. PG or R16. Kids profiles follow it.',
};

function inputFor(key, value) {
  const attrs = { name: key, autocomplete: 'off' };
  if (key === 'overview') return h('textarea', { ...attrs, rows: 5, maxlength: '2000' }, value ?? '');
  if (key === 'year') return h('input', { ...attrs, type: 'number', min: '1870', max: '2100', value: value ?? '', class: 'input-year' });
  if (key === 'season' || key === 'episode') return h('input', { ...attrs, type: 'number', min: '0', max: '9999', value: value ?? '', class: 'input-year' });
  if (key === 'releaseDate' || key === 'airDate') return h('input', { ...attrs, type: 'text', inputmode: 'numeric', placeholder: '2024-05-31', pattern: '\\d{4}-\\d{2}-\\d{2}', value: value ?? '' });
  if (key === 'genres') return h('input', { ...attrs, type: 'text', value: (value || []).join(', ') });
  return h('input', { ...attrs, type: 'text', maxlength: '2000', value: value ?? '' });
}
const read = (key, el) => (key === 'genres' ? el.value.split(',').map((g) => g.trim()).filter(Boolean) : el.value.trim() === '' ? null : el.value.trim());
// A plot compared as it reads (line endings, runs of spaces): a copy and paste of the same text isn't a change.
const norm = (v) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').trim() : v);
// Only the plot is compared loosely (pasted text brings line endings and spacing); every other field exactly.
const same = (a, b, key) => (key === 'overview' ? JSON.stringify(norm(a) ?? null) === JSON.stringify(norm(b) ?? null) : JSON.stringify(a ?? null) === JSON.stringify(b ?? null));
/** Back to the title's "…" (by its name: the page may have been drawn again). */
const backToMore = () => document.querySelector('.detail-info button[aria-label^="More options"]')?.focus();

/**
 * Open the dialog for a title. `extraSections(details, item)` lets the artwork section (Task 5) join it.
 * @param {{ id, title, kind }} item
 */
export async function openEditDetails(item, { extraSections = null } = {}) {
  let details;
  try {
    details = await api.get(`/api/items/${item.id}/details`);
  } catch (err) {
    toast(err.message, { type: 'error' });
    return;
  }
  const locked = new Set(details.locked);
  const art = { changed: false };
  const inputs = new Map();
  const rows = details.fields.map((key) => {
    const label = labelFor(key, details.kind);
    const input = inputFor(key, details.values[key]);
    inputs.set(key, input);
    const lockSlot = h('div', { class: 'edit-lock' });
    const drawLock = () => {
      lockSlot.replaceChildren();
      if (!locked.has(key)) return;
      lockSlot.append(
        h('span', { class: 'lock-badge' }, icon('lock', { size: 14 }), h('span', {}, 'Locked')),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-ghost btn-sm',
            'aria-label': `Unlock ${label}`,
            onClick: async (e) => {
              e.currentTarget.disabled = true;
              try {
                await api.patch(`/api/items/${item.id}/details`, { unlock: [key] });
                locked.delete(key);
                drawLock();
                input.focus();
                const sentence = `${label} unlocked. It follows TMDB again at the next refresh.`;
                toast(sentence);
                announce(sentence);
              } catch (err) {
                e.currentTarget.disabled = false;
                toast(err.message, { type: 'error' });
              }
            },
          },
          'Unlock',
        ),
      );
    };
    drawLock();
    return h('div', { class: `edit-field${key === 'overview' ? ' edit-field-wide' : ''}`, 'data-field': key }, field(label, input, HINTS[key]), lockSlot);
  });
  const body = h('div', { class: 'edit-details' }, h('div', { class: 'edit-grid' }, rows), scoresSection(item, locked, art), artworkSection(item, locked, art), extraSections ? extraSections(details, item) : null);
  await openDialog({
    title: `Edit details for “${item.title}”`,
    wide: true,
    // The server's sentences, not the browser's bubbles (which also block Save silently for a field in a hidden tab).
    body: (dialog) => ((dialog.querySelector('form').noValidate = true), body),
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Save', value: 'save', variant: 'primary' },
    ],
    onSubmit: async () => {
      const changes = {};
      for (const [key, el] of inputs) {
        const v = read(key, el);
        if (!same(v, details.values[key] ?? (key === 'genres' ? [] : null), key)) changes[key] = v;
      }
      if (!Object.keys(changes).length) return true;
      const updated = await api.patch(`/api/items/${item.id}/details`, { changes });
      toast(`Saved ${updated.title}`, { type: 'success' });
      announce(`Saved ${updated.title}`);
      art.changed = false; // the save redraws the page
      refreshView().then(backToMore);
      return true;
    },
  });
  if (art.changed) await refreshView();
  backToMore();
}

// ---- Outside scores (v0.23): shown, and cleared with one button (they stay cleared until unlocked) ----
function scoresSection(item, locked, art) {
  if (!['movie', 'show'].includes(item.kind) || (!item.scores?.length && !locked.has('scores'))) return null;
  const box = h('section', { class: 'edit-scores' });
  const draw = () => {
    box.replaceChildren(h('h3', {}, 'Scores'));
    if (locked.has('scores')) {
      box.append(
        h('p', { class: 'muted' }, 'Cleared. A plugin fills them again only after Unlock.'),
        button('Unlock', {
          variant: 'ghost',
          attrs: { 'aria-label': 'Unlock scores' },
          onClick: async () => {
            await api.patch(`/api/items/${item.id}/details`, { unlock: ['scores'] }).catch((err) => toast(err.message, { type: 'error' }));
            locked.delete('scores');
            art.changed = true;
            announce('Scores unlocked. They fill again at the next refresh.');
            draw();
          },
        }),
      );
      return;
    }
    box.append(
      h('p', {}, scoresText(item.scores)),
      button('Clear scores', {
        variant: 'ghost',
        onClick: async () => {
          try {
            await api.patch(`/api/items/${item.id}/details`, { clearScores: true });
            locked.add('scores');
            art.changed = true;
            announce('Scores cleared');
            draw();
            box.querySelector('button')?.focus();
          } catch (err) {
            toast(err.message, { type: 'error' });
          }
        },
      }),
    );
  };
  draw();
  return box;
}

// ---- Artwork (v0.20): Poster, Background and Logo tabs; a pick, an upload or an address changes it at once ----
const ARTWORK = [
  ['poster', 'Poster', 'posters'],
  ['backdrop', 'Background', 'backgrounds'],
  ['logo', 'Logo', 'logos'],
];
const LANGS = (() => {
  try {
    return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
  } catch {
    return null;
  }
})();
// Some browsers have no language names to hand: the common ones are here too.
const COMMON = { en: 'English', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', pl: 'Polish', ru: 'Russian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', hi: 'Hindi', ar: 'Arabic', tr: 'Turkish', mi: 'Māori' };
function languageName(code) {
  if (!code) return null;
  let name = null;
  try {
    name = LANGS?.of(code);
  } catch {
    /* an odd code */
  }
  return name && name.toLowerCase() !== code.toLowerCase() ? name : COMMON[code.toLowerCase()] || code.toUpperCase();
}

function artworkSection(item, locked, state) {
  const tabs = [];
  const panels = [];
  let options = null;
  const loading = api.get(`/api/items/${item.id}/artwork`).then(
    (o) => (options = o),
    (err) => (options = { error: err.message }),
  );
  function select(i, { focus = false } = {}) {
    tabs.forEach((t, k) => {
      t.setAttribute('aria-selected', String(k === i));
      t.tabIndex = k === i ? 0 : -1;
      panels[k].hidden = k !== i;
    });
    if (focus) tabs[i].focus();
  }
  ARTWORK.forEach(([type, name, plural], i) => {
    const tabId = `art-tab-${type}`;
    const panelId = `art-panel-${type}`;
    const tab = h('button', { type: 'button', role: 'tab', id: tabId, 'aria-controls': panelId, class: 'artwork-tab', onClick: () => select(i) }, name);
    tab.addEventListener('keydown', (e) => {
      const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: ARTWORK.length - 1 }[e.key];
      if (to == null) return;
      e.preventDefault();
      e.stopPropagation();
      select((to + ARTWORK.length) % ARTWORK.length, { focus: true });
    });
    tabs.push(tab);
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const current = h('img', { class: 'artwork-current', alt: `Current ${name.toLowerCase()}`, decoding: 'async' });
    const none = h('p', { class: 'muted artwork-empty', hidden: true }, `No ${name.toLowerCase()} yet.`);
    const showCurrent = () => {
      current.hidden = false;
      none.hidden = true;
      current.src = `/api/items/${item.id}/image/${type}?v=${Date.now()}`;
    };
    current.addEventListener('error', () => {
      current.hidden = true;
      none.hidden = false;
    });
    showCurrent();
    const choices = h('div', { class: `artwork-choices artwork-${type}`, role: 'group', 'aria-label': `${name} choices from TMDB` });
    const fail = (message) => {
      error.textContent = message;
      error.hidden = false;
    };
    async function apply(send, chosen = null) {
      error.hidden = true;
      try {
        await send();
        locked.add(type);
        for (const b of choices.querySelectorAll('.artwork-choice')) b.setAttribute('aria-pressed', String(b === chosen));
        showCurrent();
        toast(`${name} changed`, { type: 'success' });
        announce(`${name} changed`);
        state.changed = true; // the page under the dialog redraws when it closes
      } catch (err) {
        fail(err.message);
      }
    }
    const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'visually-hidden', tabindex: '-1', 'aria-label': `Upload a ${name.toLowerCase()}` });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) return fail('Pictures can be 10 MB at most.');
      apply(async () => {
        const res = await fetch(`/api/items/${item.id}/artwork/${type}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: file });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `Upload failed (${res.status})`);
      });
    });
    const urlInput = h('input', { type: 'url', inputmode: 'url', placeholder: 'https://…', autocomplete: 'off', spellcheck: 'false', 'aria-label': `Address of the ${name.toLowerCase()}` });
    const useUrl = () => {
      const url = urlInput.value.trim();
      if (!url) return urlInput.focus();
      apply(() => api.put(`/api/items/${item.id}/artwork/${type}`, { url }));
    };
    urlInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); // Enter here uses the address; it doesn't save the dialog
      useUrl();
    });
    const urlRow = h('div', { class: 'inline-fields artwork-url', hidden: true }, urlInput, h('button', { type: 'button', class: 'btn btn-secondary', onClick: useUrl }, 'Use'));
    const tools = h(
      'div',
      { class: 'actions artwork-tools' },
      h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => fileInput.click() }, icon('plus', { size: 16 }), h('span', {}, 'Upload…')),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-ghost',
          'aria-expanded': 'false',
          onClick: (e) => {
            urlRow.hidden = !urlRow.hidden;
            e.currentTarget.setAttribute('aria-expanded', String(!urlRow.hidden));
            if (!urlRow.hidden) urlInput.focus();
          },
        },
        'From an address…',
      ),
      fileInput,
    );
    const panel = h('div', { role: 'tabpanel', id: panelId, 'aria-labelledby': tabId, class: 'artwork-panel', hidden: i !== 0 }, error, h('div', { class: 'artwork-now' }, current, none), choices, tools, urlRow);
    panels.push(panel);
    loading.then(() => {
      if (options.error) return choices.append(h('p', { class: 'muted' }, options.error));
      const list = options[type] || [];
      if (!list.length) return choices.append(h('p', { class: 'muted artwork-none' }, `TMDB has no ${plural} for this title.`));
      list.forEach((c, k) => {
        const label = [`${name} ${k + 1} of ${list.length}`, c.width && c.height ? `${c.width} × ${c.height}` : null, languageName(c.language)].filter(Boolean).join(', ');
        const b = h('button', { type: 'button', class: 'artwork-choice', 'aria-label': label, 'aria-pressed': 'false' }, h('img', { src: c.url, alt: '', loading: 'lazy', decoding: 'async' }));
        b.addEventListener('click', () => apply(() => api.put(`/api/items/${item.id}/artwork/${type}`, { tmdbPath: c.path }), b));
        choices.append(b);
      });
    });
  });
  select(0);
  return h(
    'section',
    { class: 'artwork-section', 'aria-labelledby': 'art-heading' },
    h('h3', { id: 'art-heading' }, 'Artwork'),
    h('p', { class: 'muted small' }, 'Pictures change as soon as you pick one, and are locked like the details.'),
    h('div', { role: 'tablist', 'aria-label': 'Artwork', class: 'artwork-tabs' }, tabs),
    panels,
  );
}
