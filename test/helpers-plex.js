// A pretend plex.tv (link codes and the server list) and a pretend Plex Media Server for the Plex tests.
import fs from 'node:fs';
import { fakeServer } from './helpers.js';

const json = (res, data, status = 200) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(data)));
const record = async (req, calls) => {
  const u = new URL(req.url, 'http://x');
  let body = '';
  for await (const c of req) body += c;
  const call = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body };
  calls.push(call);
  return { u, call };
};

/**
 * @param {{ linkAfter?: number, expireAfter?: number, token?: string, resources?: object[] }} opts
 *   linkAfter: the pin links on this many-th poll; expireAfter: ms after creation the pin is gone (404);
 *   resources: plex.tv's /api/v2/resources answer (servers and other devices).
 */
export async function fakePlexTv({ linkAfter = 2, expireAfter = null, token = 'acct1', resources = [] } = {}) {
  const state = { pins: new Map(), calls: [], token, resources, tokenRevoked: false, down: false, nextId: 100 };
  const srv = await fakeServer(async (req, res) => {
    const { u } = await record(req, state.calls);
    if (state.down) return json(res, { error: 'down' }, 503);
    if (req.method === 'POST' && u.pathname === '/api/v2/pins') {
      const id = state.nextId++;
      const pin = { id, code: `AB${id % 100}`.slice(0, 4).padEnd(4, 'X'), polls: 0, created: Date.now() };
      state.pins.set(id, pin);
      return json(res, { id, code: pin.code, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), authToken: null }, 201);
    }
    let m;
    if ((m = /^\/api\/v2\/pins\/(\d+)$/.exec(u.pathname))) {
      const pin = state.pins.get(Number(m[1]));
      if (!pin || (expireAfter != null && Date.now() - pin.created >= expireAfter)) return json(res, { errors: [{ message: 'Not found' }] }, 404);
      pin.polls++;
      return json(res, { id: pin.id, code: pin.code, expiresAt: new Date(pin.created + 15 * 60 * 1000).toISOString(), authToken: pin.polls >= linkAfter ? state.token : null });
    }
    if (u.pathname === '/api/v2/user') {
      if (state.tokenRevoked || req.headers['x-plex-token'] !== state.token) return json(res, { errors: [{ message: 'Invalid token' }] }, 401);
      return json(res, { id: 1, username: 'dallas', title: 'dallas' });
    }
    if (u.pathname === '/api/v2/resources') {
      if (state.resourcesDown) return json(res, { error: 'down' }, 503);
      if (state.tokenRevoked || req.headers['x-plex-token'] !== state.token) return json(res, { errors: [{ message: 'Invalid token' }] }, 401);
      return json(res, state.resources);
    }
    json(res, { error: `fakePlexTv: no route ${u.pathname}` }, 404);
  });
  return { ...srv, state, calls: state.calls };
}

/** A resource entry as plex.tv lists it. */
export function plexResource({ name, machineId, owned = true, sourceTitle = null, accessToken, connections }) {
  return { name, product: 'Plex Media Server', provides: 'server', clientIdentifier: machineId, owned, sourceTitle, accessToken, connections };
}
export const conn = (uri, { local = false, relay = false } = {}) => ({ protocol: uri.startsWith('https') ? 'https' : 'http', uri, local, relay });

/**
 * A pretend Plex Media Server.
 * @param {{ machineId?: string, token?: string, sections?: object[], items?: object, streamFile?: string, pageSize?: number }} opts
 *   sections: [{ key, title, type }]; items: { [sectionKey]: { [plexType]: Metadata[] } } where plexType is 1/2/8;
 *   children: { [ratingKey]: Metadata[] }; details: { [ratingKey]: Metadata } (the /library/metadata/:id answer).
 */
