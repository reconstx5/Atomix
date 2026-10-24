// Cast sessions: Atomix drives a Chromecast or a DLNA TV and the phone is the remote. One session per device, owned
// by the profile that started it. The device's status moves the session along: progress is saved, Up next and music
// queues carry on, and a takeover, a lost device or an error ends it with a note the pill can show for 2 minutes.
import { shiftVtt } from '../stream/vttshift.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from '../http/router.js';
import { mimeFor } from '../http/static.js';
import { parseJson } from '../db.js';
import { logger } from '../log.js';
import { listSubtitles, getSubtitleVtt, sidecarFile, decodeSubtitleText } from '../stream/subtitles.js';
import { isRemotePath, resolveSource } from '../remote/index.js';
import { remoteSourceFor } from '../api/playback.js';
import { recordProgress } from '../library/progress.js';
import { ChromecastDevice } from './chromecast.js';
import { DlnaDevice } from './dlna.js';
import { castCaps, dlnaHeaders } from './caps.js';
import { baseUrlFor } from './devices.js';

const log = logger('cast');
const PLAYABLE = ['movie', 'episode', 'track', 'extra'];
const NOTE_MS = 2 * 60_000;
const LIBASS = "This ffmpeg can't draw subtitles onto video (it needs libass)";
const SUBS_DIR = (config) => path.join(config.transcodeDir, 'cast-subs');
// v0.27: encrypted channels play on a Chromecast or Google TV (its own Widevine); other TVs can't.
export const DLNA_ENCRYPTED = "This TV can't play encrypted channels; use a Chromecast or Google TV";
export const CANT_CAST_ENCRYPTED = "This channel is encrypted, so it can't be cast";
const CASTABLE_DRM = new Set(['widevine', 'clearkey']);
const loadFailed = (device, base) => `${device} couldn't load the video from ${base}. Check the address in Settings → Server → Casting.`;
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms).unref?.())]);

export class CastManager {
  constructor(core) {
    this.core = core;
    this.sessions = new Map(); // id → session
    this.notes = new Map(); // "userId:profileId" → { ended, deviceName, detail, at }
    this.upNextDelayMs = 10_000;
    this.reconnectMs = 30_000;
    this.reconnectEveryMs = 2_000;
    this.saveEveryMs = 10_000;
    this.dlnaPollMs = 2_000;
    this.chromecastOptions = {}; // { pingMs, deadMs } for tests
    this.subtitleReads = 0; // how often the subtitle folder was read (tests)
    fs.rmSync(SUBS_DIR(core.config), { recursive: true, force: true }); // burned-in .vtt files from a previous run
    // Keep the playback sessions behind casts alive (a paused Chromecast says nothing for minutes).
    this.keepAlive = setInterval(() => this.keepAliveTick(), 30_000);
    this.keepAlive.unref?.();
    // An admin's Stop (or the idle reaper) on the playback session ends the cast too.
    core.hooks.on('playback:stop', ({ session, reason }) => {
      if (String(reason).startsWith('cast')) return;
      const s = [...this.sessions.values()].find((x) => x.playbackSessionId === session.id);
      if (s && s.replacingId === session.id) return; // a 1-stream provider: the TV's own zap let the old channel go first
      if (s) return this.end(s, 'stopped', reason === 'admin' ? 'An admin stopped this.' : 'Atomix stopped this.', { stopDevice: true });
    });
  }

  /**
   * v0.27: the same for the TV's encrypted session (an admin's Stop, another press taking the provider's only stream).
   * Listened to from the first encrypted cast (Live TV's relay is made after the cast manager).
   */
  listenDrm() {
    if (this.drmListening || !this.core.live?.drm?.onStop) return;
    this.drmListening = true;
    this.core.live.drm.onStop((id, reason) => {
      if (String(reason).startsWith('cast')) return;
      const s = [...this.sessions.values()].find((x) => x.drmSessionId === id);
      if (!s || s.replacingDrm === id) return; // the TV's own zap let its old channel go first (no room for both)
      this.end(s, 'stopped', reason === 'admin' ? 'An admin stopped this.' : 'Atomix stopped this.', { stopDevice: true });
    });
  }

  /** Keep the streams behind casts alive (a paused Chromecast says nothing for minutes; a TV never pings). */
  keepAliveTick() {
    for (const s of this.sessions.values()) {
      const ps = this.core.playback.sessions.get(s.playbackSessionId);
      if (ps) ps.lastSeen = Date.now();
      if (s.drmSessionId) this.core.live?.drm?.touch(s.drmSessionId);
    }
  }

  key(userId, profileId) {
    return `${userId}:${profileId || 0}`;
  }

  // ---- Starting --------------------------------------------------------------------------------------------------

