// The Live TV guide's rules (public/js/guide-rules.js): the window, days, ruler, now line, cells in the window, the one
// tab stop, where an arrow goes (and when it moves the window), which guide requests are still needed, groups, how
// many rows ?channel= needs, the spoken channel words and the phone list's last-pick guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN, HOUR, DAY, SPAN, STEP, PAGE, windowStart, dayStart, dayOptions, maxCatchupDays, rulerTicks, nowLine, pct, cellsInWindow, tabStop, cellAt, arrowMove, guideRequests, groupOptions, channelsForGroup, initialRows, encWords, latest } from '../public/js/guide-rules.js';

const T = Date.parse('2026-11-11T19:10:00+13:00');
const from = Date.parse('2026-11-11T18:30:00+13:00');

test('constants: 2½ hours in view, 2-hour steps, 50 rows a page', () => {
  assert.equal(MIN, 60_000);
  assert.equal(HOUR, 3_600_000);
  assert.equal(DAY, 86_400_000);
  assert.equal(SPAN, 2.5 * HOUR);
  assert.equal(STEP, 2 * HOUR);
  assert.equal(PAGE, 50);
});

test('windowStart: the half hour at or before now, minus 30 minutes', () => {
  assert.equal(windowStart(T), from);
  assert.equal(windowStart(Date.parse('2026-11-11T19:00:00+13:00')), from);
  assert.equal(windowStart(Date.parse('2026-11-11T19:29:59+13:00')), from);
});

test('dayStart: local midnight', () => {
  assert.equal(dayStart(T), new Date(2026, 10, 11).getTime());
});

test('dayOptions: from maxDays back to 7 on, Today/Yesterday/Tomorrow, else the date', () => {
  const o = dayOptions(T, 3, 'long');
  assert.equal(o.length, 11);
  const today = new Date(2026, 10, 11).getTime();
  assert.deepEqual(o[3], { value: String(today), label: 'Today' });
  assert.deepEqual(o[2], { value: String(today - DAY), label: 'Yesterday' });
  assert.deepEqual(o[4], { value: String(today + DAY), label: 'Tomorrow' });
  assert.equal(o[0].label, new Date(today - 3 * DAY).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' }));
  assert.equal(o[10].label, new Date(today + 7 * DAY).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' }));
  assert.equal(dayOptions(T, 1, 'short')[8].label, new Date(today + 7 * DAY).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }));
});

test('maxCatchupDays: the longest catch-up, at least 1', () => {
  assert.equal(maxCatchupDays([]), 1);
  assert.equal(maxCatchupDays([{ catchupDays: 0 }, {}]), 1);
  assert.equal(maxCatchupDays([{ catchupDays: 3 }, { catchupDays: 7 }]), 7);
});

test('rulerTicks: every 30 minutes in view', () => {
  assert.deepEqual(rulerTicks(from), [0, 1, 2, 3, 4].map((i) => from + i * 30 * MIN));
});

test('nowLine: hidden outside the window, else how far across', () => {
  assert.deepEqual(nowLine(T, from), { hidden: false, x: (40 * MIN) / SPAN });
  assert.equal(nowLine(from - 1, from).hidden, true);
  assert.equal(nowLine(from + SPAN, from).hidden, true);
  assert.equal(nowLine(from, from).hidden, false);
});

test('pct: per cent of the window, as text', () => {
  assert.equal(pct(from + HOUR, from), '40%');
  assert.equal(pct(from, from), '0%');
  assert.equal(pct(from + 30 * MIN, from), '20%');
});

test('cellsInWindow: only programmes in view, by start, cut to the window', () => {
  const a = { id: 1, start: from - HOUR, end: from + 30 * MIN };
  const b = { id: 2, start: from + 30 * MIN, end: from + HOUR };
  const c = { id: 3, start: from + 2 * HOUR, end: from + 4 * HOUR };
  const gone = { id: 4, start: from - 2 * HOUR, end: from };
  const later = { id: 5, start: from + SPAN, end: from + SPAN + HOUR };
  const cells = cellsInWindow([c, later, b, gone, a], from);
  assert.deepEqual(cells.map((x) => x.p.id), [1, 2, 3]);
  assert.deepEqual(cells.map((x) => x.left), ['0%', '20%', '80%']);
  assert.equal(cells[0].width, 'calc(20% - 4px)');
  assert.equal(cells[1].width, 'calc(20% - 4px)');
  assert.equal(cells[2].width, `calc(${((30 * MIN) / SPAN) * 100}% - 4px)`);
});

