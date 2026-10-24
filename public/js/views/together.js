// #/together/<code>: a Watch together link. Joins the room and opens its title in the player; a room that has
// ended, is full, or holds a title this profile may not see says so here.
import { h } from '../dom.js';
import { button, emptyState } from '../components.js';
import { navigate, setTitle } from '../app.js';
import { joinRoom } from '../together.js';

export async function render(el, params) {
  setTitle('Watch together');
  try {
    const r = await joinRoom(params.code);
    navigate(`#/play/${r.itemId}?together=${r.code}&member=${encodeURIComponent(r.member)}`, { replace: true });
  } catch (err) {
    el.append(h('div', { class: 'together-refused' }, emptyState({ title: "Can't join this room", text: err.message, icon: 'users', action: button('Go home', { href: '#/', variant: 'primary' }), level: 1 })));
  }
}