  /**
   * @param {{ user, profile, viewer, deviceId, itemId?, queue?: { itemIds, index }, position?, audioIndex?, subtitle? }} opts
   */
  async start({ user, profile, viewer, deviceId, itemId, queue, position, audioIndex, subtitle, live = null }) {
    const { settings, library, config } = this.core;
    if (!settings.get('castEnabled')) throw new HttpError(403, 'Casting is turned off on this server.');
    const devices = this.core.cast.devices;
    const device = (await devices.get(deviceId)) || (await devices.list()).find((d) => d.id === deviceId);
    if (!device) throw new HttpError(404, 'That TV is no longer on the network. Refresh the list and try again.');
    if (live?.channel?.drm && device.kind !== 'chromecast') throw new HttpError(400, DLNA_ENCRYPTED); // v0.27

    let items = [];
    let index = 0;
    if (!live) {
      const ids = queue ? queue.itemIds : [itemId];
      if (!Array.isArray(ids) || !ids.length || ids.length > 1000) throw new HttpError(400, 'Choose something to cast.');
      items = ids.map((id) => library.get(Number(id)));
      if (items.some((it) => !it || !PLAYABLE.includes(it.kind) || !library.canSee(viewer, it))) throw new HttpError(404, 'Nothing to play here');
      index = queue ? Math.max(0, Math.min(items.length - 1, Number(queue.index) || 0)) : 0;
    }

    const host = device.kind === 'chromecast' ? device.host : new URL(device.location).hostname;
    const base = baseUrlFor(host, { settings: settings.all(), config, port: this.core.listening?.port || config.port });
    if (!base) throw new HttpError(409, "Atomix doesn't know its address on your home network. Set it in Settings → Server → Casting.");

    // One session per device: whoever was casting there loses it.
    for (const other of [...this.sessions.values()]) {
      if (other.deviceId === device.id) await this.end(other, 'taken', `Someone else started casting to ${device.name}.`, { stopDevice: false });
    }

    // Live TV has no library item: a stand-in carries the kind and the title the TV shows.
    const item = live ? liveItem(live) : items[index];
    const s = {
      id: crypto.randomBytes(12).toString('hex'),
      userId: user.id,
      profileId: viewer.profileId || 0,
      user,
      profile,
      viewer,
      device,
      deviceId: device.id,
      deviceName: device.name,
      kind: device.kind,
      base,
      sink: null,
      queue: queue && !live ? { itemIds: items.map((i) => i.id), index } : null,
      live, // { kind: 'live', channel, order(), visible(id) } | { kind: 'catchup', channel, programme, visible(id) }
      item,
      playbackSessionId: null,
      offset: 0,
      state: 'buffering',
      position: 0,
      duration: null,
      volume: null,
      subtitleId: subtitle || null,
      audioIndex: audioIndex != null && audioIndex !== '' ? Number(audioIndex) : null,
      upNext: null,
      started: false,
      lastSave: 0,
      driver: null,
      busy: false,
      ended: false,
    };
    this.sessions.set(s.id, s);
    try {
      await this.connect(s);
      if (s.ended) throw new HttpError(409, `Someone else started casting to ${device.name}.`);
      const progress = live ? null : library.progressFor(s.profileId, [item.id]).get(item.id);
      const from = position != null && position !== '' ? Math.max(0, Number(position) || 0) : progress && !progress.watched && progress.position > 30 ? progress.position : 0;
      await this.play(s, item, { start: from });
      if (s.ended) throw new HttpError(409, `Someone else started casting to ${device.name}.`);
    } catch (err) {
      if (err.status) {
        await this.end(s, null, null, { stopDevice: false });
        throw err;
      }
      const detail = err.code === 'LOAD_FAILED'
        ? loadFailed(device.name, base)
        : `${device.name} didn't answer: ${err.message}`;
      await this.end(s, 'error', detail, { stopDevice: false });
      throw new HttpError(502, detail);
    }
    return this.toJson(s);
  }

  /** Opens (or reopens) the connection to the device. `resume`: rejoin what is already playing. */
  async connect(s, { resume = false } = {}) {
    let driver;
    try {
      if (s.kind === 'chromecast') {
        driver = new ChromecastDevice({ host: s.device.host, port: s.device.port, name: s.deviceName, ...this.chromecastOptions });
        await driver.connect();
        if (resume) {
          if (!(await driver.attach())) throw Object.assign(new Error('taken'), { code: 'TAKEN' });
        } else await driver.launch();
      } else {
        driver = new DlnaDevice({ location: s.device.location, pollMs: this.dlnaPollMs });
        await driver.connect();
        if (!s.sink) s.sink = await driver.protocolInfo().catch(() => []);
        if (resume) {
          driver.url = s.loadedUrl;
          driver.started = true;
          driver.startPolling();
        }
      }
    } catch (err) {
      driver?.close(); // a half-made connection never stays open
      throw err;
    }
    // Stopped (or taken over) while this was connecting: let go at once.
    if (s.ended) {
      driver.close();
      throw Object.assign(new Error('The cast has ended'), { code: 'ENDED' });
    }
    const old = s.driver;
    s.driver = driver;
    old?.close();
    driver.on('status', (st) => {
      if (s.driver === driver) this.onStatus(s, st).catch((err) => log.warn(`Cast status: ${err.message}`));
    });
    driver.on('close', () => {
      if (s.driver === driver) this.onDrop(s);
    });
    return driver;
  }

