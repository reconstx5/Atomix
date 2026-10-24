// The smart playlist builder: #/lists/smart/new and #/lists/<id>/rules. A name, songs or videos, rules matched all
// or any (field, condition, value), a sort and a limit. The fields and their conditions come from the server
// (/api/smart/fields), so the builder offers exactly what the server checks. A refused save shows the server's
// sentence in the form and puts the remote in the rule it names.
import { h, clear } from '../dom.js';
import { api } from '../api.js';
import { navigate, setTitle } from '../app.js';
import { button, field, rovingRadios } from '../components.js';

const OP_LABELS = {
  is: 'is',
  isNot: 'is not',
  contains: 'contains',
  gte: 'is at least',
  lte: 'is at most',
  between: 'is between',
  inLast: 'is in the last',
  notInLast: 'is not in the last',
  set: 'is set',
  notSet: 'is not set',
};
const SORT_LABELS = { random: 'Random', added: 'Recently added', stars: 'Stars', mostPlayed: 'Most played', lastPlayed: 'Last played', title: 'Title', year: 'Year' };
const UNITS = { length: 'minutes', stars: 'stars (1–5)' };

export async function render(el, params) {
  const editing = Boolean(params.id);
  const [vocab, list] = await Promise.all([api.get('/api/smart/fields'), editing ? api.get(`/api/lists/${params.id}`) : null]);
  if (list && (list.kind !== 'smart' || !list.own)) return navigate(`#/lists/${list.id}`, { replace: true });
  const title = editing ? `Edit ${list.name}` : 'New smart playlist';
  setTitle(title);
  el.classList.add('smart-view');

  const saved = list?.rules || { match: 'all', rules: [], sort: 'random', limit: {} };
  const state = { media: list?.media || 'video', rows: saved.rules.map((r) => ({ ...r })) };
  const fieldsOf = () => vocab[state.media];
  const fieldDef = (key) => fieldsOf().find((f) => f.key === key);

  const name = h('input', { type: 'text', name: 'name', maxlength: '80', required: true, autocomplete: 'off', value: list?.name || '' });
  const mediaRadios = [['video', 'Videos'], ['music', 'Songs']].map(([value, label]) =>
    h('button', { type: 'button', role: 'radio', class: 'chip-radio', dataset: { value }, 'aria-checked': String(state.media === value), onClick: () => setMedia(value) }, label),
  );
  const mediaGroup = rovingRadios(h('div', { role: 'radiogroup', class: 'smart-media', 'aria-label': 'This playlist is for' }, mediaRadios));
  const match = h('select', { name: 'match', 'aria-label': 'Match' }, h('option', { value: 'all' }, 'Match all of these rules'), h('option', { value: 'any' }, 'Match any of these rules'));
  match.value = saved.match;
  const rulesEl = h('div', { class: 'rule-list' });
  const addBtn = button('Add rule', { icon: 'plus', variant: 'secondary', attrs: { class: 'btn btn-secondary rule-add' }, onClick: () => addRule() });
  const sort = h('select', { name: 'sort', 'aria-label': 'Sort by' }, vocab.sorts.map((s) => h('option', { value: s }, SORT_LABELS[s] || s)));
  sort.value = saved.sort;
  const limitKind = h('select', { name: 'limit', 'aria-label': 'Limit' }, h('option', { value: 'none' }, 'No limit'), h('option', { value: 'items' }, 'Number of items'), h('option', { value: 'minutes' }, 'Minutes'));
  limitKind.value = saved.limit.items ? 'items' : saved.limit.minutes ? 'minutes' : 'none';
  const limitValue = h('input', { type: 'number', name: 'limitValue', min: '1', max: '10000', step: '1', inputmode: 'numeric', 'aria-label': 'Limit amount', value: String(saved.limit.items || saved.limit.minutes || '') });
  const showLimit = () => (limitValue.hidden = limitKind.value === 'none');
  limitKind.addEventListener('change', showLimit);
  showLimit();
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });

  /** One rule row: field, condition, value(s) and Remove. Redrawn when its field or condition changes. */
  function ruleRow(rule, i) {
    const n = i + 1;
    const def = fieldDef(rule.field) || fieldsOf()[0];
    if (!def.ops.includes(rule.op)) rule.op = def.ops[0];
    const fieldSel = h('select', { class: 'rule-field', 'aria-label': `Rule ${n}: field` }, fieldsOf().map((f) => h('option', { value: f.key }, f.label[0].toUpperCase() + f.label.slice(1))));
    fieldSel.value = def.key;
    fieldSel.addEventListener('change', () => {
      rule.field = fieldSel.value;
      rule.op = fieldDef(rule.field).ops[0];
      rule.value = undefined;
      redraw({ focus: [i, 'rule-field'] });
    });
    const opSel = h('select', { class: 'rule-op', 'aria-label': `Rule ${n}: condition` }, def.ops.map((o) => h('option', { value: o }, OP_LABELS[o] || o)));
    opSel.value = rule.op;
    opSel.addEventListener('change', () => {
      const was = rule.op;
      rule.op = opSel.value;
      if ((was === 'between') !== (rule.op === 'between')) rule.value = undefined; // one value ↔ two
      redraw({ focus: [i, 'rule-op'] });
    });
    const values = valueInputs(rule, def, n);
    const remove = h('button', { type: 'button', class: 'btn btn-ghost rule-remove', 'aria-label': `Remove rule ${n}` }, 'Remove rule');
    remove.addEventListener('click', () => {
      state.rows.splice(i, 1);
      redraw({ focus: state.rows.length ? [Math.min(i, state.rows.length - 1), 'rule-field'] : 'add' });
    });
    return h('div', { class: 'rule-row', role: 'group', 'aria-label': `Rule ${n}` }, fieldSel, opSel, values, remove);
  }

  /** The value control(s) a field and condition take; each writes into `rule.value` as it changes. */
  function valueInputs(rule, def, n) {
    const op = rule.op;
    if (op === 'set' || op === 'notSet') return null;
    const label = `Rule ${n}: value`;
    if (def.type === 'bool' || def.type === 'kind') {
      const opts = def.type === 'bool' ? [['true', 'Yes'], ['false', 'No']] : [['movie', 'Film'], ['episode', 'Episode']];
      const sel = h('select', { class: 'rule-value', 'aria-label': label }, opts.map(([v, l]) => h('option', { value: v }, l)));
      if (rule.value === undefined) rule.value = def.type === 'bool' ? true : 'movie';
      sel.value = String(rule.value);
      sel.addEventListener('change', () => (rule.value = def.type === 'bool' ? sel.value === 'true' : sel.value));
      return sel;
    }
    const numeric = def.type !== 'text' && def.type !== 'genres';
    const unit = def.type === 'date' ? 'days' : UNITS[def.key] || null;
    const input = (val, aria, onInput) => {
      const el = h('input', numeric ? { type: 'number', class: 'rule-value', step: def.key === 'length' ? '0.5' : '1', inputmode: 'decimal', 'aria-label': aria } : { type: 'text', class: 'rule-value', maxlength: '200', autocomplete: 'off', 'aria-label': aria });
      el.value = val ?? '';
      el.addEventListener('input', () => onInput(el.value));
      return el;
    };
    const asValue = (v) => (numeric ? (v.trim() === '' ? '' : Number(v)) : v);
    if (op === 'between') {
      const pair = Array.isArray(rule.value) ? rule.value : [];
      rule.value = pair;
      return h(
        'span',
        { class: 'rule-values' },
        input(pair[0], `Rule ${n}: from`, (v) => (pair[0] = asValue(v))),
        h('span', { class: 'muted' }, 'and'),
        input(pair[1], `Rule ${n}: to`, (v) => (pair[1] = asValue(v))),
        unit ? h('span', { class: 'muted' }, unit) : null,
      );
    }
    const one = input(Array.isArray(rule.value) ? '' : rule.value, label, (v) => (rule.value = asValue(v)));
    return unit ? h('span', { class: 'rule-values' }, one, h('span', { class: 'muted' }, unit)) : one;
  }

  /** Redraw the rules; `focus` is [rowIndex, className] or 'add'. */
  function redraw({ focus = null } = {}) {
    clear(rulesEl).append(...state.rows.map(ruleRow));
    if (!state.rows.length) rulesEl.append(h('p', { class: 'muted rule-none' }, state.media === 'music' ? 'No rules: every song.' : 'No rules: every film and episode.'));
    if (focus === 'add') addBtn.focus();
    else if (focus) rulesEl.querySelectorAll('.rule-row')[focus[0]]?.querySelector(`.${focus[1]}`)?.focus();
  }

  function addRule() {
    state.rows.push({ field: 'genre', op: 'is', value: undefined });
    redraw({ focus: [state.rows.length - 1, 'rule-field'] });
  }

  function setMedia(media) {
    if (media === state.media) return;
    state.media = media;
    for (const r of mediaRadios) r.setAttribute('aria-checked', String(r.dataset.value === media));
    // Rules on a field the other media doesn't have start again from genre.
    for (const r of state.rows) if (!fieldDef(r.field)) Object.assign(r, { field: 'genre', op: 'is', value: undefined });
    redraw();
  }

  async function save() {
    error.hidden = true;
    const rules = state.rows.map((r) => (r.op === 'set' || r.op === 'notSet' ? { field: r.field, op: r.op } : { field: r.field, op: r.op, value: r.value === undefined ? '' : r.value }));
    const lim = limitKind.value === 'none' ? {} : { [limitKind.value]: limitValue.value === '' ? 0 : Number(limitValue.value) };
    const body = { name: name.value, media: state.media, rules: { match: match.value, rules, sort: sort.value, limit: lim } };
    try {
      const out = editing ? await api.patch(`/api/lists/${list.id}`, body) : await api.post('/api/lists', { kind: 'smart', ...body });
      navigate(`#/lists/${out.id}`, { replace: editing });
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      const n = /^Rule (\d+):/.exec(err.message)?.[1];
      if (n) rulesEl.querySelectorAll('.rule-row')[Number(n) - 1]?.querySelector('select, input')?.focus();
      else if (/name/i.test(err.message)) name.focus();
      else if (/limit/i.test(err.message)) limitValue.focus();
    }
  }

  const form = h(
    'form',
    { class: 'smart-form panel', novalidate: true, onSubmit: (e) => (e.preventDefault(), save()) },
    error,
    field('Name', name),
    h('div', { class: 'field' }, h('span', { class: 'field-label', 'aria-hidden': 'true' }, 'For'), mediaGroup),
    match,
    rulesEl,
    h('div', { class: 'actions' }, addBtn),
    h('div', { class: 'smart-order' }, field('Sort by', sort), h('div', { class: 'field' }, h('span', { class: 'field-label', 'aria-hidden': 'true' }, 'Limit'), h('div', { class: 'smart-limit' }, limitKind, limitValue))),
    h(
      'div',
      { class: 'actions smart-actions' },
      button('Save', { variant: 'primary', type: 'submit', attrs: { class: 'btn btn-primary smart-save' } }),
      button('Cancel', { variant: 'ghost', onClick: () => navigate(editing ? `#/lists/${list.id}` : '#/lists', { replace: true }) }),
    ),
  );
  el.append(h('header', { class: 'page-head' }, h('h1', {}, title)), form);
  redraw();
  if (!editing) name.focus();
}
