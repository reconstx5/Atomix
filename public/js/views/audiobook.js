// An audiobook's page (v0.22): cover, author, narrator, length; Play or "Resume chapter N, X left"; its chapters (OK
// plays from one); Mark finished; a device download; Edit details for admins.
import { api } from '../api.js';
import { h, formatClock, formatRuntime } from '../dom.js';
import { art, button, toast, moreButton } from '../components.js';
import { setTitle, refreshView, canAdmin } from '../app.js';
import { setBackdrop } from '../backdrop.js';
import { playBook } from '../spoken.js';
import { chapterAt, leftText } from '../spoken-time.js';
import { downloadSheetItem } from '../offline/ui.js';

export async function render(el, params, query = {}, first = null) {
  const data = first || (await api.get(`/api/items/${params.id}`));
  const book = data.item;
  const parts = data.parts || [];
  const chapters = data.chapters || [];
  const total = parts.reduce((s, p) => s + (p.duration || 0), 0) || book.duration || 0;
  setTitle(book.title);
  setBackdrop(book.backdrop || book.poster);

  const p = book.progress;
  const finished = Boolean(p?.watched);
  const at = p && !finished && p.position > 30 ? p.position : 0;
  const here = at ? chapterAt(chapters, at) : null;
  const actions = [];
  if (at) {
    const label = `Resume ${here ? `chapter ${here.index + 1}` : `from ${formatClock(at)}`}, ${leftText(Math.max(0, total - at))}`;
    actions.push(button(label, { icon: 'play', variant: 'primary', autofocus: true, onClick: () => playBook(book, { data }) }));
    actions.push(button('From the start', { icon: 'replay', variant: 'ghost', onClick: () => playBook(book, { data, from: 0 }) }));
  } else {
    actions.push(button('Play', { icon: 'play', variant: 'primary', autofocus: true, onClick: () => playBook(book, { data, from: 0 }) }));
  }
  actions.push(
    button(finished ? 'Finished' : 'Mark finished', {
      icon: 'check',
      variant: finished ? 'secondary active' : 'ghost',
      attrs: { 'aria-pressed': String(finished) },
      onClick: async () => {
        await api.post(`/api/items/${book.id}/watched`, { watched: !finished });
        toast(finished ? 'Marked as not finished' : 'Marked as finished');
        refreshView();
      },
    }),
  );
  const more = [downloadSheetItem(book, { label: 'Download to this device' })];
  if (canAdmin() && !book.remote) more.push({ label: 'Edit details', icon: 'edit', onSelect: async () => (await import('./edit-details.js')).openEditDetails(book) });
  if (more.some(Boolean)) actions.push(moreButton(book.title, more.filter(Boolean)));

  const meta = [book.year, total ? formatRuntime(total / 60) : null, chapters.length > 1 ? `${chapters.length} chapters` : null].filter(Boolean).join(' · ');
  const list = h('ol', { class: 'chapter-list', role: 'list', 'aria-label': 'Chapters' });
  chapters.forEach((c, i) => {
    const end = chapters[i + 1]?.start ?? total;
    const current = here?.index === i;
    list.append(
      h(
        'li',
        {},
        h(
          'button',
          {
            type: 'button',
            class: `chapter-row${current ? ' is-current' : ''}`,
            'aria-current': current ? 'true' : null,
            'aria-label': `Play chapter ${i + 1}${c.title ? `: ${c.title}` : ''}, from ${formatClock(c.start)}`,
            onClick: () => playBook(book, { data, from: c.start }),
          },
          h('span', { class: 'chapter-num' }, String(i + 1)),
          h('span', { class: 'chapter-title' }, c.title || `Chapter ${i + 1}`),
          h('span', { class: 'chapter-time muted' }, formatClock(Math.max(0, end - c.start))),
        ),
      ),
    );
  });

  el.append(
    h(
      'div',
      { class: 'audiobook-view' },
      h(
        'header',
        { class: 'detail-header' },
        h(
          'div',
          { class: 'detail-inner' },
          h('div', { class: 'detail-poster is-square' }, art(book.poster, book.title, { kind: 'square', eager: true })),
          h(
            'div',
            { class: 'detail-info' },
            h('h1', { class: 'detail-title' }, book.title),
            book.author ? h('p', { class: 'byline' }, `by ${book.author}`) : null,
            book.narrator ? h('p', { class: 'byline muted' }, `Read by ${book.narrator}`) : null,
            meta ? h('p', { class: 'meta muted' }, meta) : null,
            book.overview ? h('p', { class: 'overview' }, book.overview) : null,
            h('div', { class: 'actions' }, actions),
          ),
        ),
      ),
      chapters.length ? h('div', { class: 'detail-body' }, h('section', { class: 'detail-section' }, h('h2', {}, 'Chapters'), list)) : null,
    ),
  );
}
