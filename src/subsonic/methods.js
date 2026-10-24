// Every Subsonic method Atomix answers, registered on one handler.
import { Subsonic } from './index.js';
import { registerSystem } from './system.js';
import { registerBrowse } from './browse.js';
import { registerMedia } from './media.js';
import { registerAnnotate } from './annotate.js';
import { registerPlaylists } from './playlists.js';
import { registerPodcasts } from './podcasts.js';

export function createSubsonic(core) {
  const s = new Subsonic(core);
  registerSystem(s);
  registerBrowse(s);
  registerMedia(s);
  registerAnnotate(s);
  registerPlaylists(s);
  registerPodcasts(s);
  return s;
}
