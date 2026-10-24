// Turns a Live TV channel, or a programme from a channel's archive, into a playback session. The source (plugin)
// hands over the provider's address and headers; they stay on the server. Providers allow only so many streams
// at once, so each source's limit is checked here — with a reservation taken before any waiting, so two people
// pressing play at the same moment can't both get past it.
import crypto from 'node:crypto';
import { HttpError } from '../http/router.js';
import { probe } from '../library/probe.js';
import { decide, MAX_SESSIONS_PER_USER } from '../stream/playback.js';
import { withTimeout, RESOLVE_TIMEOUT_MS } from './timeout.js';

const VIEWER_IDLE_MS = 2 * 60_000; // a tuner viewer whose player stopped pinging
export const NO_REWIND = "Rewind isn't available on this channel";
export const EVERY_STREAM_RECORDING = "Couldn't record: every stream is recording";

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_REUSE_MS = 10 * 60_000; // a channel's stream check is reused this long: one provider connection per start
const isNetworkUrl = (u) => /^https?:\/\/[^/]/i.test(String(u || ''));

/** Where a conversion restarts after a provider drop: the new run's live point (2 pieces back), but never further
 *  back than the new run itself — reaching into the old run would replay what was already seen. */
export function piecesAfterRun(tuner) {
  const n = tuner.runs?.at(-1)?.pieces.length || 0;
  return Math.max(1, Math.min(2, n));
}

export class LiveStreams {
  constructor({ store, plugins, playback, config, log, now = Date.now, tuners = null }) {
    Object.assign(this, { store, plugins, playback, config, log, now, tuners });
    this.resolveTimeoutMs = RESOLVE_TIMEOUT_MS; // a source's stream() that never answers
    this.reserved = new Map(); // source key -> starts in progress
    this.probes = new Map(); // "source\0channel" -> { at, url, media, channelId }
    // Other kinds of live stream count toward a source's limit and an account's cap too (encrypted sessions, tuner
    // viewers): each kind adds its list here.
    this.openSources = []; // (sourceKey) => streams open on the source
    this.stoppers = []; // (id, reason) => true when it stopped one of its own
    this.viewers = new Map(); // tuner viewer id → viewer (the browser plays the tuner's buffer itself)
    this.ended = new Map(); // viewer id → { error, at } (the next ping hears why)
    this.offs = new Map(); // viewer or session id → what it listens to on its tuner (taken off when it goes)
    if (playback) {
      playback.externalLists ||= [];
      playback.externalLists.push((userId) => [...this.viewers.values()].filter((v) => v.userId === userId));
      // A conversion from a tuner's buffer that stops lets go of its hold.
      playback.hooks?.on?.('playback:stop', ({ session }) => {
        this.unlisten(session.id);
        this.tuners?.release(session.id);
      });
    }
    this.stoppers.push((id, reason) => (this.viewers.has(id) ? (this.viewerStop(id, reason), true) : false));
    this.reaper = setInterval(() => this.reapViewers(), 15_000);
    this.reaper.unref?.();
    // A channel whose stream drops may have changed format: its next start checks the stream again.
    if (playback) playback.onLiveDropped = (session) => this.forgetProbe(session.live);
  }

  /** Forget a channel's reused stream check. */
  forgetProbe(live) {
    if (!live) return;
    for (const [k, p] of this.probes) if (k.startsWith(`${live.sourceKey}\0`) && p.channelId === live.channelId) this.probes.delete(k);
  }

  /**
   * Live and catch-up streams open on a source. A tuner counts once however many watch or record it (an idle one
   * no-one holds isn't counted: it closes for the next channel); conversions riding on a tuner aren't counted again.
   */
  openOn(sourceKey) {
    const own = [...this.playback.sessions.values()].filter((s) => s.live?.sourceKey === sourceKey && !s.live?.tunerKey);
    const tuned = (this.tuners?.list() || [])
      .filter((t) => t.key.startsWith(`${sourceKey}\0`) && t.holders.length)
      .map((t) => {
        const people = t.holders.map((h) => this.holderInfo(h)).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
        const newest = people[0] || {};
        return { ...newest, id: `tuner:${t.key}`, tunerKey: t.key, holderIds: t.holders.map((h) => h.id), people, live: newest.live || { sourceKey, channelName: t.label } };
      });
    return [...own, ...tuned, ...this.openSources.flatMap((fn) => fn(sourceKey))];
  }

