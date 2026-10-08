// The gate: what a page load shows. Each tab keeps a note in sessionStorage (which the browser clears
// when the tab closes) saying which profile it is on and when it was last touched. No note means a fresh
// open (the splash, then "Who's watching?"); a fresh note means a reload (nothing extra); a stale note
// means the picker comes back. Playing video or music counts as being there.
export const NOTE_KEY = 'atomix-gate';
const TOUCH_EVERY = 5_000;

/**
 * Pure: the four outcomes. `note` is { profileId, lastActive } or null; idleMinutes 0 means never.
 * `profileId` (optional) is the profile the server session serves: a note for a different one means this
 * tab's last pick isn't what it would get, so it must ask again.
 */
export function gateDecision({ note, now, idleMinutes, needsPicker, profileId = null }) {
  const last = Number(note?.lastActive);
  if (!note || !Number.isFinite(last)) return needsPicker ? 'splash+picker' : 'splash';
  if (profileId != null && note.profileId !== profileId) return needsPicker ? 'picker' : 'nothing';
  if (!idleMinutes || now - last < idleMinutes * 60_000) return 'nothing';
  return needsPicker ? 'picker' : 'nothing';
}

// ---- The note (storage may be missing or refuse: then this page keeps its own copy, and every load is a
// fresh open — but the idle picker still comes back within the page) ----
let memo = null; // the note as this page last wrote it, for when storage can't be read
function storage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
export function readNote() {
  const s = storage();
  if (!s) return memo;
  try {
    const raw = s.getItem(NOTE_KEY);
    if (!raw) return null;
    const note = JSON.parse(raw);
    return note && typeof note === 'object' ? note : null;
  } catch {
    return memo;
  }
}
function saveNote(note) {
  memo = note;
  try {
    storage()?.setItem(NOTE_KEY, JSON.stringify(note));
  } catch {
    /* no storage: the next load is a fresh open, which is fine */
  }
}
export function writeNote(profileId, now = Date.now()) {
  saveNote({ profileId, lastActive: now });
}
let lastTouch = 0;
export function touchNote(now = Date.now(), { force = false } = {}) {
  if (!force && now - lastTouch < TOUCH_EVERY) return;
  lastTouch = now;
  const note = readNote();
  if (note) saveNote({ ...note, lastActive: now });
}
export function clearNote() {
  memo = null;
  try {
    storage()?.removeItem(NOTE_KEY);
  } catch {
    /* ignore */
  }
}

// ---- Activity, playing, and the tick ----
const ACTIVITY = ['keydown', 'pointermove', 'pointerdown', 'wheel', 'touchstart', 'scroll'];
const TICK_MS = 30_000;
const REREAD_EVERY = 10; // ticks between re-reads of the server's status while idle
let tick = null;
let idle = 30;
let picker = null;
let refresh = null;
let mediaPlaying = () => false;
let shown = false;
let returnTo = null;
const onActivity = () => touchNote();

/**
 * A player says it started (video or music): the note is touched at once. Whether something is *still*
 * playing is asked of the media elements themselves on each tick (see startGate's `isMediaPlaying`), so
 * events that come in odd pairs (a src swap, pause + ended) can't leave a stale count behind.
 */
export function markPlaying(on) {
  if (on) touchNote(Date.now(), { force: true });
}
export const isPlaying = () => mediaPlaying();

/** The address to go back to after the picker, for the profile that was on. Taken once, by that profile only. */
export function rememberReturn(hash, profileId) {
  returnTo = { hash, profileId };
}
export function takeReturn(profileId) {
  const r = returnTo;
  returnTo = null;
  return r && r.profileId === profileId ? r.hash : null;
}
export function forgetReturn() {
  returnTo = null;
}

export function setGateIdle(minutes) {
  idle = Number(minutes) || 0;
}

/**
 * Watch for idle time once a profile is on. `onPicker()` is called once when it is time to ask again.
 * `isMediaPlaying()` says whether video or music is playing right now. `onRefresh()` (async, optional) is
 * asked for the current { idleMinutes, needsPicker } just before the picker would show, so a setting changed
 * from another screen, or a profile or PIN added since, counts without a reload.
 */
export function startGate({ idleMinutes, needsPicker, onPicker, isMediaPlaying = () => false, onRefresh = null }) {
  stopGate();
  idle = Number(idleMinutes) || 0;
  let needs = Boolean(needsPicker);
  picker = onPicker;
  refresh = onRefresh;
  mediaPlaying = isMediaPlaying;
  shown = false;
  let ticks = 0;
  for (const ev of ACTIVITY) window.addEventListener(ev, onActivity, { passive: true, capture: true });
  const reread = async () => {
    if (!refresh) return;
    try {
      const fresh = await refresh();
      if (tick !== myTick || !fresh) return; // the gate was stopped or restarted meanwhile
      idle = Number(fresh.idleMinutes) || 0;
      needs = Boolean(fresh.needsPicker);
    } catch {
      /* offline: decide on what we know */
    }
  };
  const myTick = setInterval(async () => {
    if (mediaPlaying()) return touchNote(Date.now(), { force: true }); // never stale while something plays
    if (shown) return;
    const due = () => gateDecision({ note: readNote(), now: Date.now(), idleMinutes: idle, needsPicker: needs }) === 'picker';
    // A setting changed elsewhere (the admin's laptop), or a profile or PIN added since: re-read the server's
    // status every ten quiet ticks (5 minutes), and once more right before asking.
    if (++ticks % REREAD_EVERY === 0 || due()) await reread();
    if (tick !== myTick || !due() || mediaPlaying()) return;
    shown = true;
    picker?.();
  }, TICK_MS);
  tick = myTick;
}
export function stopGate() {
  for (const ev of ACTIVITY) window.removeEventListener(ev, onActivity, { capture: true });
  clearInterval(tick);
  tick = null;
}
