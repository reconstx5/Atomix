// Live TV: the guide. Channels down the side, time across (2½ hours in view), arrows move programme by programme,
// Enter opens the programme's details. On phones: one channel's day as a list.
// v0.30: a Preact screen; the keyboard and fetch decisions are in guide-rules.js. The programme sheet and the Record
// series dialog stay dialogs with DOM bodies (openProgramme is also used by Live TV and search).
import { html, useState, useRef, useLayoutEffect } from '../ui.js';
import { Button, EmptyState, Icon } from '../ui/basics.js';
import { ChannelLogo, LockBadge, RecDot } from '../ui/live.js';
import { h } from '../dom.js';
import { openDialog, toast, announce } from '../components.js';
import { setTitle, canAdmin } from '../app.js';
import { channels as fetchChannels, groups as fetchGroups, guide as fetchGuide, programme as fetchProgramme, programmeTimes, programmeState, clockTime, liveStatus, playChannel, recordProgramme, cancelRecording, stopRecording, stopSeries, recordingWords } from '../live.js';
import { recDot } from '../live-bits.js';
import { listable, deviceSoon } from '../dash/playable.js';
import { HOUR, DAY, SPAN, STEP, PAGE, windowStart, dayStart, dayOptions, maxCatchupDays, rulerTicks, nowLine, pct, cellsInWindow, tabStop, cellAt, arrowMove, guideRequests, groupOptions, channelsForGroup, initialRows, encWords, latest } from '../guide-rules.js';

const STATE_TEXT = { now: 'on now', aired: 'aired', upcoming: 'upcoming', catchup: 'catch-up available' };
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

// ---- The page (v0.30: a Preact screen; the keyboard and fetch decisions are in guide-rules.js) ----

/** A channel's programmes for one day (the phone list), in four 6-hour requests, without repeats, by start. */
async function dayOf(c, start) {
  const progs = [];
  for (let t = start; t < start + DAY; t += 6 * HOUR) {
    const g = await fetchGuide(t, t + 6 * HOUR, [c.id]);
    progs.push(...(g.programmes[c.id] || []));
  }
  const seen = new Set();
  return progs.filter((p) => !seen.has(p.id) && seen.add(p.id)).sort((a, b) => a.start - b.start);
}

/** Fetch what the window at `from` still needs for `ids` into `cache`; resolves to the new record of what was fetched. */
async function ensure(cache, fetched, ids, from) {
  const { requests, record } = guideRequests(fetched, ids, from);
  for (const r of requests) {
    const g = await fetchGuide(r.from, r.to, r.ids);
    for (const [cid, progs] of Object.entries(g.programmes)) {
      if (!cache.has(Number(cid))) cache.set(Number(cid), new Map());
      for (const p of progs) cache.get(Number(cid)).set(p.id, p);
    }
  }
  return record;
}

export async function load(params, query = {}) {
  setTitle('Guide');
  const status = await liveStatus({ fresh: true });
  if (!status.enabled) return { enabled: false };
  // v0.28: channels this device can't play are left out (unless the Live TV switch is on).
  const listed = await fetchChannels();
  const all = listable(listed, { device: await deviceSoon(listed) });
  const want = query.channel ? Number(query.channel) : null;
  if (window.matchMedia('(max-width: 720px)').matches) {
    const c = all.find((x) => x.id === want) || all[0] || null;
    const day = dayStart(Date.now());
    return { enabled: true, layout: 'phone', all, channel: c?.id ?? null, day, programmes: c ? await dayOf(c, day) : [] };
  }
  const names = await fetchGroups();
  const from = windowStart(Date.now());
  const drawn = initialRows(all, want);
  const cache = new Map(); // channel id -> Map(programme id -> programme), for what has been fetched
  const fetched = await ensure(cache, [], all.slice(0, drawn).map((c) => c.id), from);
  return { enabled: true, layout: 'grid', all, names, cache, fetched, from, drawn, want };
}

export function Screen({ data, view }) {
  useLayoutEffect(() => {
    view?.classList.add('guide-view');
  }, []);
  if (!data.enabled) return html`<${EmptyState} title="Live TV isn't set up yet" text=${canAdmin() ? 'Add a playlist in Settings → Plugins → IPTV Simple' : ''} icon="live" />`;
  return data.layout === 'phone' ? html`<${GuideList} data=${data} />` : html`<${GuideGrid} data=${data} />`;
}

// ---- TV and desktop: the grid ----

