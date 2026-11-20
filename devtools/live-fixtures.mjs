// Made-up Live TV for the Guide and Recordings checks (fixed-compare.mjs LIVE=1, guide-fn.mjs, recordings-fn.mjs): the
// dev server's mock IPTV has no guide, so every /api/live/ answer the two pages use is made up here against a fixed clock,
// T_LIVE (11 Nov 2026 19:10 NZ, the clock fixed-compare.mjs uses). Channels and recordings come from fixtures/live/;
// programmes are built from T_LIVE: back-to-back 30/60/90-minute programmes (by channel number) from three days before
// to two days after, ids channel id × 10000 + n. Writes (POST/PUT/PATCH/DELETE under /api/live/) answer { ok: true } and
// are kept for liveRequests(). Use a context with serviceWorkers: 'block' (the app's service worker would answer past
// page.route).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const T_LIVE = Date.parse('2026-11-11T19:10:00+13:00');

const CHANNELS = JSON.parse(fs.readFileSync(path.join(DIR, 'channels.json'), 'utf8'));
const RECORDINGS = JSON.parse(fs.readFileSync(path.join(DIR, 'recordings.json'), 'utf8'));

/** The page addresses the Guide and Recordings comparisons capture (the second: a channel on the second page of rows). */
export const LIVE_PAGES = ['#/live/guide', `#/live/guide?channel=${CHANNELS[56].id}`, '#/live/recordings'];
export const CHANNEL_IDS = CHANNELS.map((c) => c.id);

const TITLES = ['Evening News', 'Coastal Rescue', 'Night Garden', 'Mountain Kitchen', 'Weekend Football', 'Quiz Night', 'Late Show', 'Morning Market', 'Garden Rescue', 'The Long Road', 'Harbour Lights', 'Wild Islands', 'Market Day', 'Cold Case Files', 'Studio Session'];
const CATEGORIES = [['News'], ['Documentary', 'Reality'], ['Kids'], ['Food'], ['Sport'], ['Entertainment']];

/** A channel's programmes, built once. */
const progCache = new Map();
function programmesOf(c) {
  if (c.noGuide) return [];
  if (progCache.has(c.id)) return progCache.get(c.id);
  const len = [30, 60, 90][c.number % 3] * MIN;
  const first = Math.floor((T_LIVE - 3 * DAY) / (30 * MIN)) * 30 * MIN;
  const list = [];
  for (let t = first, n = 1; t < T_LIVE + 2 * DAY; t += len, n++) {
    const title = TITLES[(c.number * 7 + n) % TITLES.length];
    list.push({
      id: c.id * 10000 + n,
      channelId: c.id,
      start: t,
      end: t + len,
      title,
      subtitle: n % 4 === 0 ? `Part ${n % 9}` : null,
      description: `${title} on ${c.name}.`,
      categories: CATEGORIES[(c.number + n) % CATEGORIES.length],
      episode: n % 3 === 0 ? `S${(n % 5) + 1} E${(n % 12) + 1}` : null,
      image: null,
      repeat: false,
      // Channel 1's programme on an hour from now is scheduled to record (a red dot in the guide).
      recording: c.number === 1 && t <= T_LIVE + HOUR && T_LIVE + HOUR < t + len ? 'scheduled' : null,
    });
  }
  progCache.set(c.id, list);
  return list;
}

const shapeChannel = (c) => {
  const { noGuide, ...rest } = c;
  return { ...rest };
};
const withNowNext = (c, now) => {
  const list = programmesOf(c);
  const i = list.findIndex((p) => p.start <= now && now < p.end);
  return { ...shapeChannel(c), now: i >= 0 ? list[i] : null, next: i >= 0 ? list[i + 1] || null : null };
};

/** The recordings answer: times turned from minutes (from T_LIVE) into times. */
function recordingsAnswer() {
  const at = (r) => ({ ...r, start: T_LIVE + r.start * MIN, end: T_LIVE + r.end * MIN });
  const out = {};
  for (const k of ['recording', 'scheduled', 'done', 'failed']) out[k] = RECORDINGS[k].map(at);
  out.rules = structuredClone(RECORDINGS.rules);
  return out;
}

const seen = new WeakMap(); // page -> write requests

