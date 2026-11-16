// Card motion v2 (v0.28), live preview: a film card rested on for 1.2 s plays its 5 s silent clip inside the art —
// one muted video, unseen until its first frame plays, then gone (src let go) the moment focus moves, a key is pressed
// or the page hides. A held arrow asks for no clip at all. No clip, a 404 clip or a refused play(): the still-frame flip.
// Kids, the profile pref off and reduced motion: no video. `node devtools/card-clip.mjs` (dev server on :8787)
import { open, go, check, failed, BASE } from './lib.mjs';

const CARDS = '.library-view a.card';

/** Watch every clip video: was it ever shown (.is-on) before its first `playing`? */
const watch = () => {
  window.__clips = [];
  const recs = new WeakMap();
  // Capture on the document: heard before any listener on the video itself (the page's own fades in from there).
  document.addEventListener('playing', (e) => recs.has(e.target) && (recs.get(e.target).played = true), true);
  new MutationObserver((list) => {
    for (const m of list) {
      for (const n of m.addedNodes) {
        if (!n.matches?.('video.card-clip')) continue;
        const rec = { played: false, early: false, shownAt: 0 };
        window.__clips.push(rec);
        recs.set(n, rec);
        new MutationObserver(() => {
          if (n.classList.contains('is-on') && !rec.shownAt) {
            rec.shownAt = performance.now();
            if (!rec.played) rec.early = true;
          }
        }).observe(n, { attributes: true, attributeFilter: ['class'] });
      }
    }
  }).observe(document, { subtree: true, childList: true });
};

async function setup(opts = {}, { before } = {}) {
  const o = await open(opts);
  await o.context.addInitScript(watch);
  if (before) await before(o);
  o.clipReqs = [];
  o.previewReqs = []; // the manifest and the picture sheets (/api/items/:id/previews…)
  o.page.on('request', (r) => /\/api\/items\/\d+\/clip/.test(r.url()) && o.clipReqs.push(r.url()));
  o.page.on('request', (r) => /\/previews(\/|\?|$)/.test(new URL(r.url()).pathname) && o.previewReqs.push(r.url()));
  await go(o.page, '#/library/1');
  await o.page.waitForSelector(CARDS, { timeout: 15000 });
  await o.page.waitForTimeout(500);
  return o;
}
const videoInfo = (page) =>
  page.evaluate(() => {
    const vs = document.querySelectorAll('video.card-clip');
    const v = vs[0];
    return v && {
      count: vs.length,
      t: v.currentTime,
      on: v.classList.contains('is-on'),
      opacity: Number(getComputedStyle(v).opacity),
      muted: v.muted && v.hasAttribute('muted'),
      inline: v.hasAttribute('playsinline'),
      controls: v.controls,
      loop: v.loop,
      hidden: v.getAttribute('aria-hidden'),
      pip: v.hasAttribute('disablepictureinpicture'),
      remote: v.hasAttribute('disableremoteplayback'),
      preload: v.preload,
      fit: getComputedStyle(v).objectFit,
      inArt: Boolean(v.closest('.card-art .art')),
      duration: v.duration,
    };
  });
const flipShown = (page) => page.evaluate(() => Boolean(document.querySelector('.card-flip')));
const anyVideo = (page) => page.evaluate(() => document.querySelectorAll('video.card-clip').length);