export async function fakePlex({ machineId = 'mach1', token = 'srv1', sections = [], items = {}, children = {}, details = {}, streamFile = null, pageSize = null, totalSize = true } = {}) {
  const state = { machineId, token, sections, items, children, details, streamFile, calls: [], totalSize, hang: false, detailFail: false };
  const authed = (req) => req.headers['x-plex-token'] === state.token;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  const srv = await fakeServer(async (req, res) => {
    const { u } = await record(req, state.calls);
    if (u.pathname === '/identity') return json(res, { MediaContainer: { machineIdentifier: state.machineId, version: '1.40.0' } });
    if (!authed(req)) return json(res, {}, 401);
    if (state.hang && (u.pathname.startsWith('/:/'))) return; // never answers
    if (u.pathname === '/library/sections') return json(res, { MediaContainer: { size: state.sections.length, Directory: state.sections } });
    let m;
    if ((m = /^\/library\/sections\/([^/]+)\/all$/.exec(u.pathname))) {
      const all = state.items[m[1]]?.[u.searchParams.get('type')] || [];
      const start = Number(u.searchParams.get('X-Plex-Container-Start') || 0);
      let size = Number(u.searchParams.get('X-Plex-Container-Size') || 200);
      if (pageSize) size = Math.min(size, pageSize);
      const page = all.slice(start, start + size);
      return json(res, { MediaContainer: { size: page.length, offset: start, ...(state.totalSize ? { totalSize: all.length } : {}), Metadata: page } });
    }
    if ((m = /^\/library\/metadata\/([^/]+)\/children$/.exec(u.pathname))) {
      const kids = state.children[m[1]] || [];
      return json(res, { MediaContainer: { size: kids.length, Metadata: kids } });
    }
    if ((m = /^\/library\/metadata\/([^/]+)$/.exec(u.pathname))) {
      if (state.detailFail) return json(res, {}, 500);
      const d = state.details[m[1]];
      return d ? json(res, { MediaContainer: { size: 1, Metadata: [d] } }) : json(res, {}, 404);
    }
    if (/^\/library\/metadata\/[^/]+\/(thumb|art)\//.test(u.pathname)) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(png);
    }
    if (/^\/library\/parts\//.test(u.pathname)) {
      if (!state.streamFile) return json(res, {}, 404);
      const size = fs.statSync(state.streamFile).size;
      const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      let start = 0, end = size - 1;
      if (r) { start = r[1] ? Number(r[1]) : size - Number(r[2]); if (r[1] && r[2]) end = Math.min(Number(r[2]), size - 1); }
      res.writeHead(r ? 206 : 200, { 'content-type': 'video/x-matroska', 'accept-ranges': 'bytes', 'content-length': end - start + 1, ...(r ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(state.streamFile, { start, end }).pipe(res);
    }
    if (u.pathname === '/:/timeline' || u.pathname === '/:/scrobble') return (res.writeHead(200), res.end());
    json(res, { error: `fakePlex: no route ${u.pathname}` }, 404);
  });
  return { ...srv, state, calls: state.calls };
}

/** A Plex movie as the section listing gives it. */
export function plexMovie(ratingKey, title, extra = {}) {
  return {
    ratingKey, key: `/library/metadata/${ratingKey}`, type: 'movie', title, titleSort: title.toLowerCase(), year: 2020, summary: `${title} summary`,
    contentRating: 'gb/PG', audienceRating: 7.4, duration: 5400000, originallyAvailableAt: '2020-05-01', addedAt: 1700000000, updatedAt: 1710000000,
    thumb: `/library/metadata/${ratingKey}/thumb/1700000000`, art: `/library/metadata/${ratingKey}/art/1700000000`,
    Genre: [{ tag: 'Drama' }], Director: [{ tag: 'Mara Quill' }], Role: [{ tag: 'June Okafor' }],
    Media: [{ container: 'mkv', bitrate: 4000, videoCodec: 'h264', width: 1280, height: 720, audioCodec: 'aac', audioChannels: 2, Part: [{ id: Number(ratingKey) || 1, key: `/library/parts/${ratingKey}/1700000000/file.mkv`, size: 1000 }] }],
    ...extra,
  };
}
