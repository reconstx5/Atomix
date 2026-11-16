// Live TV: the guide. Channels down the side, time across (2½ hours in view), arrows move programme by programme,
// Enter opens the programme's details. On phones: one channel's day as a list.
import { h, clear, icon } from '../dom.js';
import { button, openDialog, emptyState, toast, announce } from '../components.js';
import { setTitle, canAdmin } from '../app.js';
import { channels as fetchChannels, groups as fetchGroups, guide as fetchGuide, programme as fetchProgramme, programmeTimes, programmeState, clockTime, liveStatus, playChannel, recordProgramme, cancelRecording, stopRecording, stopSeries, recordingWords } from '../live.js';
import { channelLogo, lockBadge, recDot } from '../live-bits.js';
import { listable, deviceSoon } from '../dash/playable.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SPAN = 2.5 * HOUR; // what's in view
const STEP = 2 * HOUR; // Earlier / Later
const PAGE = 50; // rows drawn at a time
// Spoken after an encrypted channel's name (v0.28: and one this device can't play, listed with the switch on).
const enc = (c) => (c.drm ? ', encrypted' : '') + (c.unplayable ? ", can't play here" : '');
const STATE_TEXT = { now: 'on now', aired: 'aired', upcoming: 'upcoming', catchup: 'catch-up available' };

const floorHalf = (t) => Math.floor(t / (30 * MIN)) * 30 * MIN;
const toWords = (p) => programmeTimes(p).replace(' – ', ' to ');

/** The details sheet for a programme, with the buttons that apply now. Also used by search's "On TV". */
export async function openProgramme(id) {
  const p = await fetchProgramme(id);
  const facts = [p.episode, p.channel?.name, `${new Date(p.start).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}, ${programmeTimes(p)}`].filter(Boolean).join(' · ');
  const actions = [];
  if (p.canWatchLive) actions.push({ label: 'Watch live', value: 'live', variant: 'primary' });
  if (p.canStartOver) actions.push({ label: 'Start over', value: 'catchup' });
  if (p.canCatchup) actions.push({ label: 'Play', value: 'catchup', variant: 'primary' });
  // Recording (grown-ups, TV channels that aren't encrypted, programmes not over yet).
  if (p.recordingId) actions.push({ label: 'Cancel recording', value: 'rec-cancel' });
  else if (p.canRecord) actions.push({ label: 'Record', value: 'rec' });
  if (p.ruleId) actions.push({ label: 'Stop series', value: 'rec-stop-series' });
  else if (p.canRecord) actions.push({ label: 'Record series', value: 'rec-series' });
  actions.push({ label: 'Close', value: 'close' });
  const body = h(
    'div',
    { class: 'programme-sheet' },
    p.image ? h('img', { class: 'programme-image', src: p.image, alt: '' }) : null,
    h('p', { class: 'muted' }, facts),
    p.recording ? h('p', { class: 'programme-rec' }, recDot(p, { silent: true }), p.recording === 'recording' ? 'Recording now' : 'Recording scheduled') : null,
    p.categories?.length ? h('ul', { class: 'chips', role: 'list' }, p.categories.map((c) => h('li', { class: 'chip' }, c))) : null,
    p.subtitle ? h('p', {}, h('strong', {}, p.subtitle)) : null,
    p.description ? h('p', {}, p.description) : null,
  );
  const choice = await openDialog({ title: p.title, body, actions });
  if (choice === 'live') playChannel(p.channel); // a radio station plays in the music player
  else if (choice === 'catchup') location.hash = `#/live/catchup/${p.id}`;
  else if (String(choice).startsWith('rec')) return (await recordAction(choice, p)) ? 'recordings-changed' : choice;
  return choice;
}

const said = (text, type = 'success') => (toast(text, { type }), announce(text));

