// Names for what the browser remembers between visits (localStorage). Atomix used to
// be called NodeFlix and these started with "nf-"; anything saved under an old name
// moves across the first time this loads. What's already under the new name wins.
try {
  const old = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('nf-')) old.push(key);
  }
  for (const key of old) {
    const renamed = `atomix-${key.slice(3)}`;
    if (localStorage.getItem(renamed) === null) localStorage.setItem(renamed, localStorage.getItem(key));
    localStorage.removeItem(key);
  }
} catch {
  /* storage blocked (private mode) or full — nothing to move */
}

/** Volume, shared by the video and music players. */
export const VOLUME_KEY = 'atomix-volume';
/** The music queue and position, per profile. */
export const musicKey = (profileId) => `atomix-music:${profileId}`;
