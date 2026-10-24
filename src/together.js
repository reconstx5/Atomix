// Watch together: rooms where up to 8 people watch the same film or episode in step, each with their own playback
// session. The room keeps the truth — a position at a time, playing or paused, who's ready — and every member's player
// follows it. Play and seek wait until everyone can play from there (or 10 s pass); someone buffering pauses the room
// for them. Rooms live in memory: one ends when its last member leaves, or after 10 minutes with nobody connected.
import crypto from 'node:crypto';
import { HttpError } from './http/router.js';

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I: easy to read off a TV
const MAX_MEMBERS = 8;
const GONE_MS = 30_000;
const PLAYABLE = new Set(['movie', 'episode']);

export const SENTENCES = {
  ended: 'This Watch together room has ended.',
  hidden: "This title isn't available on your profile",
  full: `This room is full (${MAX_MEMBERS} people).`,
  kind: 'Watch together is for films and episodes.',
  notYours: "You're not in this room.",
  notNext: "That isn't the next episode.",
};

/** A random code from the alphabet (32 letters: 5 bits each, no bias). */
export function makeCode(length = 6) {
  return [...crypto.randomBytes(length)].map((b) => CODE_ALPHABET[b & 31]).join('');
}

export class Rooms {
  /**
   * nextOf(room, current): what may follow the title playing (the show's next episode, or the room's playlist's next);
   * viewerOf(member): the member's rules as they are now (a profile can change while the room runs).
   */
  constructor({ library, now = Date.now, waitMs = 10_000, emptyMs = 10 * 60_000, nextOf = null, viewerOf = null }) {
    Object.assign(this, { library, now, waitMs, emptyMs, nextOf, viewerOf });
    this.rooms = new Map();
  }