const rows = [
  { channel: 1, cells: [{ start: from, end: from + HOUR, state: 'aired' }, { start: from + HOUR, end: from + 2 * HOUR, state: 'upcoming' }] },
  { channel: 2, cells: [{ start: from, end: from + 30 * MIN, state: 'aired' }, { start: from + 30 * MIN, end: from + HOUR, state: 'now' }, { start: from + HOUR, end: from + 3 * HOUR, state: 'upcoming' }] },
  { channel: 3, cells: [{ start: from, end: from, state: null, empty: true }] },
];

test('tabStop: the first programme on now, in row order', () => {
  assert.deepEqual(tabStop(rows), { channel: 2, index: 1 });
});

test('tabStop: no programme on now: the first cell of the first row; no rows: null', () => {
  assert.deepEqual(tabStop([rows[0], rows[2]]), { channel: 1, index: 0 });
  assert.deepEqual(tabStop([rows[2]]), { channel: 3, index: 0 });
  assert.equal(tabStop([]), null);
});

test('cellAt: the cell covering the time, else the nearest start, -1 for none', () => {
  assert.equal(cellAt(rows[1].cells, from + 40 * MIN), 1);
  assert.equal(cellAt(rows[1].cells, from + 3 * HOUR + MIN), 2);
  assert.equal(cellAt(rows[1].cells, from - 10 * MIN), 0);
  assert.equal(cellAt(rows[2].cells, T), 0);
  assert.equal(cellAt([], T), -1);
});

test('arrowMove: Right and Left go to the neighbour cell, just past its start', () => {
  assert.deepEqual(arrowMove({ key: 'ArrowRight', rows, rowIndex: 1, cellIndex: 1, from, column: 123 }), { focus: { channel: 2, at: from + HOUR + 1 }, column: null });
  assert.deepEqual(arrowMove({ key: 'ArrowLeft', rows, rowIndex: 1, cellIndex: 1, from, column: null }), { focus: { channel: 2, at: from + 1 }, column: null });
});

test('arrowMove: Right at the last cell moves the window on and lands at the later of its end or the new view', () => {
  const end = from + 2 * HOUR;
  assert.deepEqual(arrowMove({ key: 'ArrowRight', rows, rowIndex: 0, cellIndex: 1, from, column: null }), { moveWindow: from + STEP, focus: { channel: 1, at: Math.max(end, from + SPAN - STEP) }, column: null });
  assert.equal(arrowMove({ key: 'ArrowRight', rows, rowIndex: 1, cellIndex: 2, from, column: null }).focus.at, from + 3 * HOUR);
});

test('arrowMove: Left at the first cell moves the window back and lands just before it', () => {
  assert.deepEqual(arrowMove({ key: 'ArrowLeft', rows, rowIndex: 0, cellIndex: 0, from, column: 5 }), { moveWindow: from - STEP, focus: { channel: 1, at: from - 1 }, column: null });
});

test('arrowMove: an empty row moves the window either way, from the window start', () => {
  assert.deepEqual(arrowMove({ key: 'ArrowLeft', rows, rowIndex: 2, cellIndex: 0, from, column: null }), { moveWindow: from - STEP, focus: { channel: 3, at: from - 1 }, column: null });
  assert.deepEqual(arrowMove({ key: 'ArrowRight', rows, rowIndex: 2, cellIndex: 0, from, column: null }), { moveWindow: from + STEP, focus: { channel: 3, at: from + SPAN - STEP }, column: null });
});

test('arrowMove: Up/Down set the column from the cell (not before the window) and keep it', () => {
  const down = arrowMove({ key: 'ArrowDown', rows, rowIndex: 0, cellIndex: 1, from, column: null });
  assert.deepEqual(down, { focus: { channel: 2, at: from + HOUR }, column: from + HOUR });
  const down2 = arrowMove({ key: 'ArrowDown', rows, rowIndex: 1, cellIndex: 2, from, column: down.column });
  assert.deepEqual(down2, { focus: { channel: 3, at: from + HOUR }, column: from + HOUR });
  const up = arrowMove({ key: 'ArrowUp', rows, rowIndex: 2, cellIndex: 0, from, column: down2.column });
  const up2 = arrowMove({ key: 'ArrowUp', rows, rowIndex: 1, cellIndex: 2, from, column: up.column });
  assert.equal(up2.focus.at, down.focus.at);
  assert.equal(up2.focus.channel, 1);
  // A programme that started before the window: the column is the window start.
  assert.equal(arrowMove({ key: 'ArrowDown', rows: [{ channel: 9, cells: [{ start: from - HOUR, end: from + HOUR }] }, rows[0]], rowIndex: 0, cellIndex: 0, from, column: null }).column, from);
});

