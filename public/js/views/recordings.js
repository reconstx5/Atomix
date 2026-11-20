// Live TV → Recordings: what's recording now (Stop), what's scheduled (with clash marks), what's done (Play, Delete),
// what failed (and why), and the series rules (keep, new episodes only, Stop series). Everyone's recordings, each
// named by the profile that scheduled it. Kids profiles can't record and see only that sentence.
// v0.30: a Preact screen (rules in recordings-rules.js).
import { html, useState, useRef, useLayoutEffect } from '../ui.js';
import { Button, EmptyState, Icon } from '../ui/basics.js';
import { RecDot } from '../ui/live.js';
import { toast, announce } from '../components.js';
import { setTitle } from '../app.js';
import { recordingsList, stopRecording, cancelRecording, retryRecording, updateRule, stopSeries, clockTime } from '../live.js';
import { nextFocusKey, afterDeleteFocus, episodeLine, gapText } from '../recordings-rules.js';

const REFRESH_MS = 15_000;
const MIN = 60_000;

const dayTime = (ms) => `${new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${clockTime(ms)}`;
const said = (text, type = 'success') => (toast(text, { type }), announce(text));

/** The list, or why there is none: { data } | { forbidden: sentence } (Kids) | { error: message }. */
async function read() {
  try {
    return { data: await recordingsList() };
  } catch (err) {
    return err.status === 403 ? { forbidden: err.message } : { error: err.message };
  }
}

export async function load() {
  setTitle('Recordings');
  return read();
}

// Each row's first control (focus goes there when the row above it goes).
const FIRST = {
  'rec-now': (r) => `stop:${r.id}`,
  'rec-scheduled': (r) => `cancel:${r.id}`,
  'rec-done': (r) => (r.itemId ? `play:${r.id}` : `delete:${r.id}`),
  'rec-failed': (r) => (r.canRetry && !r.saving ? `retry:${r.id}` : r.saving ? null : `remove:${r.id}`),
  'rec-rules': (r) => `chan:${r.id}`,
};
const LIST = { 'rec-now': 'recording', 'rec-scheduled': 'scheduled', 'rec-done': 'done', 'rec-failed': 'failed', 'rec-rules': 'rules' };

