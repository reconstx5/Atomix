// Made-up music for the music checks (compare.mjs with MUSIC=1, and the checks that follow): the songs `make-music.mjs`
// writes, found through the API of the dev server on BASE, and helpers that start a song in the page, paused at a fixed
// place, so a picture of it is the same every time. Never runs against the live server (:8787).

export const BASE = process.env.BASE;

/** Stop (exit 2) when BASE is unset or is the live server. */
export function guardBase() {
  if (!BASE || /:8787/.test(BASE)) {
    console.log('Set BASE to the dev Atomix (for example http://localhost:8797). This check changes the profile, so it will not run against the default or the live server on port 8787.');
    process.exit(2);
  }
}

/** Sign in as the dev user on a browser context. */
export async function login(ctx) {
  const r = await ctx.request.post(`${BASE}/api/auth/login`, { data: { username: 'dallas', password: 'atomix-dev-1' } });
  if (!r.ok()) throw new Error(`login ${r.status()}`);
}

const get = async (ctx, url) => {
  const r = await ctx.request.get(`${BASE}${url}`);
  if (!r.ok()) throw new Error(`${url}: ${r.status()}`);
  return r.json();
};

/**
 * The made-up music's ids, read from the API: { libraryId, albums: { lowWater, smallHours }, artists: { cobaltTide,
 * fenChoir }, tracks: { harbourLight, slackTide, saltLine, lowerStill, lastEbb, nightFerry, reedBed, firstLight }, book }.
 * `lowerStill` is disc 2 track 1 of Low Water. `book` is the audiobook "The Salt Road" (null when there is none).
 */
export async function ids(ctx) {
  const libs = await get(ctx, '/api/libraries');
  const music = libs.find((l) => l.type === 'music' && l.paths.some((p) => /Music$/.test(p)));
  const books = libs.find((l) => l.type === 'audiobooks');
  if (!music) throw new Error('No music library: run devtools/make-music.mjs and add a Music library on its Music folder.');
  const albums = (await get(ctx, `/api/libraries/${music.id}/items`)).items.filter((i) => i.kind === 'album');
  const album = (title) => {
    const a = albums.find((x) => x.title === title);
    if (!a) throw new Error(`No album called ${title}`);
    return a;
  };
  const lowWater = album('Low Water');
  const smallHours = album('Small Hours');
  const tracks = {};
  const NAMES = { 'Harbour Light': 'harbourLight', 'Slack Tide': 'slackTide', 'Salt Line': 'saltLine', 'Lower Still': 'lowerStill', 'Last Ebb': 'lastEbb', 'Night Ferry': 'nightFerry', 'Reed Bed': 'reedBed', 'First Light': 'firstLight' };
  for (const a of [lowWater, smallHours]) for (const t of (await get(ctx, `/api/items/${a.id}`)).tracks) if (NAMES[t.title]) tracks[NAMES[t.title]] = t.id;
  let book = null;
  if (books) book = (await get(ctx, `/api/libraries/${books.id}/items`)).items.find((i) => i.title === 'The Salt Road')?.id ?? null;
  return { libraryId: music.id, albums: { lowWater: lowWater.id, smallHours: smallHours.id }, artists: { cobaltTide: lowWater.parentId, fenChoir: smallHours.parentId }, tracks, book };
}

/** Keep the checks from writing places for the made-up songs (a second run would not look like the first). */
export async function routeMusicQuiet(page) {
  await page.route(/\/api\/items\/\d+\/progress/, (route) => route.fulfill({ json: { ok: true } }));
}

/** Stop whatever plays and empty the queue. */
export async function stopMusic(page) {
  await page.evaluate(async () => {
    const { music } = await import('/js/music.js');
    music.stop();
  });
}

/** Pause at `seconds` and wait until the engine says it is there and stays paused (a play() still on its way can start it again). */
async function pauseAt(page, seconds) {
  for (let round = 0; round < 6; round++) {
    await page.evaluate(async (s) => {
      const { music } = await import('/js/music.js');
      music.pause();
      if (Math.abs(music.position - s) >= 0.05) music.seek(s);
      await new Promise((res) => {
        const done = () => Math.abs(music.position - s) < 0.05 && !music.playing;
        if (done()) return res();
        const t = setInterval(() => done() && (clearInterval(t), res()), 50);
        setTimeout(() => (clearInterval(t), res()), 4000);
      });
    }, seconds);
    await page.waitForTimeout(600);
    const settled = await page.evaluate(async (s) => {
      const { music } = await import('/js/music.js');
      return !music.playing && Math.abs(music.position - s) < 0.05;
    }, seconds);
    if (settled) return;
  }
  throw new Error(`The song would not stay paused at ${seconds} s`);
}

