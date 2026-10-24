// ffmpeg reads a connected server's or a live channel's stream over HTTP: the sign-in travels as request headers.
import { redactUrl } from '../http/net.js';

/** One `-headers` block (each line CRLF-terminated, as ffmpeg wants), plus reconnects for a long read over HTTP. */
export function headerArgs(headers) {
  const h = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  return ['-headers', h, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
}

/**
 * Input options for an endless live stream: the user agent on its own (ffmpeg adds its "Lavf" one unless told), the
 * other headers, reconnects on drops and network errors, and a read timeout so a stalled provider ends the process.
 */
export function liveInputArgs(headers = {}) {
  const rest = { ...(headers || {}) };
  const uaKey = Object.keys(rest).find((k) => k.toLowerCase() === 'user-agent');
  const ua = uaKey ? rest[uaKey] : null;
  if (uaKey) delete rest[uaKey];
  const args = [];
  if (ua) args.push('-user_agent', ua);
  if (Object.keys(rest).length) args.push(...headerArgs(rest));
  else args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  args.push('-reconnect_on_network_error', '1', '-rw_timeout', '15000000', ...NETWORK_ONLY);
  return args;
}

/**
 * Live and catch-up inputs come from someone else's playlist: ffmpeg may only use network protocols for them, so an
 * HLS playlist can't send it to file:, concat: or the like on this server.
 */
export const NETWORK_ONLY = ['-protocol_whitelist', 'http,https,tcp,tls,crypto'];

/** The same arguments for a log line: the header block (token or cookie) and the input address (logins) replaced. */
export function redactArgs(args) {
  return args.map((a, i) => {
    if (i > 0 && args[i - 1] === '-headers') return '[redacted]';
    if (i > 0 && args[i - 1] === '-i' && /^https?:\/\//i.test(String(a))) return redactUrl(a);
    return a;
  });
}

/** Any http(s) address inside free text (ffmpeg's error output) reduced to its host. */
export function redactText(text) {
  return String(text || '').replace(/https?:\/\/[^\s'"<>]+/gi, (u) => redactUrl(u));
}
