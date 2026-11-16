// Dominant colours of artwork (card motion v2): a card paints this colour in its art box until the picture has
// decoded. The picture is scaled to 8x8 by ffmpeg, the pixels are averaged and the result is given a mild boost in
// saturation (greys stay grey). Stored in items.colors as JSON { poster, backdrop }; filled lazily after an artwork
// request, so a request never waits for it and a card has tint null until it is known.
import { execFile } from 'node:child_process';
import os from 'node:os';

const hex = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');

/** '#rrggbb' for a buffer of packed RGB pixels (3 bytes each); null when there are none. */
export function dominantColor(rgb) {
  const n = Math.floor((rgb?.length || 0) / 3);
  if (!n) return null;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < n * 3; i += 3) {
    r += rgb[i];
    g += rgb[i + 1];
    b += rgb[i + 2];
  }
  r /= n;
  g /= n;
  b /= n;
  // Saturation +30 % in HSV, kept below full; a grey (no saturation) is left exactly as it is.
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max > 0 && (max - min) / max > 0.02) {
    const s = Math.min(1, ((max - min) / max) * 1.3);
    const lo = max * (1 - s);
    const k = (max - lo) / (max - min);
    [r, g, b] = [r, g, b].map((c) => lo + (c - min) * k);
  }
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** The dominant colour of a picture file, or null when ffmpeg can't read it. `onSpawn(proc)` gets the ffmpeg child. */
export function colorOfImage(ffmpegPath, file, { onSpawn } = {}) {
  return new Promise((resolve) => {
    const proc = execFile(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-frames:v', '1', '-vf', 'scale=8:8:flags=area,format=rgb24', '-f', 'rawvideo', '-'],
      { encoding: 'buffer', timeout: 15000, maxBuffer: 1 << 20 },
      (err, out) => resolve(err || !out || out.length < 192 ? null : dominantColor(out.subarray(0, 192))),
    );
    onSpawn?.(proc);
  });
}

const LOW_PRIORITY = 10; // nice 10; "below normal" on Windows (as the background jobs in src/tasks.js)
function lowPriority(proc) {
  try {
    if (proc?.pid) os.setPriority(proc.pid, LOW_PRIORITY);
  } catch {
    /* not allowed here; it still runs */
  }
}
const TINTED = new Set(['movie', 'show', 'episode', 'season']); // the cards that carry a tint

const pending = new Set(); // item:type already queued or running
const undecodable = new Set(); // files ffmpeg could not read: not tried again while the process lives
const waiting = [];
let active = 0;
const LIMIT = 2; // ffmpeg processes at once: a first load of a big grid must not spike the CPU

function pump() {
  while (active < LIMIT && waiting.length) {
    active++;
    waiting.shift()().finally(() => {
      active--;
      pump();
    });
  }
}

/**
 * After a film's, show's, episode's or season's picture was asked for: work out its colour if the title doesn't have
 * it yet and keep it (ffmpeg at low priority). Never awaited by
 * the request (the work is queued, two at a time); failures are ignored (the card just has no tint). `core.colorOf`
 * replaces the ffmpeg reader (tests).
 */
export function noteColor(core, row, type, file) {
  if (!core.thumbs?.tools?.ffmpeg?.available || (type !== 'poster' && type !== 'backdrop') || !file || !row?.id) return;
  if (!TINTED.has(row.kind) || undecodable.has(file)) return; // music, books, people…: no card uses a colour
  let have = null;
  try {
    have = row.colors ? JSON.parse(row.colors) : null;
  } catch {}
  if (have?.[type]) return;
  const key = `${row.id}:${type}`;
  if (pending.has(key)) return;
  pending.add(key);
  const ref = row[type];
  const read = core.colorOf || colorOfImage;
  waiting.push(async () => {
    try {
      const color = await read(core.config.ffmpegPath, file, { onSpawn: lowPriority });
      if (!color) {
        if (undecodable.size > 5000) undecodable.clear();
        undecodable.add(file);
        return;
      }
      const current = core.db.get('SELECT colors, poster, backdrop FROM items WHERE id = ?', row.id);
      if (!current || current[type] !== ref) return; // the artwork changed while this ran: the colour is stale
      let now = {};
      try {
        now = JSON.parse(current.colors || '{}') || {};
      } catch {}
      core.db.run('UPDATE items SET colors = ? WHERE id = ?', JSON.stringify({ ...now, [type]: color }), row.id);
    } catch {
      // no tint
    } finally {
      pending.delete(key);
    }
  });
  pump();
}
