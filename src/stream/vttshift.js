// A WebVTT file with every cue moved by `seconds` (v0.21: a cast's subtitle delay — +0.5 shows each line half a second
// later, as the browser player does). Cues pushed before 0 start at 0.
const STAMP = /(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})/g;
const INLINE = /<((?:\d+:)?\d{1,2}:\d{2}\.\d{3})>/g; // a karaoke timestamp inside a cue's text
const two = (n) => String(n).padStart(2, '0');

function shiftStamp(text, seconds) {
  return text.replace(STAMP, (_, h, m, s, ms) => {
    const t = Math.max(0, Math.round(((Number(h) || 0) * 3600 + Number(m) * 60 + Number(s)) * 1000 + Number(ms) + seconds * 1000));
    const hh = Math.floor(t / 3600_000);
    const mm = Math.floor((t % 3600_000) / 60_000);
    const ss = Math.floor((t % 60_000) / 1000);
    return `${two(hh)}:${two(mm)}:${two(ss)}.${String(t % 1000).padStart(3, '0')}`;
  });
}

/** The timing lines change, and a cue's karaoke timestamps (`<00:00:01.200>`); other text that happens to look like
 *  a time stays as it is. */
export function shiftVtt(vtt, seconds) {
  const d = Number(seconds) || 0;
  if (!d) return vtt;
  return String(vtt)
    .split('\n')
    .map((line) => (line.includes('-->') ? shiftStamp(line, d) : line.replace(INLINE, (_, t) => `<${shiftStamp(t, d)}>`)))
    .join('\n');
}