  /** Makes the stream for `item` from `start` and loads it on the device. A restart replaces the old stream. */
  async play(s, item, { start = 0, forceTranscode = false, commanded = false } = {}) {
    if (s.live) return this.playLive(s, { start });
    const { playback, config } = this.core;
    const media = parseJson(item.media, null);
    // v0.21: the profile's own audio and subtitle delay for this title, as in the browser.
    s.delays = ['movie', 'episode'].includes(item.kind) && s.profileId && this.core.playSettings ? this.core.playSettings.get(s.profileId, item.id) : { audioDelay: 0, subtitleDelay: 0 };
    const subs = this.readSubtitles(item);
    let chosen = s.subtitleId ? subs.find((x) => x.id === s.subtitleId) : null;
    if (!chosen) s.subtitleId = null;
    let burnSubtitle = null;
    let burnTextFile = null;
    if (chosen?.kind === 'image') burnSubtitle = chosen.streamIndex;
    else if (chosen && s.kind === 'dlna') {
      // Drawing text onto the video needs ffmpeg's libass: without it a chosen subtitle is refused (or, at a start, left off).
      if (!this.core.tools?.filters?.subtitles) {
        if (commanded) throw new HttpError(400, LIBASS);
        chosen = null;
        s.subtitleId = null;
        s.notice = LIBASS; // the start goes on without it, and says why (the player and the Remote show it)
      } else burnTextFile = await this.writeSubtitle(item, chosen, s.delays?.subtitleDelay || 0);
    }
    try {
      return await this.playStream(s, item, { start, forceTranscode, media, subs, chosen, burnSubtitle, burnTextFile });
    } catch (err) {
      // A playback session that took the .vtt deletes it when stopped; one that never existed leaves it to us.
      if (burnTextFile) fs.rmSync(burnTextFile, { force: true });
      throw err;
    }
  }
  readSubtitles(item) {
    this.subtitleReads++;
    return listSubtitles(item, this.core.config);
  }
  async playStream(s, item, { start, forceTranscode, media, subs, chosen, burnSubtitle, burnTextFile }) {
    const { playback } = this.core;
    const source = await remoteSourceFor(this.core, item);
    // A TV already known to refuse Seek gets a converted stream straight away when starting past the beginning.
    if (s.kind === 'dlna' && start > 0 && s.driver?.seekSupported === false) forceTranscode = true;
    const { session: ps, url } = await playback.create({
      keepUntilLoaded: s.playbackSessionId || null, // the old stream stops once the TV has the new one
      user: s.user,
      profile: s.profile,
      item,
      caps: castCaps({ ...s.device, sink: s.sink }),
      source,
      start,
      audioIndex: s.audioIndex,
      quality: 'original',
      burnSubtitle,
      burnTextFile,
      audioDelay: s.delays?.audioDelay || 0,
      subtitleDelay: s.delays?.subtitleDelay || 0, // a picture subtitle drawn on moves with it (the same -itsoffset input)
      forceTranscode,
      clientIp: 'cast',
      castDevice: s.deviceName,
      extraHeaders: s.kind === 'dlna' ? dlnaHeaders() : null,
    });
    const token = this.core.cast.links.issue({ sessionId: ps.id, itemId: item.id, userId: s.userId, profileId: s.profileId || null, castId: s.id });
    const link = (u) => `${s.base}${u}${u.includes('?') ? '&' : '?'}cast=${token}`;
    const subDelay = s.delays?.subtitleDelay || 0;
    const withDelay = (u) => (subDelay ? `${u}${u.includes('?') ? '&' : '?'}delay=${subDelay}` : u);
    const tracks = s.kind === 'chromecast' ? subs.filter((x) => x.kind === 'text' && x.url).map((x, i) => ({ trackId: i + 1, subId: x.id, url: link(withDelay(x.url)), language: x.language || 'und', name: x.label })) : [];
    const duration = item.duration || media?.duration || null;
    const offset = ps.mode === 'direct' ? 0 : ps.start;
    const old = s.playbackSessionId;
    Object.assign(s, {
      item, playbackSessionId: ps.id, offset, tracks, duration, position: start, state: 'buffering', started: false, upNext: null, finishing: false, loadedUrl: link(url),
      // What the Remote polls every second, read once here rather than on every poll.
      subtitles: subs.map((x) => ({ id: x.id, label: x.label, language: x.language, kind: x.kind })),
      previews: s.previews ?? null,
    });
    if (s.queue) s.queueTitles = s.queue.itemIds.map((id) => ({ id, title: this.core.library.get(id)?.title || '' }));
    s.busy = true;
    try {
      await s.driver.load({
        url: s.loadedUrl,
        contentType: this.contentType(item, ps, media),
        kind: item.kind,
        title: item.title,
        subtitle: this.byline(item),
        album: item.kind === 'track' && item.parent_id ? this.core.library.get(item.parent_id)?.title : undefined,
        image: link(`/api/items/${this.imageId(item)}/image/poster`),
        startTime: ps.mode === 'direct' ? start : 0,
        duration: duration ? Math.max(0, duration - offset) : undefined,
        tracks,
        activeTrackIds: chosen?.kind === 'text' && s.kind === 'chromecast' ? tracks.filter((t) => t.subId === chosen.id).map((t) => t.trackId) : [],
      });
    } catch (err) {
      playback.stop(ps.id, 'cast failed');
      // The old stream is still this cast's: whoever ends the cast stops it (and its ffmpeg).
      s.playbackSessionId = old || null;
      throw err;
    } finally {
      s.busy = false;
    }
    // The old stream's link and ffmpeg go with its playback session (the playback:stop hook revokes its links).
    if (old && old !== ps.id) playback.stop(old, 'cast restart');
    // A DLNA TV that refused to seek the file is playing from 0: give it a converted stream from the right time instead.
    if (s.kind === 'dlna' && start > 0 && ps.mode === 'direct' && s.driver.seekSupported === false) {
      const keep = { offset: s.offset, loadedUrl: s.loadedUrl, duration: s.duration, tracks: s.tracks };
      try {
        await this.play(s, item, { start, forceTranscode: true });
      } catch (err) {
        // Converting is off, or the converted load failed: the file is already playing from the start, so keep it.
        if (s.ended) throw err;
        Object.assign(s, keep, { position: 0, resumeDropped: true });
      }
    }
  }

