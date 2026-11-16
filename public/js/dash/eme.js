// Keys for an encrypted DASH channel, from the browser's own key system (Widevine, or ClearKey) through Encrypted
// Media Extensions. Atomix never sees a Widevine key: the key system's licence requests go to Atomix's licence
// address, which relays them to the provider, and the sealed answer goes back to the key system. The pure helpers
// (what to ask for, the init data, the sentences) are tested in Node; setupKeys runs in the browser.

const WIDEVINE = 'com.widevine.alpha';
// v0.28: PlayReady (Edge on Windows, some Chromium builds). The newer name first; the plain one if it's refused.
export const PLAYREADY = 'com.microsoft.playready.recommendation';
export const PLAYREADY_PLAIN = 'com.microsoft.playready';
export const isPlayReady = (keySystem) => keySystem === PLAYREADY || keySystem === PLAYREADY_PLAIN;
const PLAYREADY_ID = [0x9a, 0x04, 0xf0, 0x79, 0x98, 0x40, 0x42, 0x86, 0xab, 0x92, 0xe6, 0x5b, 0xe0, 0x88, 0x5f, 0x95];
export const NO_WIDEVINE = "This browser can't play this channel's protection.";
// v0.27: said before the channel starts (dash/support.js). iPhones have no Widevine; FairPlay plays only in Safari.
export const NO_WIDEVINE_IPHONE = "This channel is encrypted with Widevine, which iPhones can't play.";
export const NO_FAIRPLAY = 'This channel is encrypted with FairPlay, which plays in Safari on Apple devices';
export const WONT_PLAY = "This channel's protection won't play in this browser";
export const REFUSED = "The provider refused this channel's licence";
export const NOT_ANSWERING = "The licence server isn't answering";
export const UNREADABLE = "This channel's stream couldn't be read";
export const EXPIRED = 'Your sign-in has expired — sign in again';
// v0.27: browsers only decrypt on a secure page (https://, or this computer's own localhost) — a phone on the plain
// home-network address gets this, with the secure address to open (views/player.js).
export const NEED_SECURE = "Encrypted channels need Atomix's secure address on this device";
// v0.28: a channel offering several systems, none of which this device has (said before the channel starts).
export const NO_COMMON_SYSTEM = "This browser can't play any of this channel's protections.";
export const NO_PROTECTION_IOS = "This channel's protection doesn't play on iPhone or iPad.";

const LOWER_CODECS = new Set(['opus', 'flac']); // browsers match these by their lowercase names

/** A representation's SourceBuffer type ("audio/mp4; codecs=\"opus\""). */
export function mseType(rep) {
  const codecs = String(rep.codecs || '')
    .split(',')
    .map((c) => (LOWER_CODECS.has(c.trim().toLowerCase()) ? c.trim().toLowerCase() : c.trim()))
    .join(',');
  return `${rep.mimeType}; codecs="${codecs}"`;
}
const contentType = mseType;
const unique = (list) => [...new Set(list)];

/** The configurations to ask requestMediaKeySystemAccess for, from the tracks the player will play. */
export function keySystemConfigs(keySystem, { video = [], audio = [] } = {}) {
  if (isPlayReady(keySystem)) {
    // Hardware (3000) video first, then software (2000): two configurations, the browser takes the first it can give.
    // Audio is software (2000) in both: PlayReady devices refuse 3000 for audio.
    return ['3000', '2000'].map((robustness) => {
      const caps = (tracks, r) => unique(tracks.filter((t) => t.mimeType && t.codecs).map(contentType)).map((c) => ({ contentType: c, robustness: r }));
      const config = { initDataTypes: ['cenc'] };
      const v = caps(video, robustness);
      const a = caps(audio, '2000');
      if (v.length) config.videoCapabilities = v;
      if (a.length) config.audioCapabilities = a;
      return { ...config, persistentState: 'optional', distinctiveIdentifier: 'optional', sessionTypes: ['temporary'] };
    });
  }
  const wv = keySystem === WIDEVINE;
  const caps = (tracks) => unique(tracks.filter((t) => t.mimeType && t.codecs).map(contentType)).map((c) => (wv ? { contentType: c, robustness: 'SW_SECURE_CRYPTO' } : { contentType: c }));
  const config = { initDataTypes: wv ? ['cenc'] : ['keyids', 'cenc'] };
  const v = caps(video);
  const a = caps(audio);
  if (v.length) config.videoCapabilities = v;
  if (a.length) config.audioCapabilities = a;
  return [{ ...config, persistentState: 'optional', distinctiveIdentifier: 'optional', sessionTypes: ['temporary'] }];
}

