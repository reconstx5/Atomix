// Home screen, Kodi "Arctic" style: a spotlight with the focused title's details
// and artwork on top, rows of cards ("widgets") underneath. On big screens the
// rows scroll under a fixed spotlight, the way a TV media centre does.
// v0.28: a Preact screen (the same elements as before, built from ui/cards.js and ui/spotlight.js).
import { api } from '../api.js';
import { html, useState, useRef, useLayoutEffect, useEffect } from '../ui.js';
import { Row } from '../ui/cards.js';
import { Spotlight } from '../ui/spotlight.js';
import { Button, EmptyState } from '../ui/basics.js';
import { cardItems, eagerCards } from '../components.js';
import { setTitle, canAdmin, isKidsProfile, isOrbit } from '../app.js';
import { setBackdrop, artFor, followFocus } from '../backdrop.js';
import { followFocus as followBackdrop } from '../focus-backdrop.js';
import { listable, hiddenCount, deviceNow, whenDeviceKnown } from '../dash/playable.js';
import { rippleOnArrival } from '../transitions.js';

export async function load() {
  setTitle();
  return api.get('/api/home');
}

export function Screen({ data, view }) {
  const empty = !data.libraries.length && !data.rows.some((r) => r.id === 'live-now');
  if (empty) {
    const admin = canAdmin();
    return html`<${EmptyState}
      title="Your media hub is empty"
      text=${admin ? 'Add a folder of movies, TV shows or music and Atomix will organise it for you.' : 'An admin needs to add some media folders first.'}
      action=${admin ? html`<${Button} label="Add a library" icon="plus" variant="primary" href="#/settings/libraries" autofocus=${true} />` : null}
    />`;
  }
  return html`<${Home} data=${data} view=${view} />`;
}

function Home({ data, view }) {
  const featured = data.hero || data.rows.find((r) => r.id !== 'live-now')?.items[0] || null;
  const [spotItem, setSpotItem] = useState(featured);
  const rows = useRef(null);
  // v0.28: On now leaves out the channels this device can't play (an iPhone at once, elsewhere once the probe answers).
  const [device, setDevice] = useState(deviceNow);
  const onNow = data.rows.find((r) => r.id === 'live-now');
  useEffect(() => {
    if (!device && onNow) whenDeviceKnown(onNow.items).then((d) => d && setDevice(d)).catch(() => {});
  }, []);
  // The page's own box: Home's classes, and the top area growing smaller past the first row (Orbit; other themes
  // have no styles for .is-compact).
  useLayoutEffect(() => {
    view.classList.add('home-view');
    rippleOnArrival(view); // card motion v2: the first screenful of cards ripples in when Home is first drawn
    view.classList.toggle('no-spotlight', !featured);
    const rowEls = [...rows.current.querySelectorAll(':scope > .row')];
    const onFocus = (e) => view.classList.toggle('is-compact', rowEls.indexOf(e.target.closest?.('.row')) > 0);
    view.addEventListener('focusin', onFocus);
    // The spotlight (and the artwork behind it) follows whatever card has focus.
    if (featured) followFocus(rows.current, (card) => cardItems.get(card), (item) => setSpotItem(item));
    // Themes that ask for it (Arctic): the artwork follows a card the remote rests on, after 350 ms.
    const stopBackdrop = followBackdrop(rows.current, { itemOf: (card) => cardItems.get(card) });
    return () => {
      view.removeEventListener('focusin', onFocus);
      stopBackdrop();
    };
  }, []);
  eagerCards(6); // Home's first six pictures (the rows on screen first) load at once (v0.24)
  const shownRows = data.rows
    .map((r) => (r.id === 'live-now' && hiddenCount(r.items, device) ? { ...r, items: listable(r.items, { device }) } : r))
    .filter((r) => r.id !== 'live-now' || r.items.length);
  const rowEls = shownRows.map((r) => {
    const href = r.href || (r.libraryId ? `#/library/${r.libraryId}` : r.id === 'watchlist' || r.id === 'lists' ? '#/lists' : null);
    return html`<${Row} key=${r.id} id=${r.id} inMenu=${true} title=${r.title} items=${r.items} style=${r.style} href=${href} />`;
  });
  const after = html`<${EagerOff} />`;
  const none = !data.rows.length
    ? isKidsProfile()
      ? html`<${EmptyState} title="Nothing to watch here yet" text="This Kids profile only shows titles with a suitable age rating. A grown-up can change that in Settings → Profiles." />`
      : html`<${EmptyState} title="Nothing here yet" text="Your libraries are still being scanned. This page fills in as media is found." />`
    : null;
  return html`${featured ? html`<${Spotlight} item=${spotItem} onShow=${(item) => setBackdrop(artFor(item))} />` : null}<div class="home-rows"><div ref=${rows} class="rows">${rowEls}${after}${none}${isOrbit() ? html`<div class="home-arrange"><${Button} label="Arrange home" icon="edit" variant="ghost" href="#/arrange-home" /></div>` : null}</div></div>`;
}

/** Renders nothing: by the time it is drawn the rows' cards have taken the eager pictures, so the rest load lazily. */
function EagerOff() {
  eagerCards(0);
  return null;
}
