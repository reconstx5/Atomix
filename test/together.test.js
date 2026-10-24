// Watch together rooms on a fake clock: codes, play/pause/seek for everyone, waiting for slow members, buffering,
// the last action winning, Kids refused, the 8-person limit, closed streams, the end and the next episode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rooms, makeCode, CODE_ALPHABET } from '../src/together.js';

const ITEMS = { 1: { id: 1, kind: 'movie', title: 'Film' }, 2: { id: 2, kind: 'episode', title: 'Ep 1' }, 3: { id: 3, kind: 'episode', title: 'Ep 2' }, 4: { id: 4, kind: 'track', title: 'Song' }, 5: { id: 5, kind: 'movie', title: 'Scary' } };

function setup() {
  const clock = { t: 1_000_000 };
  const library = { get: (id) => ITEMS[id] || null, canSee: (viewer, row) => !(viewer.kids && (row.id === 5 || row.id === 3)) };
  const rooms = new Rooms({ library, now: () => clock.t });
  let n = 0;
  const who = (name, kids = false) => ({ user: { id: ++n }, profile: { id: n, name }, viewer: { profileId: n, kids } });
  const sent = new Map(); // member id -> states received
  const listen = (room, member) => {
    sent.set(member.id, []);
    return rooms.connect(room.code, member.id, (s) => sent.get(member.id).push(s));
  };
  const last = (member) => sent.get(member.id).at(-1);
  return { clock, rooms, who, listen, last, sent };
}

/** A room for `item` with A (who made it) and B, both listening. */
function pair(s, item = ITEMS[1]) {
  const { room, member: a } = s.rooms.create({ ...s.who('A'), item });
  const { member: b } = s.rooms.join(room.code, s.who('B'));
  const offA = s.listen(room, a);
  const offB = s.listen(room, b);
  return { room, a, b, offA, offB };
}