const fromBase64 = (b64) => Uint8Array.from(atob(String(b64).replace(/\s+/g, '')), (c) => c.charCodeAt(0));
const hexToBase64Url = (hex) => {
  let bin = '';
  for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** A version-0 PSSH box for PlayReady around the manifest's PlayReady Header Object (mspr:pro). */
function playReadyPssh(pro) {
  const data = fromBase64(pro);
  const out = new Uint8Array(32 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  out.set([0x70, 0x73, 0x73, 0x68], 4); // 'pssh'; version 0, no flags
  out.set(PLAYREADY_ID, 12);
  view.setUint32(28, data.length);
  out.set(data, 32);
  return out;
}

/**
 * The init data for the manifest's protection entries: Widevine's pssh boxes (each once); PlayReady's own pssh boxes,
 * else PSSH boxes built from its mspr:pro headers; or for ClearKey the key ids.
 * Empty when the manifest has none (the init segment's `encrypted` event supplies it then).
 */
export function initDataFor(keySystem, contentProtection = []) {
  if (keySystem === WIDEVINE) {
    const pssh = unique(contentProtection.filter((c) => c.system === 'widevine' && c.pssh).map((c) => c.pssh));
    return pssh.map((p) => ({ initDataType: 'cenc', initData: fromBase64(p) }));
  }
  if (isPlayReady(keySystem)) {
    const pr = contentProtection.filter((c) => c.system === 'playready');
    const pssh = unique(pr.filter((c) => c.pssh).map((c) => c.pssh));
    if (pssh.length) return pssh.map((p) => ({ initDataType: 'cenc', initData: fromBase64(p) }));
    const pros = unique(pr.filter((c) => c.pro).map((c) => c.pro));
    const out = [];
    for (const p of pros) {
      try {
        out.push({ initDataType: 'cenc', initData: playReadyPssh(p) });
      } catch {
        /* not base64: the init segment's own data is used */
      }
    }
    return out;
  }
  const kids = unique(contentProtection.map((c) => c.kid).filter(Boolean));
  if (!kids.length) return [];
  return [{ initDataType: 'keyids', initData: new TextEncoder().encode(JSON.stringify({ kids: kids.map(hexToBase64Url) })) }];
}

/** A failed licence request as a sentence: Atomix's own (403s), a gone session (404), a lapsed sign-in (401), else "isn't answering". */
export function licenceError(status, serverSentence = null) {
  if (status === 403) return serverSentence || REFUSED;
  if (status === 404) return UNREADABLE; // the relay session has gone: the player's restart budget applies
  if (status === 401) return EXPIRED;
  return NOT_ANSWERING;
}

/**
 * The sentence when the key system won't use any key (an output it can't protect, an internal failure); null while
 * one is usable — a browser that restricts the HD keys (Widevine without hardware protection) still plays SD.
 */
export function keyStatusError(statuses) {
  const all = [...statuses.values()];
  if (all.includes('usable')) return null;
  return all.some((s) => s === 'output-restricted' || s === 'internal-error') ? WONT_PLAY : null;
}

const toHex = (buf) => [...new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** v0.27: the key ids (hex) a phone refuses for now — HD behind output protection it can't give. */
export function restrictedKids(statuses) {
  const out = [];
  for (const [kid, status] of statuses) if (status === 'output-restricted' || status === 'usable-in-future') out.push(toHex(kid));
  return out;
}

// The previous player's keys being released (closing sessions, detaching from the video): a new channel's keys
// wait for it, or setMediaKeys would refuse them (or the late detach would remove them).
let releasing = Promise.resolve();

const same = (a, b) => a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);

/**
 * Give `video` its keys. Licence messages are POSTed (bytes) to `licenceUrl`; a failure later on (a refused licence,
 * a key that won't play) reaches `onError(sentence)` once.
 * @returns {Promise<{ close(): Promise<void> }>}
 */
export async function setupKeys(video, { keySystem, licenceUrl, contentProtection = [], tracks = {}, serverCertificate = null, initData = null, isStale = () => false, onError = () => {}, onRestricted = () => {}, fetch = globalThis.fetch }) {
  await releasing.catch(() => {});
  if (globalThis.isSecureContext === false) throw new Error(NEED_SECURE);
  let access;
  // PlayReady: the server's name is a hint; the browser asks for the newer name first, then the plain one.
  const names = isPlayReady(keySystem) ? [PLAYREADY, PLAYREADY_PLAIN] : [keySystem];
  for (const name of names) {
    try {
      access = await navigator.requestMediaKeySystemAccess(name, keySystemConfigs(name, tracks));
      keySystem = name;
      break;
    } catch {
      /* the next name, or the sentence below */
    }
  }
  if (!access) throw new Error(keySystem === WIDEVINE ? NO_WIDEVINE : WONT_PLAY);
  let keys;
  try {
    keys = await access.createMediaKeys();
  } catch {
    throw new Error(WONT_PLAY);
  }
  // The playlist's server certificate (Widevine privacy mode): on the keys before they're attached and before the
  // first licence request. A refused one is the playlist's problem: not worth retrying.
  if (serverCertificate) {
    try {
      await keys.setServerCertificate(fromBase64(serverCertificate));
    } catch {
      throw new Error(WONT_PLAY);
    }
  }
  // The player was stopped meanwhile (a zap to a plain channel): the video may be loading another source now.
  if (isStale()) throw new Error('stopped');
  try {
    await video.setMediaKeys(keys);
  } catch {
    throw new Error(WONT_PLAY);
  }
  const sessions = [];
  const seen = [];
  let closed = false;
  let failed = false;
  const fail = (sentence) => {
    if (closed || failed) return;
    failed = true;
    onError(sentence);
  };
  const open = async (initDataType, initData) => {
    const bytes = new Uint8Array(initData);
    if (closed || seen.some((s) => same(s, bytes))) return;
    seen.push(bytes);
    const session = keys.createSession('temporary');
    sessions.push(session);
    session.addEventListener('message', async (e) => {
      let res;
      try {
        res = await fetch(licenceUrl, { method: 'POST', body: e.message, headers: { 'content-type': 'application/octet-stream' }, credentials: 'same-origin' });
      } catch {
        return fail(NOT_ANSWERING);
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        return fail(licenceError(res.status, body?.error));
      }
      try {
        await session.update(await res.arrayBuffer());
      } catch {
        fail(WONT_PLAY);
      }
    });
    session.addEventListener('keystatuseschange', () => {
      const sentence = keyStatusError(session.keyStatuses);
      if (sentence) return fail(sentence);
      // Some keys refused while another plays (a phone without HD output protection): the player drops those levels.
      const refused = restrictedKids(session.keyStatuses);
      if (refused.length && !closed && !failed) onRestricted(refused);
    });
    try {
      await session.generateRequest(initDataType, bytes);
    } catch {
      fail(WONT_PLAY);
    }
  };
  let fromManifest = initDataFor(keySystem, contentProtection);
  // The playlist's init data (license_data) when the manifest carries none.
  if (!fromManifest.length && initData) {
    try {
      fromManifest = [{ initDataType: 'cenc', initData: fromBase64(initData) }];
    } catch {
      /* not base64: the init segment's own data is used */
    }
  }
  // The init segment's own init data names the same key (in another form): only used when the manifest had none,
  // or a second session would ask for the same licence again.
  const onEncrypted = (e) => {
    if (e.initData && !fromManifest.length) open(e.initDataType, e.initData);
  };
  video.addEventListener('encrypted', onEncrypted);
  for (const { initDataType, initData } of fromManifest) await open(initDataType, initData);
  return {
    close() {
      if (closed) return releasing;
      closed = true;
      video.removeEventListener('encrypted', onEncrypted);
      // Detach first, at once (the player removed its source just before): once the next channel's source starts
      // loading, the browser refuses to remove the keys ("cannot be removed at this time").
      const detached = video.setMediaKeys(null).catch(() => {});
      const done = (async () => {
        await detached;
        await Promise.all(sessions.map((s) => s.close().catch(() => {})));
      })();
      releasing = done;
      return done;
    },
  };
}
