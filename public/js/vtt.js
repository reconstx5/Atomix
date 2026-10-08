// WebVTT parsing for the player. Subtitles are drawn by Atomix itself so they
// can be styled and follow the stream's logical timeline.
export function parseTime(t) {
  const parts = t.trim().split(':').map(Number);
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}

export function parseVtt(text) {
  const cues = [];
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = parseTime(a);
    const end = parseTime(b.trim().split(/\s+/)[0]);
    const body = lines.slice(i + 1).join('\n').trim();
    if (body && Number.isFinite(start) && Number.isFinite(end)) cues.push({ start, end, text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': '\u00a0', '&lrm;': '\u200e', '&rlm;': '\u200f' };

/** Cue text → safe HTML. Only <i>, <b> and <u> survive; everything else is shown as text or dropped. */
export function cueHtml(text) {
  const stripped = text
    .replace(/<(?!\/?(i|b|u)>)[^>]*>/gi, '') // voice/class/timestamp tags
    .replace(/\{\\[^}]*\}/g, '') // leftover ASS override codes like {\an8}
    .replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (m) => ENTITIES[m]);
  const escaped = stripped.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(/&lt;(\/?)(i|b|u)&gt;/gi, '<$1$2>').replace(/\n/g, '<br>');
}

