// Building blocks (v0.26): the Preact versions of components.js's button(), emptyState(), moreButton(), spinner()
// and dom.js's icon(). Each draws the same elements, classes, attributes and text as the helper for the same inputs
// (checked in devtools/v026-ui.mjs `blocks`), so a converted screen looks exactly as before.
import { html, h, useRef, useLayoutEffect } from '../ui.js';
import { PATHS } from '../dom.js';
import { openSheet, LOADER } from '../components.js';

// h() leaves out null/false and writes true as an empty attribute; Preact would write "true" for data-/aria- ones.
const attr = (v) => (v === true ? '' : v === false || v == null ? null : v);

/** An icon from Atomix's set (dom.js PATHS). `label`: spoken as a picture; otherwise hidden from screen readers. */
export function Icon({ name, size = 20, label }) {
  return html`<svg
    viewBox="0 0 24 24"
    width=${size}
    height=${size}
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="icon"
    role=${label ? 'img' : null}
    aria-label=${label || null}
    aria-hidden=${label ? null : 'true'}
    dangerouslySetInnerHTML=${{ __html: PATHS[name] || '' }}
  />`;
}

/** button(label, { icon, variant, onClick, href, autofocus, title, type, attrs }) as a component. */
export function Button({ label, icon, variant = 'secondary', onClick, href, autofocus, title, type = 'button', attrs = {} }) {
  const cls = `btn btn-${variant}${label ? '' : ' btn-icon'}`;
  const extra = Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, /^(data|aria)-/.test(k) ? attr(v) : v]));
  const content = [icon ? html`<${Icon} name=${icon} />` : null, label ? html`<span>${label}</span>` : null];
  if (href) return html`<a class=${cls} href=${href} data-autofocus=${attr(autofocus || null)} title=${title} aria-label=${label ? null : title} ...${extra}>${content}</a>`;
  return html`<button class=${cls} type=${type} onClick=${onClick} data-autofocus=${attr(autofocus || null)} title=${title} aria-label=${label ? null : title} ...${extra}>${content}</button>`;
}

/** emptyState({ title, text, action, icon, level }); `action` is a vnode (a Button). */
export function EmptyState({ title, text, action, icon = 'film', level = 2 }) {
  const H = `h${level}`;
  return html`<div class="empty-state">
    <div class="empty-icon"><${Icon} name=${icon} size=${40} /></div>
    <${H}>${title}<//>
    ${text ? html`<p>${text}</p>` : null}
    ${action ? html`<div class="actions">${action}</div>` : null}
  </div>`;
}

/** moreButton(title, items): a round "…" that opens the items in a sheet. */
export function MoreButton({ title, items }) {
  return html`<${Button}
    label=""
    icon="more"
    title="More"
    onClick=${() => openSheet(title, items)}
    attrs=${{ 'aria-haspopup': 'dialog', 'aria-label': title ? `More options for ${title}` : 'More options' }}
  />`;
}

/** spinner(label, { inline, size }). */
export function Spinner({ label = 'Loading', inline = false, size = 18 }) {
  if (inline) return html`<span class="spinner" role="status" aria-label=${label} style=${{ '--spinner-size': `${size}px` }} />`;
  return html`<div class="spinner-wrap" role="status"><span class="loader" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: LOADER }} /><span class="visually-hidden">${label}</span></div>`;
}

/** An element whose children come from DOM-building code that isn't a component yet (an engine's track list, an
 * older helper's cards). `make()` runs when `deps` change; Preact never touches what it returns. */
export function Island({ tag = 'div', make, deps = [], ...attrs }) {
  const el = useRef(null);
  useLayoutEffect(() => {
    el.current.replaceChildren(...[make()].flat().filter(Boolean));
  }, deps);
  return h(tag, { ...attrs, ref: el });
}
