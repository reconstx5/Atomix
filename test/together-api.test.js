// Watch together over HTTP: start a room, join from another account, the event stream, actions reaching the other
// member, Kids refused on an R16 film, member ids bound to their profile, an ended room.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
let nf;
let admin;
let guest;
let kid;
const ids = {};

before(async () => {
  if (!hasFfmpeg) return;
  const m = path.join(media, 'Movies');
  for (const [folder, rating] of [['Cartoon (2020)', 'NZ:G'], ['Scary (2018)', 'R16']]) {
    makeVideo(path.join(m, folder, `${folder}.mp4`));
    fs.writeFileSync(path.join(m, folder, `${folder}.nfo`), `<movie><title>${folder.replace(/ \(\d+\)$/, '')}</title><mpaa>${rating}</mpaa></movie>`);
  }
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  ids.movies = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [m] })).data.id;
  await waitForScan(admin);
  for (const it of (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items) ids[it.title] = it.id;
  await admin.post('/api/users', { username: 'guest', password: 'guestpass1' });
  guest = client(nf.base);
  await guest.post('/api/auth/login', { username: 'guest', password: 'guestpass1' });
  const gp = (await guest.get('/api/profiles')).data[0];
  await guest.post(`/api/profiles/${gp.id}/select`, {});
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
});

after(async () => {
  await nf?.app.stop();
});

/** Read an event stream; `next()` resolves with the next state. */
async function events(who, code, member) {
  const ac = new AbortController();
  const res = await fetch(`${nf.base}/api/together/${code}/events?member=${encodeURIComponent(member)}`, { headers: { cookie: who.cookie }, signal: ac.signal });
  const states = [];
  const waiters = [];
  if (res.ok) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (!data) continue;
            const s = JSON.parse(data.slice(6));
            states.push(s);
            waiters.splice(0).forEach((w) => w());
          }
        }
      } catch {
        /* aborted */
      }
    })();
  }
  const next = async (pred = () => true, ms = 3000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const s = states.find(pred);
      if (s) return s;
      if (Date.now() > deadline) throw new Error(`no matching state in ${ms} ms: ${JSON.stringify(states.at(-1))}`);
      await new Promise((r) => {
        waiters.push(r);
        setTimeout(r, 100);
      });
    }
  };
  return { res, states, next, close: () => ac.abort() };
}

test('start, join and follow each other', { skip }, async () => {
  const made = await admin.post('/api/together', { itemId: ids.Cartoon });
  assert.equal(made.status, 200);
  assert.match(made.data.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(made.data.itemId, ids.Cartoon);
  const code = made.data.code;
  const joined = await guest.post(`/api/together/${code.toLowerCase()}/join`, {});
  assert.equal(joined.status, 200, 'codes work in any case');
  const a = await events(admin, code, made.data.member);
  const b = await events(guest, code, joined.data.member);
  assert.match(a.res.headers.get('content-type'), /^text\/event-stream/);
  const two = await a.next((s) => s.members.length === 2);
  assert.deepEqual(two.members.map((m) => m.name).sort(), ['dallas', 'guest']);
  assert.equal(two.members.find((m) => m.you).name, 'dallas');
  await guest.post(`/api/together/${code}/pause`, { member: joined.data.member, position: 12 });
  const paused = await a.next((s) => s.last?.action === 'paused');
  assert.equal(paused.position, 12);
  assert.equal(paused.last.name, 'guest');
  await admin.post(`/api/together/${code}/play`, { member: made.data.member, position: 12 });
  await admin.post(`/api/together/${code}/ready`, { member: made.data.member });
  await guest.post(`/api/together/${code}/ready`, { member: joined.data.member });
  assert.equal((await b.next((s) => s.playing)).position, 12);
  assert.equal((await guest.post(`/api/together/${code}/pause`, { member: made.data.member })).status, 403, "a member id is its own profile's");
  assert.equal((await guest.post(`/api/together/${code}/pause`, { member: made.data.member })).data.error, "You're not in this room.");
  await guest.post(`/api/together/${code}/leave`, { member: joined.data.member });
  assert.equal((await a.next((s) => s.last?.action === 'left')).members.length, 1);
  a.close();
  b.close();
  await admin.post(`/api/together/${code}/leave`, { member: made.data.member });
  assert.equal((await events(admin, code, made.data.member)).res.status, 404, 'an ended room');
  assert.equal((await guest.post(`/api/together/${code}/join`, {})).data.error, 'This Watch together room has ended.');
});

test('a profile that may not see the title is refused', { skip }, async () => {
  const made = (await admin.post('/api/together', { itemId: ids.Scary })).data;
  const r = await kid.post(`/api/together/${made.code}/join`, {});
  assert.equal(r.status, 403);
  assert.equal(r.data.error, "This title isn't available on your profile");
  assert.equal((await kid.post('/api/together', { itemId: ids.Scary })).status, 404, "a kid can't start one either");
  await admin.post(`/api/together/${made.code}/leave`, { member: made.member });
});

test('stopping Atomix ends open event streams', { skip }, async () => {
  const other = await startAtomix();
  const c = client(other.base);
  await c.post('/api/setup', { username: 'dallas', password: 'password123' });
  // No titles needed: a stream for an open room is enough. Make one through the store directly.
  const core = other.app.core;
  const profile = core.db.get('SELECT * FROM profiles LIMIT 1');
  const user = core.db.get('SELECT * FROM users LIMIT 1');
  core.together.library = { get: () => ({ id: 1, kind: 'movie' }), canSee: () => true };
  const { room, member } = core.together.create({ user, profile, viewer: core.profiles.viewer(user, profile), item: { id: 1, kind: 'movie' } });
  await c.post(`/api/profiles/${profile.id}/select`, { pin: '' });
  const res = await fetch(`${other.base}/api/together/${room.code}/events?member=${member.id}`, { headers: { cookie: c.cookie } });
  assert.equal(res.status, 200);
  const started = Date.now();
  await other.app.stop();
  assert.ok(Date.now() - started < 8000, 'stop did not hang on the open stream');
});
