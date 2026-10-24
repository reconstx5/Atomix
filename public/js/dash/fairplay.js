// FairPlay in Safari (v0.27): the relayed HLS playlist on the video, keys from Safari's own FairPlay module through
// modern EME. Atomix serves the certificate and relays the licence (SPC in, CKC out); it never holds a key.
import { NO_FAIRPLAY, WONT_PLAY, NOT_ANSWERING, licenceError } from './eme.js';

export const FAIRPLAY = 'com.apple.fps';

/** What to ask requestMediaKeySystemAccess for. */
export function fairPlayConfigs() {
  return [{ initDataTypes: ['skd'], videoCapabilities: [{ contentType: 'application/vnd.apple.mpegurl' }, { contentType: 'video/mp4' }], distinctiveIdentifier: 'not-allowed', persistentState: 'not-allowed', sessionTypes: ['temporary'] }];
}

/** The content id in `skd` init data (the skd:// URI, as UTF-8 or UTF-16), without the scheme. */
export function skdContentId(initData) {
  const b = initData instanceof Uint8Array ? initData : new Uint8Array(initData);
  let wide = b.length >= 4 && b.length % 2 === 0;
  for (let i = 1; wide && i < b.length; i += 2) if (b[i] !== 0) wide = false;
  const text = new TextDecoder(wide ? 'utf-16le' : 'utf-8').decode(b).replace(/\0/g, '').trim();
  return text.replace(/^skd:\/\//i, '');
}

/**
 * Play a FairPlay channel. Failures before playing reject with a sentence; later ones (a refused licence) reach onError once.
 * @returns {Promise<{ close(): Promise<void> }>}
 */
export async function playFairPlay(video, { playlist, licence, certificate, onError = () => {}, isStale = () => false, fetch = globalThis.fetch }) {
  let access;
  try {
    access = await navigator.requestMediaKeySystemAccess(FAIRPLAY, fairPlayConfigs());
  } catch {
    throw new Error(NO_FAIRPLAY);
  }
  let keys;
  try {
    keys = await access.createMediaKeys();
    const res = await fetch(certificate, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('no certificate');
    await keys.setServerCertificate(await res.arrayBuffer());
  } catch {
    throw new Error(WONT_PLAY);
  }
  // Stopped meanwhile (a zap): the video may be playing the next channel now — leave it alone.
  if (isStale()) throw new Error('stopped');
  try {
    await video.setMediaKeys(keys);
  } catch {
    throw new Error(WONT_PLAY);
  }
  if (isStale()) {
    await video.setMediaKeys(null).catch(() => {});
    throw new Error('stopped');
  }
  const sessions = [];
  let closed = false;
  let failed = false;
  const fail = (sentence) => {
    if (closed || failed) return;
    failed = true;
    onError(sentence);
  };
  const onEncrypted = async (e) => {
    if (closed || !e.initData) return;
    const contentId = skdContentId(e.initData);
    const session = keys.createSession('temporary');
    sessions.push(session);
    session.addEventListener('message', async (m) => {
      let res;
      try {
        res = await fetch(`${licence}?contentId=${encodeURIComponent(contentId)}`, { method: 'POST', body: m.message, headers: { 'content-type': 'application/octet-stream' }, credentials: 'same-origin' });
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
    try {
      await session.generateRequest(e.initDataType || 'skd', e.initData);
    } catch {
      fail(WONT_PLAY);
    }
  };
  video.addEventListener('encrypted', onEncrypted);
  video.src = playlist;
  return {
    async close() {
      if (closed) return;
      closed = true;
      video.removeEventListener('encrypted', onEncrypted);
      // Only its own playlist: a channel that started meanwhile keeps its stream.
      if (!video.getAttribute || video.getAttribute('src') === playlist) {
        video.removeAttribute('src');
        video.load();
      }
      await video.setMediaKeys(null).catch(() => {});
      await Promise.all(sessions.map((s) => s.close().catch(() => {})));
    },
  };
}