  /** A channel (or a programme from its archive) through Live TV's stream starter, then the same load as a title. */
  async playLive(s, { start = 0 }) {
    const { playback } = this.core;
    const streams = this.core.live.streams;
    const { channel } = s.live;
    if (channel.drm) return this.playEncrypted(s);
    const old = s.playbackSessionId;
    const oldDrm = s.drmSessionId || null;
    const common = {
      user: s.user,
      profile: s.profile,
      channel,
      caps: castCaps({ ...s.device, sink: s.sink }),
      quality: 'original',
      clientIp: 'cast',
      castDevice: s.deviceName,
      extraHeaders: s.kind === 'dlna' ? dlnaHeaders() : null,
      keepUntilLoaded: old || null,
    };
    s.replacingId = old || null;
    s.replacingDrm = oldDrm;
    let started;
    try {
      // From an encrypted channel: the next starts beside it, and only when the provider (or the account) has no room
      // for both does the old one go first — then a start that fails ends the cast with its reason.
      const begin = (replaces) => (s.live.kind === 'live' ? streams.startLive({ ...common, replaces }) : streams.startCatchup({ ...common, replaces, programme: s.live.programme, from: start }));
      started = await this.withRoom(s, begin, oldDrm);
    } finally {
      s.replacingId = null;
      s.replacingDrm = null;
    }
    const { session: ps, url } = started;
    const length = s.live.kind === 'catchup' ? started.duration : null;
    const offset = s.live.kind === 'catchup' ? started.start : 0;
    const token = this.core.cast.links.issue({ sessionId: ps.id, itemId: null, userId: s.userId, profileId: s.profileId || null, castId: s.id });
    s.item = liveItem(s.live);
    Object.assign(s, { playbackSessionId: ps.id, offset, tracks: [], duration: length, position: offset, state: 'buffering', started: false, upNext: null, finishing: false, loadedUrl: `${s.base}${url}${url.includes('?') ? '&' : '?'}cast=${token}`, subtitles: [], previews: null });
    s.busy = true;
    try {
      await s.driver.load({
        url: s.loadedUrl,
        contentType: `${ps.audioOnly ? 'audio' : 'video'}/${ps.target === 'webm' ? 'webm' : 'mp4'}`,
        kind: channel.radio ? 'track' : 'movie',
        live: s.live.kind === 'live',
        title: s.item.title,
        subtitle: s.item.byline,
        startTime: 0,
        duration: length ? Math.max(0, length - offset) : undefined,
        tracks: [],
        activeTrackIds: [],
      });
    } catch (err) {
      playback.stop(ps.id, 'cast failed');
      s.playbackSessionId = old && playback.sessions.has(old) ? old : null;
      throw err;
    } finally {
      s.busy = false;
    }
    if (old && old !== ps.id && playback.sessions.has(old)) playback.stop(old, 'cast restart');
    if (oldDrm) {
      s.drmSessionId = null;
      this.core.live.drm.stop(oldDrm, 'cast restart');
    }
  }

  /**
   * v0.27: start the TV's next channel beside the one it's on; only when there's no room for both (the provider's
   * limit, the account's 4) does the old one go first. If that second try fails too, the TV has nothing left: the
   * cast ends with the reason.
   */
  async withRoom(s, begin, old) {
    try {
      return await begin(null);
    } catch (err) {
      if (!old || ![409, 429].includes(err.status)) throw err;
    }
    try {
      return await begin(old);
    } catch (err) {
      const gone = !this.core.playback.sessions.has(old) && !this.core.live.drm.sessions.has(old);
      if (gone) await this.end(s, 'error', err.message, { stopDevice: true });
      throw err;
    }
  }

