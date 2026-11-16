// Can this device play a channel's protection (v0.27)? Asked before an encrypted channel starts, so a phone that can't
// play it hears why at once and no stream is opened for nothing. iPhones have no Widevine at all (the secure address
// wouldn't help); other browsers need a secure page, then their own key system.
import { NEED_SECURE, NO_WIDEVINE, NO_WIDEVINE_IPHONE, NO_FAIRPLAY, NO_COMMON_SYSTEM, NO_PROTECTION_IOS, PLAYREADY, PLAYREADY_PLAIN } from './eme.js';
import { fairPlayConfigs, FAIRPLAY } from './fairplay.js';

const WIDEVINE = 'com.widevine.alpha';
const CLEARKEY = 'org.w3.clearkey';
const AVC = 'video/mp4; codecs="avc1.42E01E"';
const WIDEVINE_PROBE = [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: AVC, robustness: 'SW_SECURE_CRYPTO' }] }];
const AAC = 'audio/mp4; codecs="mp4a.40.2"';
// Video hardware (3000) then software (2000); PlayReady audio is software (2000) in both.
const PLAYREADY_PROBE = ['3000', '2000'].map((robustness) => ({ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: AVC, robustness }], audioCapabilities: [{ contentType: AAC, robustness: '2000' }] }));
const CLEARKEY_PROBE = [{ initDataTypes: ['keyids', 'cenc'], videoCapabilities: [{ contentType: AVC }] }];
const probeConfigs = (keySystem) => (keySystem === FAIRPLAY ? fairPlayConfigs() : keySystem === PLAYREADY || keySystem === PLAYREADY_PLAIN ? PLAYREADY_PROBE : keySystem === CLEARKEY ? CLEARKEY_PROBE : WIDEVINE_PROBE);

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
        ? navigator.requestMediaKeySystemAccess(keySystem, probeConfigs(keySystem)).then(
            () => true,
            () => false,
          )
        : Promise.resolve(false),
    );
  }
  return probes.get(keySystem);
}

const appleSafari = (ua = String(globalThis.navigator?.userAgent || '')) => /Safari/.test(ua) && !/Chrome|Chromium|Android|Edg\//.test(ua);
const edgeOnWindows = (ua, platform) => /Edg\//.test(ua) && (/Windows/.test(ua) || /^Win/.test(String(platform || '')));

// v0.28: what each kind of browser prefers. Safari's FairPlay; Edge on Windows' PlayReady is hardware-backed there
// (its Widevine is software only); everything else Widevine first.
const EME_NAMES = { widevine: [WIDEVINE], playready: [PLAYREADY, PLAYREADY_PLAIN], clearkey: [CLEARKEY], fairplay: [FAIRPLAY] };
const IOS_SYSTEMS = ['fairplay', 'clearkey'];

let known = null; // this page's answer, once the probe has given it
let asking = null;

const PROBE_MS = 4000; // a key system that never answers counts as absent
const has = async (probe, name) => {
  for (const k of EME_NAMES[name]) {
    let timer;
    const late = new Promise((r) => (timer = setTimeout(() => r(false), PROBE_MS)));
    const ok = await Promise.race([Promise.resolve(probe(k)).catch(() => false), late]);
    clearTimeout(timer);
    if (ok) return true;
  }
  return false;
};

/**
 * The key systems this device has, by name, in its own order of preference (sent with the play request). On an
 * iPhone or iPad known without asking; elsewhere probed once per page, on a secure page only (a plain-http page has
 * none: [] — the secure address may still play the channel). Called with options (tests), nothing is cached.
 * @returns {Promise<string[]>}
 */
export function deviceKeySystems(opts) {
  const nav = globalThis.navigator;
  const { ua = String(nav?.userAgent || ''), platform = nav?.platform, ios = opts?.ua ? isIos({ userAgent: ua, platform: '', maxTouchPoints: 0 }) : isIos(nav), secure = globalThis.isSecureContext, probe = probeKeySystem } = opts || {};
  const work = async () => {
    if (ios) return [...IOS_SYSTEMS];
    if (secure === false) return [];
    const order = appleSafari(ua) ? ['fairplay', 'clearkey'] : edgeOnWindows(ua, platform) ? ['playready', 'widevine', 'clearkey'] : ['widevine', 'playready', 'clearkey'];
    const out = [];
    for (const name of order) if (await has(probe, name)) out.push(name);
    return out;
  };
  if (opts) return work();
  if (!asking) {
    if (ios) known = [...IOS_SYSTEMS];
    asking = work().then((list) => (known = list));
  }
  return asking;
}

/**
 * Does a channel's play request carry the device's key systems? Only when the channel offers several (or isn't
 * known yet: a direct link). With one system the server's choice is forced, so the v0.27 request is sent as it was
 * (no list, no probe).
 */
export const sendsKeySystems = (drm) => drm === undefined || (Array.isArray(drm) && drm.filter(Boolean).length > 1);

/** This page's key systems if already known (an iPhone or iPad at once, else once the probe answered); else null. */
export function deviceKeySystemsNow() {
  if (!known && !asking && isIos()) known = [...IOS_SYSTEMS];
  return known;
}

/**
 * The sentence when this device can't play `system` ('widevine' | 'clearkey' | 'fairplay'), else null.
 * v0.28: `system` may be the channel's list of systems: null when any of them is on this device, else the sentence
 * for the best one to explain (an iPhone's own sentences, the secure address on a plain-http page, else "can't play any").
 * @returns {Promise<string|null>}
 */
export async function protectionVerdict(system, opts = {}) {
  if (Array.isArray(system)) return listVerdict(system, opts);
  const { secure = globalThis.isSecureContext, ios = isIos(), apple = appleSafari() || ios, probe = probeKeySystem } = opts;
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

async function listVerdict(systems, { secure = globalThis.isSecureContext, ios = isIos(), probe, ua } = {}) {
  if (!systems.length) return null;
  if (ios) {
    if (!systems.some((s) => IOS_SYSTEMS.includes(s))) return systems.includes('widevine') ? NO_WIDEVINE_IPHONE : NO_PROTECTION_IOS;
    return secure === false ? NEED_SECURE : null;
  }
  if (secure === false) return NEED_SECURE;
  const device = probe || ua ? await deviceKeySystems({ secure, ios: false, ...(probe ? { probe } : {}), ...(ua ? { ua } : {}) }) : await deviceKeySystems();
  return systems.some((s) => device.includes(s)) ? null : NO_COMMON_SYSTEM;
}