test('codes use the alphabet', () => {
  assert.equal(CODE_ALPHABET, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
  for (let i = 0; i < 200; i++) assert.match(makeCode(), /^[A-HJ-NP-Z2-9]{6}$/);
});

test('play and pause apply to all', () => {
  const s = setup();
  const { room, a, b } = pair(s);
  assert.equal(s.last(a).members.length, 2);
  s.rooms.act(room.code, a.id, 'play', { position: 10 });
  assert.equal(s.last(b).playing, false);
  assert.deepEqual(s.last(b).waitingFor.sort(), ['A', 'B']);
  s.rooms.act(room.code, a.id, 'ready');
  s.rooms.act(room.code, b.id, 'ready');
  let st = s.last(b);
  assert.equal(st.playing, true);
  assert.equal(st.position, 10);
  assert.equal(st.at, s.clock.t);
  assert.deepEqual(st.waitingFor, []);
  s.clock.t += 4000;
  s.rooms.act(room.code, b.id, 'pause', { position: 14 });
  st = s.last(a);
  assert.equal(st.playing, false);
  assert.equal(st.position, 14);
  assert.equal(st.last.name, 'B');
  assert.equal(st.last.action, 'paused');
  assert.equal(st.last.member, b.id);
  assert.deepEqual({ ...s.last(a), members: null }, { ...s.last(b), members: null }, 'everyone gets the same room');
  assert.equal(s.last(a).members.find((m) => m.you).name, 'A');
});

test('waiting for a slow member', () => {
  const s = setup();
  const { room, a, b } = pair(s);
  s.rooms.act(room.code, a.id, 'seek', { position: 30 });
  s.rooms.act(room.code, a.id, 'play', { position: 30 });
  s.rooms.act(room.code, a.id, 'ready');
  assert.deepEqual(s.last(a).waitingFor, ['B']);
  assert.equal(s.last(a).playing, false);
  s.clock.t += 9000;
  s.rooms.tick();
  assert.equal(s.last(a).playing, false);
  s.clock.t += 1500;
  s.rooms.tick();
  assert.equal(s.last(a).playing, true, 'after 10 s the room starts anyway');
  assert.ok(s.last(a).members.some((m) => m.name === 'B'), 'B is still in the room');
  assert.equal(b.id.length > 10, true);
});

test('buffering pauses the room', () => {
  const s = setup();
  const { room, a, b } = pair(s);
  s.rooms.act(room.code, a.id, 'play', { position: 0 });
  s.rooms.act(room.code, a.id, 'ready');
  s.rooms.act(room.code, b.id, 'ready');
  s.clock.t += 5000;
  s.rooms.act(room.code, b.id, 'buffering');
  let st = s.last(a);
  assert.equal(st.playing, false);
  assert.equal(st.position, 5);
  assert.deepEqual(st.waitingFor, ['B']);
  s.clock.t += 2000;
  s.rooms.act(room.code, b.id, 'ready');
  st = s.last(a);
  assert.equal(st.playing, true);
  assert.equal(st.position, 5);
  assert.equal(st.at, s.clock.t);
});

test('last action wins and nobody echoes', () => {
  const s = setup();
  const { room, a, b } = pair(s);
  s.rooms.act(room.code, a.id, 'play', { position: 0 });
  s.rooms.act(room.code, a.id, 'ready');
  s.rooms.act(room.code, b.id, 'ready');
  s.rooms.act(room.code, a.id, 'pause', { position: 3 });
  s.rooms.act(room.code, b.id, 'play', { position: 3 });
  const st = s.last(a);
  assert.equal(st.last.action, 'played');
  assert.equal(st.last.member, b.id, "B's play was last");
  assert.equal(s.last(b).last.member, b.id, "B's own action comes back marked as B's");
});

test('a profile that may not see the title is refused', () => {
  const s = setup();
  const { room } = s.rooms.create({ ...s.who('A'), item: ITEMS[5] });
  assert.throws(() => s.rooms.join(room.code, s.who('Kid', true)), { status: 403, message: "This title isn't available on your profile" });
  assert.equal(s.rooms.state(room.code).members.length, 1);
  assert.throws(() => s.rooms.join('ZZZZZZ', s.who('X')), { status: 404, message: 'This Watch together room has ended.' });
});

test('up to 8 people', () => {
  const s = setup();
  const { room } = s.rooms.create({ ...s.who('A'), item: ITEMS[1] });
  for (let i = 0; i < 7; i++) s.rooms.join(room.code, s.who(`M${i}`));
  assert.throws(() => s.rooms.join(room.code, s.who('Ninth')), { status: 409, message: 'This room is full (8 people).' });
});

test('joining again from the same profile is the same member', () => {
  const s = setup();
  const a = s.who('A');
  const { room, member } = s.rooms.create({ ...a, item: ITEMS[1] });
  assert.equal(s.rooms.join(room.code, a).member.id, member.id);
  assert.equal(s.rooms.state(room.code).members.length, 1);
});

test('a closed stream leaves the room', () => {
  const s = setup();
  const { room, a, b, offA, offB } = pair(s);
  s.rooms.act(room.code, a.id, 'play', { position: 0 });
  s.rooms.act(room.code, a.id, 'ready');
  offB();
  assert.equal(s.last(a).playing, true, 'a gone member is not waited for');
  s.clock.t += 31_000;
  s.rooms.tick();
  assert.deepEqual(s.last(a).members.map((m) => m.name), ['A']);
  assert.equal(s.last(a).last.action, 'left');
  assert.equal(s.last(a).last.name, 'B');
  assert.throws(() => s.rooms.act(room.code, b.id, 'pause', { position: 1 }), { status: 403, message: "You're not in this room." });
  offA();
  s.clock.t += 9 * 60_000;
  s.rooms.tick();
  assert.ok(s.rooms.state(room.code), 'kept a while with nobody connected');
  s.clock.t += 61_000;
  s.rooms.tick();
  assert.throws(() => s.rooms.state(room.code), { status: 404 });
});

test('the last to leave ends the room', () => {
  const s = setup();
  const { room, a, b } = pair(s);
  s.rooms.leave(room.code, b.id);
  assert.equal(s.last(a).last.action, 'left');
  s.rooms.leave(room.code, a.id);
  assert.throws(() => s.rooms.state(room.code), { status: 404 });
});

test('the end and the next episode', () => {
  const s = setup();
  const { room, member: a } = s.rooms.create({ ...s.who('A'), item: ITEMS[2] });
  const { member: k } = s.rooms.join(room.code, s.who('Kid', true));
  s.listen(room, a);
  s.listen(room, k);
  s.rooms.act(room.code, a.id, 'play', { position: 100 });
  s.rooms.act(room.code, a.id, 'ready');
  s.rooms.act(room.code, k.id, 'ready');
  s.rooms.act(room.code, k.id, 'ended');
  assert.equal(s.last(a).ended, true);
  assert.equal(s.last(a).playing, false);
  s.rooms.act(room.code, a.id, 'next', { itemId: 3 });
  const st = s.last(a);
  assert.equal(st.itemId, 3);
  assert.equal(st.position, 0);
  assert.equal(st.ended, false);
  assert.deepEqual(st.members.map((m) => m.name), ['A'], "the kid can't see Ep 2");
  assert.equal(s.last(k).removed, "This title isn't available on your profile");
  assert.throws(() => s.rooms.act(room.code, a.id, 'next', { itemId: 4 }), { status: 400, message: 'Watch together is for films and episodes.' });
});

test('films and episodes only', () => {
  const s = setup();
  assert.throws(() => s.rooms.create({ ...s.who('A'), item: ITEMS[4] }), { status: 400, message: 'Watch together is for films and episodes.' });
});

// ---- v0.21 tidy-up ----
function withNext() {
  const s = setup();
  // Ep 1 → Ep 2 is the show's order; a playlist (listId 7) goes Film → Ep 2.
  const fresh = new Map(); // profile id → the viewer as it is now
  s.rooms.nextOf = (room, current) => (room.listId === 7 ? (current.id === 1 ? ITEMS[3] : null) : current.id === 2 ? ITEMS[3] : null);
  s.rooms.viewerOf = (m) => fresh.get(m.profileId) || null;
  return { ...s, fresh };
}

test('next only takes the show\'s next episode (or the playlist\'s next)', () => {
  const s = withNext();
  const { room, member: a } = s.rooms.create({ ...s.who('A'), item: ITEMS[2] });
  s.listen(room, a);
  assert.throws(() => s.rooms.act(room.code, a.id, 'next', { itemId: 1 }), { status: 400, message: "That isn't the next episode." });
  s.rooms.act(room.code, a.id, 'next', { itemId: 3 });
  assert.equal(s.last(a).itemId, 3);
  const film = s.rooms.create({ ...s.who('C'), item: ITEMS[1], listId: 7 });
  s.listen(film.room, film.member);
  s.rooms.act(film.room.code, film.member.id, 'next', { itemId: 3 });
  assert.equal(s.last(film.member).itemId, 3, "the playlist's next");
});

test('next re-reads each member\'s rules as they are now', () => {
  const s = withNext();
  const { room, member: a } = s.rooms.create({ ...s.who('A'), item: ITEMS[2] });
  const kid = s.who('Kid', false); // joined as a grown-up profile…
  const { member: k } = s.rooms.join(room.code, kid);
  s.listen(room, a);
  s.listen(room, k);
  s.fresh.set(kid.profile.id, { profileId: kid.profile.id, kids: true }); // …made a Kids profile since
  s.rooms.act(room.code, a.id, 'next', { itemId: 3 });
  assert.deepEqual(s.last(a).members.map((m) => m.name), ['A']);
  assert.equal(s.last(k).removed, "This title isn't available on your profile");
});

test('the room tells each member the next title it accepts (a playlist room follows its list for everyone)', () => {
  const s = withNext();
  const film = s.rooms.create({ ...s.who('C'), item: ITEMS[1], listId: 7 });
  const { member: d } = s.rooms.join(film.room.code, s.who('D'));
  s.listen(film.room, film.member);
  s.listen(film.room, d);
  assert.equal(s.last(d).nextItemId, 3, 'a member who joined by code is told the playlist\'s next');
  s.rooms.act(film.room.code, d.id, 'next', { itemId: s.last(d).nextItemId });
  assert.equal(s.last(film.member).itemId, 3);
});
