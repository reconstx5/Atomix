// Adds the people the title-page checks need to the dev Atomix, if they aren't there yet: a non-admin user guest /
// atomix-dev-guest, and under guest a Kids profile "Kids" (dallas keeps one profile). Running it again changes nothing.
//   BASE=http://localhost:8797 node devtools/item-users.mjs
const BASE = process.env.BASE;
if (!BASE || /:8787/.test(BASE)) {
  console.log('Set BASE to the dev Atomix (for example http://localhost:8797). This adds a profile and a user, so it will not run against the default or the live server on port 8787.');
  process.exit(2);
}

async function signIn(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (!r.ok) throw new Error(`Couldn't sign in as ${username} (${r.status}).`);
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return async (method, url, body) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
    return res.json();
  };
}

// dallas keeps one profile: a second one would make every dev check stop at "Choose who is watching".
const admin = await signIn('dallas', 'atomix-dev-1');
const users = await admin('GET', '/api/users');
if (users.some((u) => u.username === 'guest')) console.log('guest user: already there');
else { await admin('POST', '/api/users', { username: 'guest', password: 'atomix-dev-guest', role: 'user' }); console.log('guest user: added'); }

const guest = await signIn('guest', 'atomix-dev-guest');
const profiles = await guest('GET', '/api/profiles');
if (profiles.some((p) => p.name === 'Kids')) console.log('Kids profile: already there');
else { await guest('POST', '/api/profiles', { name: 'Kids', kids: true }); console.log('Kids profile: added'); }