  /** Who a tuner holder is (a viewer, a conversion, or a recording — which no-one's press may stop). */
  holderInfo(h) {
    if (h.kind === 'recording') return h.info ? { ...h.info, recording: true } : null;
    const v = this.viewers.get(h.id) || this.playback.sessions.get(h.id);
    if (v) return { id: v.id, userId: v.userId, profileId: v.profileId, username: v.username, createdAt: v.createdAt, live: v.live };
    return h.info || null;
  }

  /** Stop a viewer's stream (any kind) and have its player say `sentence`; a tuner: every viewer on it. */
  stopFor(id, sentence) {
    id = String(id);
    if (id.startsWith('tuner:')) {
      const t = this.tuners?.get(id.slice(6));
      for (const h of t ? [...t.holders.values()] : []) if (h.kind !== 'recording') this.stopFor(h.id, sentence);
      return;
    }
    const wasSession = this.playback.sessions.has(id);
    this.stopAny(id, 'recording');
    const at = this.now();
    if (wasSession) this.playback.ended?.set(id, { error: sentence, at });
    for (const m of [this.ended, this.encryptedEnded]) if (m?.has(id)) m.set(id, { ...m.get(id), error: sentence, at });
  }

  /** Count a start in progress on the source (released by the returned function). */
  hold(key) {
    this.reserved.set(key, (this.reserved.get(key) || 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const n = (this.reserved.get(key) || 1) - 1;
      if (n > 0) this.reserved.set(key, n);
      else this.reserved.delete(key);
    };
  }

  /**
   * A slot for a recording at its start time. The channel already tuned: no slot needed. Else a free one; else the
   * newest viewers' streams on the source are stopped ("Stopped to record <title>") until there is room. A recording
   * never stops another: when recordings hold every slot it fails, naming them (the scheduler decides whether to wait).
   * @returns {{ ok: true, release: () => void } | { ok: false, error: string, recordings: object[] }}
   */
  takeSlotFor(source, { channelKey, title }) {
    const key = source.key;
    const tunerKey = `${key}\0${channelKey}`;
    if (this.tuners?.get(tunerKey)?.holders.size) return { ok: true, release: () => {} };
    const max = Number(typeof source.maxStreams === 'function' ? source.maxStreams() : Infinity);
    let open = this.openOn(key);
    const busy = () => open.length + (this.reserved.get(key) || 0);
    if (Number.isFinite(max) && busy() >= max) {
      const isRecording = (s) => Boolean(s.recording) || (s.people || []).some((p) => p.recording);
      const viewers = open.filter((s) => !isRecording(s)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      if (open.filter(isRecording).length >= max) return { ok: false, error: EVERY_STREAM_RECORDING, recordings: open.filter(isRecording) };
      // The rest is a viewer's start in progress (not yet a stream that can be stopped): the recording waits a tick.
      if (busy() - viewers.length >= max) return { ok: false, waiting: true, error: 'A viewer is starting on the last stream' };
      while (viewers.length && busy() >= max) {
        const v = viewers.shift();
        this.stopFor(v.id, `Stopped to record ${title}`);
        open = open.filter((s) => s !== v);
      }
    }
    this.tuners?.endIdle?.(`${key}\0`, tunerKey);
    return { ok: true, release: this.hold(key) };
  }

  /**
   * Tune a channel for a recording: its tuner (shared with whoever watches it; started if needed), or — for a
   * channel the tuner can't buffer — the provider's address for a recorder of its own.
   * @returns {Promise<{ tuner } | { direct: { url, headers, media } }>}
   */
  /** Each restart of a tuner asks the source for the channel's address again (a provider's addresses can expire) —
   *  only ever a network address, as at a start. */
  resolverFor(source, channel) {
    return async () => {
      const fresh = (await withTimeout(source.stream(channel.key, { log: this.log }), this.resolveTimeoutMs)) || null;
      return fresh && isNetworkUrl(fresh.url) ? fresh : null;
    };
  }

  /** The source's address for a channel; one that doesn't answer in time is the channel not answering (502). */
  async addressOf(source, channel) {
    try {
      return await withTimeout(source.stream(channel.key, { log: this.log }), this.resolveTimeoutMs);
    } catch (err) {
      if (err?.code === 'RESOLVE_TIMEOUT') throw new HttpError(502, "This channel isn't answering right now (the provider closed the connection)");
      throw err;
    }
  }

  async tuneForRecording(source, channel, holder) {
    const key = `${source.key}\0${channel.key}`;
    const tuned = this.tuners?.get(key);
    const resolve = this.resolverFor(source, channel);
    if (tuned) return { tuner: await this.tuners.acquire({ key, url: tuned.url, headers: tuned.headers, media: tuned.media, label: channel.name, resolve }, holder) };
    const { url, headers = {} } = (await this.addressOf(source, channel)) || {};
    if (!isNetworkUrl(url)) throw new HttpError(502, "This channel isn't answering right now (the provider closed the connection)");
    const cached = this.probes.get(key);
    const media = cached && cached.url === url && this.now() - cached.at < PROBE_REUSE_MS ? cached.media : await this.probeOrExplain(url, headers);
    this.probes.set(key, { at: this.now(), url, media, channelId: channel.id });
    if (!this.tuners) return { direct: { url, headers, media } };
    try {
      return { tuner: await this.tuners.acquire({ key, url, headers, media, label: channel.name, resolve }, holder) };
    } catch (err) {
      if (err?.unbuffered) return { direct: { url, headers, media } };
      throw err;
    }
  }

  /** Stop a live stream, whichever kind it is (a playback session, an encrypted one, a tuner's viewers). */
  stopAny(id, reason) {
    if (String(id).startsWith('tuner:')) {
      const t = this.tuners?.get(String(id).slice(6));
      for (const h of t ? [...t.holders.values()] : []) if (h.kind !== 'recording') this.stopAny(h.id, reason);
      return;
    }
    if (this.stoppers.some((fn) => fn(id, reason))) return;
    this.playback.stop(id, reason);
  }

  /** Take a slot on the source, or refuse with who holds the slots. Synchronous: no await before it. */
  reserve(source, { user, profile, isAdmin, replaces, spareKey = null }) {
    const key = source.key;
    const max = Number(typeof source.maxStreams === 'function' ? source.maxStreams() : Infinity);
    // The stream this press replaces doesn't count — only when it's the caller's own (an id can't free a slot
    // someone else holds).
    // A tuner whose only holder is the replaced stream is freed by it too.
    let open = this.openOn(key).filter((s) => !(s.id === replaces && s.userId === user.id) && !(s.holderIds && replaces && s.holderIds.length === 1 && s.holderIds[0] === replaces && s.userId === user.id));
    const busy = () => open.length + (this.reserved.get(key) || 0);
    // Over the limit with streams of this same profile (a reloaded tab, a crashed player, another screen): the
    // newest press wins — its own older streams on this source stop, oldest first. Other profiles are asked. When
    // stopping all of them couldn't make room, nothing is stopped (a TV of yours keeps playing).
    if (Number.isFinite(max) && busy() >= max) {
      // A tuner is this profile's only when everyone on it is this profile (stopping it mustn't cut someone else off).
      const mine = (s) => s.userId === user.id && s.profileId === (profile?.id ?? null);
      // A recording is never "your own older stream": a press doesn't stop it.
      const own = open.filter((s) => !s.recording && (s.people ? s.people.length && s.people.every((p) => mine(p) && !p.recording) : mine(s))).sort((a, b) => a.createdAt - b.createdAt);
      if (busy() - own.length >= max) own.length = 0;
      while (own.length && busy() >= max) {
        const old = own.shift();
        this.stopAny(old.id, 'replaced');
        open = open.filter((s) => s.id !== old.id);
      }
    }
    if (Number.isFinite(max) && busy() >= max) {
      // Who holds the streams is told to the same profile, or to an admin on a grown-up profile; others (Kids above
      // all) learn only that it's someone on their account or in the household.
      const named = (s) => (s.userId === user.id && s.profileId === (profile?.id ?? null)) || (isAdmin && !profile?.kids);
      const holders = open.map((s) => (named(s) ? { profile: s.username, channel: s.live.channelName || null } : { profile: s.userId === user.id ? 'Another profile on your account' : 'Someone else in your household', channel: null }));
      const n = `${max} stream${max === 1 ? '' : 's'}`;
      const sameAccount = open.some((s) => s.userId === user.id && !named(s));
      throw new HttpError(409, sameAccount ? `Your provider allows ${n} at a time — another profile on your account is using it` : `Your provider allows ${n} at a time — stop the other one first`, { holders });
    }
    // Idle tuners (no-one holds them, closing in 30 s) still hold a provider connection: a granted slot closes them
    // now (but not the channel being asked for, whose buffer can be reused).
    this.tuners?.endIdle?.(`${key}\0`, spareKey);
    return this.hold(key);
  }

  sourceFor(channel) {
    const source = this.plugins.getLiveSource(channel.source);
    if (!source) throw new HttpError(404, 'This channel no longer exists.');
    return source;
  }

  async probeOrExplain(url, headers) {
    let media;
    try {
      media = await probe(this.config.ffprobePath, url, { headers, live: true, timeout: PROBE_TIMEOUT_MS });
    } catch (err) {
      if (/timed out/.test(err?.message || '')) throw new HttpError(504, 'This channel took too long to answer');
      throw new HttpError(502, "This channel isn't answering right now (the provider closed the connection)");
    }
    if (!media || (!media.video && !media.audio?.length)) throw new HttpError(502, "This channel isn't a video stream");
    return media;
  }

  stopReplaced(user, replaces) {
    if (!replaces) return;
    const old = this.playback.sessions.get(replaces);
    if (old && old.userId === user.id) return this.playback.stop(old.id, 'replaced');
    const viewer = this.viewers.get(String(replaces));
    if (viewer && viewer.userId === user.id) return this.viewerStop(viewer.id, 'replaced');
    const enc = this.encrypted?.get(String(replaces));
    if (enc && enc.userId === user.id) this.stopAny(enc.id, 'replaced');
  }

  /** Can this browser play the channel's streams as they are (no conversion)? */
  playsAsIs(media, caps, quality) {
    if (quality && quality !== 'original') return false;
    const plan = decide({ file: 'live.ts', media, caps, quality: 'original', transcodingEnabled: true, tools: this.playback.tools?.() || null });
    return plan.mode === 'remux';
  }

  // ---- Tuner viewers: the browser plays the tuner's buffer through Atomix (routes in api/live.js) ----
  viewerGet(id, user, profile) {
    const v = this.viewers.get(String(id));
    if (!v || v.userId !== user?.id || v.profileId !== (profile?.id ?? null)) throw new HttpError(404, 'No such stream.');
    return v;
  }

  viewerPing(id, user, profile) {
    const v = this.viewers.get(String(id));
    if (!v || v.userId !== user?.id || v.profileId !== (profile?.id ?? null)) {
      const ended = this.ended.get(String(id));
      return ended ? { ok: false, error: ended.error } : { ok: false };
    }
    v.lastSeen = this.now();
    return { ok: true };
  }

  /** Listen on a tuner for a viewer or a conversion; taken off again when that one goes. */
  listen(id, tuner, event, fn) {
    tuner.on?.(event, fn);
    if (!this.offs.has(id)) this.offs.set(id, []);
    this.offs.get(id).push(() => tuner.off?.(event, fn));
  }
  unlisten(id) {
    for (const off of this.offs.get(id) || []) off();
    this.offs.delete(id);
  }

  /** Tuner viewers for the Dashboard (the browser plays the buffer itself), shaped as playback sessions are. */
  viewerList() {
    return [...this.viewers.values()].map((v) => ({
      id: v.id,
      kind: 'live',
      user: v.username,
      itemId: `live:${v.live?.channelId}`,
      title: v.title,
      mode: 'direct',
      delivery: 'dash',
      quality: 'original',
      position: 0,
      paused: false,
      reasons: ["Played from the channel's tuner"],
      startedAt: v.createdAt,
      clientIp: v.clientIp,
      castDevice: null,
      transcoding: false,
    }));
  }

  viewerStop(id, reason = 'stopped', error = 'This channel stopped.') {
    const v = this.viewers.get(String(id));
    if (!v) return;
    this.viewers.delete(v.id);
    this.unlisten(v.id);
    this.tuners?.release(v.id);
    this.ended.set(v.id, { error: reason === 'user' ? null : error, at: this.now() });
  }

  reapViewers() {
    const now = this.now();
    for (const v of [...this.viewers.values()]) if (now - v.lastSeen > VIEWER_IDLE_MS) this.viewerStop(v.id, 'idle');
    for (const [id, e] of this.ended) if (now - e.at > 5 * 60_000) this.ended.delete(id);
  }

  /**
   * @param {{ user, profile, channel, caps, quality?, replaces?, audioOnly?, clientIp?, isAdmin?, castDevice?, extraHeaders?, keepUntilLoaded? }} o
   *   channel: a store row the caller checked; the cast options go through to the playback session as for a title
   * @returns {Promise<{ session, url, media }>}
   */
  async startLive({ user, profile, channel, caps, quality = 'original', replaces = null, audioOnly = false, clientIp = null, isAdmin = false, castDevice = null, extraHeaders = null, keepUntilLoaded = null, behind = 0 }) {
    const source = this.sourceFor(channel);
    // Joining a channel someone is already watching (or recording) costs no stream: it's already tuned.
    const tunerKey = `${source.key}\0${channel.key}`;
    const joining = Boolean(this.tuners && !castDevice && this.tuners.get(tunerKey)?.holders.size);
    const release = joining ? () => {} : this.reserve(source, { user, profile, isAdmin, replaces, spareKey: tunerKey });
    try {
      // The old channel goes first: a 1-stream provider refuses a second connection while it's open (an idle tuner
      // the old stream leaves behind closes too, before the new channel is asked for).
      this.stopReplaced(user, replaces);
      if (this.tuners && !castDevice && !joining) this.tuners.endIdle?.(`${source.key}\0`, tunerKey);
      // A channel already tuned (watched, recorded, or idle for a moment): its connection and stream check are
      // reused — asking the provider again would need a second connection.
      const tuned = this.tuners && !castDevice ? this.tuners.get(tunerKey) : null;
      if (tuned) {
        const isRadio = audioOnly || channel.radio;
        const liveInfo = { kind: 'live', sourceKey: source.key, channelId: channel.id, channelName: channel.name };
        const create = (m, extra = {}) => this.playback.create({ user, profile, caps, quality, audioOnly: isRadio, clientIp, keepUntilLoaded, live: liveInfo, item: { id: `live:${channel.id}`, kind: 'live', title: channel.name, path: null, media: m, duration: null }, ...extra });
        return await this.startTuned({ user, profile, channel, source, url: tuned.url, headers: tuned.headers, media: tuned.media, caps, quality, isRadio, liveInfo, create, clientIp, behind });
      }
      const { url, headers = {} } = (await this.addressOf(source, channel)) || {};
      // Only a network address: a playlist entry must never make ffmpeg read a file on this server.
      if (!isNetworkUrl(url)) throw new HttpError(502, "This channel isn't answering right now (the provider closed the connection)");
      // The channel's stream check is reused for 10 minutes (a 1-stream provider sees one connection per start); a
      // start that then fails is tried once more with a fresh check (the stream may have changed).
      const probeKey = `${source.key}\0${channel.key}`;
      const cached = this.probes.get(probeKey);
      const reused = cached && cached.url === url && this.now() - cached.at < PROBE_REUSE_MS;
      let media = reused ? cached.media : await this.probeOrExplain(url, headers);
      if (!reused) this.probes.set(probeKey, { at: this.now(), url, media, channelId: channel.id });
      const isRadio = audioOnly || channel.radio;
      const liveInfo = { kind: 'live', sourceKey: source.key, channelId: channel.id, channelName: channel.name };
      const create = (m, extra = {}) => this.playback.create({
        user,
        profile,
        caps,
        source: { file: url, remote: true, headers },
        quality,
        audioOnly: isRadio,
        clientIp,
        castDevice,
        extraHeaders,
        keepUntilLoaded,
        live: liveInfo,
        item: { id: `live:${channel.id}`, kind: 'live', title: channel.name, path: null, media: m, duration: null },
        ...extra,
      });
      // The shared tuner: one provider connection for everyone on this channel (not for a cast: the TV gets its own
      // converted stream as before).
      if (this.tuners && !castDevice) {
        const tuned = await this.startTuned({ user, profile, channel, source, url, headers, media, caps, quality, isRadio, liveInfo, create, clientIp, behind }).catch((err) => {
          if (err?.unbuffered) return null;
          throw err;
        });
        if (tuned) return tuned;
        // Unbuffered: the channel's own connection, as before 0.19 (counted on its own), and the player says so.
        const made = await create(media);
        made.session.reasons = [...(made.session.reasons || []), NO_REWIND];
        return { session: made.session, url: made.url, media, delivery: made.session.delivery };
      }
      let made;
      try {
        made = await create(media);
      } catch (err) {
        if (!reused) throw err;
        this.probes.delete(probeKey);
        media = await this.probeOrExplain(url, headers);
        this.probes.set(probeKey, { at: this.now(), url, media, channelId: channel.id });
        made = await create(media);
      }
      return { session: made.session, url: made.url, media, delivery: made.session.delivery };
    } finally {
      release();
    }
  }

  /** Watch through the channel's tuner: the buffer itself (dash), or a conversion reading it. Rejects unbuffered. */
  async startTuned({ user, profile, channel, source, url, headers, media, caps, quality, isRadio, liveInfo, create, clientIp, behind = 0 }) {
    const key = `${source.key}\0${channel.key}`;
    // The buffer as it is needs MediaSource in the page (none on iPhone Safari: it gets a conversion, HLS).
    const asIs = !isRadio && Boolean(media?.video) && caps?.mse !== false && this.playsAsIs(media, caps, quality);
    if (asIs && (this.playback.sessionsOf?.(user.id) || []).length >= MAX_SESSIONS_PER_USER) throw new HttpError(429, 'Too many streams open on this account.');
    // A 1-stream provider: an idle tuner of another channel (just zapped away from) closes now, not in 30 s.
    if (!this.tuners.get(key)) this.tuners.endIdle?.(`${source.key}\0`, key);
    const id = crypto.randomBytes(12).toString('hex');
    // A TV channel is tuned whole even for "listen only" (a later viewer wants the picture); radio has no picture.
    const resolve = this.resolverFor(source, channel);
    let tuner;
    try {
      tuner = await this.tuners.acquire({ key, url, headers, media: channel.radio ? { ...media, video: null } : media, label: channel.name, resolve }, { id, kind: 'viewer' });
    } catch (err) {
      if (err?.code === 'REFUSED') throw new HttpError(502, 'The provider refused this channel');
      throw err;
    }
    // Starts in parallel all passed the check above before any was counted: count again now this one holds a tuner.
    if (asIs && (this.playback.sessionsOf?.(user.id) || []).length >= MAX_SESSIONS_PER_USER) {
      this.tuners.release(id);
      throw new HttpError(429, 'Too many streams open on this account.');
    }
    if (asIs) {
      const viewer = { id, userId: user.id, profileId: profile?.id ?? null, username: profile?.name || user.username || '', tunerKey: key, createdAt: this.now(), lastSeen: this.now(), clientIp, live: { ...liveInfo, tunerKey: key }, rewind: true, title: channel.name };
      this.viewers.set(id, viewer);
      this.listen(id, tuner, 'ended', (why) => this.viewers.has(id) && this.viewerStop(id, 'stream lost', why === 'idle' ? 'This channel stopped.' : why));
      return { session: viewer, url: null, media, delivery: 'dash' };
    }
    try {
      const made = await create(isRadio ? { ...media, video: null } : media, {
        source: { file: tuner.localPlaylist(), remote: false, headers: null },
        live: { ...liveInfo, kind: 'buffer', tunerKey: key },
        behind,
        behindPieces: tuner.piecesBack?.(behind) || null,
      });
      this.tuners.rename?.(id, made.session.id);
      // The tuner gave up (the provider kept dropping): the conversion ends with the same sentence.
      const sid = made.session.id;
      this.listen(sid, tuner, 'ended', (why) => {
        const s = this.playback.sessions.get(made.session.id);
        if (!s || why === 'idle' || why === 'closing') return;
        this.playback.ended?.set(s.id, { error: why, at: Date.now() });
        this.playback.stop(s.id, 'stream lost');
      });
      // After a provider drop the tuner writes a new run: the conversion restarts on its playlist.
      this.listen(sid, tuner, 'run', () => {
        const s = this.playback.sessions.get(made.session.id);
        if (!s) return;
        s.file = tuner.localPlaylist();
        s.behindPieces = piecesAfterRun(tuner); // the new run's live point, inside the new run
        this.playback.respawn ? this.playback.respawn(s) : s.proc?.kill('SIGKILL');
      });
      return { session: made.session, url: made.url, media, delivery: made.session.delivery };
    } catch (err) {
      this.tuners.release(id);
      throw err;
    }
  }

  /**
   * A programme from the channel's archive, `from` seconds in. The caller checked the programme may be played.
   * @returns {Promise<{ session, url, duration, start }>}
   */
  async startCatchup({ user, profile, channel, programme, from = 0, caps, quality = 'original', replaces = null, clientIp = null, isAdmin = false, castDevice = null, extraHeaders = null, keepUntilLoaded = null }) {
    const source = this.sourceFor(channel);
    if (typeof source.catchup !== 'function') throw new HttpError(400, "This programme can't be played from the archive");
    const length = Math.round((programme.end - programme.start) / 1000);
    const start = Math.max(0, Math.min(Math.floor(Number(from) || 0), length - 1));
    const release = this.reserve(source, { user, profile, isAdmin, replaces });
    try {
      this.stopReplaced(user, replaces);
      let out;
      try {
        out = await source.catchup(channel.key, programme, { from: start }, { log: this.log });
      } catch (err) {
        if (err?.status) throw err;
        throw new HttpError(400, "This programme can't be played from the archive");
      }
      if (!isNetworkUrl(out?.url)) throw new HttpError(502, "This channel isn't answering right now (the provider closed the connection)");
      const media = await this.probeOrExplain(out.url, out.headers || {});
      const item = { id: `catchup:${programme.id}`, kind: 'catchup', title: programme.title, path: null, media, duration: length - start };
      const { session, url } = await this.playback.create({
        user,
        profile,
        item,
        caps,
        source: { file: out.url, remote: true, headers: out.headers || {} },
        quality,
        audioOnly: channel.radio,
        clientIp,
        castDevice,
        extraHeaders,
        keepUntilLoaded,
        live: { kind: 'catchup', sourceKey: source.key, channelId: channel.id, channelName: channel.name, programmeId: programme.id, offset: start },
      });
      return { session, url, duration: length, start };
    } finally {
      release();
    }
  }
}