export function Screen({ data: first, view }) {
  const [page, setPage] = useState(first); // { data } | { forbidden } | { error }
  const [asking, setAsking] = useState(null); // the row whose Delete question is open
  const body = useRef(null);
  const latest = useRef(page);
  latest.current = page;
  const askingRef = useRef(asking);
  askingRef.current = asking;
  const focusWant = useRef(null); // a control's data-key to focus once the next draw is on the page
  const [drawn, setDrawn] = useState(0); // bumped by each re-read, so the focus is placed after its draw
  const alive = useRef(true);
  const saving = useRef(new Set()); // Try again's polling timeouts

  /** The focused control's key, so a re-read puts focus back where it was. */
  const focusKey = () => document.activeElement?.closest?.('.recordings-view') && document.activeElement.dataset.key;
  const byKey = (key) => body.current?.querySelector(`[data-key="${CSS.escape(key)}"]`);

  /** Read the list again and draw it; focus `focus` after. A failed re-read keeps the list (the next one tries again). */
  async function reload({ focus = focusKey() } = {}) {
    const next = await read();
    if (!alive.current) return false;
    if (next.forbidden != null) {
      setPage(next);
      return false;
    }
    if (next.error != null) {
      if (latest.current.data) return true;
      setPage(next);
      return false;
    }
    focusWant.current = focus || null;
    setAsking(null); // a redraw closes the question, as the page drawn again would
    setPage(next);
    setDrawn((n) => n + 1);
    return true;
  }

  useLayoutEffect(() => {
    view?.classList.add('recordings-view');
    return () => {
      alive.current = false;
      for (const t of saving.current) clearTimeout(t);
      saving.current.clear();
    };
  }, []);

  // The 15-s re-read: not for Kids, not while a Delete question is open, not while the page is hidden.
  const forbidden = page.forbidden != null;
  useLayoutEffect(() => {
    if (forbidden) return;
    const timer = setInterval(() => askingRef.current == null && !document.hidden && reload(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [forbidden]);

  useLayoutEffect(() => {
    const key = focusWant.current;
    focusWant.current = null;
    if (key) byKey(key)?.focus();
  }, [drawn]);

  /** After Try again: read again every 2 s until the row has saved (Done) or failed again, and say which. */
  function watchSaving(r) {
    const later = (fn) => {
      const t = setTimeout(() => (saving.current.delete(t), fn()), 2000);
      saving.current.add(t);
    };
    const step = async () => {
      if (!alive.current) return;
      let data;
      try {
        data = await recordingsList();
      } catch {
        return void later(step);
      }
      if (!alive.current) return;
      if (data.failed.some((x) => x.id === r.id && x.saving)) return void later(step);
      const done = data.done.some((x) => x.id === r.id);
      if (!done && !data.failed.some((x) => x.id === r.id)) return void reload(); // it went (removed elsewhere): nothing to say
      const focus = focusKey();
      await reload({ focus: focus && byKey(focus) ? focus : done ? 'h:rec-done' : `retry:${r.id}` });
      if (!alive.current) return;
      if (done) said(`Saved ${r.title}`);
      else said(data.failed.find((x) => x.id === r.id)?.error || `Couldn't save ${r.title}`, 'error');
    };
    later(step);
  }

  /** After a row goes: the next row's first control in its own section, else the previous row's, else the heading. */
  const nextFocus = (id, section) => nextFocusKey((latest.current.data?.[LIST[section]] || []).map((r) => ({ id: r.id, firstKey: FIRST[section](r) })), id, section);

  const ctx = { reload, nextFocus, watchSaving, body, asking, setAsking, byKey };
  const head = html`<header class="page-head"><h1>Recordings</h1><div class="actions"><${Button} label="Guide" icon="guide" variant="ghost" href="#/live/guide" /></div></header>`;
  let content;
  if (forbidden) content = html`<${EmptyState} title=${page.forbidden} text="" icon="live" />`;
  else if (page.error != null) content = html`<${EmptyState} title="Couldn't load the recordings" text=${page.error} icon="live" />`;
  else {
    const d = page.data;
    content = [
      html`<${Section} key="rec-now" cls="rec-now" title="Recording now" rows=${d.recording} empty="Nothing is recording." Row=${NowRow} ctx=${ctx} />`,
      html`<${Section} key="rec-scheduled" cls="rec-scheduled" title="Scheduled" rows=${d.scheduled} empty="Nothing is scheduled. Choose Record on a programme in the guide." Row=${ScheduledRow} ctx=${ctx} />`,
      html`<${Section} key="rec-done" cls="rec-done" title="Done" rows=${d.done} empty="No recordings yet." Row=${DoneRow} ctx=${ctx} />`,
      html`<${Section} key="rec-failed" cls="rec-failed" title="Failed" rows=${d.failed} empty="Nothing failed." Row=${FailedRow} ctx=${ctx} />`,
      html`<${Section} key="rec-rules" cls="rec-rules" title="Series rules" rows=${d.rules} empty="No series are recorded. Choose Record series on a programme in the guide." Row=${RuleRow} ctx=${ctx} />`,
    ];
  }
  return html`${head}<div class="stack" ref=${body}>${content}</div>`;
}

function Section({ cls, title, rows, empty, Row, ctx }) {
  return html`<section class=${`panel rec-section ${cls}`}>
    <h2 tabindex="-1" data-key=${`h:${cls}`}>${`${title} (${rows.length})`}</h2>
    ${rows.length ? html`<ul class="rec-list" role="list">${rows.map((r) => html`<${Row} key=${r.id} r=${r} ctx=${ctx} />`)}</ul>` : html`<p class="muted">${empty}</p>`}
  </section>`;
}

/** A row's button: its visible word, and a name that says which recording ("Cancel Seven Sharp, Mon 12, 7:00 PM"). */
function Act({ label, name, k, fn, variant = 'secondary', ctx }) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const onClick = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    let failed = false;
    try {
      await fn();
    } catch (err) {
      failed = true;
      toast(err.message, { type: 'error', timeout: 9000 }); // an error toast is spoken by the alert region
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    // Disabling it while it waited took the focus away; a re-read meanwhile may have drawn the row again, so the
    // same button by its key (else a heading). Once it is enabled again (the next draw).
    if (failed) {
      requestAnimationFrame(() => (ctx.byKey(k) || ctx.body.current?.querySelector('.rec-failed h2, .rec-section h2'))?.focus());
    }
  };
  return html`<${Button} label=${label} variant=${variant} onClick=${onClick} attrs=${{ class: `btn btn-${variant}`, 'data-key': k, 'aria-label': name, disabled: busy }} />`;
}

function Row({ r, extra, actions, rule = false }) {
  return html`<li class=${rule ? 'rec-row rec-rule' : 'rec-row'} data-id=${r.id}>
    <div class="rec-main">
      <strong class="rec-title">${r.title}${r.status === 'recording' ? html`<${RecDot} p=${{ recording: 'recording' }} />` : null}</strong>
      ${extra.filter(Boolean).map((t) => (typeof t === 'string' ? html`<span class="muted small">${t}</span>` : t))}
    </div>
    <div class="rec-actions actions">${actions}</div>
  </li>`;
}

function NowRow({ r, ctx }) {
  return html`<${Row}
    r=${r}
    extra=${[episodeLine(r) || null, `${r.channel} · until ${clockTime(r.end + r.post * MIN)} · Scheduled by ${r.profile}`]}
    actions=${html`<${Act}
      label="Stop"
      name=${`Stop recording ${r.title}`}
      k=${`stop:${r.id}`}
      ctx=${ctx}
      fn=${async () => {
        const res = await stopRecording(r.id);
        said(res?.status === 'failed' ? `Nothing was recorded of ${r.title}` : `Stopped recording ${r.title}`);
        await ctx.reload({ focus: 'h:rec-done' });
      }}
    />`}
  />`;
}

function ScheduledRow({ r, ctx }) {
  const clash = r.clash ? html`<span class="rec-clash small"><${Icon} name="info" size=${16} />${r.clash}</span>` : null;
  return html`<${Row}
    r=${r}
    extra=${[episodeLine(r) || null, `${dayTime(r.start)} · ${r.channel} · Scheduled by ${r.profile}`, clash]}
    actions=${html`<${Act}
      label="Cancel"
      name=${`Cancel ${r.title}, ${dayTime(r.start)}, ${r.channel}`}
      k=${`cancel:${r.id}`}
      ctx=${ctx}
      fn=${async () => {
        await cancelRecording(r.id);
        said(`Cancelled ${r.title}`);
        await ctx.reload({ focus: ctx.nextFocus(r.id, 'rec-scheduled') });
      }}
    />`}
  />`;
}

function DoneRow({ r, ctx }) {
  const gap = gapText(r);
  const when = episodeLine(r) || dayTime(r.start);
  const play = r.itemId
    ? html`<${Button} label="Play" icon="play" variant="primary" href=${`#/item/${r.itemId}`} attrs=${{ 'data-key': `play:${r.id}`, 'aria-label': `Play ${r.title}, ${when}` }} />`
    : html`<span class="muted small">Adding to the library…</span>`;
  const actions =
    ctx.asking === r.id
      ? html`<${DeleteQuestion} r=${r} ctx=${ctx} />`
      : [play, html`<${Act} label="Delete" name=${`Delete ${r.title}, ${when}`} k=${`delete:${r.id}`} variant="ghost" ctx=${ctx} fn=${() => ctx.setAsking(r.id)} />`];
  return html`<${Row} r=${r} extra=${[episodeLine(r) || dayTime(r.start), r.channel, gap ? html`<span class="rec-warn small">${gap}</span>` : null, r.error ? html`<span class="rec-warn small">${r.error}</span>` : null]} actions=${actions} />`;
}

/** Delete asks in the row (no browser dialogs): "Delete <title>? The file is removed." One question at a time. */
function DeleteQuestion({ r, ctx }) {
  const no = useRef(null);
  const [busy, setBusy] = useState(false);
  useLayoutEffect(() => {
    no.current?.focus();
  }, []);
  const close = () => {
    ctx.setAsking(null);
    requestAnimationFrame(() => ctx.byKey(`delete:${r.id}`)?.focus());
  };
  const yes = async () => {
    setBusy(true);
    const focus = afterDeleteFocus(ctx.nextFocus(r.id, 'rec-done'), r.id);
    try {
      await cancelRecording(r.id);
      said(`Deleted ${r.title}`);
      await ctx.reload({ focus });
    } catch (err) {
      setBusy(false);
      toast(err.message, { type: 'error', timeout: 9000 });
    }
  };
  // Esc, or the remote's Back: the question goes, the page stays.
  const onKeyDown = (e) => {
    if (!['Escape', 'BrowserBack', 'GoBack', 'Backspace'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const askId = `rec-ask-${r.id}`;
  return html`<div class="rec-confirm" role="group" aria-label="Delete this recording?" aria-describedby=${askId} onKeyDown=${onKeyDown}>
    <p id=${askId}>${`Delete ${r.title}? The file is removed.`}</p>
    <div class="actions">
      <button ref=${no} type="button" class="btn btn-secondary" onClick=${close}>Cancel</button>
      <button type="button" class="btn btn-danger" disabled=${busy} onClick=${yes}>Delete</button>
    </div>
  </div>`;
}

function FailedRow({ r, ctx }) {
  return html`<${Row}
    r=${r}
    extra=${[`${dayTime(r.start)} · ${r.channel}`, r.saving ? html`<span class="muted small rec-saving">Saving…</span>` : html`<span class="rec-warn small">${r.error || 'It failed'}</span>`]}
    actions=${[
      // Its pieces are still there (the join failed): join them again. Atomix answers at once; the page reads again
      // until the join has saved or failed.
      r.canRetry && !r.saving
        ? html`<${Act}
            label="Try again"
            name=${`Try saving ${r.title}, ${dayTime(r.start)}, again`}
            k=${`retry:${r.id}`}
            ctx=${ctx}
            fn=${async () => {
              await retryRecording(r.id);
              said(`Saving ${r.title}…`);
              await ctx.reload({ focus: 'h:rec-failed' }); // its row now says "Saving…" (no buttons until it's done)
              ctx.watchSaving(r);
            }}
          />`
        : null,
      r.saving
        ? null
        : html`<${Act}
            label="Remove"
            name=${`Remove ${r.title}, ${dayTime(r.start)}, from the list`}
            k=${`remove:${r.id}`}
            variant="ghost"
            ctx=${ctx}
            fn=${async () => {
              await cancelRecording(r.id);
              said('Removed');
              await ctx.reload({ focus: ctx.nextFocus(r.id, 'rec-failed') });
            }}
          />`,
    ]}
  />`;
}

async function saveRule(rule, fields) {
  try {
    await updateRule(rule.id, fields);
    said('Saved');
  } catch (err) {
    toast(err.message, { type: 'error', timeout: 9000 });
  }
}

function RuleRow({ r: rule, ctx }) {
  const opts = html`<div class="rec-rule-opts">
    <select name="channel" aria-label=${`Record ${rule.title} on`} data-key=${`chan:${rule.id}`} onChange=${(e) => saveRule(rule, { channelKey: e.target.value || null })}>
      <option value="" selected=${!rule.channelKey}>Any channel</option>
      ${(rule.channelOptions || []).map((c) => html`<option value=${c.key} selected=${c.key === rule.channelKey}>${c.name}</option>`)}
    </select>
    <select aria-label=${`Keep for ${rule.title}`} data-key=${`keep:${rule.id}`} onChange=${(e) => saveRule(rule, { keep: Number(e.target.value) })}>
      ${[['0', 'Keep all episodes'], ['5', 'Keep the last 5'], ['10', 'Keep the last 10']].map(([v, l]) => html`<option value=${v} selected=${String(rule.keep) === v}>${l}</option>`)}
    </select>
    <label class="check"><input type="checkbox" checked=${Boolean(rule.newOnly)} aria-label=${`New episodes only, ${rule.title}`} data-key=${`new:${rule.id}`} onChange=${(e) => saveRule(rule, { newOnly: e.target.checked })} /><span>New episodes only</span></label>
  </div>`;
  return html`<${Row}
    r=${rule}
    rule=${true}
    extra=${[`${rule.channel ? `This channel: ${rule.channel}` : 'Any channel'} · ${rule.upcoming} upcoming · Set up by ${rule.profile}`, opts]}
    actions=${html`<${Act}
      label="Stop series"
      name=${`Stop series ${rule.title}`}
      k=${`stopseries:${rule.id}`}
      variant="ghost"
      ctx=${ctx}
      fn=${async () => {
        await stopSeries(rule.id);
        said(`Stopped recording ${rule.title}`);
        await ctx.reload({ focus: ctx.nextFocus(rule.id, 'rec-rules') });
      }}
    />`}
  />`;
}
