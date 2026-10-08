// LRC lyrics: "[mm:ss.xx] line" per line, several stamps per line, an [offset:] tag. Shared by the server and the browser.
const STAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const INLINE = /<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g;
const META = /^\[(ar|ti|al|au|by|re|ve|length|offset|la|lr):(.*)\]\s*$/i;

const stampSeconds = (m) => Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0);

/** @returns {{ synced: boolean, lines: { at: number | null, text: string }[], offset: number }} */
export function parseLrc(text) {
  const raw = String(text || '').replace(/^﻿/, '');
  let offset = 0;
  const timed = [];
  const plain = [];
  for (const line of raw.split(/\r?\n/)) {
    const meta = META.exec(line);
    if (meta) {
      if (meta[1].toLowerCase() === 'offset') offset = (Number(meta[2]) || 0) / 1000;
      continue;
    }
    // Stamps count only at the start of the line ("[Chorus]" in the words is not a stamp).
    const lead = /^(\s*(?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+)/.exec(line);
    const stamps = lead ? [...lead[1].matchAll(STAMP)] : [];
    const body = (lead ? line.slice(lead[1].length) : line).replace(INLINE, '').replace(/\s+/g, ' ').trim();
    if (stamps.length) for (const s of stamps) timed.push({ at: stampSeconds(s), text: body });
    else plain.push({ at: null, text: body });
  }
  if (timed.length >= 3) {
    timed.sort((a, b) => a.at - b.at);
    return { synced: true, lines: timed.map((l) => ({ at: l.at + offset, text: l.text })), offset };
  }
  const all = raw.split(/\r?\n/).filter((l) => !META.test(l)).map((l) => ({ at: null, text: l.replace(STAMP, '').replace(INLINE, '').replace(/\s+/g, ' ').trim() }));
  while (all.length && !all[all.length - 1].text) all.pop();
  return { synced: false, lines: all, offset };
}
