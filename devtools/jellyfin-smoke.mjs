// Walks the calls a Jellyfin app (Infuse) makes against a running Atomix, with fetch only: add server, sign in, views,
// each library's items, Resume, Next Up, Latest, a show's seasons and episodes, an episode, PlaybackInfo, a ranged
// stream, the playing reports, PlayedItems, DisplayPreferences, Logout. Prints PASS / FAIL per step and ends with
// `ALL PASS` or `n FAILED`.
//
//   BASE=http://localhost:8797 USER=<name> APP_PASSWORD=<app password> node devtools/jellyfin-smoke.mjs
//
// The app password is made in Settings -> Apps (or POST /api/me/app-passwords). Never run this against :8787.
const BASE = (process.env.BASE || '').replace(/\/+$/, '');
const USER = process.env.USER_NAME || process.env.USER || '';
const PASSWORD = process.env.APP_PASSWORD || '';
if (!BASE || !USER || !PASSWORD) {
  console.error('Set BASE, USER and APP_PASSWORD, e.g. BASE=http://localhost:8797 USER=dallas APP_PASSWORD=... node devtools/jellyfin-smoke.mjs');
  process.exit(2);
}
if (/:8787(\/|$)/.test(BASE)) {
  console.error('This check does not run against port 8787 (the live server). Use a dev server on 8797.');
  process.exit(2);
}

const header = (token) => `MediaBrowser Client="Atomix smoke", Device="smoke", DeviceId="atomix-smoke", Version="1.0"${token ? `, Token="${token}"` : ''}`;
let token = null;
let failed = 0;

async function step(method, path, { query, body, headers, expect, json = true, check } = {}) {
  const url = `${BASE}/jellyfin${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const h = { Authorization: header(token), ...(headers || {}) };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  let status = 0;
  let data = null;
  let problem = '';
  try {
    const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    status = res.status;
    const text = await res.text();
    if (json && text) {
      try {
        data = JSON.parse(text);
      } catch {
        problem = 'not JSON';
      }
    }
    const good = expect ? status === expect : status >= 200 && status < 300;
    if (!good) problem ||= 'unexpected status';
    if (!problem && check) problem = check(data) || '';
  } catch (err) {
    problem = String(err.message || err);
  }
  if (problem) {
    failed++;
    console.log(`FAIL ${method} ${path} ${status}${problem === 'unexpected status' ? '' : ` (${problem})`}`);
  } else {
    console.log(`PASS ${method} ${path} ${status}`);
  }
  return data;
}

const info = await step('GET', '/System/Info/Public', { check: (d) => (d?.Id ? '' : 'no Id') });
await step('GET', '/Branding/Configuration');
await step('GET', '/QuickConnect/Enabled');
const auth = await step('POST', '/Users/AuthenticateByName', { body: { Username: USER, Pw: PASSWORD }, check: (d) => (d?.AccessToken ? '' : 'no token') });
if (!auth?.AccessToken) {
  console.log('1 FAILED (could not sign in; the other steps need it)');
  process.exit(1);
}
token = auth.AccessToken;
const user = auth.User.Id;
await step('POST', '/Sessions/Capabilities/Full', { body: { PlayableMediaTypes: ['Video'] } });
await step('GET', '/System/Info');
await step('GET', `/Users/${user}/Configuration`);
const views = await step('GET', `/Users/${user}/Views`);
await step('GET', '/Localization/ParentalRatings');
await step('GET', '/Genres', { query: { UserId: user } });

let film = null;
let show = null;
for (const view of views?.Items || []) {
  const types = view.CollectionType === 'tvshows' ? 'Series' : 'Movie';
  const page = await step('GET', `/Users/${user}/Items`, {
    query: { ParentId: view.Id, Recursive: 'true', Fields: 'Overview,Genres,MediaSources,ProviderIds', IncludeItemTypes: types, StartIndex: '0', Limit: '100' },
  });
  const first = page?.Items?.[0];
  if (first && types === 'Movie') film ||= first;
  if (first && types === 'Series') show ||= first;
}
await step('GET', `/Users/${user}/Items/Resume`, { query: { Limit: '12', MediaTypes: 'Video' } });
await step('GET', '/Shows/NextUp', { query: { UserId: user, Limit: '12' } });
await step('GET', `/Users/${user}/Items/Latest`, { query: { Limit: '16' } });

let episode = null;
if (show) {
  const seasons = await step('GET', `/Shows/${show.Id}/Seasons`, { query: { UserId: user } });
  const season = seasons?.Items?.[0];
  const eps = await step('GET', `/Shows/${show.Id}/Episodes`, { query: { UserId: user, ...(season ? { SeasonId: season.Id } : {}), Fields: 'Overview,MediaSources' } });
  episode = eps?.Items?.[0] || null;
} else {
  console.log('FAIL no TV show was found in the views');
  failed++;
}
const playable = episode || film;
if (!playable) {
  console.log('FAIL nothing playable was found');
  failed++;
} else {
  const id = playable.Id;
  await step('GET', `/Users/${user}/Items/${id}`);
  await step('GET', `/Items/${id}/Similar`, { query: { UserId: user, Limit: '12' } });
  await step('GET', `/Users/${user}/Items/${id}/Intros`);
  await step('GET', `/DisplayPreferences/home`, { query: { userId: user, client: 'smoke' } });
  await step('POST', `/DisplayPreferences/home`, { query: { userId: user, client: 'smoke' }, body: { SortBy: 'SortName', SortOrder: 'Ascending', CustomPrefs: {} } });
  await step('POST', `/Items/${id}/PlaybackInfo`, { query: { UserId: user }, body: { DeviceProfile: {} }, check: (d) => (d?.MediaSources?.length ? '' : 'no MediaSources') });
  await step('GET', `/Videos/${id}/stream`, { query: { Static: 'true', MediaSourceId: id }, headers: { Range: 'bytes=0-1023' }, expect: 206, json: false });
  await step('POST', '/Sessions/Playing', { body: { ItemId: id, MediaSourceId: id, PositionTicks: 0, CanSeek: true, IsPaused: false } });
  await step('POST', '/Sessions/Playing/Progress', { body: { ItemId: id, PositionTicks: 10000000, IsPaused: false } });
  await step('POST', '/Sessions/Playing/Stopped', { body: { ItemId: id, PositionTicks: 15000000 } });
  await step('POST', `/Users/${user}/PlayedItems/${id}`);
  await step('DELETE', `/Users/${user}/PlayedItems/${id}`); // leaves the watched mark as it was
}
await step('POST', '/Sessions/Logout', { json: false });
await step('GET', '/Users/Me', { expect: 401, json: false }); // the token is gone

console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