  /**
   * v0.27: an encrypted channel on a Chromecast. A LiveDrm session held by this cast (no browser pings it), a cast link
   * for that session only, and Atomix's own DASH manifest — which names Atomix's licence address — loaded as LIVE.
   */
  async playEncrypted(s) {
    const { channel } = s.live;
    if (!CASTABLE_DRM.has(channel.drm)) throw new HttpError(400, CANT_CAST_ENCRYPTED);
    if (s.kind !== 'chromecast') throw new HttpError(400, DLNA_ENCRYPTED);
    if (s.live.kind !== 'live') throw new HttpError(400, CANT_CAST_ENCRYPTED); // live only
    const drm = this.core.live.drm;
    this.listenDrm();
    const source = this.core.plugins.getLiveSource(channel.source);
    if (!source) throw new HttpError(404, 'This channel no longer exists.');
    const oldDrm = s.drmSessionId || null;
    const oldPs = s.playbackSessionId || null;
    s.replacingId = oldPs;
    s.replacingDrm = oldDrm;
    let d;
    try {
      d = await this.withRoom(s, (replaces) => drm.start({ user: s.user, profile: s.profile, channel, source, replaces, isAdmin: s.user.role === 'admin', clientIp: 'cast', castId: s.id }), oldDrm || oldPs);
    } finally {
      s.replacingId = null;
      s.replacingDrm = null;
    }
    const token = this.core.cast.links.issue({ drmSessionId: d.id, channelId: channel.id, base: s.base, userId: s.userId, profileId: s.profileId || null, castId: s.id });
    s.item = liveItem(s.live);
    const url = `${s.base}/api/live/drm/${d.id}/manifest.mpd?cast=${token}`;
    const logo = channel.logo ? `${s.base}/api/live/channels/${channel.id}/logo?cast=${token}` : null;
    Object.assign(s, { drmSessionId: d.id, playbackSessionId: null, offset: 0, tracks: [], duration: null, position: 0, state: 'buffering', started: false, upNext: null, finishing: false, loadedUrl: url, subtitles: [], previews: null });
    s.busy = true;
    try {
      await s.driver.load({ url, contentType: 'application/dash+xml', kind: 'movie', live: true, title: s.item.title, subtitle: null, image: logo, startTime: 0, tracks: [], activeTrackIds: [] });
    } catch (err) {
      drm.stop(d.id, 'cast failed');
      s.drmSessionId = oldDrm && drm.sessions.has(oldDrm) ? oldDrm : null;
      s.playbackSessionId = oldPs && this.core.playback.sessions.has(oldPs) ? oldPs : null;
      throw err;
    } finally {
      s.busy = false;
    }
    if (oldDrm && oldDrm !== d.id) drm.stop(oldDrm, 'cast restart');
    if (oldPs && this.core.playback.sessions.has(oldPs)) this.core.playback.stop(oldPs, 'cast restart');
  }

  /** Channel up/down on the TV: the next channel in the viewer's order, checked as they may see it. */
  async zap(s, dir) {
    if (s.live?.kind !== 'live') throw new HttpError(400, 'Channel up and down are for live TV.');
    const order = s.live.order();
    if (!order.length) throw new HttpError(404, 'This channel no longer exists.');
    const i = order.indexOf(s.live.channel.id);
    const nextId = order[i < 0 ? 0 : (i + dir + order.length) % order.length];
    const previous = s.live.channel;
    s.live.channel = s.live.visible(nextId);
    try {
      await this.play(s, s.item);
    } catch (err) {
      s.live.channel = previous;
      s.item = liveItem(s.live);
      if (err.status) throw err;
      const detail = err.code === 'LOAD_FAILED' ? loadFailed(s.deviceName, s.base) : `${s.deviceName} didn't answer.`;
      await this.end(s, 'error', detail, { stopDevice: false });
      throw new HttpError(502, detail);
    }
  }

  async writeSubtitle(item, sub, delay = 0) {
    const { config } = this.core;
    const dir = SUBS_DIR(config);
    fs.mkdirSync(dir, { recursive: true });
    // An .ass/.ssa sidecar keeps its positioning and styling when drawn on: copied as-is under a plain name.
    const styled = !isRemotePath(item.path) && sidecarFile(item, sub.id);
    if (styled && /\.(ass|ssa)$/i.test(styled) && !delay) { // with a delay: the text form, its cues moved
      const file = path.join(dir, `${crypto.randomBytes(8).toString('hex')}.ass`);
      fs.writeFileSync(file, decodeSubtitleText(fs.readFileSync(styled))); // libass wants UTF-8; an old Latin-1 file is converted
      return file;
    }
    const source = isRemotePath(item.path) ? await resolveSource({ db: this.core.db, providers: this.core.remote.providers }, item) : null;
    const vtt = await getSubtitleVtt(item, sub.id, config, source);
    if (vtt == null) throw new HttpError(404, 'Subtitle not found');
    const file = path.join(dir, `${crypto.randomBytes(8).toString('hex')}.vtt`);
    fs.writeFileSync(file, delay ? shiftVtt(vtt, delay) : vtt);
    return file;
  }

  contentType(item, ps, media) {
    if (ps.mode !== 'direct') return `${ps.audioOnly ? 'audio' : 'video'}/${ps.target === 'webm' ? 'webm' : 'mp4'}`;
    if (!isRemotePath(item.path)) return mimeFor(item.path);
    const c = String(media?.container || '').split(',')[0].trim();
    return mimeFor(`x.${c || 'mp4'}`);
  }
  /** An episode shows its show's poster (its own picture is a landscape still). */
  imageId(item) {
    return item.kind === 'episode' && item.show_id ? item.show_id : item.id;
  }
  byline(item) {
    if (item.kind === 'episode') {
      const show = item.show_id ? this.core.library.get(item.show_id)?.title : null;
      return [show, item.season != null && item.episode != null ? `S${item.season} E${item.episode}` : null].filter(Boolean).join(' · ') || null;
    }
    if (item.kind === 'track') return item.artist || null;
    return item.year ? String(item.year) : null;
  }

  // ---- What the device says ---------------------------------------------------------------------------------------

