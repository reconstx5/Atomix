// Can this device play a channel's protection (v0.27)? Asked before an encrypted channel starts, so a phone that can't
// play it hears why at once and no stream is opened for nothing. iPhones have no Widevine at all (the secure address
// wouldn't help); other browsers need a secure page, then their own key system.
import { NEED_SECURE, NO_WIDEVINE, NO_WIDEVINE_IPHONE, NO_FAIRPLAY } from './eme.js';
import { fairPlayConfigs, FAIRPLAY } from './fairplay.js';

const WIDEVINE = 'com.widevine.alpha';
const WIDEVINE_PROBE = [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"', robustness: 'SW_SECURE_CRYPTO' }] }];

/** An iPhone or iPad (iPadOS asks for the desktop site: a "Mac" with a touch screen). */
export function isIos(nav = globalThis.navigator) {
  const ua = String(nav?.userAgent || '');
  return /iPhone|iPad|iPod/.test(ua) || (nav?.platform === 'MacIntel' && Number(nav?.maxTouchPoints) > 1);
}

const probes = new Map();
/** Does this browser have the key system? Asked once per key system. */
export function probeKeySystem(keySystem) {
  if (!probes.has(keySystem)) {
    const ask = globalThis.navigator?.requestMediaKeySystemAccess;
    probes.set(
      keySystem,
      ask
        ? navigator.requestMediaKeySystemAccess(keySystem, keySystem === FAIRPLAY ? fairPlayConfigs() : WIDEVINE_PROBE).then(
            () => true,
            () => false,
          )
        : Promise.resolve(false),
    );
  }
  return probes.get(keySystem);
}

const appleSafari = () => {
  const ua = String(globalThis.navigator?.userAgent || '');
  return /Safari/.test(ua) && !/Chrome|Chromium|Android|Edg\//.test(ua);
};

/**
 * The sentence when this device can't play `system` ('widevine' | 'clearkey' | 'fairplay'), else null.
 * @returns {Promise<string|null>}
 */
export async function protectionVerdict(system, { secure = globalThis.isSecureContext, ios = isIos(), apple = appleSafari() || ios, probe = probeKeySystem } = {}) {
  if (!system) return null;
  if (system === 'widevine') {
    if (ios) return NO_WIDEVINE_IPHONE;
    if (secure === false) return NEED_SECURE;
    return (await probe(WIDEVINE)) ? null : NO_WIDEVINE;
  }
  if (system === 'fairplay') {
    if (secure === false) return apple ? NEED_SECURE : NO_FAIRPLAY;
    return (await probe(FAIRPLAY)) ? null : NO_FAIRPLAY;
  }
  return secure === false ? NEED_SECURE : null; // ClearKey: its own path says why if it fails
}