test('arrowMove: a column outside the window is set again', () => {
  assert.equal(arrowMove({ key: 'ArrowDown', rows, rowIndex: 0, cellIndex: 1, from, column: from - MIN }).column, from + HOUR);
  assert.equal(arrowMove({ key: 'ArrowDown', rows, rowIndex: 0, cellIndex: 1, from, column: from + SPAN }).column, from + HOUR);
});

test('arrowMove: Up from the first row and Down from the last are left to the page; other keys too', () => {
  assert.equal(arrowMove({ key: 'ArrowUp', rows, rowIndex: 0, cellIndex: 0, from, column: null }), null);
  assert.equal(arrowMove({ key: 'ArrowDown', rows, rowIndex: 2, cellIndex: 0, from, column: null }), null);
  assert.equal(arrowMove({ key: 'Enter', rows, rowIndex: 1, cellIndex: 0, from, column: null }), null);
});

test('guideRequests: 200 channels and 6 hours a request, an hour either side of the window', () => {
  const ids = Array.from({ length: 450 }, (_, i) => i + 1);
  const { requests, record } = guideRequests([], ids, from);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((r) => r.ids.length), [200, 200, 50]);
  assert.deepEqual(requests.map((r) => [r.from, r.to]), [[from - HOUR, from + SPAN + HOUR], [from - HOUR, from + SPAN + HOUR], [from - HOUR, from + SPAN + HOUR]]);
  assert.equal(record.length, 3);
  assert.equal(guideRequests(record, ids, from).requests.length, 0);
});

test('guideRequests: only what is not covered; a moved window asks again', () => {
  const { record } = guideRequests([], [1, 2], from);
  assert.deepEqual(guideRequests(record, [1, 2, 3], from).requests.map((r) => r.ids), [[3]]);
  assert.equal(guideRequests(record, [1, 2], from + 30 * MIN).requests.length, 1);
  assert.deepEqual(guideRequests(record, [1, 2], from).record, record); // nothing new to note
  assert.equal(record.length, 1);
  assert.equal(guideRequests([], [], from).requests.length, 0);
});

test('guideRequests: a window longer than 6 hours is asked in 6-hour pieces', () => {
  // (The guide's window is 4½ hours with its margins; the pieces rule is the route's.)
  const { requests } = guideRequests([], [1], from);
  assert.ok(requests.every((r) => r.to - r.from <= 6 * HOUR));
});

const chans = [
  { id: 1, groups: ['News'], favourite: false },
  { id: 2, groups: ['Sport'], favourite: true },
  { id: 3, groups: ['News', 'Sport'], favourite: false },
];

test('groupOptions: All, Favourites when there are any, then the groups', () => {
  assert.deepEqual(groupOptions(chans, ['News', 'Sport']), ['All', 'Favourites', 'News', 'Sport']);
  assert.deepEqual(groupOptions(chans.map((c) => ({ ...c, favourite: false })), ['News']), ['All', 'News']);
});

test('channelsForGroup: All, Favourites, or a group', () => {
  assert.equal(channelsForGroup(chans, 'All'), chans);
  assert.deepEqual(channelsForGroup(chans, 'Favourites').map((c) => c.id), [2]);
  assert.deepEqual(channelsForGroup(chans, 'News').map((c) => c.id), [1, 3]);
});

test('initialRows: enough pages of 50 to reach ?channel=, else one page', () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ id: i + 1 }));
  assert.equal(initialRows(many, 57), 100);
  assert.equal(initialRows(many, 50), 50);
  assert.equal(initialRows(many, 101), 120);
  assert.equal(initialRows(many, null), 50);
  assert.equal(initialRows(many, 9999), 50);
  assert.equal(initialRows(many.slice(0, 60), 57), 60);
  assert.equal(initialRows([], 1), 0);
});

test("encWords: encrypted and can't play here", () => {
  assert.equal(encWords({ drm: ['widevine'] }), ', encrypted');
  assert.equal(encWords({ unplayable: true }), ", can't play here");
  assert.equal(encWords({ drm: 'clearkey', unplayable: true }), ", encrypted, can't play here");
  assert.equal(encWords({ drm: null }), '');
});

test('latest: only the newest pick stays current', () => {
  const next = latest();
  const a = next();
  assert.equal(a(), true);
  const b = next();
  assert.equal(a(), false);
  assert.equal(b(), true);
  const other = latest()();
  assert.equal(b(), true); // each guard has its own count
  assert.equal(other(), true);
});