/** Record, Record series (its choices first), Cancel recording, Stop series. True when something changed. */
async function recordAction(choice, p) {
  try {
    if (choice === 'rec-cancel') {
      // Recording now: it stops and keeps what it got. Scheduled: cancelled. A sheet opened a while ago never removes
      // a finished recording (the server answers "This recording has finished").
      if (p.recording === 'recording') {
        await stopRecording(p.recordingId);
        said(`Stopped recording ${p.title}`);
      } else {
        await cancelRecording(p.recordingId, { onlyActive: true });
        said('Recording cancelled');
      }
      return true;
    }
    if (choice === 'rec-stop-series') {
      await stopSeries(p.ruleId);
      said('Series stopped');
      return true;
    }
    let opts = {};
    if (choice === 'rec-series') {
      opts = await seriesChoices(p);
      if (!opts) return false;
    }
    const r = await recordProgramme(p.id, opts);
    said(choice === 'rec-series' ? 'Series recording set up' : 'Recording scheduled');
    if (r.clash) toast(r.clash, { type: 'warning', timeout: 9000 }), announce(r.clash);
    return true;
  } catch (err) {
    toast(err.message, { type: 'error', timeout: 9000 }); // spoken by the alert region
    return false;
  }
}

/** Record series: this channel or any channel, new episodes only, how many to keep. Null when cancelled. */
async function seriesChoices(p) {
  const radio = (value, label, checked) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'series-channel', value, checked: checked || null }), h('span', {}, label));
  const where = h('fieldset', { class: 'stack' }, h('legend', {}, 'Record on'), radio('this', `This channel: ${p.channel?.name || ''}`, true), radio('any', 'Any channel'));
  const newOnly = h('input', { type: 'checkbox', checked: true });
  const keep = h('select', { 'aria-label': 'Keep' }, [['0', 'All episodes'], ['5', 'The last 5'], ['10', 'The last 10']].map(([v, l]) => h('option', { value: v }, l)));
  const body = h('div', { class: 'stack series-choices' }, where, h('label', { class: 'check' }, newOnly, h('span', {}, 'New episodes only')), h('label', { class: 'field' }, h('span', {}, 'Keep'), keep));
  // A remote's OK (Enter) picks a choice or ticks the box — in a form it would otherwise submit (Cancel).
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement) || !['radio', 'checkbox'].includes(e.target.type)) return;
    e.preventDefault();
    e.stopPropagation();
    e.target.click();
  });
  const v = await openDialog({ title: `Record series: ${p.title}`, body, actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Record series', value: 'ok', variant: 'primary' }] });
  if (v !== 'ok') return null;
  return { series: true, anyChannel: where.querySelector('input:checked')?.value === 'any', newOnly: newOnly.checked, keep: Number(keep.value) };
}

export async function render(el, params, query = {}) {
  setTitle('Guide');
  el.classList.add('guide-view');
  const status = await liveStatus({ fresh: true });
  if (!status.enabled) {
    el.append(emptyState({ title: "Live TV isn't set up yet", text: canAdmin() ? 'Add a playlist in Settings → Plugins → IPTV Simple' : '', icon: 'live' }));
    return;
  }
  // v0.28: channels this device can't play are left out (unless the Live TV switch is on).
  const listed = await fetchChannels();
  const all = listable(listed, { device: await deviceSoon(listed) });
  if (window.matchMedia('(max-width: 720px)').matches) return renderList(el, all, query);
  return renderGrid(el, all, query);
}

// ---- TV and desktop: the grid ----
async function renderGrid(el, all, query) {
  const now = () => Date.now();
  let from = floorHalf(now()) - 30 * MIN;
  let group = 'All';
  let shown = all;
  let drawn = 0;
  const cache = new Map(); // channel id -> Map(programme id -> programme), for what has been fetched
  const fetched = []; // [from, to, idsKey] windows already asked for
  const maxDays = Math.max(1, ...all.map((c) => c.catchupDays || 0));

  const grid = h('div', { class: 'guide-grid', role: 'grid', 'aria-label': 'TV guide' });
  const ruler = h('div', { class: 'guide-ruler', 'aria-hidden': 'true' });
  const nowLine = h('div', { class: 'guide-now', 'aria-hidden': 'true' });
  const day = h('select', { class: 'guide-day', 'aria-label': 'Day' });
  const groupSel = h('select', { class: 'guide-group', 'aria-label': 'Channel group' });
  const sentinel = h('div', { class: 'guide-more', 'aria-hidden': 'true' });

  const names = await fetchGroups();
  groupSel.append(...['All', ...(all.some((c) => c.favourite) ? ['Favourites'] : []), ...names].map((g) => h('option', { value: g }, g)));
  groupSel.addEventListener('change', () => {
    group = groupSel.value;
    shown = group === 'All' ? all : group === 'Favourites' ? all.filter((c) => c.favourite) : all.filter((c) => c.groups.includes(group));
    drawRows(true);
  });
  const dayStart = (t) => new Date(new Date(t).setHours(0, 0, 0, 0)).getTime();
  for (let d = -maxDays; d <= 7; d++) {
    const t = dayStart(now()) + d * DAY;
    day.append(h('option', { value: String(t) }, d === 0 ? 'Today' : d === -1 ? 'Yesterday' : d === 1 ? 'Tomorrow' : new Date(t).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })));
  }
  day.value = String(dayStart(now()));
  day.addEventListener('change', () => {
    const t = Number(day.value);
    const clockPart = from - dayStart(from);
    moveTo(t + clockPart);
  });

  el.append(
    h('header', { class: 'page-head' }, h('h1', {}, 'Guide'), h('div', { class: 'actions' }, button('Channels', { icon: 'live', variant: 'ghost', href: '#/live' }))),
    h(
      'div',
      { class: 'guide-tools' },
      button('Earlier', { icon: 'back', variant: 'ghost', onClick: () => moveTo(from - STEP) }),
      button('Now', { icon: 'live', variant: 'ghost', onClick: () => moveTo(floorHalf(now()) - 30 * MIN) }),
      button('Later', { icon: 'next', variant: 'ghost', onClick: () => moveTo(from + STEP) }),
      h('label', { class: 'guide-pick' }, 'Day ', day),
      h('label', { class: 'guide-pick' }, 'Group ', groupSel),
    ),
    h('div', { class: 'guide-body' }, ruler, grid, nowLine, sentinel),
  );

  const pct = (t) => `${((t - from) / SPAN) * 100}%`;

  function drawRuler() {
    clear(ruler);
    for (let t = from; t < from + SPAN; t += 30 * MIN) ruler.append(h('span', { style: `left:${pct(t)}` }, clockTime(t)));
    const n = now();
    nowLine.hidden = !(n >= from && n < from + SPAN);
    nowLine.style.setProperty('--x', String((n - from) / SPAN));
    grid.dataset.from = String(from);
    grid.dataset.to = String(from + SPAN);
  }

  async function ensure(ids) {
    const lo = from - HOUR;
    const hi = from + SPAN + HOUR;
    const need = ids.filter((id) => !fetched.some(([a, b, set]) => a <= lo && b >= hi && set.has(id)));
    if (!need.length) return;
    // The guide route takes 6 hours and 200 channels at a time.
    for (let i = 0; i < need.length; i += 200) {
      const part = need.slice(i, i + 200);
      for (let t = lo; t < hi; t += 6 * HOUR) {
        const g = await fetchGuide(t, Math.min(hi, t + 6 * HOUR), part);
        for (const [cid, progs] of Object.entries(g.programmes)) {
          if (!cache.has(Number(cid))) cache.set(Number(cid), new Map());
          for (const p of progs) cache.get(Number(cid)).set(p.id, p);
        }
      }
      fetched.push([lo, hi, new Set(part)]);
    }
  }

  function rowFor(c) {
    const n = now();
    const progs = [...(cache.get(c.id)?.values() || [])].filter((p) => p.end > from && p.start < from + SPAN).sort((a, b) => a.start - b.start);
    const cells = progs.map((p) => {
      const st = programmeState(p, n, c);
      const left = Math.max(p.start, from);
      const right = Math.min(p.end, from + SPAN);
      return h(
        'div',
        { class: 'guide-cell', role: 'gridcell', style: `left:${pct(left)};width:calc(${((right - left) / SPAN) * 100}% - 4px)` },
        h(
          'button',
          {
            type: 'button',
            class: `guide-prog is-${st}`,
            'aria-label': `${c.name}${enc(c)}, ${toWords(p)}, ${p.title}, ${STATE_TEXT[st]}${recordingWords(p)}`,
            dataset: { id: p.id, start: p.start, end: p.end },
            tabindex: -1,
            onClick: async () => {
              if ((await openProgramme(p.id)) !== 'recordings-changed') return;
              // The red dots changed (a series may span channels): the guide is asked again, focus stays here.
              cache.clear();
              fetched.length = 0;
              drawRows(false, { focusChannel: c.id, focusAt: p.start });
            },
          },
          st === 'catchup' ? h('span', { class: 'guide-badge', title: 'Catch-up available' }, icon('rewind', { size: 14 })) : null,
          recDot(p),
          h('span', { class: 'guide-title' }, p.title),
          h('span', { class: 'guide-time' }, programmeTimes(p)),
        ),
      );
    });
    if (!cells.length) {
      cells.push(h('div', { class: 'guide-cell guide-cell-empty', role: 'gridcell', style: 'left:0;width:calc(100% - 4px)' }, h('button', { type: 'button', class: 'guide-empty', tabindex: -1, 'aria-label': `${c.name}${enc(c)}, No guide information`, onClick: () => playChannel(c) }, 'No guide information')));
    }
    return h(
      'div',
      { class: c.unplayable ? 'guide-row is-unplayable' : 'guide-row', role: 'row', dataset: { channel: c.id } },
      h('div', { class: 'guide-chan', role: 'rowheader' }, channelLogo(c, 'sm'), h('span', { class: 'live-num' }, c.number != null ? String(c.number) : ''), h('span', { class: 'guide-chan-name' }, c.name), lockBadge(c), c.unplayable ? h('span', { class: 'chip live-cant', 'aria-hidden': 'true' }, "Can't play here") : null),
      h('div', { class: 'guide-track' }, cells),
    );
  }

  let moreObserver = null;
  let rowsGen = 0; // bumped whenever the rows are redrawn: "more rows" for an older window is dropped
  async function drawRows(reset = false, { focusChannel = null, focusAt = null } = {}) {
    rowsGen++;
    if (reset) {
      drawn = 0;
      clear(grid);
    }
    const ids = shown.slice(0, Math.max(drawn, PAGE)).map((c) => c.id);
    await ensure(ids);
    clear(grid);
    drawn = Math.max(drawn, Math.min(PAGE, shown.length));
    grid.append(...shown.slice(0, drawn).map(rowFor));
    drawRuler();
    // One tab stop: the programme on now in the first row (or the first programme).
    const first = grid.querySelector('button.guide-prog.is-now') || grid.querySelector('button.guide-prog, button.guide-empty');
    if (first) first.tabIndex = 0;
    if (focusChannel != null) focusCellAt(focusChannel, focusAt);
    // Look at the sentinel again: a "more rows" dropped for an older window is asked for again if it's still in view.
    if (moreObserver) {
      moreObserver.unobserve(sentinel);
      moreObserver.observe(sentinel);
    }
  }

  async function moreRows() {
    if (drawn >= shown.length) return;
    const next = shown.slice(drawn, drawn + PAGE);
    const gen = rowsGen;
    await ensure(next.map((c) => c.id));
    if (gen !== rowsGen) return; // the window moved (or the rows were redrawn) meanwhile
    drawn += next.length;
    grid.append(...next.map(rowFor));
  }
  moreObserver = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && moreRows().catch(() => {}), { rootMargin: '600px' });
  moreObserver.observe(sentinel);

  function cellsOf(row) {
    return [...row.querySelectorAll('button.guide-prog, button.guide-empty')];
  }
  /** Focus the programme in `channel`'s row covering `at` (or the nearest to it). */
  function focusCellAt(channel, at) {
    const row = grid.querySelector(`.guide-row[data-channel="${channel}"]`);
    if (!row) return false;
    const cells = cellsOf(row);
    const t = at ?? now();
    const hit = cells.find((b) => Number(b.dataset.start) <= t && t < Number(b.dataset.end)) || cells.reduce((best, b) => (!best || Math.abs(Number(b.dataset.start) - t) < Math.abs(Number(best.dataset.start) - t) ? b : best), null);
    if (!hit) return false;
    for (const b of grid.querySelectorAll('[tabindex="0"]')) b.tabIndex = -1;
    hit.tabIndex = 0;
    hit.focus({ preventScroll: true });
    hit.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  }

  async function moveTo(t, keep = null) {
    from = t;
    day.value = String(dayStart(from));
    await drawRows(false, keep || {});
  }

  let column = null; // the time Up/Down keep (set by the first Up/Down after a Left/Right, so Up undoes Down)
  let moving = false; // a window move is loading: presses meanwhile are dropped (holding Left mustn't stack moves)
  grid.addEventListener('keydown', async (e) => {
    const b = e.target.closest('button.guide-prog, button.guide-empty');
    if (!b || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    if (moving) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const row = b.closest('.guide-row');
    const channel = row.dataset.channel;
    const start = Number(b.dataset.start || from);
    const end = Number(b.dataset.end || from);
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const other = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
      if (!other) return; // the page above (the tools) or nothing below: the usual navigation
      e.preventDefault();
      e.stopPropagation();
      if (column == null || column < from || column >= from + SPAN) column = Math.max(start, from);
      focusCellAt(other.dataset.channel, column);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    column = null;
    const cells = cellsOf(row);
    const i = cells.indexOf(b);
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const next = cells[i + dir];
    if (next) {
      focusCellAt(channel, Number(next.dataset.start) + 1);
      return;
    }
    // Off the edge of what's in view: move the window and stay on this channel.
    moving = true;
    try {
      if (dir < 0) await moveTo(from - STEP, { focusChannel: channel, focusAt: start - 1 });
      else await moveTo(from + STEP, { focusChannel: channel, focusAt: Math.max(end, from + SPAN - STEP) });
    } finally {
      moving = false;
    }
  });

  const tick = setInterval(drawRuler, 30_000);
  const want = query.channel ? Number(query.channel) : null;
  if (want && shown.some((c) => c.id === want)) {
    const idx = shown.findIndex((c) => c.id === want);
    drawn = Math.min(shown.length, Math.ceil((idx + 1) / PAGE) * PAGE);
  }
  await drawRows(true, want ? { focusChannel: want, focusAt: now() } : {});
  if (want) grid.querySelector('[tabindex="0"]')?.setAttribute('data-focus-now', '');
  return () => clearInterval(tick);
}

