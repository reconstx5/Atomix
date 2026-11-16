// Channels this device can't play (v0.28): an encrypted channel none of whose key systems this device has is left
// out of every channel list (Live TV, the guide, Home's On now, search's On TV, the player's list and channel up/down),
// unless the viewer turns on "Show channels this iPhone can't play"; then it is listed dimmed, and opening it shows a
// message card instead of a stream (ui/cant-play.js).
//
// Kept small, since every Live TV page loads it: an iPhone or iPad is known at once (no Widevine or PlayReady there),
// other browsers from support.js's key-system probe, which is loaded only when a list holds an encrypted channel.
// Until the probe has answered, and always on a plain-http page (the secure address may play it), nothing is hidden.
// The iOS check is a copy of support.js's isIos (test/playable.test.js keeps the two the same) so a plain page
// doesn't load the EME and FairPlay helpers for it.

/** The local-storage key of the per-device switch. */
export const SHOW_KEY = 'atomix-show-unplayable';
const IOS_SYSTEMS = ['fairplay', 'clearkey'];

/** An iPhone or iPad (iPadOS asks for the desktop site: a "Mac" with a touch screen). Same as support.js's isIos. */
export function iosDevice(nav = globalThis.navigator) {
  const ua = String(nav?.userAgent || '');
  return /iPhone|iPad|iPod/.test(ua) || (nav?.platform === 'MacIntel' && Number(nav?.maxTouchPoints) > 1);
}

/** 'iPhone' | 'iPad' | 'browser': the word the switch uses for this device. */
export function deviceWord(nav = globalThis.navigator) {
  const ua = String(nav?.userAgent || '');
  if (/iPad/.test(ua) || (!/iPhone|iPod/.test(ua) && iosDevice(nav))) return 'iPad';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  return 'browser';
}

/** "Show channels this iPhone can't play" ("…this iPad…", "…this browser…"). */
export const switchLabel = (word = deviceWord()) => `Show channels this ${word} can't play`;

const systemsOf = (drm) => (Array.isArray(drm) ? drm.filter(Boolean) : drm ? [drm] : []);

/**
 * Can a device with key systems `device` play a channel protected by `drm` (a list of systems, an older single
 * name, or null)? A plain channel always; a device not known yet (null) is given the benefit of the doubt.
 */
export function channelPlayable(drm, device) {
  const systems = systemsOf(drm);
  if (!systems.length || !device) return true;
  return systems.some((s) => device.includes(s));
}

/**
 * The channels to list, in their order: those `device` can play, or, with `showAll`, every one, the others copied
 * with `unplayable: true` (the playable ones are the same objects).
 */
export function hiddenFilter(list, { device = null, showAll = false } = {}) {
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (channelPlayable(c?.drm, device)) out.push(c);
    else if (showAll) out.push({ ...c, unplayable: true });
  }
  return out;
}

// ---- This page's device ----

let support = null; // dash/support.js, once loaded
const secureOrIos = () => iosDevice() || globalThis.isSecureContext !== false;

/** Can anything be hidden on this page at all? Not on a plain-http page, except on an iPhone or iPad. */
export const mayHide = () => secureOrIos();

/** This device's key systems if known now (an iPhone or iPad at once, else once the probe answered), else null. */
export function deviceNow() {
  if (!secureOrIos()) return null;
  if (support) return support.deviceKeySystemsNow();
  return iosDevice() ? [...IOS_SYSTEMS] : null;
}

/**
 * Resolves to this device's key systems once known, or null when they won't be (a plain-http page) or aren't needed
 * (`list` holds no encrypted channel: the probe and its module aren't loaded for nothing).
 */
export async function whenDeviceKnown(list) {
  const now = deviceNow();
  if (now) return now;
  if (!secureOrIos()) return null;
  if (list && !list.some((c) => systemsOf(c?.drm).length)) return null;
  support ||= await import('./support.js');
  await support.deviceKeySystems();
  return deviceNow();
}

/** whenDeviceKnown, waiting at most `ms` (a page drawn once, such as the guide, doesn't wait long; null: hide nothing). */
export const deviceSoon = (list, ms = 1500) => Promise.race([whenDeviceKnown(list).catch(() => null), new Promise((r) => setTimeout(() => r(null), ms))]);

/** Is this channel one this device is known not to play? */
export const unplayableHere = (drm) => !channelPlayable(drm, deviceNow());

/** The switch: are the channels this device can't play listed anyway (dimmed)? */
let pageOnly = null; // the switch when local storage can't keep it (a private window)
export function showAllNow() {
  if (pageOnly != null) return pageOnly;
  try {
    return globalThis.localStorage?.getItem(SHOW_KEY) === '1';
  } catch {
    return false;
  }
}
export function setShowAll(on) {
  pageOnly = null;
  try {
    if (on) globalThis.localStorage?.setItem(SHOW_KEY, '1');
    else globalThis.localStorage?.removeItem(SHOW_KEY);
  } catch {
    pageOnly = Boolean(on); // the switch lasts this page only
  }
}

/** The channels to list on this page now (the device as known now, the switch as set). */
export const listable = (list, { showAll = showAllNow(), device = deviceNow() } = {}) => hiddenFilter(list, { device, showAll });

/** How many of `list` this device is known not to play (the switch is shown only when this is above 0). */
export const hiddenCount = (list, device = deviceNow()) => (Array.isArray(list) ? list.filter((c) => !channelPlayable(c?.drm, device)).length : 0);

/** Home's "On now" card as the channel the message card needs. */
export const liveTarget = (item) => ({ id: item.channelId, name: item.subtitle, number: item.number ?? null, drm: item.drm ?? null, appUrl: item.appUrl || null, appName: item.appName || null, radio: Boolean(item.radio) });
