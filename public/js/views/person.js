// A person's films and shows in the library this viewer can see, with their role and character (v0.24; opened from
// Orbit's search suggestions). v0.26: a Preact screen.
import { html } from '../ui.js';
import { Button, EmptyState } from '../ui/basics.js';
import { Grid } from '../ui/cards.js';
import { api } from '../api.js';
import { setTitle } from '../app.js';

export async function load(params) {
  let name = params.name;
  try {
    name = decodeURIComponent(name);
  } catch {
    /* already plain text */
  }
  setTitle(name);
  const data = await api.get(`/api/people/${encodeURIComponent(name)}/items`);
  return { ...data, items: data.items.map((i) => ({ ...i, note: [i.role, i.character].filter(Boolean).join(' · ') })) };
}

export function Screen({ data }) {
  return html`<section class="page person-view">
    <header class="page-head"><h1>${data.name}</h1></header>
    ${data.items.length ? html`<${Grid} items=${data.items} />` : html`<${EmptyState} title="Nothing here you can watch." icon="user" action=${html`<${Button} label="Search" icon="search" variant="ghost" href="#/search" />`} />`}
  </section>`;
}