const cellKey = (cell) => (cell.p ? cell.p.id : 'empty');
/** One row as drawn: its cells with their state at `now` (states change only when the rows are drawn again). */
function rowModel(c, cache, from, now) {
  const cells = cellsInWindow([...(cache.get(c.id)?.values() || [])], from).map((x) => ({ ...x, start: x.p.start, end: x.p.end, state: programmeState(x.p, now, c) }));
  return { c, channel: c.id, cells: cells.length ? cells : [{ p: null, empty: true, start: from, end: from, state: null }] };
}
/** The one tab stop: the cell covering `focus.at` in its channel's row (when drawn), else the usual one. */
function stopFor(rows, focus) {
  const row = focus && rows.find((r) => String(r.channel) === String(focus.channel));
  if (row) {
    const i = cellAt(row.cells, focus.at ?? Date.now());
    if (i >= 0) return { stop: { channel: row.channel, key: cellKey(row.cells[i]) }, found: true };
  }
  const t = tabStop(rows);
  return { stop: t && { channel: t.channel, key: cellKey(rows.find((r) => r.channel === t.channel).cells[t.index]) }, found: false };
}
// The cells' and ruler's style is written as an attribute, as before (a style property is read back respaced).
const styled = (s) => (el) => el?.setAttribute('style', s);
// Preact leaves out an option's value when it is the same as its text; the group options keep it, as before.
const valueAttr = (v) => (el) => el?.setAttribute('value', v);

