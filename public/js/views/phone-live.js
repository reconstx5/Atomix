// Live TV on a phone (v0.27): while a channel plays the screen stays on (Screen Wake Lock), and full screen turns the
// phone to landscape. Touch devices only (a coarse pointer): computers and TVs with remotes are unchanged. Every
// refusal (battery saver, an unsupported browser, iPhone's own full screen) is ignored: playback goes on regardless.

/**
 * @param {HTMLVideoElement} video
 * @returns {{ destroy(): void }}
 */
export function phoneLive(video, { touch = globalThis.matchMedia?.('(pointer: coarse)').matches ?? false } = {}) {
  if (!touch) return { destroy() {} };
  let lock = null;
  let wanted = false; // playing: the lock should be held (it's dropped by the browser when the page is hidden)
  let gone = false;

  const take = async () => {
    if (gone || lock || !navigator.wakeLock?.request || document.visibilityState === 'hidden') return;
    try {
      const l = await navigator.wakeLock.request('screen');
      if (gone || !wanted) return l.release().catch(() => {});
      lock = l;
      l.addEventListener?.('release', () => {
        if (lock === l) lock = null;
      });
    } catch {
      /* refused: the screen may dim, nothing else changes */
    }
  };
  const drop = () => {
    const l = lock;
    lock = null;
    l?.release().catch(() => {});
  };
  const onPlaying = () => {
    wanted = true;
    take();
  };
  const onStop = () => {
    wanted = false;
    drop();
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible' && wanted && !video.paused) take();
  };
  const onFullscreen = () => {
    const o = globalThis.screen?.orientation;
    try {
      if (document.fullscreenElement) o?.lock?.('landscape')?.catch?.(() => {});
      else o?.unlock?.();
    } catch {
      /* not allowed here */
    }
  };
  video.addEventListener('playing', onPlaying);
  video.addEventListener('pause', onStop);
  video.addEventListener('ended', onStop);
  document.addEventListener('visibilitychange', onVisible);
  document.addEventListener('fullscreenchange', onFullscreen);
  return {
    destroy() {
      if (gone) return;
      gone = true;
      wanted = false;
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('pause', onStop);
      video.removeEventListener('ended', onStop);
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('fullscreenchange', onFullscreen);
      drop();
    },
  };
}
