// Orbit's Live TV page (v0.25): rules that need no page, tested in Node (test/live-rules.test.js). views/live.js
// and live-spot.js apply them.

/** A steady colour for a channel without a picture: the same name always gets the same hue (FNV-1a). */
export function channelTint(name) {
  const s = String(name || '');
  if (!s) return 'hsl(220 20% 24%)';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `hsl(${h % 360} 45% 32%)`;
}

/** "38 min left", "1 h 5 min left", "Ending now"; '' without a programme. */
export function minutesLeft(p, now) {
  if (!p) return '';
  const mins = Math.floor((p.end - now) / 60_000);
  if (mins < 1) return 'Ending now';
  if (mins < 60) return `${mins} min left`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min left` : `${h} h left`;
}

/** The card's "Next 2:00 PM · Coast" ('' when nothing follows). */
export const nextLine = (next, clock) => (next ? `Next ${clock(next.start)} · ${next.title}` : '');

/** The channel the spotlight starts on: the first favourite, else the first channel. */
export function spotStart(channels) {
  return (channels.find((c) => c.favourite) || channels[0])?.id ?? null;
}

/** The spotlight keeps its channel while it is still listed (a reload, a programme change); otherwise it starts again. */
export const spotKeep = (channels, currentId) => (channels.some((c) => c.id === currentId) ? currentId : spotStart(channels));
