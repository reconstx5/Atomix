// Catch-up (archive) URLs for a programme that already aired, in the styles IPTV playlists use: a full template
// (default), a template added to the live URL (append), ?utc=&lutc= (shift), Flussonic's path form and
// Xtream-Codes' /timeshift/ form. Times are UTC seconds; written from the playlist conventions, not Kodi's code.

const pad = (n, w = 2) => String(n).padStart(w, '0');

function formatTime(sec, fmt) {
  const d = new Date(sec * 1000);
  const parts = { Y: d.getUTCFullYear(), m: pad(d.getUTCMonth() + 1), d: pad(d.getUTCDate()), H: pad(d.getUTCHours()), M: pad(d.getUTCMinutes()), S: pad(d.getUTCSeconds()) };
  return fmt.replace(/[YmdHMS]/g, (c) => String(parts[c]));
}

/**
 * Fill a catch-up template. start/end/now in ms.
 * {utc} {start} · {utcend} {end} · {lutc} {now} {timestamp} · {duration} {duration:N} · {offset:N} ·
 * {Y} {m} {d} {H} {M} {S} (programme start, UTC) · ${start} ${end} ${timestamp} ${duration} · {utc:FORMAT} ${start:FORMAT}
 */
export function fillTemplate(template, { start, end, now }) {
  const s = Math.floor(start / 1000);
  const e = Math.floor(end / 1000);
  const n = Math.floor(now / 1000);
  const value = { utc: s, start: s, utcend: e, end: e, lutc: n, now: n, timestamp: n, duration: e - s };
  return String(template)
    .replace(/\$?\{(utc|start|utcend|end|lutc|now|timestamp):([^}]+)\}/g, (_, k, fmt) => formatTime(value[k], fmt))
    .replace(/\{duration:(\d+(?:\.\d+)?)\}/g, (_, d) => String(Math.floor((e - s) / Number(d))))
    .replace(/\{offset:(\d+(?:\.\d+)?)\}/g, (_, d) => String(Math.floor((n - s) / Number(d))))
    .replace(/\$?\{(utc|start|utcend|end|lutc|now|timestamp|duration)\}/g, (_, k) => String(value[k]))
    .replace(/\{([YmdHMS])\}/g, (_, c) => formatTime(s, c));
}

function addQuery(url, query) {
  return url + (url.includes('?') ? '&' : '?') + query;
}

function flussonic(url, { start, end }) {
  const u = new URL(url);
  const s = Math.floor(start / 1000);
  const dur = Math.floor((end - start) / 1000);
  const parts = u.pathname.split('/');
  const file = parts.pop();
  const m = /^(.*)\.m3u8$/i.exec(file);
  if (m) parts.push(`${m[1]}-${s}-${dur}.m3u8`);
  else parts.push(`archive-${s}-${dur}.ts`); // "mpegts" and other TS forms
  u.pathname = parts.join('/');
  return u.toString();
}

function xtream(url, { start, end }) {
  const m = /^(https?:\/\/[^/]+)\/(?:live\/)?([^/]+)\/([^/]+)\/(\d+)(\.\w+)?(\?.*)?$/i.exec(url);
  if (!m) throw new Error('This channel has no catch-up');
  const [, host, user, pass, id, ext, query = ''] = m;
  const minutes = Math.ceil((end - start) / 60_000);
  const at = formatTime(Math.floor(start / 1000), 'Y-m-d:H-M');
  return `${host}/timeshift/${user}/${pass}/${minutes}/${at}/${id}${ext || '.ts'}${query}`;
}

/**
 * @param {{ url: string, catchup?: { mode?, source?, correction? } }} channel
 * @param {{ start: number, end: number, now: number, from?: number, defaults?: { mode?, source? } }} t  ms; from in s
 */
export function catchupUrl(channel, { start, end, now, from = 0, defaults = {} }) {
  const c = channel.catchup || {};
  const mode = String(c.mode || defaults.mode || '').toLowerCase();
  const source = c.source || defaults.source || '';
  const shift = (Number(c.correction) || 0) * 3600_000;
  const t = { start: start + shift + Math.max(0, Number(from) || 0) * 1000, end: end + shift, now };
  switch (mode) {
    case 'default':
      if (!source) break;
      return fillTemplate(source, t);
    case 'append':
      if (!source) break;
      return channel.url + fillTemplate(source, t);
    case 'shift':
    case 'timeshift':
      return addQuery(channel.url, fillTemplate('utc={utc}&lutc={lutc}', t));
    case 'flussonic':
    case 'flussonic-hls':
    case 'flussonic-ts':
    case 'fs':
      return flussonic(channel.url, t);
    case 'xc':
    case 'xtream':
    case 'xtreamcodes':
      return xtream(channel.url, t);
    default:
      break;
  }
  throw new Error('This channel has no catch-up');
}

/** How many days back a channel offers catch-up: its own catchup-days, else the playlist's, else the setting; 0 without any. */
export function catchupWindowDays(channel, header = {}, settingDays = 7) {
  const own = Number(channel?.catchup?.days);
  if (Number.isFinite(own) && own > 0) return own;
  const has = Boolean(channel?.catchup?.mode || channel?.catchup?.source || header?.catchup || header?.catchupSource);
  if (!has) return 0;
  const fromHeader = Number(header?.catchupDays);
  return Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : Number(settingDays) || 0;
}
