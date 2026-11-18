// Jellyfin apps' playing sessions: one stream slot per signed-in device (per token). Every range read of that device
// shares the slot, and reading another title moves the slot to it (Infuse pre-reads files and jumps to the next
// episode); it never opens a second one. The slots count toward the account's cap of open streams, shared with web
// playback, Live TV and casting (registered in playback.externalLists, as LiveDrm does). A slot ends with
// Sessions/Playing/Stopped, Sessions/Logout, or `idleMs` of silence (the reaper).
import crypto from 'node:crypto';
import { HttpError } from './index.js';
import { MAX_SESSIONS_PER_USER } from '../stream/playback.js';

const clientName = (c) => [c?.client, c?.device].filter(Boolean).join(' on ') || 'Jellyfin app';

export class JellyfinSessions {
  constructor({ playback, now = Date.now, idleMs = 120_000 }) {
    this.playback = playback;
    this.now = now;
    this.idleMs = idleMs;
    this.sessions = new Map(); // token row id -> session
    this.timer = setInterval(() => this.reap(), 15_000);
    this.timer.unref?.();
    (playback.externalLists ||= []).push((userId) => [...this.sessions.values()].filter((s) => s.userId === userId));
  }

  /** The token's slot, moved to `item` and touched; a new one when the token has none (429 at the account's cap). */
  open({ tokenRow, user, profile, item, clientIp = null, client = null }) {
    const existing = this.sessions.get(tokenRow.id);
    if (existing && existing.userId === user.id) {
      if (existing.itemId !== item.id) Object.assign(existing, { itemId: item.id, title: item.title, position: 0, paused: false });
      existing.lastSeen = this.now();
      return existing;
    }
    if (existing) this.stop(tokenRow.id);
    if (this.playback.sessionsOf(user.id).length >= MAX_SESSIONS_PER_USER) throw new HttpError(429, 'Too many streams open on this account.');
    const s = {
      id: `jf-${crypto.randomBytes(8).toString('hex')}`,
      tokenId: tokenRow.id,
      userId: user.id,
      username: user.username,
      profileId: profile?.id ?? null,
      itemId: item.id,
      title: item.title,
      mode: 'direct',
      position: 0,
      paused: false,
      createdAt: this.now(),
      lastSeen: this.now(),
      clientIp,
      client: clientName(client),
    };
    this.sessions.set(tokenRow.id, s);
    return s;
  }

  /** Keeps the token's slot alive (a progress report, a ping); a token with no slot is left alone. */
  touch(tokenId, { position, paused } = {}) {
    const s = this.sessions.get(tokenId);
    if (!s) return null;
    s.lastSeen = this.now();
    if (Number.isFinite(position)) s.position = position;
    if (typeof paused === 'boolean') s.paused = paused;
    return s;
  }

  stop(tokenId) {
    this.sessions.delete(tokenId);
  }

  /** Ends a slot by its dashboard id (`jf-…`); false when none has it. */
  stopById(id) {
    for (const [tokenId, s] of this.sessions) {
      if (s.id === id) { this.stop(tokenId); return true; }
    }
    return false;
  }

  reap() {
    const now = this.now();
    for (const [tokenId, s] of this.sessions) if (now - s.lastSeen > this.idleMs) this.stop(tokenId);
  }

  /** The admin dashboard's rows (shaped like PlaybackManager.publicSession). */
  list() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      user: s.username,
      itemId: s.itemId,
      title: s.title,
      mode: 'direct',
      delivery: 'jellyfin',
      position: s.position,
      paused: s.paused,
      startedAt: s.createdAt,
      clientIp: s.clientIp,
      castDevice: null,
      transcoding: false,
      client: s.client,
    }));
  }

  close() {
    clearInterval(this.timer);
    this.sessions.clear();
  }
}
