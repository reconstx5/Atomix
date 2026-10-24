// Subsonic's housekeeping methods: ping, the licence, OpenSubsonic's extensions, the signed-in user, scanning.
import { SubsonicError } from './envelope.js';

export const EXTENSIONS = ['songLyrics', 'apiKeyAuthentication', 'formPost', 'transcodeOffset'];

/** The music libraries this viewer may use. */
export function musicFolders(core, viewer) {
  return core.library.visibleLibraries(viewer).filter((l) => l.type === 'music');
}

export function registerSystem(s) {
  s.method('ping', () => ({}));
  s.method('getLicense', () => ({ license: { valid: true, email: '', licenseExpires: '2099-12-31T00:00:00.000Z' } }));
  s.method('getOpenSubsonicExtensions', () => ({ openSubsonicExtensions: EXTENSIONS.map((name) => ({ name, versions: [1] })) }), { auth: false });
  s.method('getUser', ({ core, params, user, profile, viewer }) => {
    const name = params.get('username');
    if (name !== null && name !== user.username) throw new SubsonicError(50, 'Atomix only shows the signed-in user.');
    const kids = Boolean(profile.kids);
    return {
      user: {
        username: user.username,
        scrobblingEnabled: true,
        adminRole: user.role === 'admin' && !kids,
        settingsRole: false,
        downloadRole: !kids,
        uploadRole: false,
        playlistRole: true,
        coverArtRole: true,
        commentRole: false,
        podcastRole: false,
        streamRole: true,
        jukeboxRole: false,
        shareRole: false,
        videoConversionRole: false,
        folder: musicFolders(core, viewer).map((l) => l.id),
      },
    };
  });
  s.method('getScanStatus', ({ core }) => {
    const st = core.scanner.status || {};
    const count = core.db.get("SELECT COUNT(*) AS n FROM items WHERE kind = 'track'").n;
    return { scanStatus: { scanning: Boolean(st.running || core.scanner.queue?.length), count } };
  });
}