  get(code) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    if (!room) throw new HttpError(404, SENTENCES.ended);
    return room;
  }
  member(room, id) {
    const m = room.members.get(String(id || ''));
    if (!m) throw new HttpError(403, SENTENCES.notYours);
    return m;
  }

  create({ user, profile, viewer, item, position = 0, playing = false, listId = null }) {
    if (!item || !PLAYABLE.has(item.kind)) throw new HttpError(400, SENTENCES.kind);
    if (!this.library.canSee(viewer, item)) throw new HttpError(403, SENTENCES.hidden);
    let code;
    do code = makeCode();
    while (this.rooms.has(code));
    const room = { code, itemId: item.id, listId: listId ? Number(listId) : null, playing: Boolean(playing), position: Math.max(0, Number(position) || 0), at: this.now(), pending: false, waiting: new Set(), waitSince: 0, members: new Map(), last: null, ended: false, emptySince: this.now() };
    this.rooms.set(code, room);
    const member = this.addMember(room, { user, profile, viewer });
    return { room: this.state(code, member.id), member: { id: member.id } };
  }

  addMember(room, { user, profile, viewer }) {
    for (const m of room.members.values()) if (m.profileId === profile.id && m.userId === user.id) return m;
    if (room.members.size >= MAX_MEMBERS) throw new HttpError(409, SENTENCES.full);
    const m = { id: crypto.randomBytes(16).toString('base64url'), userId: user.id, profileId: profile.id, name: profile.name, viewer, connected: 0, goneSince: this.now(), sends: new Set() };
    room.members.set(m.id, m);
    return m;
  }

  join(code, who) {
    const room = this.get(code);
    const item = this.library.get(room.itemId);
    if (!item || !this.library.canSee(who.viewer, item)) throw new HttpError(403, SENTENCES.hidden);
    const known = [...room.members.values()].some((m) => m.profileId === who.profile.id && m.userId === who.user.id);
    const member = this.addMember(room, who);
    if (!known) this.note(room, member, 'joined');
    this.broadcast(room);
    return { room: this.state(room.code, member.id), member: { id: member.id } };
  }

  /** Where the room is now (a playing room moves on with the clock). */
  positionNow(room) {
    return room.playing ? room.position + (this.now() - room.at) / 1000 : room.position;
  }
  note(room, m, action) {
    room.last = { name: m.name, member: m.id, action, at: this.now() };
  }
  /** Wait for every connected member (or start at once when none is left to wait for). */
  waitAll(room) {
    room.pending = true;
    room.playing = false;
    room.waiting = new Set([...room.members.values()].filter((m) => m.connected).map((m) => m.id));
    room.waitSince = this.now();
    this.maybeStart(room);
  }
  maybeStart(room) {
    if (!room.pending || room.waiting.size) return;
    room.pending = false;
    room.playing = true;
    room.at = this.now();
  }

  act(code, memberId, action, payload = {}) {
    const room = this.get(code);
    const m = this.member(room, memberId);
    const pos = Number(payload.position);
    const at = Number.isFinite(pos) && pos >= 0 ? pos : null;
    switch (action) {
      case 'play':
        if (at != null) room.position = at;
        else room.position = this.positionNow(room);
        room.ended = false;
        this.note(room, m, 'played');
        this.waitAll(room);
        break;
      case 'pause':
        room.position = at ?? this.positionNow(room);
        room.playing = false;
        room.pending = false;
        room.waiting.clear();
        this.note(room, m, 'paused');
        break;
      case 'seek': {
        const was = room.playing || room.pending;
        room.position = at ?? this.positionNow(room);
        room.at = this.now();
        room.ended = false;
        this.note(room, m, 'seeked');
        if (was) this.waitAll(room);
        break;
      }
      case 'ready':
        room.waiting.delete(m.id);
        this.maybeStart(room);
        break;
      case 'buffering':
        if (room.playing) {
          room.position = this.positionNow(room);
          room.playing = false;
          room.pending = true;
          room.waiting = new Set([m.id]);
          room.waitSince = this.now();
        }
        break;
      case 'ended':
        room.position = this.positionNow(room);
        room.playing = false;
        room.pending = false;
        room.waiting.clear();
        room.ended = true;
        this.note(room, m, 'ended');
        break;
      case 'next': {
        const item = this.library.get(Number(payload.itemId));
        if (!item || !PLAYABLE.has(item.kind)) throw new HttpError(400, SENTENCES.kind);
        // Only what follows the title playing: the show's next episode, or the room's playlist's next.
        if (this.nextOf) {
          const current = this.library.get(room.itemId);
          if (!current || this.nextOf(room, current, m.viewer)?.id !== item.id) throw new HttpError(400, SENTENCES.notNext);
        }
        for (const other of room.members.values()) other.viewer = this.viewerOf?.(other) || other.viewer;
        if (!this.library.canSee(m.viewer, item)) throw new HttpError(403, SENTENCES.hidden);
        for (const other of [...room.members.values()]) {
          if (this.library.canSee(other.viewer, item)) continue;
          for (const send of other.sends) send({ ...this.state(room.code, other.id), removed: SENTENCES.hidden });
          room.members.delete(other.id);
        }
        room.itemId = item.id;
        room.position = 0;
        room.at = this.now();
        room.ended = false;
        this.note(room, m, 'next');
        this.waitAll(room);
        break;
      }
      case 'leave':
        return this.leave(code, memberId);
      default:
        throw new HttpError(404, 'Unknown Watch together action');
    }
    this.broadcast(room);
    return this.state(room.code, m.id);
  }

  leave(code, memberId) {
    const room = this.get(code);
    const m = this.member(room, memberId);
    this.remove(room, m);
    return null;
  }
  remove(room, m) {
    room.members.delete(m.id);
    room.waiting.delete(m.id);
    if (!room.members.size) {
      this.rooms.delete(room.code);
      return;
    }
    this.note(room, m, 'left');
    this.maybeStart(room);
    this.broadcast(room);
  }

  /** A member's event stream: sends the room now and on every change; the returned function disconnects it. */
  connect(code, memberId, send) {
    const room = this.get(code);
    const m = this.member(room, memberId);
    m.connected++;
    m.sends.add(send);
    send(this.state(room.code, m.id));
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      m.sends.delete(send);
      m.connected = Math.max(0, m.connected - 1);
      if (!m.connected) {
        m.goneSince = this.now();
        if (room.waiting.delete(m.id)) {
          this.maybeStart(room);
          if (this.rooms.get(room.code) === room) this.broadcast(room);
        }
        if (![...room.members.values()].some((x) => x.connected)) room.emptySince = this.now();
      }
    };
  }

  state(code, memberId = null) {
    const room = this.get(code);
    const names = (ids) => [...ids].map((id) => room.members.get(id)?.name).filter(Boolean);
    return {
      code: room.code,
      itemId: room.itemId,
      playing: room.playing,
      position: Math.round(room.position * 1000) / 1000,
      at: room.at,
      serverNow: this.now(),
      waitingFor: room.pending ? names(room.waiting) : [],
      members: [...room.members.values()].map((m) => ({ id: m.id, name: m.name, ready: !room.waiting.has(m.id), connected: m.connected > 0, you: m.id === memberId })),
      last: room.last,
      ended: room.ended,
      nextItemId: this.nextFor(room, memberId), // what this member's "next" sends (the room's playlist, else the show)
    };
  }
  nextFor(room, memberId) {
    if (!this.nextOf) return null;
    const current = this.library.get(room.itemId);
    const m = memberId && room.members.get(memberId);
    try {
      return (current && this.nextOf(room, current, m?.viewer || null)?.id) ?? null;
    } catch {
      return null;
    }
  }

  broadcast(room) {
    for (const m of room.members.values()) for (const send of m.sends) send(this.state(room.code, m.id));
  }

  /** Once a second: start rooms that waited 10 s, drop members gone 30 s, close rooms nobody's watched for 10 min. */
  tick() {
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      if (room.pending && room.waiting.size && now - room.waitSince >= this.waitMs) {
        room.waiting.clear();
        this.maybeStart(room);
        this.broadcast(room);
      }
      const anyone = [...room.members.values()].some((m) => m.connected);
      if (anyone) {
        for (const m of [...room.members.values()]) if (!m.connected && now - m.goneSince >= GONE_MS) this.remove(room, m);
      } else if (now - room.emptySince >= this.emptyMs) this.rooms.delete(room.code);
    }
  }
}
