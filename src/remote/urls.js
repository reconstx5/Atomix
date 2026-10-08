// Server addresses as people type them: "jelly.local:8096", "http://10.0.0.5:8096/", "https://x/jellyfin/".
import { HttpError } from '../http/router.js';

/** A clean base URL: a scheme (https when none was given), lower-case host, no trailing slash. */
export function normaliseUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new HttpError(400, 'Enter the server’s address.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new HttpError(400, 'That doesn’t look like a server address.');
  }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || /\s/.test(s)) throw new HttpError(400, 'That doesn’t look like a server address.');
  u.protocol = u.protocol.toLowerCase();
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
}