function GuideGrid({ data }) {
  const { all, names } = data;
  const cache = useRef(data.cache);
  const fetched = useRef(data.fetched);
  const [g, setG] = useState(() => {
    const shown = all.slice(0, data.drawn);
    const rows = shown.map((c) => rowModel(c, data.cache, data.from, Date.now()));
    return { from: data.from, group: 'All', drawn: data.drawn, rows, stop: stopFor(rows, data.want ? { channel: data.want, at: Date.now() } : null).stop, drawsN: 0, tick: 0 };
  });
  const cur = useRef(g);
  cur.current = g;
  const fromRef = useRef(data.from); // the window last asked for (Earlier/Later count from it while it loads)
  const gen = useRef(0); // bumped by every draw: an answer for an older one (or "more rows" for it) is dropped
  const moving = useRef(false); // a window move is loading: arrows meanwhile are dropped (holding Left mustn't stack moves)
  const more = useRef(false); // "more rows" is loading
  const column = useRef(null); // the time Up/Down keep (set by the first Up/Down after a Left/Right, so Up undoes Down)
  const focusNext = useRef(false); // focus the tab stop after the next render
  const grid = useRef(null);
  const sentinel = useRef(null);
  const observer = useRef(null);
  const alive = useRef(true);

  /** Draw the rows again (a window move, a group, a changed recording); `focus` { channel, at } moves focus there. */
  async function draw({ from = fromRef.current, group = cur.current.group, reset = false } = {}, focus = null) {
    const mine = ++gen.current;
    const shown = channelsForGroup(all, group);
    const drawn = reset ? Math.min(PAGE, shown.length) : Math.max(cur.current.drawn, Math.min(PAGE, shown.length));
    fetched.current = await ensure(cache.current, fetched.current, shown.slice(0, drawn).map((c) => c.id), from);
    if (mine !== gen.current || !alive.current) return;
    const now = Date.now();
    const rows = shown.slice(0, drawn).map((c) => rowModel(c, cache.current, from, now));
    const { stop, found } = stopFor(rows, focus);
    focusNext.current = found;
    setG((s) => ({ ...s, from, group, drawn, rows, stop, drawsN: s.drawsN + 1 }));
  }
  const moveTo = (t, focus = null) => {
    fromRef.current = t;
    return draw({ from: t }, focus);
  };

  async function moreRows() {
    const s = cur.current;
    const shown = channelsForGroup(all, s.group);
    if (more.current || s.drawn >= shown.length) return;
    more.current = true;
    const mine = gen.current;
    try {
      const next = shown.slice(s.drawn, s.drawn + PAGE);
      fetched.current = await ensure(cache.current, fetched.current, next.map((c) => c.id), s.from);
      if (mine !== gen.current || !alive.current) return; // the window moved (or the rows were drawn again) meanwhile
      const now = Date.now();
      setG((x) => ({ ...x, drawn: x.drawn + next.length, rows: [...x.rows, ...next.map((c) => rowModel(c, cache.current, x.from, now))] }));
    } finally {
      more.current = false;
    }
  }

  // The ruler and now line every 30 s; "more rows" when the sentinel comes near; both stop when the page is left.
  useLayoutEffect(() => {
    const tick = setInterval(() => setG((s) => ({ ...s, tick: s.tick + 1 })), 30_000);
    observer.current = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && moreRows().catch(() => {}), { rootMargin: '600px' });
    observer.current.observe(sentinel.current);
    // A ?channel= link: its programme on now (or the usual tab stop) is focused and kept in view by the router.
    if (data.want) grid.current.querySelector('[tabindex="0"]')?.setAttribute('data-focus-now', '');
    return () => {
      alive.current = false;
      clearInterval(tick);
      observer.current.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    if (g.drawsN && observer.current) {
      // Look at the sentinel again: a "more rows" dropped for an older window is asked for again if it's still in view.
      observer.current.unobserve(sentinel.current);
      observer.current.observe(sentinel.current);
    }
  }, [g.drawsN]);

  useLayoutEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    const b = grid.current?.querySelector('[tabindex="0"]');
    if (!b) return;
    b.focus({ preventScroll: true });
    b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  const focusAt = (channel, at) => {
    const row = cur.current.rows.find((r) => String(r.channel) === String(channel));
    const i = row ? cellAt(row.cells, at) : -1;
    if (i < 0) return;
    focusNext.current = true;
    setG((s) => ({ ...s, stop: { channel: row.channel, key: cellKey(row.cells[i]) } }));
  };

  const onKeyDown = async (e) => {
    const b = e.target.closest('button.guide-prog, button.guide-empty');
    if (!b || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    if (moving.current) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const { rows, from } = cur.current;
    const rowIndex = rows.findIndex((r) => String(r.channel) === b.closest('.guide-row').dataset.channel);
    const cellIndex = rowIndex < 0 ? -1 : rows[rowIndex].cells.findIndex((c) => (c.p ? String(c.p.id) === b.dataset.id : !b.dataset.id));
    const res = arrowMove({ key: e.key, rows, rowIndex, cellIndex, from, column: column.current });
    if (!res) return; // the page above (the tools) or nothing below: the usual navigation
    e.preventDefault();
    e.stopPropagation();
    column.current = res.column;
    if (res.moveWindow == null) return focusAt(res.focus.channel, res.focus.at);
    // Off the edge of what's in view: move the window and stay on this channel.
    moving.current = true;
    try {
      await moveTo(res.moveWindow, res.focus);
    } finally {
      moving.current = false;
    }
  };

  const open = async (c, p) => {
    if ((await openProgramme(p.id)) !== 'recordings-changed' || !alive.current) return;
    // The red dots changed (a series may span channels): the guide is asked again, focus stays here.
    cache.current.clear();
    fetched.current = [];
    draw({}, { channel: c.id, at: p.start });
  };

  const { from, rows, stop } = g;
  const now = Date.now();
  const line = nowLine(now, from);
  const days = dayOptions(now, maxCatchupDays(all), 'long');
  const cell = (c, x) => {
    const tab = stop && stop.channel === c.id && stop.key === cellKey(x) ? 0 : -1;
    if (x.empty) {
      return html`<div class="guide-cell guide-cell-empty" role="gridcell" ref=${styled('left:0;width:calc(100% - 4px)')}><button type="button" class="guide-empty" tabindex=${tab} aria-label=${`${c.name}${encWords(c)}, No guide information`} onClick=${() => playChannel(c)}>No guide information</button></div>`;
    }
    const p = x.p;
    const st = x.state;
    return html`<div key=${p.id} class="guide-cell" role="gridcell" ref=${styled(`left:${x.left};width:${x.width}`)}>
      <button type="button" class=${`guide-prog is-${st}`} aria-label=${`${c.name}${encWords(c)}, ${toWords(p)}, ${p.title}, ${STATE_TEXT[st]}${recordingWords(p)}`} data-id=${p.id} data-start=${p.start} data-end=${p.end} tabindex=${tab} onClick=${() => open(c, p)}>
        ${st === 'catchup' ? html`<span class="guide-badge" title="Catch-up available"><${Icon} name="rewind" size=${14} /></span>` : null}
        <${RecDot} p=${p} />
        <span class="guide-title">${p.title}</span>
        <span class="guide-time">${programmeTimes(p)}</span>
      </button>
    </div>`;
  };
  return html`
    <header class="page-head"><h1>Guide</h1><div class="actions"><${Button} label="Channels" icon="live" variant="ghost" href="#/live" /></div></header>
    <div class="guide-tools">
      <${Button} label="Earlier" icon="back" variant="ghost" onClick=${() => moveTo(fromRef.current - STEP)} />
      <${Button} label="Now" icon="live" variant="ghost" onClick=${() => moveTo(windowStart(Date.now()))} />
      <${Button} label="Later" icon="next" variant="ghost" onClick=${() => moveTo(fromRef.current + STEP)} />
      <label class="guide-pick">Day <select class="guide-day" aria-label="Day" value=${String(dayStart(from))} onChange=${(e) => moveTo(Number(e.target.value) + (fromRef.current - dayStart(fromRef.current)))}>${days.map((d) => html`<option value=${d.value}>${d.label}</option>`)}</select></label>
      <label class="guide-pick">Group <select class="guide-group" aria-label="Channel group" value=${g.group} onChange=${(e) => draw({ group: e.target.value, reset: true })}>${groupOptions(all, names).map((n) => html`<option ref=${valueAttr(n)}>${n}</option>`)}</select></label>
    </div>
    <div class="guide-body">
      <div class="guide-ruler" aria-hidden="true">${rulerTicks(from).map((t) => html`<span key=${t} ref=${styled(`left:${pct(t, from)}`)}>${clockTime(t)}</span>`)}</div>
      <div ref=${grid} class="guide-grid" role="grid" aria-label="TV guide" data-from=${String(from)} data-to=${String(from + SPAN)} onKeyDown=${onKeyDown}>
        ${rows.map(({ c, cells }) => html`<div key=${c.id} class=${c.unplayable ? 'guide-row is-unplayable' : 'guide-row'} role="row" data-channel=${c.id}>
          <div class="guide-chan" role="rowheader"><${ChannelLogo} c=${c} size="sm" /><span class="live-num">${c.number != null ? String(c.number) : ''}</span><span class="guide-chan-name">${c.name}</span><${LockBadge} c=${c} />${c.unplayable ? html`<span class="chip live-cant" aria-hidden="true">Can't play here</span>` : null}</div>
          <div class="guide-track">${cells.map((x) => cell(c, x))}</div>
        </div>`)}
      </div>
      <div class="guide-now" aria-hidden="true" hidden=${line.hidden} style=${{ '--x': String(line.x) }} />
      <div ref=${sentinel} class="guide-more" aria-hidden="true" />
    </div>
  `;
}

// ---- Phones: one channel's day as a list ----

function GuideList({ data }) {
  const { all } = data;
  const [l, setL] = useState({ channel: data.channel, day: data.day, programmes: data.programmes, n: 0 });
  const pick = useRef(latest()).current;
  const picked = useRef({ channel: data.channel, day: data.day }); // the pickers as last changed (an answer may still be loading)
  const list = useRef(null);
  const focusId = useRef(null);
  const alive = useRef(true);
  useLayoutEffect(() => () => (alive.current = false), []);
  const c = all.find((x) => x.id === l.channel) || all[0];

  /** Show `channel`'s `day`; a slower answer for an earlier pick is dropped (the last pick wins). */
  async function show(change) {
    const { channel, day } = Object.assign(picked.current, change);
    const current = pick();
    const ch = all.find((x) => x.id === channel) || all[0];
    const programmes = ch ? await dayOf(ch, day) : [];
    if (!current() || !alive.current) return false;
    setL((s) => ({ channel, day, programmes, n: s.n + 1 }));
    return true;
  }

  useLayoutEffect(() => {
    list.current?.querySelector('.is-now')?.scrollIntoView({ block: 'center' });
    const id = focusId.current;
    focusId.current = null;
    if (id != null) list.current?.querySelector(`[data-id="${id}"]`)?.focus();
  }, [l.n]);

  const open = async (p) => {
    if ((await openProgramme(p.id)) !== 'recordings-changed' || !alive.current) return;
    focusId.current = p.id;
    if (!(await show({}))) focusId.current = null;
  };

  const now = Date.now();
  const days = dayOptions(now, maxCatchupDays(all), 'short');
  const rows = l.programmes;
  return html`
    <header class="page-head"><h1>Guide</h1></header>
    <div class="guide-tools">
      <select class="guide-channel-select" aria-label="Channel" value=${c ? String(c.id) : ''} onChange=${(e) => show({ channel: Number(e.target.value) })}>${all.map((x) => html`<option value=${String(x.id)}>${`${x.number != null ? `${x.number} ${x.name}` : x.name}${encWords(x)}`}</option>`)}</select>
      <select class="guide-day" aria-label="Day" value=${String(l.day)} onChange=${(e) => show({ day: Number(e.target.value) })}>${days.map((d) => html`<option value=${d.value}>${d.label}</option>`)}</select>
    </div>
    <ul ref=${list} class=${c?.unplayable ? 'guide-list is-unplayable' : 'guide-list'} role="list">
      ${rows.length
        ? rows.map((p) => {
            const st = programmeState(p, now, c);
            return html`<li key=${p.id}><button type="button" class=${`guide-prog is-${st}`} aria-label=${`${c.name}${encWords(c)}, ${toWords(p)}, ${p.title}, ${STATE_TEXT[st]}${recordingWords(p)}`} data-id=${p.id} data-start=${p.start} data-end=${p.end} onClick=${() => open(p)}><span class="guide-time">${clockTime(p.start)}</span><span class="guide-title">${p.title}</span><${RecDot} p=${p} />${st === 'catchup' ? html`<span class="guide-badge"><${Icon} name="rewind" size=${14} /></span>` : null}</button></li>`;
          })
        : html`<li class="muted">No guide information</li>`}
    </ul>
  `;
}