// ---- Phones: one channel's day as a list ----
async function renderList(el, all, query) {
  const chanSel = h('select', { class: 'guide-channel-select', 'aria-label': 'Channel' }, all.map((c) => h('option', { value: String(c.id) }, `${c.number != null ? `${c.number} ${c.name}` : c.name}${enc(c)}`)));
  const daySel = h('select', { class: 'guide-day', 'aria-label': 'Day' });
  const maxDays = Math.max(1, ...all.map((c) => c.catchupDays || 0));
  const today = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  for (let d = -maxDays; d <= 7; d++) {
    const t = today + d * DAY;
    daySel.append(h('option', { value: String(t) }, d === 0 ? 'Today' : d === -1 ? 'Yesterday' : d === 1 ? 'Tomorrow' : new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })));
  }
  daySel.value = String(today);
  if (query.channel) chanSel.value = String(query.channel);
  const listEl = h('ul', { class: 'guide-list', role: 'list' });
  el.append(h('header', { class: 'page-head' }, h('h1', {}, 'Guide')), h('div', { class: 'guide-tools' }, chanSel, daySel), listEl);

  async function draw() {
    const c = all.find((x) => String(x.id) === chanSel.value) || all[0];
    listEl.classList.toggle('is-unplayable', Boolean(c?.unplayable)); // v0.28: dimmed (the picker's name says why)
    const start = Number(daySel.value);
    const progs = [];
    for (let t = start; t < start + DAY; t += 6 * HOUR) {
      const g = await fetchGuide(t, t + 6 * HOUR, [c.id]);
      progs.push(...(g.programmes[c.id] || []));
    }
    const seen = new Set();
    const n = Date.now();
    const rows = progs.filter((p) => !seen.has(p.id) && seen.add(p.id)).sort((a, b) => a.start - b.start);
    clear(listEl).append(
      ...(rows.length
        ? rows.map((p) => {
            const st = programmeState(p, n, c);
            const open = async () => {
              if ((await openProgramme(p.id)) !== 'recordings-changed') return;
              await draw();
              listEl.querySelector(`[data-id="${p.id}"]`)?.focus();
            };
            return h('li', {}, h('button', { type: 'button', class: `guide-prog is-${st}`, 'aria-label': `${c.name}${enc(c)}, ${toWords(p)}, ${p.title}, ${STATE_TEXT[st]}${recordingWords(p)}`, dataset: { id: p.id, start: p.start, end: p.end }, onClick: open }, h('span', { class: 'guide-time' }, clockTime(p.start)), h('span', { class: 'guide-title' }, p.title), recDot(p), st === 'catchup' ? h('span', { class: 'guide-badge' }, icon('rewind', { size: 14 })) : null));
          })
        : [h('li', { class: 'muted' }, 'No guide information')]),
    );
    listEl.querySelector('.is-now')?.scrollIntoView({ block: 'center' });
  }
  chanSel.addEventListener('change', draw);
  daySel.addEventListener('change', draw);
  await draw();
}
