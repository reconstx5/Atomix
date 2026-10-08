// A YouTube trailer, embedded. A dark page, the frame as big as the screen allows, Back under it with focus.
import { h } from '../dom.js';
import { api } from '../api.js';
import { setTitle, goBack } from '../app.js';
import { button, emptyState } from '../components.js';

export async function render(el, params) {
  el.classList.add('trailer-view');
  const data = await api.get(`/api/items/${params.id}`).catch(() => null);
  const t = data?.trailer;
  const back = button('Back', { icon: 'back', autofocus: true, onClick: () => goBack(`#/item/${params.id}`) });
  // Full-screen pages (like the player) focus themselves: the remote can't reach into the frame, so Back takes it.
  setTimeout(() => back.focus({ preventScroll: true }), 0);
  if (!t || t.kind !== 'youtube') {
    setTitle('Trailer');
    el.append(emptyState({ title: 'Nothing to play here', text: 'This title has no trailer to show.' }), h('div', { class: 'actions' }, back));
    const onEmptyKey = (e) => { if (['Escape', 'Backspace', 'BrowserBack', 'GoBack'].includes(e.key)) { e.preventDefault(); goBack(`#/item/${params.id}`); } };
    window.addEventListener('keydown', onEmptyKey);
    return () => window.removeEventListener('keydown', onEmptyKey);
  }
  setTitle(`${data.item.title} — Trailer`);
  const frame = h('iframe', {
    src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(t.key)}?autoplay=1&rel=0&modestbranding=1`,
    title: `${data.item.title} trailer`,
    allow: 'autoplay; encrypted-media; fullscreen',
    allowfullscreen: '',
    referrerpolicy: 'strict-origin-when-cross-origin',
  });
  const note = h('p', { class: 'muted trailer-note', hidden: true }, 'The trailer didn’t load — this TV may not reach YouTube.');
  // A full-screen page handles its own keys (nav.js leaves them to it): Back/Escape leave.
  const onKey = (e) => {
    if (['Escape', 'Backspace', 'BrowserBack', 'GoBack'].includes(e.key)) {
      e.preventDefault();
      goBack(`#/item/${params.id}`);
    }
  };
  window.addEventListener('keydown', onKey);
  let loaded = false;
  frame.addEventListener('load', () => (loaded = true));
  const timer = setTimeout(() => { if (!loaded) note.hidden = false; }, 6000);
  el.append(h('h1', {}, data.item.title), h('div', { class: 'trailer-frame' }, frame), note, h('div', { class: 'actions' }, back));
  return () => {
    clearTimeout(timer);
    window.removeEventListener('keydown', onKey);
  };
}
