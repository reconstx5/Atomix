// Building block (v0.26): Orbit's A–Z rail for Movies and TV Shows (was az-rail.js). The letters that have titles;
// Select jumps to a letter's first title and selects it; the letter in view is marked while scrolling. Up/Down move
// between letters, Left goes back to the titles. Callers key it by the list it serves, so a new list starts afresh.
import { html, useRef, useLayoutEffect } from '../ui.js';
import { railLetters, jumpIndex, letterOf } from '../library-rules.js';

const named = (l) => (l === '#' ? 'Jump to numbers and symbols' : `Jump to ${l}`);

/** `cards()` returns the card elements, in the same order as `items`. */
export function AzRail({ items, cards, onJump }) {
  const nav = useRef(null);
  const lastJump = useRef(null);
  const letters = railLetters(items);
  const buttons = () => [...(nav.current?.querySelectorAll('.az-letter') || [])];
  const jump = (letter) => {
    const card = cards()[jumpIndex(items, letter)];
    if (!card) return;
    lastJump.current = card;
    card.scrollIntoView({ block: 'start' });
    card.focus({ preventScroll: true });
    onJump?.(letter);
  };
  const onKeyDown = (e) => {
    const all = buttons();
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus(); // no wrap
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      const list = cards();
      const back = (lastJump.current?.isConnected && lastJump.current) || list.find((c) => c.getBoundingClientRect().bottom > 0 && c.getBoundingClientRect().top < innerHeight) || list[0];
      back?.focus();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault(); // nothing to the right of the rail
      e.stopPropagation();
    }
  };
  // The letter of the first title at least half in view (cards come in list order), worked out after each scroll.
  useLayoutEffect(() => {
    let frame = 0;
    const mark = (letter) => {
      for (const b of buttons()) {
        if (b.textContent === letter) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      }
    };
    // The list's own box when it scrolls (TVs, laptops); otherwise (phones, upright tablets) the page scrolls: the screen.
    const scroller = () => {
      const sc = cards()[0]?.closest('.library-scroll');
      return sc && sc.scrollHeight > sc.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY) ? sc : null;
    };
    const update = () => {
      frame = 0;
      const box = scroller()?.getBoundingClientRect() || { top: 0, bottom: innerHeight };
      const list = cards();
      const i = list.findIndex((c) => {
        const r = c.getBoundingClientRect();
        return Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top) >= r.height / 2;
      });
      if (i >= 0) mark(letterOf(items[i]));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true }); // the list's own box, or the page on phones
    frame = requestAnimationFrame(update);
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      cancelAnimationFrame(frame);
    };
  }, []);
  return html`<nav ref=${nav} class="az-rail" aria-label="Jump to letter" onKeyDown=${onKeyDown}>
    <ul role="list">${letters.map((l) => html`<li key=${l}><button type="button" class="az-letter" aria-label=${named(l)} onClick=${() => jump(l)}>${l}</button></li>`)}</ul>
  </nav>`;
}
