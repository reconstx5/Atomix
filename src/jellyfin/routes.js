// Every Jellyfin route Atomix answers, registered on one handler (later: browse.js, media.js, userdata.js).
import { Jellyfin } from './index.js';
import { registerSystem } from './system.js';

export function createJellyfin(core) {
  const j = new Jellyfin(core);
  registerSystem(j);
  return j;
}