  async onStatus(s, st) {
    if (s.ended || s.busy || s.finishing) return;
    const before = s.position;
    if (st.volume != null) s.volume = st.volume;
    if (st.position != null) s.position = st.position + s.offset;
    if (st.duration && !s.duration) s.duration = st.duration + s.offset;
    if (st.state) s.state = st.state;
    if (st.state === 'playing' || st.state === 'paused') s.started = true;
    const ps = this.core.playback.sessions.get(s.playbackSessionId);
    if (ps) {
      ps.lastSeen = Date.now();
      ps.position = s.position;
      ps.paused = st.state === 'paused';
    }
    if (st.idleReason === 'finished') {
      // A DLNA TV says STOPPED both at the end and for Stop on its own remote: only near the end is it finished.
      const nearEnd = !s.duration || before >= s.duration - Math.min(30, s.duration * 0.1);
      // A live channel never reaches an end: STOPPED there is always Stop on the TV's own remote.
      if (s.kind === 'dlna' && (!nearEnd || s.live?.kind === 'live')) {
        s.position = before;
        return this.end(s, 'finished', `Stopped on ${s.deviceName}.`, { stopDevice: false });
      }
      return this.finished(s);
    }
    if (st.idleReason === 'taken') return this.end(s, 'taken', `Something else is playing on ${s.deviceName} now.`, { stopDevice: false });
    if (st.idleReason === 'error') return this.end(s, 'error', s.started ? `${s.deviceName} stopped with an error.` : loadFailed(s.deviceName, s.base), { stopDevice: false });
    if (st.idleReason === 'stopped') return this.end(s, 'finished', `Stopped on ${s.deviceName}.`, { stopDevice: false });
    // The profile was deleted: nobody is left to read a note (and a new profile may get the same id), so none is kept.
    if (s.profileId && !this.core.profiles.get(s.userId, s.profileId)) return this.end(s, null, null, { stopDevice: true, save: false });
    if (s.started && Date.now() - s.lastSave >= this.saveEveryMs) await this.save(s);
  }

  async save(s, { final = false } = {}) {
    if (!s.item || s.live) return; // Live TV keeps no progress
    s.lastSave = Date.now();
    const position = final && s.duration ? s.duration : s.position;
    try {
      await recordProgress(this.core, { user: s.user, viewer: s.viewer, item: s.item, position, duration: s.duration, sessionId: s.playbackSessionId, client: 'cast' });
    } catch (err) {
      log.warn(`Saving cast progress failed: ${err.message}`);
    }
  }

  async finished(s) {
    if (s.finishing) return; // the device repeats "finished" with every later status (a volume change…)
    s.finishing = true;
    if (s.live?.kind === 'live') return this.end(s, 'error', 'This channel stopped sending video.', { stopDevice: false, save: false });
    if (s.live) return this.end(s, 'finished', null, { stopDevice: false, save: false });
    await this.save(s, { final: true });
    const { library } = this.core;
    if (s.queue && s.queue.index + 1 < s.queue.itemIds.length) {
      s.queue.index++;
      return this.advance(s, library.get(s.queue.itemIds[s.queue.index]));
    }
    const prefs = parseJson(s.profile?.prefs, {}) || {};
    const next = s.item.kind === 'episode' && prefs.autoplayNext !== false ? library.nextEpisode(s.item) : null;
    if (next && library.canSee(s.viewer, next)) {
      s.state = 'idle';
      s.upNext = { itemId: next.id, title: next.title, at: Date.now() + this.upNextDelayMs };
      clearTimeout(s.upNextTimer);
      s.upNextTimer = setTimeout(() => this.advance(s, next), this.upNextDelayMs);
      s.upNextTimer.unref?.();
      return;
    }
    return this.end(s, 'finished', null, { stopDevice: false, save: false });
  }

  async advance(s, item) {
    if (s.ended) return;
    clearTimeout(s.upNextTimer);
    s.upNext = null;
    if (!item || !this.core.library.canSee(s.viewer, item)) return this.end(s, 'finished', null, { stopDevice: false, save: false });
    s.subtitleId = null;
    s.audioIndex = null;
    try {
      await this.play(s, item, { start: 0 });
    } catch (err) {
      await this.end(s, 'error', err.code === 'LOAD_FAILED' ? loadFailed(s.deviceName, s.base) : err.message, { stopDevice: false, save: false });
    }
  }

  onDrop(s) {
    if (s.ended || s.lostSince) return;
    s.lostSince = Date.now();
    const again = async () => {
      if (s.ended) return;
      try {
        await this.connect(s, { resume: true });
        s.lostSince = null;
        log.info(`Reconnected to ${s.deviceName}`);
        return;
      } catch (err) {
        if (err.code === 'ENDED' || s.ended) return;
        if (err.code === 'TAKEN') return this.end(s, 'taken', `Something else is playing on ${s.deviceName} now.`, { stopDevice: false });
      }
      if (Date.now() - s.lostSince >= this.reconnectMs) return this.end(s, 'lost', `Atomix lost touch with ${s.deviceName}.`, { stopDevice: false });
      s.reconnectTimer = setTimeout(again, this.reconnectEveryMs);
      s.reconnectTimer.unref?.();
    };
    s.reconnectTimer = setTimeout(again, Math.min(250, this.reconnectEveryMs));
    s.reconnectTimer.unref?.();
  }

  // ---- Ending --------------------------------------------------------------------------------------------------------

