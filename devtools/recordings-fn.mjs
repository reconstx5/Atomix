// Live TV → Recordings' behaviour (made-up recordings from live-fixtures.mjs, clock fixed at T_LIVE): the five
// sections, each row action's request and where focus lands, the in-row Delete question, Try again's polling, rule
// options, Kids, a failed load, the 15-s re-read and nothing left running after the page is left. Prints PASS/FAIL
// lines; exit 1 on a FAIL.
//   BASE=http://localhost:8797 node devtools/recordings-fn.mjs [sections stop cancel delete remove retry rules kids error refresh leaks]
import { open, check, failed, BASE } from './lib.mjs';
import { routeLive, liveRequests, recordingsFixture, T_LIVE } from './live-fixtures.mjs';

if (!process.env.BASE || /:8787/.test(process.env.BASE)) {
  console.log('Set BASE to the dev Atomix (for example http://localhost:8797). This check changes the profile, so it will not run against the default or the live server on port 8787.');
  process.exit(2);
}
const ALL = ['sections', 'stop', 'cancel', 'delete', 'remove', 'retry', 'rules', 'kids', 'error', 'refresh', 'leaks'];
const LEGS = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const REREAD = 16_000; // a little over the page's 15 s

// Every sentence said to a screen reader (the live regions' lines come and go).
const noteSpoken = () => {
  window.__said = [];
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1 && n.parentElement?.matches('#live-polite, #live-alert')) window.__said.push(n.textContent);
  }).observe(document, { subtree: true, childList: true });
};

