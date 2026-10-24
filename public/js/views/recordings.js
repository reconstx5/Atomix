// Live TV → Recordings: what's recording now (Stop), what's scheduled (with clash marks), what's done (Play, Delete),
// what failed (and why), and the series rules (keep, new episodes only, Stop series). Everyone's recordings, each
// named by the profile that scheduled it. Kids profiles can't record and see only that sentence.
import { h, clear, icon } from '../dom.js';
import { button, emptyState, toast, announce } from '../components.js';
import { setTitle } from '../app.js';
import { recordingsList, stopRecording, cancelRecording, retryRecording, updateRule, stopSeries, clockTime } from '../live.js';
import { recDot } from '../live-bits.js';

const REFRESH_MS = 15_000;
const MIN = 60_000;

const dayTime = (ms) => `${new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${clockTime(ms)}`;
const episodeLine = (r) => [r.season != null && r.episode != null ? `S${r.season} E${r.episode}` : null, r.episodeTitle].filter(Boolean).join(' · ');
const said = (text, type = 'success') => (toast(text, { type }), announce(text));

export async function render(el) {
  setTitle('Recordings');
  el.classList.add('recordings-view');
  const body = h('div', { class: 'stack' });
  el.append(h('header', { class: 'page-head' }, h('h1', {}, 'Recordings'), h('div', { class: 'actions' }, button('Guide', { icon: 'guide', variant: 'ghost', href: '#/live/guide' }))), body);

  // A Delete question is open: the 15-s re-read waits (read from the page, so a re-render can't leave it stuck).
  const confirming = () => Boolean(body.querySelector('.rec-confirm'));
  let timer = null;

  /** The focused control's key, so a re-read puts focus back where it was. */
  const focusKey = () => document.activeElement?.closest?.('.recordings-view') && document.activeElement.dataset.key;

  let shown = false; // the page has a list on it: a failed re-read keeps it (the next one tries again)
  let forbidden = false; // a Kids profile: the sentence, nothing to re-read
  async function load({ focus = focusKey() } = {}) {
    let data;
    try {
      data = await recordingsList();
    } catch (err) {
      if (err.status === 403) {
        forbidden = true;
        clear(body).append(emptyState({ title: err.message, text: '', icon: 'live' }));
        clearInterval(timer);
        return false;
      }
      if (!shown) clear(body).append(emptyState({ title: "Couldn't load the recordings", text: err.message, icon: 'live' }));
      return shown;
    }
    shown = true;
    clear(body).append(
      section('rec-now', 'Recording now', data.recording, 'Nothing is recording.', nowRow),
      section('rec-scheduled', 'Scheduled', data.scheduled, 'Nothing is scheduled. Choose Record on a programme in the guide.', scheduledRow),
      section('rec-done', 'Done', data.done, 'No recordings yet.', doneRow),
      section('rec-failed', 'Failed', data.failed, 'Nothing failed.', failedRow),
      section('rec-rules', 'Series rules', data.rules, 'No series are recorded. Choose Record series on a programme in the guide.', ruleRow),
    );
    if (focus) body.querySelector(`[data-key="${CSS.escape(focus)}"]`)?.focus();
    return true;
  }

  /** After Try again: read again every 2 s until the row has saved (Done) or failed again, and say which. */
  function watchSaving(r) {
    const step = async () => {
      if (!body.isConnected) return;
      let data;
      try {
        data = await recordingsList();
      } catch {
        return void setTimeout(step, 2000);
      }
      if (data.failed.some((x) => x.id === r.id && x.saving)) return void setTimeout(step, 2000);
      const done = data.done.some((x) => x.id === r.id);
      if (!done && !data.failed.some((x) => x.id === r.id)) return void load(); // it went (removed elsewhere): nothing to say
      const focus = focusKey();
      await load({ focus: focus && body.querySelector(`[data-key="${CSS.escape(focus)}"]`) ? focus : done ? 'h:rec-done' : `retry:${r.id}` });
      if (done) said(`Saved ${r.title}`);
      else said(data.failed.find((x) => x.id === r.id)?.error || `Couldn't save ${r.title}`, 'error');
    };
    setTimeout(step, 2000);
  }

  function section(cls, title, rows, empty, rowFn) {
    return h(
      'section',
      { class: `panel rec-section ${cls}` },
      h('h2', { tabindex: -1, dataset: { key: `h:${cls}` } }, `${title} (${rows.length})`),
      rows.length ? h('ul', { class: 'rec-list', role: 'list' }, rows.map(rowFn)) : h('p', { class: 'muted' }, empty),
    );
  }

  /** A row's button: its visible word, and a name that says which recording ("Cancel Seven Sharp, Mon 12, 7:00 PM"). */
  const act = (label, name, key, fn, variant = 'secondary') =>
    button(label, {
      variant,
      attrs: { class: `btn btn-${variant}`, 'data-key': key, 'aria-label': name },
      onClick: async (e) => {
        const btn = e.currentTarget;
        if (btn.disabled) return;
        btn.disabled = true;
        let failed = false;
        try {
          await fn(btn);
        } catch (err) {
          failed = true;
          toast(err.message, { type: 'error', timeout: 9000 }); // an error toast is spoken by the alert region
        } finally {
          btn.disabled = false;
        }
        // Disabling it while it waited took the focus away; a re-read meanwhile may have drawn the row again, so the
        // same button by its key (else its section's heading).
        if (failed) {
          const again = btn.isConnected ? btn : body.querySelector(`[data-key="${CSS.escape(key)}"]`);
          (again || body.querySelector('.rec-failed h2, .rec-section h2'))?.focus();
        }
      },
    });

  const row = (r, extra, actions) =>
    h('li', { class: 'rec-row', dataset: { id: r.id } }, h('div', { class: 'rec-main' }, h('strong', { class: 'rec-title' }, r.title, r.status === 'recording' ? recDot({ recording: 'recording' }) : null), extra.filter(Boolean).map((t) => (typeof t === 'string' ? h('span', { class: 'muted small' }, t) : t))), h('div', { class: 'rec-actions actions' }, actions));

  function nowRow(r) {
    return row(r, [episodeLine(r) || null, `${r.channel} · until ${clockTime(r.end + r.post * MIN)} · Scheduled by ${r.profile}`], [
      act('Stop', `Stop recording ${r.title}`, `stop:${r.id}`, async () => {
        const res = await stopRecording(r.id);
        said(res?.status === 'failed' ? `Nothing was recorded of ${r.title}` : `Stopped recording ${r.title}`);
        await load({ focus: 'h:rec-done' });
      }),
    ]);
  }

  function scheduledRow(r) {
    return row(r, [episodeLine(r) || null, `${dayTime(r.start)} · ${r.channel} · Scheduled by ${r.profile}`, r.clash ? h('span', { class: 'rec-clash small' }, icon('info', { size: 16 }), r.clash) : null], [
      act('Cancel', `Cancel ${r.title}, ${dayTime(r.start)}, ${r.channel}`, `cancel:${r.id}`, async () => {
        await cancelRecording(r.id);
        said(`Cancelled ${r.title}`);
        await load({ focus: nextFocus(r.id, 'rec-scheduled') });
      }),
    ]);
  }

  function doneRow(r) {
    const gap = r.gapSeconds > 0 ? `Has a gap (${Math.max(1, Math.ceil(r.gapSeconds / 60))} min missing)` : null;
    const when = episodeLine(r) || dayTime(r.start);
    const play = r.itemId ? button('Play', { icon: 'play', variant: 'primary', href: `#/item/${r.itemId}`, attrs: { 'data-key': `play:${r.id}`, 'aria-label': `Play ${r.title}, ${when}` } }) : h('span', { class: 'muted small' }, 'Adding to the library…');
    const del = act('Delete', `Delete ${r.title}, ${when}`, `delete:${r.id}`, (btn) => askDelete(r, btn), 'ghost');
    return row(r, [episodeLine(r) || dayTime(r.start), r.channel, gap ? h('span', { class: 'rec-warn small' }, gap) : null, r.error ? h('span', { class: 'rec-warn small' }, r.error) : null], [play, del]);
  }

  function failedRow(r) {
    return row(r, [`${dayTime(r.start)} · ${r.channel}`, r.saving ? h('span', { class: 'muted small rec-saving' }, 'Saving…') : h('span', { class: 'rec-warn small' }, r.error || 'It failed')], [
      // Its pieces are still there (the join failed): join them again. Atomix answers at once; the page reads again
      // until the join has saved or failed.
      r.canRetry && !r.saving
        ? act('Try again', `Try saving ${r.title}, ${dayTime(r.start)}, again`, `retry:${r.id}`, async () => {
            await retryRecording(r.id);
            said(`Saving ${r.title}…`);
            await load({ focus: `h:rec-failed` }); // its row now says "Saving…" (no buttons until it's done)
            watchSaving(r);
          })
        : null,
      r.saving ? null : act('Remove', `Remove ${r.title}, ${dayTime(r.start)}, from the list`, `remove:${r.id}`, async () => {
        await cancelRecording(r.id);
        said('Removed');
        await load({ focus: nextFocus(r.id, 'rec-failed') });
      }, 'ghost'),
    ]);
  }

  function ruleRow(rule) {
    const keep = h(
      'select',
      { 'aria-label': `Keep for ${rule.title}`, dataset: { key: `keep:${rule.id}` }, onChange: (e) => saveRule(rule, { keep: Number(e.target.value) }) },
      [['0', 'Keep all episodes'], ['5', 'Keep the last 5'], ['10', 'Keep the last 10']].map(([v, l]) => h('option', { value: v, selected: String(rule.keep) === v || null }, l)),
    );
    const newOnly = h('input', { type: 'checkbox', checked: rule.newOnly || null, 'aria-label': `New episodes only, ${rule.title}`, dataset: { key: `new:${rule.id}` }, onChange: (e) => saveRule(rule, { newOnly: e.target.checked }) });
    const where = h(
      'select',
      { name: 'channel', 'aria-label': `Record ${rule.title} on`, dataset: { key: `chan:${rule.id}` }, onChange: (e) => saveRule(rule, { channelKey: e.target.value || null }) },
      h('option', { value: '', selected: !rule.channelKey || null }, 'Any channel'),
      (rule.channelOptions || []).map((c) => h('option', { value: c.key, selected: c.key === rule.channelKey || null }, c.name)),
    );
    const li = row(
      rule,
      [`${rule.channel ? `This channel: ${rule.channel}` : 'Any channel'} · ${rule.upcoming} upcoming · Set up by ${rule.profile}`, h('div', { class: 'rec-rule-opts' }, where, keep, h('label', { class: 'check' }, newOnly, h('span', {}, 'New episodes only')))],
      [
        act('Stop series', `Stop series ${rule.title}`, `stopseries:${rule.id}`, async () => {
          await stopSeries(rule.id);
          said(`Stopped recording ${rule.title}`);
          await load({ focus: nextFocus(rule.id, 'rec-rules') });
        }, 'ghost'),
      ],
    );
    li.classList.add('rec-rule');
    return li;
  }

  async function saveRule(rule, fields) {
    try {
      await updateRule(rule.id, fields);
      said('Saved');
    } catch (err) {
      toast(err.message, { type: 'error', timeout: 9000 });
    }
  }

  /** After a row goes: the next row's first control in its own section, else the previous row's, else the section's
   *  heading (a rule and a recording can have the same number). */
  function nextFocus(id, section) {
    const li = body.querySelector(`.${section} .rec-row[data-id="${id}"]`);
    const sib = li?.nextElementSibling || li?.previousElementSibling;
    return sib?.querySelector('[data-key]')?.dataset.key || `h:${section}`;
  }

  /** Delete asks in the page (no browser dialogs): "Delete <title>? The file is removed." */
  function askDelete(r, btn) {
    const actions = btn.closest('.rec-actions');
    const kept = [...actions.childNodes];
    body.querySelector('.rec-confirm')?.dispatchEvent(new CustomEvent('rec-close')); // one question at a time
    const done = () => actions.replaceChildren(...kept);
    const no = h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => (done(), actions.querySelector(`[data-key="delete:${r.id}"]`)?.focus()) }, 'Cancel');
    const yes = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-danger',
        onClick: async () => {
          yes.disabled = true;
          const focus = nextFocus(r.id, 'rec-done');
          try {
            await cancelRecording(r.id);
            said(`Deleted ${r.title}`);
            await load({ focus: focus.startsWith(`play:${r.id}`) || focus.startsWith(`delete:${r.id}`) ? 'h:rec-done' : focus });
          } catch (err) {
            yes.disabled = false;
            toast(err.message, { type: 'error', timeout: 9000 });
          }
        },
      },
      'Delete',
    );
    const askId = `rec-ask-${r.id}`;
    const box = h('div', { class: 'rec-confirm', role: 'group', 'aria-label': 'Delete this recording?', 'aria-describedby': askId }, h('p', { id: askId }, `Delete ${r.title}? The file is removed.`), h('div', { class: 'actions' }, no, yes));
    box.addEventListener('rec-close', done);
    box.addEventListener('keydown', (e) => {
      // Esc, or the remote's Back: the question goes, the page stays.
      if (['Escape', 'BrowserBack', 'GoBack', 'Backspace'].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        no.click();
      }
    });
    actions.replaceChildren(box);
    no.focus();
  }

  await load();
  if (forbidden) return;
  timer = setInterval(() => !confirming() && !document.hidden && load(), REFRESH_MS);
  return () => clearInterval(timer);
}