  /** @param {string|null} reason the note kept for the pill (null: none, the owner stopped it) */
  async end(s, reason, detail = null, { stopDevice = true, save = true } = {}) {
    if (s.ended) return;
    s.ended = true;
    this.core.cast.links.revokeCast(s.id); // the TV's links die first, before anything that waits
    clearTimeout(s.upNextTimer);
    clearTimeout(s.reconnectTimer);
    this.sessions.delete(s.id);
    if (save && s.started) await this.save(s);
    if (stopDevice && s.driver) await withTimeout(s.driver.stop().catch(() => {}), 2000);
    s.driver?.close();
    if (s.playbackSessionId && this.core.playback.sessions.has(s.playbackSessionId)) this.core.playback.stop(s.playbackSessionId, 'cast ended');
    if (s.drmSessionId) this.core.live?.drm?.stop(s.drmSessionId, 'cast ended');
    const k = this.key(s.userId, s.profileId);
    if (reason) this.notes.set(k, { ended: reason, deviceName: s.deviceName, detail, at: Date.now() });
    else this.notes.delete(k);
  }

  async stopAll(detail = 'Atomix is shutting down.') {
    await withTimeout(Promise.all([...this.sessions.values()].map((s) => this.end(s, 'stopped', detail, { stopDevice: true }))), 3000);
    clearInterval(this.keepAlive);
  }

  // ---- The remote ------------------------------------------------------------------------------------------------------

  owned(id, user, viewer) {
    const s = this.sessions.get(id);
    if (!s || s.userId !== user.id || s.profileId !== (viewer.profileId || 0)) throw new HttpError(404, 'No such cast session.');
    return s;
  }

  /** @returns {object|null} the live session, a recent "ended" note, or null */
  current(user, viewer) {
    const live = [...this.sessions.values()].find((s) => s.userId === user.id && s.profileId === (viewer.profileId || 0));
    if (live) return this.toJson(live);
    const note = this.notes.get(this.key(user.id, viewer.profileId));
    if (note && Date.now() - note.at < NOTE_MS) return { ended: note.ended, deviceName: note.deviceName, detail: note.detail };
    return null;
  }

  busy(deviceId) {
    return [...this.sessions.values()].some((s) => s.deviceId === deviceId);
  }