/** A signed-in page on Recordings with the made-up Live TV, in keyboard (remote) mode. */
async function start({ hash = '#/live/recordings', ...live } = {}) {
  const s = await open({ theme: 'midnight', serviceWorkers: 'block', reducedMotion: 'reduce' });
  await s.page.clock.setFixedTime(T_LIVE);
  await s.page.addInitScript(noteSpoken);
  s.live = await routeLive(s.page, live);
  await s.page.goto(`${BASE}/#/`);
  await s.page.keyboard.press('Escape').catch(() => {}); // end the splash
  await s.page.waitForTimeout(800);
  await s.page.keyboard.press('ArrowDown');
  await go(s.page, hash);
  return s;
}
async function go(page, hash, wait = 1000) {
  await page.evaluate((h) => { location.hash = h; }, hash.replace(/^#/, ''));
  await page.waitForSelector('main .recordings-view .stack > *, main .live-view', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(wait);
}
const activeKey = (page) => page.evaluate(() => document.activeElement?.dataset?.key || document.activeElement?.textContent?.trim() || null);
const press = async (page, sel, wait = 900) => {
  await page.focus(sel);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(wait);
};
const sent = (page, method, url) => liveRequests(page).find((r) => r.method === method && r.url === url);
const said = (page) => page.evaluate(() => window.__said);

if (LEGS.includes('sections')) {
  const { browser, page, errors } = await start();
  const heads = await page.$$eval('.rec-section > h2', (hs) => hs.map((h) => h.textContent));
  check('sections: five sections in order', JSON.stringify(heads) === JSON.stringify(['Recording now (2)', 'Scheduled (3)', 'Done (4)', 'Failed (2)', 'Series rules (2)']), JSON.stringify(heads));
  const text = await page.$eval('main', (m) => m.textContent);
  check('sections: the clash line', /Clashes with Coastal Rescue on Summit One/.test(await page.$eval('.rec-clash', (c) => c.textContent).catch(() => '')));
  for (const t of ['Has a gap (5 min missing)', 'Adding to the library…', 'Saving…', 'The last 2 minutes are missing']) check(`sections: says "${t}"`, text.includes(t));
  const rule = await page.$eval('.rec-rule[data-id="901"]', (li) => ({ keep: li.querySelector('[data-key="keep:901"]').value, newOnly: li.querySelector('[data-key="new:901"]').checked, chan: li.querySelector('[data-key="chan:901"]').value }));
  check('sections: rule options show the rule', rule.keep === '5' && rule.newOnly && rule.chan === 'kauri-one', JSON.stringify(rule));
  check('sections: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('stop')) {
  const { browser, page, errors } = await start();
  await press(page, '[data-key="stop:501"]');
  check('stop: asks the server to stop it', Boolean(sent(page, 'POST', '/api/live/recordings/501/stop')), JSON.stringify(liveRequests(page)));
  check('stop: focus on the Done heading', (await activeKey(page)) === 'h:rec-done', await activeKey(page));
  check('stop: says so', (await said(page)).includes('Stopped recording Evening News'), JSON.stringify(await said(page)));
  check('stop: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('cancel')) {
  const { browser, page, errors } = await start();
  await press(page, '[data-key="cancel:511"]');
  check('cancel: asks the server to cancel it', Boolean(sent(page, 'DELETE', '/api/live/recordings/511')), JSON.stringify(liveRequests(page)));
  check("cancel: focus on the next row's Cancel", (await activeKey(page)) === 'cancel:512', await activeKey(page));
  await press(page, '[data-key="cancel:513"]');
  check("cancel: the last row's goes to the row before", (await activeKey(page)) === 'cancel:512', await activeKey(page));
  check('cancel: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('delete')) {
  const { browser, page, errors } = await start();
  await press(page, '[data-key="delete:521"]', 400);
  const q = await page.$$eval('.rec-confirm', (cs) => cs.map((c) => ({ text: c.querySelector('p')?.textContent, row: c.closest('.rec-row')?.dataset.id, role: c.getAttribute('role') })));
  check('delete: the question in the row', q.length === 1 && q[0].text === 'Delete Weekend Football? The file is removed.' && q[0].row === '521' && q[0].role === 'group', JSON.stringify(q));
  check("delete: focus on the question's Cancel", await page.evaluate(() => document.activeElement?.closest('.rec-confirm') && document.activeElement.textContent === 'Cancel'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('delete: Escape closes it', !(await page.$('.rec-confirm')));
  check('delete: focus back on Delete', (await activeKey(page)) === 'delete:521', await activeKey(page));
  check('delete: the page is still Recordings', await page.evaluate(() => location.hash === '#/live/recordings'));
  await press(page, '[data-key="delete:521"]', 400);
  await press(page, '[data-key="delete:522"]', 400);
  const two = await page.$$eval('.rec-confirm', (cs) => cs.map((c) => c.closest('.rec-row')?.dataset.id));
  check('delete: one question at a time', JSON.stringify(two) === JSON.stringify(['522']), JSON.stringify(two));
  check('delete: the first row has its buttons back', Boolean(await page.$('.rec-row[data-id="521"] [data-key="delete:521"]')));
  check('delete: nothing deleted yet', !liveRequests(page).some((r) => r.method === 'DELETE'), JSON.stringify(liveRequests(page)));
  await page.click('.rec-confirm .btn-danger');
  await page.waitForTimeout(900);
  check('delete: Delete asks the server to delete it', Boolean(sent(page, 'DELETE', '/api/live/recordings/522')), JSON.stringify(liveRequests(page)));
  check("delete: focus on the next row's first control", (await activeKey(page)) === 'play:523', await activeKey(page));
  check('delete: says so', (await said(page)).includes('Deleted Coastal Rescue'), JSON.stringify(await said(page)));
  check('delete: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('remove')) {
  const { browser, page, errors } = await start();
  await press(page, '[data-key="remove:531"]');
  check('remove: asks the server to remove it', Boolean(sent(page, 'DELETE', '/api/live/recordings/531')), JSON.stringify(liveRequests(page)));
  // The next row is saving (no buttons): the heading.
  check('remove: focus on the Failed heading', (await activeKey(page)) === 'h:rec-failed', await activeKey(page));
  check('remove: says Removed', (await said(page)).includes('Removed'), JSON.stringify(await said(page)));
  check('remove: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('retry')) {
  const { browser, page, errors, live } = await start();
  // After Try again: two answers with it saving, then it is done.
  let after = 0;
  const saving = () => { const d = recordingsFixture(); d.failed.find((r) => r.id === 531).saving = true; return d; };
  const done = () => { const d = recordingsFixture(); const r = d.failed.find((x) => x.id === 531); d.failed = d.failed.filter((x) => x.id !== 531); d.done.unshift({ ...r, status: 'done', itemId: 9 }); return d; };
  live.set({ recordings: () => (++after <= 3 ? saving() : done()) }); // the first is the page's own re-read after Try again
  await press(page, '[data-key="retry:531"]');
  check('retry: asks the server to try again', Boolean(sent(page, 'POST', '/api/live/recordings/531/retry')), JSON.stringify(liveRequests(page)));
  check('retry: the row says Saving…', (await page.$eval('.rec-row[data-id="531"]', (r) => r.textContent).catch(() => '')).includes('Saving…'));
  check('retry: focus on the Failed heading', (await activeKey(page)) === 'h:rec-failed', await activeKey(page));
  await page.waitForTimeout(8000);
  check('retry: says Saved once it has saved', (await said(page)).includes('Saved Garden Rescue'), JSON.stringify(await said(page)));
  check('retry: the row is now under Done', Boolean(await page.$('.rec-done .rec-row[data-id="531"]')));
  const gets = live.recordingsGets();
  await page.waitForTimeout(4500);
  check('retry: the polling stopped', live.recordingsGets() === gets, `${gets} -> ${live.recordingsGets()}`);
  check('retry: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('rules')) {
  const { browser, page, errors } = await start();
  await page.selectOption('[data-key="keep:901"]', '10');
  await page.waitForTimeout(600);
  const r = sent(page, 'PATCH', '/api/live/rules/901');
  check('rules: Keep saves { keep: 10 }', JSON.stringify(r?.body) === '{"keep":10}', JSON.stringify(liveRequests(page)));
  check('rules: says Saved', (await said(page)).includes('Saved'), JSON.stringify(await said(page)));
  await page.click('[data-key="new:901"]');
  await page.waitForTimeout(600);
  check('rules: New episodes only saves { newOnly: false }', liveRequests(page).some((x) => x.method === 'PATCH' && JSON.stringify(x.body) === '{"newOnly":false}'), JSON.stringify(liveRequests(page)));
  await page.selectOption('[data-key="chan:901"]', '');
  await page.waitForTimeout(600);
  check('rules: Any channel saves { channelKey: null }', liveRequests(page).some((x) => x.method === 'PATCH' && JSON.stringify(x.body) === '{"channelKey":null}'), JSON.stringify(liveRequests(page)));
  await press(page, '[data-key="stopseries:901"]');
  check('rules: Stop series asks the server', Boolean(sent(page, 'DELETE', '/api/live/rules/901')), JSON.stringify(liveRequests(page)));
  check("rules: focus on the next rule's first control", (await activeKey(page)) === 'chan:902', await activeKey(page));
  check('rules: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('kids')) {
  const { browser, page, errors, live } = await start({ recordings: 'kids' });
  const t = await page.evaluate(() => ({ title: document.querySelector('main .recordings-view .empty-state h2')?.textContent, sections: document.querySelectorAll('main .rec-section').length, head: document.querySelector('main .page-head h1')?.textContent }));
  check("kids: only the sentence under the head", t.title === "Kids profiles can't record" && t.sections === 0 && t.head === 'Recordings', JSON.stringify(t));
  const gets = live.recordingsGets();
  await page.waitForTimeout(REREAD + 4000);
  check('kids: no re-read', live.recordingsGets() === gets, `${gets} -> ${live.recordingsGets()}`);
  check('kids: no page errors', !errors.filter((e) => !/403/.test(e)).length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('error')) {
  {
    const { browser, page, errors } = await start({ recordings: 'error' });
    const t = await page.evaluate(() => ({ title: document.querySelector('main .recordings-view .empty-state h2')?.textContent, text: document.querySelector('main .recordings-view .empty-state p')?.textContent, head: document.querySelector('main .page-head h1')?.textContent }));
    check("error: says Couldn't load the recordings, in the page", t.title === "Couldn't load the recordings" && t.text === 'Something went wrong on the server.' && t.head === 'Recordings', JSON.stringify(t));
    check('error: no page errors', !errors.filter((e) => !/500/.test(e)).length, errors.join(' | '));
    await browser.close();
  }
  const { browser, page, errors, live } = await start();
  live.set({ recordings: 'error' });
  await page.waitForTimeout(REREAD);
  check('error: a failed re-read keeps the list', (await page.$$('.rec-section')).length === 5 && !(await page.$('main .empty-state')));
  check('error: no page errors', !errors.filter((e) => !/500/.test(e)).length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('refresh')) {
  const { browser, page, errors, live } = await start();
  let gets = live.recordingsGets();
  await page.focus('[data-key="cancel:512"]');
  await page.waitForTimeout(REREAD);
  check('refresh: read again after 15 s', live.recordingsGets() === gets + 1, `${gets} -> ${live.recordingsGets()}`);
  check('refresh: focus kept on the same control', (await activeKey(page)) === 'cancel:512', await activeKey(page));
  await press(page, '[data-key="delete:521"]', 300);
  gets = live.recordingsGets();
  await page.waitForTimeout(REREAD);
  check('refresh: not while a Delete question is open', live.recordingsGets() === gets, `${gets} -> ${live.recordingsGets()}`);
  check('refresh: the question is still open', Boolean(await page.$('.rec-confirm')));
  await page.keyboard.press('Escape');
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
  gets = live.recordingsGets();
  await page.waitForTimeout(REREAD);
  check('refresh: not while the page is hidden', live.recordingsGets() === gets, `${gets} -> ${live.recordingsGets()}`);
  check('refresh: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('leaks')) {
  const { browser, page, errors, live } = await start();
  for (let i = 0; i < 20; i++) {
    await go(page, '#/live', 300);
    await go(page, '#/live/recordings', 300);
  }
  await go(page, '#/live', 300);
  let gets = live.recordingsGets();
  await page.waitForTimeout(REREAD);
  check('leaks: no re-read after leaving (20 visits)', live.recordingsGets() === gets, `${gets} -> ${live.recordingsGets()}`);
  await go(page, '#/live/recordings');
  live.set({ recordings: () => { const d = recordingsFixture(); d.failed.find((r) => r.id === 531).saving = true; return d; } });
  await press(page, '[data-key="retry:531"]', 500);
  await go(page, '#/live', 300);
  gets = live.recordingsGets();
  await page.waitForTimeout(6000);
  check('leaks: Try again stops polling when the page is left', live.recordingsGets() === gets, `${gets} -> ${live.recordingsGets()}`);
  check('leaks: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

console.log(failed() ? `${failed()} FAIL` : 'all passed');
process.exit(failed() ? 1 : 0);
