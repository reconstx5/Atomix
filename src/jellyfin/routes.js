// Every Jellyfin route Atomix answers, registered on one handler (later: browse.js, media.js, userdata.js).
import { Jellyfin } from './index.js';
import { registerSystem } from './system.js';
import { registerBrowse } from './browse.js';

export function createJellyfin(core) {
  const j = new Jellyfin(core);
  registerSystem(j);
  registerBrowse(j);
  return j;
}
