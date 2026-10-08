// Connected servers: one provider per kind, and the helpers that tell a remote item from a local file.
import { HttpError } from '../http/router.js';
import { JellyfinProvider } from './jellyfin.js';
import { AtomixProvider } from './atomix.js';
import { PlexProvider } from './plex.js';
import { parseJson } from '../db.js';

export const REMOTE_PREFIX = 'remote:';
export const isRemotePath = (p) => typeof p === 'string' && p.startsWith(REMOTE_PREFIX);
export const remotePath = (serverId, remoteId) => `${REMOTE_PREFIX}${serverId}:${remoteId}`;

/** The provider for a server kind (one instance per kind per process). */
export function makeProviders({ version, settings }) {
  const by = {
    jellyfin: new JellyfinProvider({ kind: 'jellyfin', version }),
    emby: new JellyfinProvider({ kind: 'emby', version }),
    atomix: new AtomixProvider({ kind: 'atomix', version }),
    plex: new PlexProvider({ kind: 'plex', version, settings }),
  };
  return { for: (kind) => by[kind] || null, all: by };
}

/** Where a playable item's bytes come from: a file on disk, or a server's stream with the headers it needs. */
export async function resolveSource({ db, providers }, item) {
  if (!isRemotePath(item.path)) return { file: item.path, headers: null, remote: false };
  const lib = db.get('SELECT server_id FROM libraries WHERE id = ?', item.library_id);
  const server = lib?.server_id ? db.get('SELECT * FROM servers WHERE id = ?', lib.server_id) : null;
  const provider = server && providers.for(server.kind);
  if (!provider) return { file: null, headers: null, remote: true, server: null };
  // An Atomix provider keeps its session in memory: after a restart it has to sign in before the headers mean anything.
  try {
    await provider.ensureSession?.(server);
  } catch (err) {
    if (err.status !== 401) throw err;
    db.run("UPDATE servers SET status = 'unauthorized', status_detail = ? WHERE id = ?", err.message, server.id);
    throw new HttpError(502, `Can't reach ${server.name}: sign in again in Settings.`);
  }
  const { url, headers } = provider.streamUrl(server, { remoteId: item.remote_id, kind: item.kind, media: parseJson(item.media, null) });
  return { file: url, headers, remote: true, server, provider };
}