  async command(id, { user, viewer }, name, args = {}) {
    const s = this.owned(id, user, viewer);
    if (s.busy && name !== 'channelUp' && name !== 'channelDown') throw new HttpError(409, 'One moment: the TV is still loading.'); // channel presses queue
    const num = (v, what) => {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n)) throw new HttpError(400, `Give ${what}.`);
      return n;
    };
    const device = (fn) => fn().catch((err) => {
      if (err.status || err.code === 'SEEK_UNSUPPORTED') throw err;
      throw new HttpError(502, `${s.deviceName} didn't answer.`);
    });
    if (s.live?.kind === 'live' && (name === 'seek' || name === 'skip')) throw new HttpError(400, "You can't seek a live channel");
    if (s.live && (name === 'subtitle' || name === 'audio')) throw new HttpError(400, 'Live TV has no subtitle or audio choices here.');
    switch (name) {
      case 'channelUp':
      case 'channelDown': {
        // Presses run one after another: two starts at once would trip a 1-stream provider, and the first one's
        // stream would be left behind when the second took its place.
        const run = (s.zapChain || Promise.resolve()).then(() => (s.ended ? null : this.zap(s, name === 'channelUp' ? 1 : -1)));
        s.zapChain = run.catch(() => {});
        await run;
        break;
      }
      case 'play':
        await device(() => s.driver.play());
        s.state = 'playing';
        break;
      case 'pause':
        await device(() => s.driver.pause());
        s.state = 'paused';
        break;
      case 'seek':
        await this.seekTo(s, Math.max(0, num(args.position, 'a position in seconds')), device);
        break;
      case 'skip':
        await this.seekTo(s, Math.max(0, s.position + num(args.by, 'how many seconds to skip')), device);
        break;
      case 'volume': {
        const level = num(args.level, 'a volume from 0 to 1');
        if (level < 0 || level > 1) throw new HttpError(400, 'Give a volume from 0 to 1.');
        await device(() => s.driver.setVolume(level));
        s.volume = level;
        break;
      }
      case 'subtitle': {
        const want = args.id == null || args.id === '' ? null : String(args.id);
        const subs = listSubtitles(s.item, this.core.config);
        const sub = want ? subs.find((x) => x.id === want) : null;
        if (want && !sub) throw new HttpError(400, 'No such subtitle.');
        const was = s.subtitleId ? subs.find((x) => x.id === s.subtitleId) : null;
        const loaded = sub ? s.tracks.filter((t) => t.subId === sub.id).map((t) => t.trackId) : [];
        // A text track the Chromecast already has is switched in place; a picture subtitle, or a track that arrived after
        // the load (downloaded mid-cast), means a restart with the fresh list. The choice is recorded once it took.
        if (s.kind === 'chromecast' && was?.kind !== 'image' && sub?.kind !== 'image' && (!sub || loaded.length)) {
          await device(() => s.driver.setTracks(loaded));
          s.subtitleId = want;
        } else await this.restart(s, { start: s.position, subtitleId: want });
        break;
      }
      case 'audio': {
        const index = num(args.index, 'an audio track');
        const media = parseJson(s.item.media, null);
        if (!(media?.audio || []).some((a) => a.index === index)) throw new HttpError(400, 'No such audio track.');
        await this.restart(s, { start: s.position, audioIndex: index });
        break;
      }
      case 'next': {
        const { library } = this.core;
        if (s.upNext) await this.advance(s, library.get(s.upNext.itemId));
        else if (s.queue && s.queue.index + 1 < s.queue.itemIds.length) {
          await this.save(s);
          s.queue.index++;
          await this.advance(s, library.get(s.queue.itemIds[s.queue.index]));
        } else throw new HttpError(400, 'Nothing is up next.');
        break;
      }
      case 'cancel-up-next':
        if (!s.upNext) throw new HttpError(400, 'Nothing is up next.');
        await this.end(s, 'finished', null, { stopDevice: false, save: false });
        return { ok: true };
      case 'stop':
        await this.end(s, null, null, { stopDevice: true });
        return { ok: true };
      default:
        throw new HttpError(404, 'Unknown cast command.');
    }
    return s.ended ? this.current(user, viewer) : this.toJson(s);
  }

  /** Native seek for a file the device plays itself; a restart at the new time for a converted stream. */
  async seekTo(s, position, device) {
    const ps = this.core.playback.sessions.get(s.playbackSessionId);
    if (ps?.mode === 'direct' && s.driver.seekSupported !== false) {
      try {
        await device(() => s.driver.seek(position));
        s.position = position;
        return;
      } catch (err) {
        if (err.code !== 'SEEK_UNSUPPORTED') throw err;
        return this.restart(s, { start: position, forceTranscode: true });
      }
    }
    return this.restart(s, { start: position, forceTranscode: ps?.mode === 'direct' });
  }

  /** A restart with a different subtitle or audio track keeps the old choice until the new stream is playing. */
  async restart(s, { subtitleId, audioIndex, ...opts } = {}) {
    const keep = { subtitleId: s.subtitleId, audioIndex: s.audioIndex };
    if (subtitleId !== undefined) s.subtitleId = subtitleId;
    if (audioIndex !== undefined) s.audioIndex = audioIndex;
    try {
      await this.play(s, s.item, { ...opts, commanded: true });
    } catch (err) {
      Object.assign(s, keep);
      if (err.status) throw err;
      const detail = err.code === 'LOAD_FAILED' ? loadFailed(s.deviceName, s.base) : `${s.deviceName} didn't answer.`;
      await this.end(s, 'error', detail, { stopDevice: false });
      throw new HttpError(502, detail);
    }
  }

  /** A subtitle was downloaded (or removed) for this title: live casts of it see the new list. */
  subtitlesChanged(itemId) {
    for (const s of this.sessions.values()) if (s.item?.id === Number(itemId)) s.subtitles = null;
  }

  toJson(s) {
    if (s.live) return this.liveJson(s);
    const item = s.item;
    const media = parseJson(item.media, null);
    const { library } = this.core;
    return {
      id: s.id,
      deviceId: s.deviceId,
      deviceName: s.deviceName,
      kind: s.kind,
      itemId: item.id,
      itemKind: item.kind,
      title: item.title,
      subtitle: this.byline(item),
      image: `/api/items/${this.imageId(item)}/image/poster`,
      backdrop: item.kind === 'track' ? null : `/api/items/${this.imageId(item)}/image/backdrop`,
      state: s.state,
      position: s.position,
      duration: s.duration,
      volume: s.volume,
      subtitleId: s.subtitleId,
      audioIndex: s.audioIndex,
      subtitles: s.subtitles || (s.subtitles = this.readSubtitles(item).map((x) => ({ id: x.id, label: x.label, language: x.language, kind: x.kind }))),
      audio: (media?.audio || []).map((a) => ({ index: a.index, codec: a.codec, channels: a.channels, language: a.language, title: a.title })),
      upNext: s.upNext ? { ...s.upNext } : null,
      queue: s.queue ? { index: s.queue.index, items: s.queueTitles || [] } : null,
      reconnecting: Boolean(s.lostSince),
      notice: s.notice || null,
      previews: item.kind === 'track' ? null : this.core.extras?.previewManifest(item) || null,
    };
  }

  /** The Remote's view of a channel or a catch-up programme: what's on (polled), and no subtitles, audio or queue. */
  liveJson(s) {
    const { channel } = s.live;
    const routes = this.core.live.routes;
    let programme = null;
    let next = null;
    if (s.live.kind === 'live') {
      const nn = this.core.live.store.nowNext([channel.id], Date.now()).get(channel.id) || {};
      programme = routes.shapeProgramme(nn.now) || null;
      next = routes.shapeProgramme(nn.next) || null;
    } else programme = routes.shapeProgramme(s.live.programme);
    const shown = routes.shapeChannel(channel);
    return {
      id: s.id,
      deviceId: s.deviceId,
      deviceName: s.deviceName,
      kind: s.kind,
      itemId: null,
      itemKind: s.live.kind,
      title: s.item.title,
      subtitle: s.live.kind === 'live' ? programme?.title || null : channel.name,
      image: shown.logo,
      backdrop: null,
      state: s.state,
      position: s.position,
      duration: s.duration,
      volume: s.volume,
      subtitleId: null,
      audioIndex: null,
      subtitles: [],
      audio: [],
      upNext: null,
      queue: null,
      reconnecting: Boolean(s.lostSince),
      previews: null,
      live: { kind: s.live.kind, channel: { id: shown.id, name: shown.name, number: shown.number, logo: shown.logo }, programme, next },
    };
  }
}

/** The stand-in "item" for a live or catch-up cast: its kind, the TV's title and byline. */
function liveItem(live) {
  if (live.kind === 'live') return { id: null, kind: 'live', title: live.channel.name, byline: null, media: null };
  return { id: null, kind: 'catchup', title: live.programme.title, byline: live.channel.name, media: null };
}