/**
 * Play `trackIds` from `index`, wait for it to be playing, then pause it `seconds` in. Needs a page that has had a
 * user gesture (a click), so the browser lets sound start.
 */
export async function playAt(page, trackIds, index = 0, seconds = 2.5) {
  await page.click('body').catch(() => {});
  const id = trackIds[index];
  await page.evaluate(async ({ trackIds, index }) => {
    const { music } = await import('/js/music.js');
    const items = [];
    for (const i of trackIds) items.push((await (await fetch(`/api/items/${i}`)).json()).item);
    music.playTracks(items, index);
  }, { trackIds, index });
  // `music.started` when the engine has it; before that, the song is current and has moved.
  await page.waitForFunction(async (id) => {
    const { music } = await import('/js/music.js');
    return music.current?.id === id && music.playing && (music.started ?? music.position > 0);
  }, id, { timeout: 15000, polling: 100 });
  await pauseAt(page, seconds);
}

/** The spoken face: play the book from `seconds` and pause there. */
export async function playBookAt(page, bookId, seconds = 2.5) {
  await page.click('body').catch(() => {});
  await page.evaluate(async ({ bookId, seconds }) => {
    const { playBook } = await import('/js/spoken.js');
    await playBook({ id: bookId }, { from: seconds });
  }, { bookId, seconds });
  await page.waitForFunction(async (from) => {
    const { music } = await import('/js/music.js');
    return Boolean(music.spoken) && music.playing && (music.started ?? music.position > from);
  }, seconds, { timeout: 15000, polling: 100 });
  await pauseAt(page, seconds);
}

/** Open the queue dialog (the same call the mini-player's Queue button makes). */
export async function openQueueDialog(page) {
  await page.evaluate(async () => {
    const { openQueue } = await import('/js/music.js');
    openQueue();
  });
  await page.waitForSelector('dialog[open] .queue-list');
}

/**
 * The music pages for compare.mjs: { name, path, play(page), after(page) }. The runner opens Home, stops music, runs
 * `play`, moves to `path` inside the app, then runs `after`.
 */
export function MUSIC_PAGES(ids) {
  const { albums, artists, tracks: t, libraryId, book } = ids;
  const smallHours = [t.nightFerry, t.reedBed, t.firstLight];
  const queueAfter = [t.harbourLight, ...smallHours];
  return [
    { name: 'album-low-water', path: `#/item/${albums.lowWater}` },
    { name: 'album-low-water-track', path: `#/item/${albums.lowWater}?track=${t.lowerStill}` },
    { name: 'artist-cobalt-tide', path: `#/item/${artists.cobaltTide}` },
    { name: 'library-songs', path: `#/library/${libraryId}?view=tracks` },
    { name: 'search-harbour-light', path: '#/search?q=harbour%20light' },
    { name: 'np-synced-lyrics', path: '#/now-playing', play: (p) => playAt(p, queueAfter, 0, 2.5) },
    { name: 'np-plain-lyrics', path: '#/now-playing', play: (p) => playAt(p, smallHours, 0, 2.5) },
    { name: 'np-no-lyrics', path: '#/now-playing', play: (p) => playAt(p, [t.slackTide], 0, 2.5) },
    { name: 'np-other-song', path: `#/now-playing?song=${t.nightFerry}`, play: (p) => playAt(p, [t.harbourLight], 0, 2.5) },
    { name: 'np-nothing', path: '#/now-playing' },
    { name: 'np-missing-song', path: '#/now-playing?song=999999' },
    { name: 'queue-dialog', path: `#/item/${albums.lowWater}`, play: (p) => playAt(p, queueAfter, 0, 2.5), after: openQueueDialog },
    ...(book ? [{ name: 'np-spoken', path: '#/now-playing', play: (p) => playBookAt(p, book, 2.5) }] : []),
  ];
}
