// Music's behaviour on the made-up music (music-fixtures.mjs): Now Playing, the song rows and the queue dialog, through
// the page and the engine's public surface (`music`), not the screens' own parts, so it keeps passing when they are
// rewritten. Prints PASS/FAIL lines and ALL PASS; exit 1 on a FAIL. Desktop on Midnight and Orbit, and a phone pass on
// Orbit for the phone-only Queue button.
//   BASE=http://localhost:8798 node devtools/music-fn.mjs [focus rows queue lyrics keys change stop leaks review phone]
import { open, check, failed } from './lib.mjs';
import { BASE, guardBase, ids as getIds, playAt, playBookAt, openQueueDialog, routeMusicQuiet } from './music-fixtures.mjs';

guardBase();
const ALL = ['focus', 'rows', 'queue', 'lyrics', 'keys', 'change', 'stop', 'leaks', 'review', 'phone'];
const LEGS = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const THEMES = ['midnight', 'orbit'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A signed-in page on Home with the music engine at `window.__music`, writing no places for the songs. */
async function start(theme, extra = {}) {
  const s = await open({ theme, serviceWorkers: 'block', reducedMotion: 'reduce', ...extra });
  await routeMusicQuiet(s.page);
  s.page.on('response', (r) => { if (r.status() >= 400 && r.status() !== 404) s.errors.push(`${r.status()} ${r.url()}`); });
  await s.page.goto(`${BASE}/#/`);
  await s.page.keyboard.press('Escape').catch(() => {}); // end the splash
  await s.page.waitForSelector('main > *', { timeout: 10000 }).catch(() => {});
  await s.page.waitForTimeout(600);
  await s.page.evaluate(async () => { window.__music = (await import('/js/music.js')).music; });
  s.ids = await getIds(s.context);
  return s;
}
const hashTo = (page, hash) => page.evaluate((h) => { location.hash = h; }, hash.replace(/^#/, ''));
/** Move inside the app and wait for the page named by `selector` (inside main). */
async function go(page, hash, selector = 'main > *') {
  await hashTo(page, hash);
  await page.waitForSelector(`main ${selector}`, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
}
/** Like go(), in keyboard (remote) mode: a pointer click (playAt makes one) puts it back to the mouse, and only keyboard mode focuses the page's first control. */
async function kgo(page, hash, selector) {
  await page.keyboard.press('ArrowDown');
  await go(page, hash, selector);
}
const until = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout, polling: 50 }).then(() => true, () => false);
const st = (page) => page.evaluate(() => {
  const m = window.__music;
  return { id: m.current?.id ?? null, playing: m.playing, pos: m.position, index: m.queue.index, items: m.queue.items.map((t) => t.id), volume: m.volume };
});
/** The playing song has been playing (music.started when the engine has it; before that, it has moved). */
const playedSome = (page) => until(page, () => { const m = window.__music; return m.playing && (m.started ?? m.position > 0.2); }, null, 15000);
const act = (page, name, arg) => page.evaluate(async ([name, arg]) => {
  const m = window.__music;
  const tracks = async (list) => Promise.all(list.map(async (i) => (await (await fetch(`/api/items/${i}`)).json()).item));
  const A = {
    stop: () => m.stop(), next: () => m.next(), prev: () => m.prev(), seek: (t) => m.seek(t), play: () => m.play(), pause: () => m.pause(),
    volume: (v) => m.setVolume(v), repeat: () => m.cycleRepeat(), playTracks: async (l) => m.playTracks(await tracks(l), 0),
    addToQueue: async (l) => m.addToQueue(await tracks(l)),
    miniClose: () => document.querySelector('.mini button[aria-label="Stop and clear the queue"]').click(),
  };
  return A[name](arg);
}, [name, arg]);
const hashNow = (page) => page.evaluate(() => location.hash);
const activeIs = (page, selector) => page.evaluate((s) => Boolean(document.activeElement?.matches(s)), selector);
const focusIs = (page, selector, timeout = 4000) => until(page, (s) => Boolean(document.activeElement?.matches(s)), selector, timeout);

/** Run one leg in its own browser, then check nothing logged an error. */
async function leg(label, theme, fn, extra = {}) {
  const { allow404, allow, ...opts } = extra;
  const s = await start(theme, opts);
  try {
    await fn(s, (name, ok, detail) => check(`${label} [${theme}]: ${name}`, ok, detail));
  } catch (e) {
    check(`${label} [${theme}]: ran to the end`, false, String(e.stack || e).split('\n').slice(0, 3).join(' | '));
  }
  const errs = s.errors.filter((e) => !(allow404 && /status of 404/.test(e)) && !(allow && allow.test(e)));
  // Let go of the stream (the server counts open ones per account) before the browser goes.
  await s.page.evaluate(() => window.__music?.stop()).catch(() => {});
  await sleep(300);
  check(`${label} [${theme}]: no errors`, !errs.length, errs.join(' | '));
  await s.browser.close();
}

/** Answer lyrics requests: `by(id)` returns { status, json, delay } or null to let the server answer. */
async function routeLyrics(page, by, seen = []) {
  await page.route(/\/api\/items\/\d+\/lyrics/, async (route) => {
    const id = Number(route.request().url().match(/items\/(\d+)\/lyrics/)[1]);
    seen.push(id);
    const a = by(id);
    if (!a) return route.continue();
    if (a.delay) await sleep(a.delay);
    if (a.status === 204) return route.fulfill({ status: 204, body: '' });
    if (a.status && a.status >= 400) return route.fulfill({ status: a.status, json: { error: 'x' } });
    return route.fulfill({ json: a.json });
  });
  return seen;
}

/** The queue dialog's order of songs still to come. */
const upcoming = (page) => page.$$eval('dialog[open] .queue-row', (rows) => rows.length);

for (const theme of THEMES) {
  // ---- first focus ----
  if (LEGS.includes('focus')) {
    await leg('focus', theme, async ({ page, ids }, ok) => {
      const t = ids.tracks;
      // Nothing playing and no song asked for: the Back button.
      await kgo(page, '#/now-playing', '.nowplaying-view');
      ok('nothing playing: Back has the focus', await focusIs(page, '.nowplaying-view button') && /Back/.test(await page.evaluate(() => document.activeElement?.textContent || '')));
      await kgo(page, '#/now-playing?song=999999', '.nowplaying-view');
      ok('a missing song: "No such song" and Back has the focus', /No such song/.test(await page.$eval('.nowplaying-view', (e) => e.textContent)) && await focusIs(page, '.nowplaying-view button') && /Back/.test(await page.evaluate(() => document.activeElement?.textContent || '')));
      // A song playing: Play/Pause.
      await go(page, '#/');
      await playAt(page, [t.harbourLight, t.slackTide], 0, 2.5);
      await kgo(page, '#/now-playing', '.nowplaying-view .np-buttons');
      ok('the song face: Play/Pause has the focus', await focusIs(page, '.np-buttons .btn-primary'));
      // Another song asked for: Play this song.
      await kgo(page, `#/now-playing?song=${t.nightFerry}`, '.nowplaying-view .np-play-this');
      ok('?song= (another song): Play this song has the focus', await focusIs(page, '.np-play-this'));
      // An album's ?track=: that row, in the middle.
      await kgo(page, '#/');
      await kgo(page, `#/item/${ids.albums.lowWater}?track=${t.saltLine}`, '.track-row');
      ok('album ?track=: that row\'s button has the focus', await focusIs(page, `.track-row[data-id="${t.saltLine}"] .track-main`));
      await until(page, (id) => {
        const r = document.querySelector(`.track-row[data-id="${id}"]`)?.getBoundingClientRect();
        return r && Math.abs((r.top + r.bottom) / 2 - innerHeight / 2) < innerHeight * 0.25;
      }, t.saltLine, 4000);
      const mid = await page.evaluate((id) => {
        const r = document.querySelector(`.track-row[data-id="${id}"]`).getBoundingClientRect();
        return { off: Math.abs((r.top + r.bottom) / 2 - innerHeight / 2), h: innerHeight };
      }, t.saltLine);
      ok('album ?track=: the row is in the middle (within 25 % of the screen)', mid.off < mid.h * 0.25, `${Math.round(mid.off)} of ${mid.h}`);
      // The spoken face: Play/Pause.
      if (ids.book) {
        await kgo(page, '#/');
        await playBookAt(page, ids.book, 2.5);
        await kgo(page, '#/now-playing', '.nowplaying-view.is-spoken');
        ok('the spoken face: Play/Pause has the focus', await focusIs(page, '.np-buttons .btn-primary'));
      }
    }, { allow404: true });
  }

  // ---- the rows ----
  if (LEGS.includes('rows')) {
    await leg('rows', theme, async ({ page, ids }, ok) => {
      const t = ids.tracks;
      const row = (id, root = 'main') => `${root} .track-row[data-id="${id}"]`;
      const marks = (selector) => page.$$eval(selector, (rows) => rows.map((r) => ({ id: Number(r.dataset.id), cur: r.classList.contains('is-current'), playing: r.classList.contains('is-playing'), aria: r.getAttribute('aria-current') })));
      // Album page: a click plays, a click on the playing row pauses.
      await go(page, `#/item/${ids.albums.lowWater}`, '.track-row');
      await page.click(`${row(t.slackTide)} .track-main`);
      ok('a click plays that song', await until(page, (id) => window.__music.current?.id === id, t.slackTide));
      await playedSome(page);
      let m = await marks('main .track-row');
      const cur = m.filter((r) => r.cur);
      ok('album: one row is-current, aria-current and is-playing, the playing song\'s', cur.length === 1 && cur[0].id === t.slackTide && cur[0].aria === 'true' && cur[0].playing && m.filter((r) => r.aria).length === 1 && m.filter((r) => r.playing).length === 1, JSON.stringify(m.filter((r) => r.cur || r.playing)));
      await page.click(`${row(t.slackTide)} .track-main`);
      ok('a click on the playing row pauses it', await until(page, () => !window.__music.playing, null));
      await until(page, (id) => { const r = document.querySelector(`main .track-row[data-id="${id}"]`); return r?.classList.contains('is-current') && !r.classList.contains('is-playing'); }, t.slackTide, 3000);
      m = await marks('main .track-row');
      ok('album: paused: is-current stays, is-playing goes', m.find((r) => r.id === t.slackTide)?.cur === true && !m.some((r) => r.playing), JSON.stringify(m.filter((r) => r.cur || r.playing)));
      await page.click(`${row(t.slackTide)} .track-main`);
      ok('a click on the paused playing row plays again', await until(page, () => window.__music.playing, null));
      await until(page, (id) => document.querySelector(`main .track-row[data-id="${id}"]`)?.classList.contains('is-playing'), t.slackTide, 3000);
      m = await marks('main .track-row');
      ok('album: playing again: is-playing is back', m.find((r) => r.id === t.slackTide)?.playing === true);
      // Next: the mark moves. Focus stays on a focused row's button across it.
      await page.focus(`${row(t.harbourLight)} .track-main`);
      await act(page, 'next');
      ok('Next: the mark moves to the next song\'s row', await until(page, (id) => document.querySelector(`main .track-row[data-id="${id}"]`)?.classList.contains('is-current'), t.saltLine, 5000)
        && !(await marks('main .track-row')).some((r) => r.id === t.slackTide && r.cur));
      ok('focus stays on the focused row\'s button across a mark change', await page.evaluate((id) => document.activeElement?.matches('.track-main') && document.activeElement.closest('.track-row')?.dataset.id === String(id), t.harbourLight));
      await act(page, 'stop');

      // The Songs view and search: the playing song's row is marked (paused first, then playing).
      await go(page, '#/');
      await playAt(page, [t.harbourLight, t.slackTide], 0, 2.5);
      for (const [name, hash] of [['Songs', `#/library/${ids.libraryId}?view=tracks`], ['search', '#/search?q=harbour%20light']]) {
        await go(page, hash, '.track-row');
        await until(page, (id) => document.querySelector(`main .track-row[data-id="${id}"]`), t.harbourLight, 8000);
        m = await marks('main .track-row');
        const c = m.filter((r) => r.cur);
        ok(`${name}: the playing song's row is-current with aria-current, not is-playing while paused`, c.length === 1 && c[0].id === t.harbourLight && c[0].aria === 'true' && !c[0].playing && m.filter((r) => r.aria).length === 1, JSON.stringify(m.filter((r) => r.cur)));
        await act(page, 'play');
        await playedSome(page);
        await until(page, (id) => document.querySelector(`main .track-row[data-id="${id}"]`)?.classList.contains('is-playing'), t.harbourLight, 3000);
        m = await marks('main .track-row');
        ok(`${name}: is-playing while it plays`, m.find((r) => r.id === t.harbourLight)?.playing === true && m.filter((r) => r.playing).length === 1);
        await act(page, 'pause');
        await until(page, (id) => !document.querySelector(`main .track-row[data-id="${id}"]`)?.classList.contains('is-playing'), t.harbourLight, 3000);
      }

      // The up-next list on Now Playing: a click jumps to its place in the queue.
      await act(page, 'stop');
      await go(page, '#/');
      await playAt(page, [t.harbourLight, t.slackTide, t.saltLine, t.lowerStill], 0, 2.5);
      await go(page, '#/now-playing', '.np-queue .track-row');
      const upRows = await page.$$eval('.np-queue .track-row', (r) => r.map((x) => Number(x.dataset.id)));
      ok('up-next lists the songs after the playing one', JSON.stringify(upRows) === JSON.stringify([t.slackTide, t.saltLine, t.lowerStill]), JSON.stringify(upRows));
      await page.click('.np-queue .track-row:nth-child(2) .track-main');
      ok('up-next: a click jumps (queue.index = offset + i)', await until(page, () => window.__music.queue.index === 2, null));
      const s1 = await st(page);
      ok('up-next: the queue itself is unchanged by the jump', JSON.stringify(s1.items) === JSON.stringify([t.harbourLight, t.slackTide, t.saltLine, t.lowerStill]) && s1.id === t.saltLine);

      // The playing song also later in the queue: that up-next row carries the playing marks (today's code marks by song id).
      await act(page, 'stop');
      await go(page, '#/');
      await playAt(page, [t.harbourLight, t.slackTide, t.harbourLight], 0, 2.5);
      await go(page, '#/now-playing', '.np-queue .track-row');
      await until(page, () => document.querySelectorAll('.np-queue .track-row').length === 2, null);
      const up = (r) => r.map((x) => ({ id: x.id, cur: x.cur, playing: x.playing, aria: x.aria }));
      m = up(await marks('.np-queue .track-row'));
      ok('up-next, paused: the playing song row is-current with aria-current, not is-playing; the other row bare', m.length === 2 && m[1].id === t.harbourLight && m[1].cur && m[1].aria === 'true' && !m[1].playing && !m[0].cur && !m[0].aria && !m[0].playing, JSON.stringify(m));
      await act(page, 'play');
      await playedSome(page);
      ok('up-next, playing: is-playing on that row', await until(page, () => document.querySelector('.np-queue .track-row:nth-child(2)')?.classList.contains('is-playing'), null, 4000), JSON.stringify(up(await marks('.np-queue .track-row'))));
      await act(page, 'pause');
      ok('up-next, paused again: is-playing goes, is-current stays', await until(page, () => { const r = document.querySelector('.np-queue .track-row:nth-child(2)'); return !r.classList.contains('is-playing') && r.classList.contains('is-current'); }, null, 4000));
      // Focus on an up-next row stays through Next while that row stays in the list.
      await act(page, 'stop');
      await go(page, '#/');
      await playAt(page, [t.harbourLight, t.slackTide, t.saltLine, t.lowerStill], 0, 2.5);
      await go(page, '#/now-playing', '.np-queue .track-row');
      await page.focus(`.np-queue .track-row[data-id="${t.lowerStill}"] .track-main`);
      await act(page, 'next');
      await until(page, (id) => window.__music.current?.id === id, t.slackTide);
      await until(page, () => document.querySelectorAll('.np-queue .track-row').length === 2, null);
      ok('up-next: focus stays on the same song row button when Next moves the list', await page.evaluate((id) => document.activeElement?.matches('.track-main') && document.activeElement.closest('.track-row')?.dataset.id === String(id), t.lowerStill));
      await act(page, 'stop');
      await go(page, '#/');
      await playAt(page, [t.harbourLight, t.slackTide, t.harbourLight], 0, 2.5);
      await go(page, '#/now-playing', '.np-queue .track-row');
      await until(page, () => document.querySelectorAll('.np-queue .track-row').length === 2, null);
      await act(page, 'next'); // s plays: the h copy is no longer marked
      ok('up-next, Next: the mark leaves that row', await until(page, () => !document.querySelector('.np-queue .track-row.is-current'), null, 4000), JSON.stringify(up(await marks('.np-queue .track-row'))));
      await act(page, 'stop');
    });
  }

  // ---- the queue dialog ----
  if (LEGS.includes('queue')) {
    await leg('queue', theme, async ({ page, ids }, ok) => {
      const t = ids.tracks;
      const five = [t.harbourLight, t.slackTide, t.saltLine, t.lowerStill, t.lastEbb];
      const fresh = async () => {
        await act(page, 'stop');
        await page.evaluate(() => document.querySelector('dialog[open]')?.close());
        await go(page, '#/');
        await playAt(page, five, 0, 2.5);
        await openQueueDialog(page);
      };
      // Where focus lands once the list has been drawn again.
      const key = async (page) => {
        await until(page, () => document.activeElement?.dataset?.qkey, null, 1500);
        return page.evaluate(() => document.activeElement?.dataset?.qkey ?? null);
      };
      const click = async (qkey) => {
        await page.click(`dialog[open] [data-qkey="${qkey}"]`);
        await sleep(300);
      };
      await fresh();
      ok('the dialog lists the four songs to come', (await upcoming(page)) === 4);
      await click('3:up'); // the song at 3 moves up to 2
      let s = await st(page);
      ok('Move up: the song moves one place up', JSON.stringify(s.items) === JSON.stringify([five[0], five[1], five[3], five[2], five[4]]), JSON.stringify(s.items));
      ok('Move up: focus lands on the moved song\'s Move up (i-1:up)', (await key(page)) === '2:up', String(await key(page)));
      await fresh();
      await click('2:down');
      s = await st(page);
      ok('Move down: the song moves one place down', JSON.stringify(s.items) === JSON.stringify([five[0], five[1], five[3], five[2], five[4]]), JSON.stringify(s.items));
      ok('Move down: focus lands on the moved song\'s Move down (i+1:down)', (await key(page)) === '3:down', String(await key(page)));
      await fresh();
      await click('2:remove');
      s = await st(page);
      ok('Remove: the song goes', JSON.stringify(s.items) === JSON.stringify([five[0], five[1], five[3], five[4]]), JSON.stringify(s.items));
      ok('Remove: focus lands on the same place (min(i, len-2):remove)', (await key(page)) === '2:remove', String(await key(page)));
      await fresh();
      await click('4:remove'); // the last one: focus goes to the new last
      s = await st(page);
      ok('Remove the last: the song goes', JSON.stringify(s.items) === JSON.stringify(five.slice(0, 4)), JSON.stringify(s.items));
      ok('Remove the last: focus lands on the new last (min(i, len-2):remove)', (await key(page)) === '3:remove', String(await key(page)));
      ok('the dialog stays open through the edits', (await upcoming(page)) === 3);
      await fresh();
      await page.click('dialog[open] button:has-text("Clear queue")');
      ok('Clear queue stops the music (music.current null)', await until(page, () => window.__music.current === null, null));
      ok('Clear queue closes the dialog', await until(page, () => !document.querySelector('dialog[open]'), null));
    });
  }

  // ---- lyrics ----
  if (LEGS.includes('lyrics')) {
    await leg('lyrics', theme, async ({ page, ids }, ok) => {
      const t = ids.tracks;
      await go(page, '#/');
      await playAt(page, [t.harbourLight, t.slackTide], 0, 2.5);
      await go(page, '#/now-playing', '.lyric-line');
      const cur = await page.$$eval('.lyric-line.is-current', (l) => l.map((x) => x.dataset.i));
      ok('the current line is marked at 2.5 s (line 2)', cur.length === 1 && cur[0] === '2', JSON.stringify(cur));
      await page.focus('.lyric-line[data-i="5"]');
      await page.keyboard.press('Enter');
      ok('Enter on a line seeks to its time', await until(page, () => Math.abs(window.__music.position - 5) < 0.4, null));
      await act(page, 'seek', 2.5);
      await until(page, () => document.querySelector('.lyric-line.is-current')?.dataset.i === '2', null);
    });
    // The box does not scroll and the list does not move under a focused line: a long synced list, so the list does move.
    await leg('lyrics (long)', theme, async ({ page, ids }, ok) => {
      const t = ids.tracks;
      const lines = Array.from({ length: 100 }, (_, i) => ({ at: i * 0.055, text: `Line number ${i}` }));
      await routeLyrics(page, (id) => (id === t.harbourLight ? { json: { synced: true, lines, source: 'file' } } : null));
      await go(page, '#/');
      await playAt(page, [t.harbourLight, t.slackTide], 0, 2.5);
      await go(page, '#/now-playing', '.lyric-line');
      await until(page, () => document.querySelector('.lyric-line.is-current'), null);
      const tf = () => page.$eval('.lyrics-synced', (l) => l.style.transform);
      await act(page, 'seek', 2.6); // a time update, so the list is placed once the lines have their size
      await until(page, () => /translateY\(-[1-9]/.test(document.querySelector('.lyrics-synced')?.style.transform || ''), null, 4000);
      await sleep(200);
      const moved = await tf();
      ok('the list moved to the current line (the test is meaningful)', /translateY\(-[1-9]/.test(moved), moved);
      // Paused, a seek into a new line: the list is placed for the lit line's own size (the lit line is larger), within 2 px.
      await act(page, 'pause');
      await act(page, 'seek', 4.0);
      await until(page, () => Number(document.querySelector('.lyric-line.is-current')?.dataset.i) > 60, null);
      await sleep(400);
      const fit = await page.evaluate(() => {
        const li = document.querySelector('.lyric-line.is-current');
        const box = document.querySelector('.np-lyrics');
        const want = Math.max(0, li.offsetTop + li.offsetHeight / 2 - box.clientHeight / 2);
        const got = -Number((document.querySelector('.lyrics-synced').style.transform.match(/-?[\d.]+/) || [0])[0]);
        return { i: li.dataset.i, want: Math.round(want * 10) / 10, got, off: Math.abs(want - got) };
      });
      ok('paused, a seek into a new line: the list is centred on the lit line (within 2 px)', fit.off <= 2, JSON.stringify(fit));
      await act(page, 'play');
      const moved2 = await tf();
      await page.focus('.lyric-line[data-i="90"]');
      await sleep(250);
      const held = await tf();
      ok('focusing a line moves the list to it', held !== moved2 && /translateY\(-[1-9]/.test(held), `${moved2} -> ${held}`);
      ok('the box itself does not scroll (scrollTop 0)', (await page.$eval('.np-lyrics', (e) => e.scrollTop)) === 0);
      await act(page, 'seek', 1.0); // one second on (or back): the current line changes
      ok('the current line changes', await until(page, () => Number(document.querySelector('.lyric-line.is-current')?.dataset.i) < 40, null));
      let same = true;
      const until4 = Date.now() + 3200;
      while (Date.now() < until4) {
        if ((await tf()) !== held) { same = false; break; }
        await sleep(200);
      }
      ok('the list does not move while a line has the focus (4 s hold)', same);
      ok('scrollTop is still 0', (await page.$eval('.np-lyrics', (e) => e.scrollTop)) === 0);
    });
  }

  // ---- keys ----
  if (LEGS.includes('keys')) {
    await leg('keys', theme, async ({ page, ids, context }, ok) => {
      const t = ids.tracks;
      const patches = [];
      page.on('request', (r) => { if (r.method() === 'PATCH' && /\/api\/me$/.test(r.url())) patches.push({ at: Date.now(), body: r.postDataJSON() }); });
      const volume0 = await page.evaluate(() => window.__music.volume);
      await go(page, '#/');
      await playAt(page, [t.harbourLight, t.slackTide], 0, 2.5);
      await go(page, '#/now-playing', '.np-seek-range');
      await act(page, 'seek', 0.4);
      await page.focus('.np-seek-range');
      await page.keyboard.press('ArrowRight');
      ok('Right on the seek bar: +5 s', await until(page, () => Math.abs(window.__music.position - 5.4) < 0.25, null), String((await st(page)).pos));
      await page.keyboard.press('ArrowLeft');
      ok('Left on the seek bar: -5 s', await until(page, () => Math.abs(window.__music.position - 0.4) < 0.25, null), String((await st(page)).pos));
      // Volume.
      await act(page, 'volume', 0.5);
      await page.focus('.np-volume');
      await page.keyboard.press('ArrowUp');
      const up = (await st(page)).volume;
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      const down = (await st(page)).volume;
      ok('Up on the volume: +0.05', Math.abs(up - 0.55) < 0.001, String(up));
      ok('Down on the volume: -0.05', Math.abs(down - 0.45) < 0.001, String(down));
      const before = patches.length;
      const t0 = Date.now();
      await sleep(1300);
      const saved = patches.slice(before).find((p) => p.body?.prefs && 'musicVolume' in p.body.prefs);
      ok('the volume is saved (PATCH /api/me musicVolume) after about 800 ms', Boolean(saved) && Math.abs(saved.body.prefs.musicVolume - 0.45) < 0.001 && saved.at - t0 > -600, JSON.stringify(saved?.body));
      // Escape within 800 ms of a change: saved at once.
      await page.focus('.np-volume');
      const n = patches.length;
      const t1 = Date.now();
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Escape');
      ok('Escape goes back', await until(page, () => !/now-playing/.test(location.hash), null));
      await until(page, (k) => false, null, 400);
      const quick = patches.slice(n).find((p) => p.body?.prefs && 'musicVolume' in p.body.prefs);
      ok('Escape within 800 ms of a change saves the volume at once', Boolean(quick) && quick.at - t1 < 700 && Math.abs(quick.body.prefs.musicVolume - 0.5) < 0.001, quick ? `${quick.at - t1} ms ${JSON.stringify(quick.body)}` : 'no request');
      // Space toggles off controls only.
      await go(page, '#/now-playing', '.np-seek-range');
      await act(page, 'pause');
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press(' ');
      ok('Space off the controls toggles (play)', await until(page, () => window.__music.playing, null));
      await page.keyboard.press(' ');
      ok('Space off the controls toggles (pause)', await until(page, () => !window.__music.playing, null));
      for (const sel of ['.np-volume', '.np-seek-range']) {
        await page.focus(sel);
        const was = (await st(page)).playing;
        await page.keyboard.press(' ');
        await sleep(300);
        ok(`Space on ${sel} does not toggle`, (await st(page)).playing === was);
      }
      await act(page, 'volume', volume0);
      await page.evaluate(async (v) => { await fetch('/api/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefs: { musicVolume: v } }) }); }, volume0);
    });
  }

  // ---- the song changes while Now Playing is open ----
  if (LEGS.includes('change')) {
    await leg('change', theme, async ({ page, ids }, ok) => {
      const t = ids.tracks;
      const seen = await routeLyrics(page, () => null);
      await go(page, '#/');
      await playAt(page, [t.harbourLight, t.nightFerry], 0, 2.5);
      await go(page, '#/now-playing', '.lyric-line');
      await act(page, 'next');
      ok('a new song: its lyrics are read and drawn', await until(page, () => /Black water under the ferry/.test(document.querySelector('.np-lyrics')?.textContent || ''), null) && seen.includes(t.nightFerry), JSON.stringify(seen));
      ok('a new song: the title changes and the old lyrics are gone', /Night Ferry/.test(await page.$eval('.np-title', (e) => e.textContent)) && !(await page.$('.lyric-line')));
    });
    await leg('change (slow answer)', theme, async ({ page, ids }, ok) => {
      const t = ids.tracks;
      await routeLyrics(page, (id) => (id === t.harbourLight ? { delay: 1500, json: { synced: true, lines: [{ at: 0, text: 'OLD SONG LINE' }], source: 'file' } } : null));
      await go(page, '#/');
      await playAt(page, [t.harbourLight, t.nightFerry], 0, 2.5);
      await go(page, '#/now-playing', '.np-lyrics');
      await act(page, 'next'); // the old song's answer is still held
      await until(page, () => /Black water under the ferry/.test(document.querySelector('.np-lyrics')?.textContent || ''), null);
      await sleep(2200);
      const txt = await page.$eval('.np-lyrics', (e) => e.textContent);
      ok('a lyrics answer held for the old song is dropped; the new song\'s lyrics stay', /Black water under the ferry/.test(txt) && !/OLD SONG LINE/.test(txt), txt.slice(0, 80));
    });
  }

  // ---- stop, and spoken to song, while open ----
  if (LEGS.includes('stop')) {
    await leg('stop', theme, async ({ page, ids }, ok) => {
      const t = ids.tracks;
      await go(page, '#/');
      await playAt(page, [t.harbourLight, t.slackTide], 0, 2.5);
      await go(page, '#/now-playing', '.lyric-line');
      await act(page, 'stop');
      ok('stopping while Now Playing is open goes back', await until(page, () => !/now-playing/.test(location.hash), null));
      ok('and html.nowplaying-open is gone', await until(page, () => !document.documentElement.classList.contains('nowplaying-open'), null));
      if (ids.book) {
        await go(page, '#/');
        await playBookAt(page, ids.book, 2.5);
        await go(page, '#/now-playing', '.nowplaying-view.is-spoken');
        ok('the spoken face has no lyrics', !(await page.$('.np-lyrics')));
        await act(page, 'playTracks', [t.harbourLight]);
        ok('a song replaces the book while open: the song face (lyrics there, is-spoken gone)', await until(page, () => document.querySelector('.np-lyrics') && !document.querySelector('.nowplaying-view.is-spoken'), null));
        ok('and html.nowplaying-open is present after the switch', await until(page, () => document.documentElement.classList.contains('nowplaying-open'), null));
        ok('and the song\'s title is shown', /Harbour Light/.test(await page.$eval('.np-title', (e) => e.textContent).catch(() => '')));
      }
    });
  }

  // ---- leaks ----
  if (LEGS.includes('leaks')) {
    await leg('leaks', theme, async ({ page, ids }, ok) => {
      const t = ids.tracks;
      await go(page, '#/');
      await playAt(page, [t.harbourLight, t.slackTide], 0, 2.5);
      // Count the listeners added and not yet removed on the engine's events and on the window's keys.
      await page.evaluate(() => {
        const live = new Map();
        const wrap = (target, tag, only) => {
          const add = target.addEventListener.bind(target);
          const rem = target.removeEventListener.bind(target);
          target.addEventListener = (type, fn, o) => { if (!only || only(type)) (live.get(tag + type) ?? live.set(tag + type, new Set()).get(tag + type)).add(fn); return add(type, fn, o); };
          target.removeEventListener = (type, fn, o) => { live.get(tag + type)?.delete(fn); return rem(type, fn, o); };
        };
        wrap(window.__music.events, 'music.');
        wrap(window, 'window.', (type) => type === 'keydown');
        window.__listeners = () => [...live.values()].reduce((n, s) => n + s.size, 0);
      });
      let base = 0;
      let peak = 0;
      // One visit first (the app adds a listener of its own the first time a page is left), then the 20 that are counted.
      for (let i = -1; i < 20; i++) {
        await hashTo(page, '#/now-playing');
        await page.waitForSelector('html.nowplaying-open .np-transport', { timeout: 8000 });
        if (i === 0) peak = await page.evaluate(() => window.__listeners());
        await hashTo(page, '#/');
        await page.waitForFunction(() => !document.documentElement.classList.contains('nowplaying-open') && !document.querySelector('.nowplaying-view'), null, { timeout: 8000 });
        if (i === -1) base = await page.evaluate(() => window.__listeners());
      }
      await sleep(500);
      const after = await page.evaluate(() => window.__listeners());
      ok('Now Playing adds listeners while open (the count is meaningful)', peak > base, `${base} -> ${peak}`);
      ok('open and leave 20 times: the listeners are back to the starting count', after === base, `${base} -> ${after}`);
      ok('html.nowplaying-open is absent after leaving', await page.evaluate(() => !document.documentElement.classList.contains('nowplaying-open')));
      // Left while the lyrics answer is still out (held 1.5 s): the late answer must not add listeners to a page that is gone.
      await routeLyrics(page, (id) => (id === t.harbourLight ? { delay: 1500, json: { synced: true, lines: [{ at: 0, text: 'Held line' }], source: 'file' } } : null));
      await hashTo(page, '#/now-playing');
      await page.waitForSelector('html.nowplaying-open .np-looking', { timeout: 8000 });
      await hashTo(page, '#/');
      await page.waitForFunction(() => !document.documentElement.classList.contains('nowplaying-open'), null, { timeout: 8000 });
      await sleep(2300);
      const late = await page.evaluate(() => window.__listeners());
      ok('left during a held lyrics answer: the listeners are back to the starting count once it lands', late === base, `${base} -> ${late}`);
    });
  }

  // ---- the Review Focus lines ----
  if (LEGS.includes('review')) {
    // 1: the same song twice in the up-next list.
    await leg('review: a song twice in up-next', theme, async ({ page, ids }, ok) => {
      const t = ids.tracks;
      const three = [t.harbourLight, t.slackTide, t.saltLine];
      const setup = async () => {
        await act(page, 'stop');
        await go(page, '#/');
        await playAt(page, three, 0, 2.5);
        await act(page, 'addToQueue', three); // Add to queue on the playing album: [h, s, sa, h, s, sa]
        await go(page, '#/now-playing', '.np-queue .track-row');
        await until(page, () => document.querySelectorAll('.np-queue .track-row').length === 5, null);
      };
      await setup();
      const rows = await page.$$eval('.np-queue .track-row', (r) => r.map((x) => Number(x.dataset.id)));
      ok('up-next shows both copies (s, sa, h, s, sa)', JSON.stringify(rows) === JSON.stringify([t.slackTide, t.saltLine, t.harbourLight, t.slackTide, t.saltLine]), JSON.stringify(rows));
      await page.click('.np-queue .track-row:nth-child(1) .track-main');
      ok('the first copy: a click jumps to its own place (queue 1)', await until(page, () => window.__music.queue.index === 1, null));
      await setup();
      await page.click('.np-queue .track-row:nth-child(4) .track-main');
      ok('the second copy: a click jumps to its own place (queue 4)', await until(page, () => window.__music.queue.index === 4, null));
      await setup();
      await page.focus('.np-queue .track-row:nth-child(4) .track-main');
      await act(page, 'pause');
      await act(page, 'play');
      await sleep(300);
      const where = () => page.evaluate(() => {
        const a = document.activeElement;
        const rows = [...document.querySelectorAll('.np-queue .track-row')];
        return { onButton: Boolean(a?.matches('.np-queue .track-main')), index: rows.indexOf(a?.closest('.track-row')) };
      });
      let w = await where();
      ok('focus stays on the second copy across a mark change', w.onButton && w.index === 3, JSON.stringify(w));
      await act(page, 'addToQueue', [t.lowerStill]); // a queue edit: the list is drawn again (a sixth row), the focused row is not moved
      await until(page, () => document.querySelectorAll('.np-queue .track-row').length === 6, null);
      await sleep(400);
      w = await where();
      // The up-next rows are keyed: the focus stays on the second copy (index 3), never another row or the page.
      ok('after the list is drawn again (a sixth row) focus stays on the second copy', w.onButton && w.index === 3, JSON.stringify(w));
    });

    // 2: lyrics that answer 204, fail or are empty; synced lyrics that begin after the position.
    for (const [name, answer] of [['204', { status: 204 }], ['500', { status: 500 }], ['{ lines: [] }', { json: { synced: false, lines: [] } }]]) {
      await leg(`review: lyrics ${name}`, theme, async ({ page, ids }, ok) => {
        const t = ids.tracks;
        await routeLyrics(page, () => answer);
        await go(page, '#/');
        await playAt(page, [t.harbourLight, t.slackTide], 0, 2.5);
        await go(page, '#/now-playing', '.np-lyrics');
        ok('the looking line goes', await until(page, () => !document.querySelector('.np-looking'), null));
        ok('no lyric lines', !(await page.$('.lyric-line')) && !(await page.$('.lyrics-synced')));
        // The song face (?song=) says so in words for all three; the player's own face does for 204 and 500.
        const text = await page.$eval('.np-lyrics', (e) => e.textContent);
        if (name !== '{ lines: [] }') ok('the player says "No lyrics for this song"', /No lyrics for this song/.test(text), text);
        await go(page, `#/now-playing?song=${t.nightFerry}`, '.np-play-this');
        ok('the song face says "No lyrics for this song"', await until(page, () => /No lyrics for this song/.test(document.querySelector('.np-lyrics')?.textContent || ''), null));
      }, { allow: /\/lyrics$|status of 500/ });
    }
    await leg('review: lyrics start later', theme, async ({ page, ids }, ok) => {
      const t = ids.tracks;
      await routeLyrics(page, (id) => (id === t.harbourLight ? { json: { synced: true, lines: [{ at: 10, text: 'Late one' }, { at: 12, text: 'Later one' }], source: 'file' } } : null));
      await go(page, '#/');
      await playAt(page, [t.harbourLight, t.slackTide], 0, 2.5);
      await go(page, '#/now-playing', '.lyric-line');
      await sleep(500);
      ok('no line is marked before the first line', (await page.$$eval('.lyric-line.is-current', (l) => l.length)) === 0);
      const tf = await page.$eval('.lyrics-synced', (l) => l.style.transform);
      ok('the list is not moved', !tf || /translateY\(-?0(px)?\)/.test(tf), tf);
    });

    // 2b: plain lyrics with an empty line: the live song face draws it as a no-break space (a line high), ?song= as a plain space.
    await leg('review: plain lyrics blank line', theme, async ({ page, ids }, ok) => {
      const t = ids.tracks;
      await routeLyrics(page, () => ({ json: { synced: false, lines: [{ text: 'First verse' }, { text: '' }, { text: 'Second verse' }] } }));
      await go(page, '#/');
      await playAt(page, [t.harbourLight, t.slackTide], 0, 2.5);
      await go(page, '#/now-playing', '.lyrics-plain p');
      const lines = () => page.$$eval('.lyrics-plain p', (ps) => ps.map((p) => ({ text: p.textContent, h: p.getBoundingClientRect().height })));
      let l = await lines();
      ok('the live song face: the empty line is a no-break space with a height', l.length === 3 && l[1].text === '\u00a0' && l[1].h > 0, JSON.stringify(l));
      await go(page, `#/now-playing?song=${t.nightFerry}`, '.lyrics-plain p');
      l = await lines();
      ok('?song=: the empty line is a plain space (as today)', l.length === 3 && l[1].text === ' ', JSON.stringify(l));
    });
    // 3: leaving while the lyrics request is out.
    await leg('review: leave during lyrics', theme, async ({ page, ids, errors }, ok) => {
      const t = ids.tracks;
      await routeLyrics(page, (id) => (id === t.harbourLight ? { delay: 1500, json: { synced: true, lines: [{ at: 0, text: 'Held line' }, { at: 1, text: 'Held two' }], source: 'file' } } : null));
      await go(page, '#/');
      await playAt(page, [t.harbourLight, t.slackTide], 0, 2.5);
      await hashTo(page, '#/now-playing');
      await page.waitForSelector('html.nowplaying-open .np-looking');
      await hashTo(page, '#/');
      await page.waitForFunction(() => !document.documentElement.classList.contains('nowplaying-open'), null, { timeout: 5000 });
      await sleep(2300);
      ok('nothing is drawn afterwards', !(await page.$('.lyric-line, .lyrics-synced, .lyrics-plain, .np-looking')));
      ok('html.nowplaying-open is not left', await page.evaluate(() => !document.documentElement.classList.contains('nowplaying-open')));
      ok('no console error', !errors.length, errors.join(' | '));
    });

    // 4: the queue dialog open when the queue stops.
    await leg('review: queue dialog and stop', theme, async ({ page, ids }, ok) => {
      const t = ids.tracks;
      await go(page, '#/');
      await playAt(page, [t.harbourLight, t.slackTide, t.saltLine], 0, 2.5);
      await openQueueDialog(page);
      await act(page, 'miniClose'); // the mini-player's close button
      ok('the queue stops (music.current null)', await until(page, () => window.__music.current === null, null));
      ok('the list says "Nothing queued."', await until(page, () => /Nothing queued\./.test(document.querySelector('dialog[open] .queue-list')?.textContent || ''), null));
      await page.click('dialog[open] button:has-text("Done")');
      ok('Done closes the dialog', await until(page, () => !document.querySelector('dialog[open]'), null));
    });

    // 5: ?song= variants.
    await leg('review: ?song=', theme, async ({ page, ids }, ok) => {
      const t = ids.tracks;
      await go(page, '#/');
      await playAt(page, [t.harbourLight, t.slackTide], 0, 2.5);
      await go(page, `#/now-playing?song=${t.harbourLight}`, '.nowplaying-view .np-buttons');
      ok('?song= with the playing song\'s id opens the song face (the player: transport, no Play this song)', Boolean(await page.$('.np-seek-range')) && !(await page.$('.np-play-this')) && /Harbour Light/.test(await page.$eval('.np-title', (e) => e.textContent)));
      for (const [name, q] of [['abc', 'abc'], ['a non-track id (an album)', String(ids.albums.lowWater)], ['an artist', String(ids.artists.cobaltTide)], ['a missing id', '999999']]) {
        await go(page, '#/');
        await go(page, `#/now-playing?song=${q}`, '.nowplaying-view .empty-state, .nowplaying-view .np-play-this');
        ok(`?song=${name} opens "No such song"`, await until(page, () => /No such song/.test(document.querySelector('.nowplaying-view')?.textContent || ''), null) && !(await page.$('.np-play-this')));
      }
      ok('the music played on through it (the same song, still queued)', (await st(page)).id === t.harbourLight);
    }, { allow404: true });
  }
}

// ---- the phone's Queue button (Orbit) ----
if (LEGS.includes('phone')) {
  await leg('phone', 'orbit', async ({ page, ids }, ok) => {
    const t = ids.tracks;
    await go(page, '#/');
    await playAt(page, [t.harbourLight, t.slackTide, t.saltLine], 0, 2.5);
    await go(page, '#/now-playing', '.np-buttons');
    const btn = page.locator('.np-phone-only button');
    ok('the phone has a Queue button on Now Playing', await btn.isVisible());
    await btn.click();
    ok('it opens the queue dialog with the songs to come', await page.waitForSelector('dialog[open] .queue-list .queue-row', { timeout: 5000 }).then(() => true, () => false) && (await upcoming(page)) === 2);
    await page.click('dialog[open] button:has-text("Done")');
    ok('Done closes it', await until(page, () => !document.querySelector('dialog[open]'), null));
  }, { width: 390, height: 844, isMobile: true, hasTouch: true });
  // And a desktop has none on show.
  await leg('desktop has no Queue button', 'orbit', async ({ page, ids }, ok) => {
    await go(page, '#/');
    await playAt(page, [ids.tracks.harbourLight, ids.tracks.slackTide], 0, 2.5);
    await go(page, '#/now-playing', '.np-buttons');
    ok('the Queue button is not shown on a desktop (the queue is beside the lyrics)', !(await page.locator('.np-phone-only button').isVisible()));
  });
}

console.log(failed() ? `${failed()} FAIL` : 'ALL PASS');
process.exit(failed() ? 1 : 0);
