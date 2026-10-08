// A Chromecast (or Google TV, or anything with Cast built in), driven with Google's own Default Media Receiver.
// Emits `status` { state, position, duration, volume, idleReason } and `close` when the connection drops.
import { EventEmitter } from 'node:events';
import { CastChannel, NS } from './castv2.js';

export const DEFAULT_RECEIVER = 'CC1AD845';
const STATES = { PLAYING: 'playing', PAUSED: 'paused', BUFFERING: 'buffering', IDLE: 'idle' };
const IDLE = { FINISHED: 'finished', CANCELLED: 'stopped', INTERRUPTED: 'stopped', ERROR: 'error' };

export class ChromecastDevice extends EventEmitter {
  constructor({ host, port = 8009, name = 'Chromecast', pingMs, deadMs }) {
    super();
    Object.assign(this, { host, port, name, pingMs, deadMs });
    this.channel = null;
    this.transportId = null;
    this.mediaSessionId = null;
    this.current = { state: 'idle', position: 0, duration: null, volume: null, idleReason: null };
  }
  status() {
    return { ...this.current };
  }
  update(patch) {
    this.current = { ...this.current, ...patch };
    this.emit('status', this.status());
  }
  async connect() {
    this.channel = await CastChannel.connect({ host: this.host, port: this.port, pingMs: this.pingMs, deadMs: this.deadMs });
    this.channel.send(NS.connection, { type: 'CONNECT' });
    this.channel.on('message', (m) => this.onMessage(m));
    this.channel.on('close', () => this.emit('close'));
  }
  onMessage({ namespace, payload }) {
    if (namespace === NS.receiver && payload.type === 'RECEIVER_STATUS') {
      const apps = payload.status?.applications || [];
      const vol = payload.status?.volume;
      if (vol?.level != null) this.current.volume = vol.level;
      // Someone else has the screen now (another app, or another sender relaunched the receiver).
      if (this.transportId && !apps.some((a) => a.transportId === this.transportId)) {
        this.transportId = null;
        this.mediaSessionId = null;
        this.update({ state: 'idle', idleReason: 'taken' });
      } else if (vol) this.emit('status', this.status());
      return;
    }
    if (namespace === NS.media && payload.type === 'MEDIA_STATUS') {
      const s = (payload.status || [])[0];
      if (!s) return;
      if (s.mediaSessionId) this.mediaSessionId = s.mediaSessionId;
      const patch = { state: STATES[s.playerState] || this.current.state };
      if (s.currentTime != null) patch.position = s.currentTime;
      if (s.media?.duration) patch.duration = s.media.duration;
      if (s.volume?.level != null) patch.volume = s.volume.level;
      patch.idleReason = s.playerState === 'IDLE' ? IDLE[s.idleReason] || null : null;
      if (Array.isArray(s.activeTrackIds)) patch.activeTrackIds = s.activeTrackIds;
      this.update(patch);
    }
  }
  /** Start the Default Media Receiver unless it is already running, and open a channel to it. */
  async launch() {
    const st = await this.channel.request(NS.receiver, { type: 'GET_STATUS' });
    let app = (st.status?.applications || []).find((a) => a.appId === DEFAULT_RECEIVER);
    if (st.status?.volume?.level != null) this.current.volume = st.status.volume.level;
    if (!app) {
      const r = await this.channel.request(NS.receiver, { type: 'LAUNCH', appId: DEFAULT_RECEIVER }, { timeoutMs: 15000 });
      app = (r.status?.applications || []).find((a) => a.appId === DEFAULT_RECEIVER);
      if (!app) throw Object.assign(new Error(`${this.name} didn't start the media receiver`), { code: 'LAUNCH_FAILED' });
    }
    this.transportId = app.transportId;
    this.channel.send(NS.connection, { type: 'CONNECT' }, { destinationId: this.transportId });
  }
  /**
   * After a reconnect: join the receiver Atomix launched, if it is still running, and ask for the media status.
   * @returns {Promise<boolean>} false when another app has the screen now
   */
  async attach() {
    const st = await this.channel.request(NS.receiver, { type: 'GET_STATUS' });
    const app = (st.status?.applications || []).find((a) => a.appId === DEFAULT_RECEIVER);
    if (!app) return false;
    this.transportId = app.transportId;
    this.channel.send(NS.connection, { type: 'CONNECT' }, { destinationId: this.transportId });
    await this.media({ type: 'GET_STATUS' }).catch(() => null);
    return true;
  }
  media(payload, opts) {
    return this.channel.request(NS.media, payload, { destinationId: this.transportId, ...opts });
  }
  /**
   * @param {{ url, contentType, title, subtitle?, image?, startTime?, duration?, kind: 'movie'|'episode'|'track'|'extra',
   *   tracks?: { trackId, url, language, name }[], activeTrackIds?: number[] }} m
   */
  async load(m) {
    const metadata = { metadataType: m.kind === 'track' ? 3 : 0, title: m.title, subtitle: m.subtitle || undefined, images: m.image ? [{ url: m.image }] : [] };
    if (m.kind === 'track') Object.assign(metadata, { artist: m.subtitle || undefined, albumName: m.album || undefined });
    const media = { contentId: m.url, contentType: m.contentType, streamType: 'BUFFERED', duration: m.duration || undefined, metadata };
    if (m.tracks?.length) media.tracks = m.tracks.map((t) => ({ trackId: t.trackId, type: 'TEXT', subtype: 'SUBTITLES', trackContentId: t.url, trackContentType: 'text/vtt', language: t.language || 'und', name: t.name }));
    const r = await this.media({ type: 'LOAD', media, autoplay: true, currentTime: m.startTime || 0, activeTrackIds: m.activeTrackIds || [] }, { timeoutMs: 20000 });
    if (r.type === 'LOAD_FAILED' || r.type === 'LOAD_CANCELLED' || r.type === 'INVALID_REQUEST') {
      this.update({ state: 'idle', idleReason: 'error' });
      throw Object.assign(new Error(`${this.name} couldn't load the video`), { code: 'LOAD_FAILED' });
    }
    if (m.duration && !this.current.duration) this.current.duration = m.duration;
  }
  control(type, extra = {}) {
    return this.media({ type, mediaSessionId: this.mediaSessionId, ...extra });
  }
  play() { return this.control('PLAY'); }
  pause() { return this.control('PAUSE'); }
  seek(seconds) { return this.control('SEEK', { currentTime: seconds }); }
  async stop() {
    if (this.mediaSessionId) await this.control('STOP').catch(() => {});
  }
  setTracks(activeTrackIds) { return this.control('EDIT_TRACKS_INFO', { activeTrackIds }); }
  async setVolume(level) {
    await this.channel.request(NS.receiver, { type: 'SET_VOLUME', volume: { level: Math.max(0, Math.min(1, level)) } });
    this.update({ volume: level });
  }
  close() {
    this.channel?.destroy();
  }
}