/**
 * Answer the Live TV routes on `page`. Options (all changeable later with the returned handle's set()):
 *   recordings: 'ok' | 'kids' (403, the server's sentence) | 'error' (500) | 'empty', or a function () => answer
 *   channels: 'many' (60) | 'none'
 *   delay: ms to hold each guide answer, or (ids, from) => ms
 * Returns { set(opts), recordingsGets() }.
 */
export async function routeLive(page, opts = {}) {
  const o = { recordings: 'ok', channels: 'many', delay: 0, ...opts };
  const writes = [];
  seen.set(page, writes);
  let gets = 0;
  const list = () => (o.channels === 'none' ? [] : CHANNELS);
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(/\/api\/live\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.method() !== 'GET') {
      let body = null;
      try {
        body = req.postDataJSON();
      } catch {
        body = req.postData();
      }
      writes.push({ method: req.method(), url: p + url.search, body });
      return json(route, { ok: true });
    }
    if (p === '/api/live/status') return json(route, { enabled: true, sources: [{ id: 'fixture', name: 'Fixture TV', channels: list().length, lastOk: T_LIVE - HOUR }] });
    if (p === '/api/live/groups') return json(route, o.channels === 'none' ? [] : ['Movies', 'News', 'Sport']);
    if (p === '/api/live/channels') {
      const fav = url.searchParams.get('favourites') === '1';
      const group = url.searchParams.get('group');
      return json(route, list().filter((c) => (!fav || c.favourite) && (!group || c.groups.includes(group))).map((c) => withNowNext(c, T_LIVE)));
    }
    if (p === '/api/live/guide') {
      const from = Number(url.searchParams.get('from'));
      const to = Math.min(Number(url.searchParams.get('to')), from + 6 * HOUR);
      const want = url.searchParams.get('channels') ? url.searchParams.get('channels').split(',').map(Number) : list().map((c) => c.id);
      const chans = want.map((id) => list().find((c) => c.id === id)).filter(Boolean).slice(0, 200);
      const ms = typeof o.delay === 'function' ? o.delay(want, from) : o.delay;
      if (ms) await new Promise((r) => setTimeout(r, ms));
      const programmes = {};
      for (const c of chans) programmes[c.id] = programmesOf(c).filter((x) => x.end > from && x.start < to);
      return json(route, { from, to, channels: chans.map(shapeChannel), programmes });
    }
    const pm = /^\/api\/live\/programmes\/(\d+)$/.exec(p);
    if (pm) {
      const id = Number(pm[1]);
      const c = CHANNELS.find((x) => x.id === Math.floor(id / 10000));
      const prog = c && programmesOf(c).find((x) => x.id === id);
      if (!prog) return json(route, { error: 'This programme is no longer in the guide.' }, 404);
      const onNow = prog.start <= T_LIVE && T_LIVE < prog.end;
      const days = c.catchupDays || 0;
      return json(route, {
        ...prog,
        channel: shapeChannel(c),
        canWatchLive: onNow,
        canStartOver: onNow && days > 0,
        canCatchup: !onNow && prog.end <= T_LIVE && days > 0 && prog.end > T_LIVE - days * DAY,
        canRecord: !c.radio && !c.drm && prog.end > T_LIVE,
        recordingId: prog.recording ? 511 : null,
        ruleId: null,
      });
    }
    if (p === '/api/live/recordings') {
      gets++;
      const r = typeof o.recordings === 'function' ? o.recordings() : o.recordings;
      if (r === 'kids') return json(route, { error: "Kids profiles can't record" }, 403);
      if (r === 'error') return json(route, { error: 'Something went wrong on the server.' }, 500);
      if (r === 'empty') return json(route, { recording: [], scheduled: [], done: [], failed: [], rules: [] });
      return json(route, r && typeof r === 'object' ? r : recordingsAnswer());
    }
    return route.fallback();
  });
  return {
    set: (next) => Object.assign(o, next),
    recordingsGets: () => gets,
  };
}

/** The recordings answer as the route gives it (to change and hand back through set({ recordings: () => … })). */
export const recordingsFixture = () => recordingsAnswer();

/** The write requests (POST/PUT/PATCH/DELETE under /api/live/) `page` has made so far. */
export const liveRequests = (page) => seen.get(page) || [];
