// A book's, a comic's or a series' page (v0.22 Plan D): the cover, who wrote it, its series, Read or "Continue ·
// Chapter 3 · 42%", Mark read, a device download, a reading list and Edit details for admins. A series lists its
// books or issues in number order, with "Continue: #13" (the first unread after the last one read).
import { api } from '../api.js';
import { h } from '../dom.js';
import { art, button, toast, moreButton, grid, emptyState } from '../components.js';
import { setTitle, refreshView, canAdmin, isKidsProfile } from '../app.js';
import { setBackdrop } from '../backdrop.js';
import { addToPlaylistItems } from '../lists.js';
import { downloadSheetItem } from '../offline/ui.js';

const issueLabel = (i) => (i.issue ? `#${i.issue}` : i.title);
const isRead = (i) => Boolean(i.progress?.watched);
const started = (i) => !isRead(i) && i.progress && i.progress.position > 0;

/** "Continue · Chapter 3 · 42%" or "Continue · page 5 of 22", else "Read". */
export function readLabel(item) {
  if (!started(item)) return 'Read';
  const p = item.progress;
  if (item.kind === 'comic') return `Continue · page ${Math.round(p.position) + 1} of ${p.duration || item.pageCount || '?'}`;
  const ch = p.locator?.chapter;
  return `Continue · ${ch != null ? `Chapter ${ch + 1} · ` : ''}${Math.min(99, Math.floor(p.position))}%`;
}

function moreFor(item, data) {
  const items = [downloadSheetItem(item, { label: item.kind === 'series' ? 'Download all to this device' : 'Download to this device' })];
  if (item.kind !== 'series' && !isKidsProfile()) items.push(addToPlaylistItems({ itemId: item.id }, { kind: 'reading', label: 'Add to a reading list…' }));
  if (canAdmin()) items.push({ label: 'Edit details', icon: 'edit', onSelect: async () => (await import('./edit-details.js')).openEditDetails(item) });
  return items.filter(Boolean);
}

export async function render(el, params, query = {}, first = null) {
  const data = first || (await api.get(`/api/items/${params.id}`));
  const item = data.item;
  setTitle(item.title);
  setBackdrop(item.backdrop || item.poster);
  const actions = [];
  const lines = [];

  if (item.kind === 'series') {
    const books = data.books || [];
    const last = books.reduce((at, b, i) => (b.progress && (isRead(b) || started(b)) ? i : at), -1);
    const next = last >= 0 && !isRead(books[last]) ? books[last] : books.slice(last + 1).find((b) => !isRead(b)) || null;
    if (next && !next.needsTool) {
      const label = last >= 0 ? `Continue: ${issueLabel(next)}` : `Read ${issueLabel(next)}`;
      actions.push(button(label, { icon: 'play', variant: 'primary', autofocus: true, href: `#/read/${next.id}` }));
    }
    lines.push(h('p', { class: 'meta muted' }, `${books.length} ${books.length === 1 ? 'title' : 'titles'}${item.readingDir === 'rtl' ? ' · read right to left' : ''}`));
    const more = moreFor(item, data);
    if (more.length) actions.push(moreButton(item.title, more));
    el.append(
      h(
        'div',
        { class: 'book-view' },
        header(item, lines, actions),
        h('div', { class: 'detail-body' }, h('section', { class: 'detail-section' }, h('h2', {}, 'In this series'), books.length ? grid(books.map((b) => ({ ...b, subtitle: issueLabel(b) })), { style: 'poster' }) : emptyState({ title: 'Nothing here yet', text: 'Its titles appear after the next scan.' }))),
      ),
    );
    return;
  }

  // A book or a comic.
  const show = data.show;
  if (item.author) lines.push(h('p', { class: 'byline' }, `by ${item.author}`));
  if (show) lines.push(h('p', { class: 'byline muted' }, item.issue ? `${item.kind === 'book' ? `Book ${item.issue} of ` : `#${item.issue} of `}` : 'Part of ', h('a', { href: `#/item/${show.id}` }, show.title)));
  const meta = [item.year, item.kind === 'comic' && item.pageCount ? `${item.pageCount} pages` : null, item.kind === 'book' && data.spineCount ? `${data.spineCount} chapters` : null, isRead(item) ? 'Read' : null].filter(Boolean).join(' · ');
  if (meta) lines.push(h('p', { class: 'meta muted' }, meta));
  if (item.needsTool) lines.push(h('p', { class: 'notice' }, `${item.needsTool}.`));
  if (!item.needsTool) actions.push(button(readLabel(item), { icon: 'play', variant: 'primary', autofocus: true, href: `#/read/${item.id}` }));
  actions.push(
    button(isRead(item) ? 'Read' : 'Mark read', {
      icon: 'check',
      variant: isRead(item) ? 'secondary active' : 'ghost',
      attrs: { 'aria-pressed': String(isRead(item)) },
      onClick: async () => {
        await api.post(`/api/items/${item.id}/watched`, { watched: !isRead(item) });
        toast(isRead(item) ? 'Marked as unread' : 'Marked as read');
        refreshView();
      },
    }),
  );
  const more = moreFor(item, data);
  if (more.length) actions.push(moreButton(item.title, more));
  el.append(h('div', { class: 'book-view' }, header(item, lines, actions)));
}

function header(item, lines, actions) {
  return h(
    'header',
    { class: 'detail-header' },
    h(
      'div',
      { class: 'detail-inner' },
      h('div', { class: 'detail-poster' }, art(item.poster, item.title, { kind: 'poster', eager: true })),
      h('div', { class: 'detail-info' }, h('h1', { class: 'detail-title' }, item.title), ...lines, item.overview ? h('p', { class: 'overview' }, item.overview) : null, h('div', { class: 'actions' }, actions)),
    ),
  );
}
