// A genre's films and shows across the viewer's film and TV libraries (v0.24; opened from Orbit's search tiles).
// v0.26: a Preact screen — the smallest real one, a good place to start reading (CONTRIBUTING.md).
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
  return api.get(`/api/genres/${encodeURIComponent(name)}/items`);
}

export function Screen({ data }) {
  return html`<section class="page genre-view">
    <header class="page-head"><h1>${data.name}</h1></header>
    ${data.items.length ? html`<${Grid} items=${data.items} />` : html`<${EmptyState} title="Nothing here you can watch." icon="film" action=${html`<${Button} label="Search" icon="search" variant="ghost" href="#/search" />`} />`}
  </section>`;
}
