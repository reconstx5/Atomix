// Every Jellyfin route Atomix answers, registered on one handler (browse.js, media.js, userdata.js ...), and the
// playing sessions (one stream slot per signed-in device).
import { Jellyfin } from './index.js';
import { registerSystem } from './system.js';
import { registerBrowse } from './browse.js';
import { registerMedia } from './media.js';
import { registerUserData } from './userdata.js';
import { JellyfinSessions } from './sessions.js';

export function createJellyfin(core) {
  const j = new Jellyfin(core);
  j.sessions = new JellyfinSessions({ playback: core.playback });
  registerSystem(j);
  registerBrowse(j);
  registerMedia(j);
  registerUserData(j);
  return j;
}