// ---- Mouse: rest, play, fade in on `playing` only, end by itself ----
{
  const { browser, page, errors, clipReqs } = await setup();
  await page.locator(CARDS).first().hover();
  await page.waitForTimeout(900);
  check('before 1.2 s: no video and no clip request', !(await anyVideo(page)) && clipReqs.length === 0, `${clipReqs.length} requests`);
  await page.waitForFunction(() => document.querySelector('video.card-clip.is-on'), null, { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(400);
  const v = await videoInfo(page);
  check('rested 1.2 s: a clip video plays in the card', Boolean(v) && v.t > 0 && v.on && v.opacity === 1 && v.inArt, JSON.stringify(v));
  check('one video, muted, inline, no controls, never loops, hidden from screen readers', v && v.count === 1 && v.muted && v.inline && !v.controls && !v.loop && v.hidden === 'true' && v.pip && v.remote && v.preload === 'auto' && v.fit === 'cover', JSON.stringify(v));
  check('the clip is at most 5 s', v && v.duration <= 5.5, String(v?.duration));
  const clips = await page.evaluate(() => window.__clips);
  check('never shown before its first frame played', clips.length === 1 && clips[0].played && !clips[0].early, JSON.stringify(clips));
  check('no flip while the clip plays', !(await flipShown(page)));
  await page.waitForTimeout(5500);
  check('after the clip: back to the poster, video gone, no flip after', !(await anyVideo(page)) && !(await flipShown(page)));
  check('no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

// ---- Keyboard: focus moves → the video goes within 300 ms and lets go of its src; one at a time ----
{
  const { browser, page, errors } = await setup();
  await page.keyboard.press('ArrowDown'); // keyboard mode
  await page.waitForTimeout(300);
  await page.evaluate((CARDS) => document.querySelector(CARDS).focus(), CARDS);
  await page.waitForFunction(() => document.querySelector('video.card-clip.is-on'), null, { timeout: 4000 }).catch(() => {});
  const v = await page.evaluateHandle(() => document.querySelector('video.card-clip'));
  check('keyboard rest: the clip plays', Boolean(await v.evaluate((x) => x && x.currentTime > 0)));
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  const gone = await v.evaluate((x) => x && { connected: x.isConnected, src: x.getAttribute('src'), paused: x.paused });
  check('focus moved: the video is gone within 300 ms, src let go, paused', gone && !gone.connected && gone.src === null && gone.paused, JSON.stringify(gone));
  const moved = await page.evaluate(() => document.activeElement?.matches('a.card'));
  await page.waitForTimeout(1700);
  check('the next card plays its own, still only one video', moved && (await anyVideo(page)) === 1, String(await anyVideo(page)));
  await page.keyboard.press('Shift');
  await page.waitForTimeout(50);
  check('any key press stops it', !(await anyVideo(page)));
  // The page hides: stop.
  await page.evaluate((CARDS) => document.querySelectorAll(CARDS)[2].focus(), CARDS);
  await page.waitForFunction(() => document.querySelector('video.card-clip.is-on'), null, { timeout: 4000 }).catch(() => {});
  const had = await anyVideo(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(50);
  check('the page hides: the clip stops', had === 1 && !(await anyVideo(page)), `had ${had}`);
  check('no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

// ---- A held arrow: no clip request at all ----
{
  const { browser, page, clipReqs } = await setup();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  await page.evaluate((CARDS) => document.querySelector(CARDS).focus(), CARDS);
  await page.waitForTimeout(100);
  clipReqs.length = 0;
  let seen = 0;
  for (let i = 0; i < 30; i++) {
    await page.keyboard.down('ArrowRight'); // repeats while held
    await page.waitForTimeout(60);
    seen = Math.max(seen, await anyVideo(page));
  }
  await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(600);
  check('a held arrow (1.8 s): no clip request, no video', clipReqs.length === 0 && seen === 0, `${clipReqs.length} requests, ${seen} videos`);
  await browser.close();
}

// ---- No clip for this title: the still-frame flip ----
{
  const { browser, page, clipReqs, errors } = await setup({}, {
    before: ({ context }) =>
      context.route(/\/api\/items\/\d+\/previews(\?|$)/, async (route) => {
        const r = await route.fetch();
        const j = await r.json();
        await route.fulfill({ response: r, json: { ...j, clip: false, clipUrl: null } });
      }),
  });
  await page.locator(CARDS).first().hover();
  await page.waitForTimeout(2200);
  check('no clip: the card flips through its pictures, no video, no clip request', (await flipShown(page)) && !(await anyVideo(page)) && clipReqs.length === 0, `${clipReqs.length} requests`);
  check('no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

// ---- play() refused (iOS Low Power Mode): the flip ----
{
  const { browser, page, errors } = await setup({}, {
    before: ({ context }) => context.addInitScript(() => (HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('refused', 'NotAllowedError')))),
  });
  await page.locator(CARDS).first().hover();
  await page.waitForTimeout(2200);
  const clips = await page.evaluate(() => window.__clips);
  check('play() refused: the flip instead, the video gone, never shown', (await flipShown(page)) && !(await anyVideo(page)) && clips.every((c) => !c.shownAt), JSON.stringify(clips));
  check('no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

// ---- The clip is missing (404): the flip ----
{
  const { browser, page } = await setup({}, { before: ({ context }) => context.route(/\/api\/items\/\d+\/clip/, (route) => route.fulfill({ status: 404, body: 'none' })) });
  await page.locator(CARDS).first().hover();
  await page.waitForTimeout(2400);
  const clips = await page.evaluate(() => window.__clips);
  check('a 404 clip: the flip instead, the video gone, never shown', (await flipShown(page)) && !(await anyVideo(page)) && clips.length === 1 && !clips[0].shownAt, JSON.stringify(clips));
  await browser.close();
}

// ---- Kids profile (the client's profile marked kids): no video, the still-frame flip only ----
{
  const { browser, page, clipReqs } = await setup();
  await page.evaluate(async () => ((await import('/js/app.js')).state.profile.kids = true));
  await page.locator(CARDS).first().hover();
  await page.waitForTimeout(2200);
  check('a Kids profile: no video, no clip request', !(await anyVideo(page)) && clipReqs.length === 0, `${clipReqs.length} requests`);
  check('a Kids profile: the still-frame flip instead', await flipShown(page));
  await browser.close();
}

// ---- "Play previews on cards" off: no card preview at all (no clip, no flip, nothing asked for) ----
{
  const { browser, page, context, clipReqs, previewReqs } = await setup({}, { before: ({ context }) => context.request.patch(`${BASE}/api/me`, { data: { prefs: { cardPreviews: false } } }) });
  previewReqs.length = 0;
  await page.locator(CARDS).first().hover();
  await page.waitForTimeout(2600);
  check('pref off: no video, no clip request', !(await anyVideo(page)) && clipReqs.length === 0, `${clipReqs.length} requests`);
  check('pref off: no flip, no previews request', !(await flipShown(page)) && previewReqs.length === 0, `${previewReqs.length} previews requests`);
  await context.request.patch(`${BASE}/api/me`, { data: { prefs: { cardPreviews: true } } });
  await browser.close();
}

// ---- Data saver (navigator.connection.saveData): no card preview at all ----
{
  const { browser, page, clipReqs, previewReqs } = await setup({}, {
    before: ({ context }) => context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'connection', { configurable: true, get: () => ({ saveData: true, effectiveType: '4g', addEventListener() {}, removeEventListener() {} }) })),
  });
  previewReqs.length = 0;
  await page.locator(CARDS).first().hover();
  await page.waitForTimeout(2600);
  check('saveData: no video, no flip, no clip or previews request', !(await anyVideo(page)) && !(await flipShown(page)) && clipReqs.length === 0 && previewReqs.length === 0, `${clipReqs.length} clip, ${previewReqs.length} previews requests`);
  await browser.close();
}

// ---- A clip that never answers: given up 2.5 s after its src is set, the flip instead ----
{
  const { browser, page, errors } = await setup({}, { before: ({ context }) => context.route(/\/api\/items\/\d+\/clip/, () => {}) });
  await page.locator(CARDS).first().hover();
  await page.waitForFunction(() => document.querySelector('video.card-clip'), null, { timeout: 4000 }).catch(() => {});
  const t0 = Date.now();
  const stalled = await page.waitForFunction(() => !document.querySelector('video.card-clip') && document.querySelector('.card-flip'), null, { timeout: 6000 }).then(() => true, () => false);
  const took = Date.now() - t0;
  const clips = await page.evaluate(() => window.__clips);
  check('a stalled clip: dropped after about 2.5 s, the flip instead, never shown', stalled && took >= 2000 && took <= 4000 && clips.length === 1 && !clips[0].shownAt, `${took} ms ${JSON.stringify(clips)}`);
  check('a stalled clip: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

// ---- A held arrow let go: the card it lands on still previews after 1.2 s ----
{
  const { browser, page } = await setup();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  await page.evaluate((CARDS) => document.querySelector(CARDS).focus(), CARDS);
  await page.waitForTimeout(100);
  await page.keyboard.down('ArrowRight');
  let wasHeld = false;
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(60);
    await page.keyboard.down('ArrowRight'); // repeats while held (the grid has 8 cards in its row)
    wasHeld ||= await page.evaluate(() => document.documentElement.classList.contains('nav-held'));
  }
  await page.keyboard.up('ArrowRight');
  const held = !wasHeld || (await page.evaluate(() => document.documentElement.classList.contains('nav-held')));
  const card = await page.evaluate(() => document.activeElement?.matches('a.card'));
  const played = await page.waitForFunction(() => document.querySelector('video.card-clip.is-on'), null, { timeout: 4000 }).then(() => true, () => false);
  const on = await page.evaluate(() => document.querySelector('video.card-clip')?.closest('a.card') === document.activeElement);
  check('a held arrow let go: the card landed on plays its clip', !held && card && played && on, JSON.stringify({ held, card, played, on }));
  await browser.close();
}

// ---- Reduced motion: still ----
{
  const { browser, page, clipReqs } = await setup({ reducedMotion: 'reduce' });
  await page.locator(CARDS).first().hover();
  await page.waitForTimeout(2200);
  check('reduced motion: no video, no flip', !(await anyVideo(page)) && !(await flipShown(page)) && clipReqs.length === 0);
  await browser.close();
}

process.exit(failed() ? 1 : 0);
