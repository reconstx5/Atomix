// Reading a book or a comic (v0.22 Plan D): full screen, the music left playing. The EPUB reader and the comic reader
// are in reader/; this page picks one and says why when it can't.
import { api } from '../api.js';
import { h } from '../dom.js';
import { button, emptyState } from '../components.js';
import { setTitle, goBack, state } from '../app.js';

/** A download on this device, read with no connection (v0.22): the reader's data from what was kept with it. */
async function offlineBook(id) {
  const [{ openStore }, { downloads }] = await Promise.all([import('../offline/store.js'), import('../offline/downloader.js')]);
  const store = await openStore();
  const pid = state.profile?.id ?? downloads.profileId;
  const e = await store.get(pid, Number(id));
  if (!e || e.status !== 'ready') throw new Error("This isn't on this device yet.");
  const ext = e.ext || (e.kind === 'book' ? 'epub' : 'cbz');
  const base = `/offline-zip/${pid}/${e.itemId}.${ext}/`;
  const item = { id: e.itemId, kind: e.kind, title: e.title, author: e.author || null, issue: e.issue ?? null, pageCount: e.pageCount ?? (e.pages || []).length, readingDir: e.readingDir || null, progress: e.progress || null };
  const report = (body) => store.queueProgress({ profileId: pid, itemId: e.itemId, at: Date.now(), ...body }).catch(() => {});
  const data = { item, spine: e.spine || [], toc: e.toc || [], opfDir: e.opfDir || '', show: e.seriesId ? { id: e.seriesId, title: e.showTitle || '', readingDir: e.readingDir || null } : null };
  return { data, base, report, pageUrl: (n) => base + String((e.pages || [])[n] || '').split('/').map(encodeURIComponent).join('/') };
}

export async function render(el, params, query = {}) {
  const back = () => goBack(state.offline || query.offline === '1' ? '#/downloads' : `#/item/${params.id}`);
  if (query.offline === '1' || state.offline) {
    let o;
    try {
      o = await offlineBook(params.id);
    } catch (err) {
      el.append(emptyState({ title: "This can't be opened", text: err.message }), h('div', { class: 'actions' }, button('Back', { icon: 'back', autofocus: true, onClick: back })));
      return;
    }
    setTitle(o.data.item.title);
    if (o.data.item.kind === 'book') return (await import('../reader/epub.js')).openEpubReader(el, { base: o.base, data: o.data, leave: back, report: o.report });
    return (await import('../reader/comic.js')).openComicReader(el, { data: o.data, leave: back, pageUrl: o.pageUrl, report: o.report });
  }
  let data;
  try {
    data = await api.get(`/api/items/${params.id}`);
  } catch (err) {
    el.append(emptyState({ title: "This can't be opened", text: err.message }), h('div', { class: 'actions' }, button('Back', { icon: 'back', autofocus: true, onClick: back })));
    return;
  }
  setTitle(data.item.title);
  if (data.item.kind === 'book') {
    const { openEpubReader } = await import('../reader/epub.js');
    return openEpubReader(el, { base: `/api/books/${data.item.id}/file/`, data, leave: back });
  }
  if (data.item.kind === 'comic') {
    const { openComicReader } = await import('../reader/comic.js');
    return openComicReader(el, { data, leave: back });
  }
  back();
}
