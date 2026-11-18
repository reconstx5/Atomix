import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TICKS, itemDto, userData, mediaSources, userDto, libraryDto } from '../src/jellyfin/shapes.js';
import { toGuid } from '../src/jellyfin/ids.js';

const SID = toGuid('server', 1);
const media = JSON.stringify({
  container: 'matroska,webm', bitrate: 8_000_000,
  video: { codec: 'hevc', width: 3840, height: 2160, hdr: true, colour: { transfer: 'smpte2084' } },
  audio: [{ index: 1, codec: 'eac3', channels: 6, language: 'eng', title: 'English', default: true }],
  subtitles: [{ index: 2, codec: 'subrip', language: 'eng', title: 'English', default: false, forced: false }],
});
const film = {
  id: 7, library_id: 1, kind: 'movie', title: 'The Matrix', sort_title: 'Matrix, The', original_title: 'The Matrix', year: 1999,
  overview: 'A hacker wakes up.', genres: '["Action","Sci-Fi"]', rating: 8.7, certification: 'R16', duration: 8160.4,
  path: 'D:\Films\Matrix\matrix.mkv', size: 123456, poster: 'p.jpg', backdrop: 'b.jpg', logo: 'l.png',
  tmdb_id: 603, imdb_id: 'tt0133093', studio: 'Warner', added_at: 1700000000000, metadata_at: 55, updated_at: 66,
  people: JSON.stringify([{ name: 'Lana Wachowski', role: 'director' }, { name: 'Keanu Reeves', role: 'cast', character: 'Neo' }]),
  media,
};
const show = { id: 10, library_id: 2, kind: 'show', title: 'Severance', year: 2022, genres: '[]', path: null, updated_at: 5 };
const episode = { id: 12, library_id: 2, kind: 'episode', title: 'Half Loop', show_id: 10, parent_id: 11, season: 1, episode: 2, show_title: 'Severance', genres: '[]', path: '/tv/s01e02.mkv', duration: 3000, updated_at: 9 };

test('a film becomes a Movie', () => {
  const d = itemDto(film, { serverId: SID });
  assert.equal(d.Type, 'Movie');
  assert.equal(d.Id, toGuid('item', 7));
  assert.equal(d.RunTimeTicks, Math.round(8160.4 * TICKS));
  assert.equal(d.ProviderIds.Tmdb, '603');
  assert.equal(d.OfficialRating, 'R16');
  assert.equal(d.MediaType, 'Video');
  assert.equal(d.ImageTags.Primary, '55');
  assert.equal(d.ImageTags.Logo, '55');
  assert.equal(d.ImageTags.Thumb, '55');
  assert.deepEqual(d.BackdropImageTags, ['55']);
  assert.equal(d.MediaSources.length, 1);
});

test('a show is a folder Series; fields add the extras', () => {
  const d = itemDto(show, { serverId: SID, counts: { children: 3, unplayed: 2 } });
  assert.equal(d.Type, 'Series');
  assert.equal(d.IsFolder, true);
  assert.equal(d.MediaType, undefined);
  assert.equal(d.ChildCount, 3);
  assert.equal(d.UserData.UnplayedItemCount, 2);
});

test('fields give people, studios and dates', () => {
  const d = itemDto(film, { serverId: SID, fields: new Set(['Overview', 'People']) });
  assert.equal(d.Overview, 'A hacker wakes up.');
  assert.deepEqual(d.Genres, ['Action', 'Sci-Fi']);
  assert.deepEqual(d.People[0], { Name: 'Lana Wachowski', Id: d.People[0].Id, Role: '', Type: 'Director' });
  assert.equal(d.People[1].Role, 'Neo');
  assert.equal(d.People[1].Type, 'Actor');
  assert.equal(d.Studios[0].Name, 'Warner');
  assert.equal(d.PremiereDate, '1999-01-01T00:00:00.0000000Z');
  assert.equal(d.DateCreated, new Date(1700000000000).toISOString());
});

test('an episode carries its series and season', () => {
  const d = itemDto(episode, { serverId: SID });
  assert.equal(d.Type, 'Episode');
  assert.equal(d.SeriesId, toGuid('item', 10));
  assert.equal(d.SeasonId, toGuid('item', 11));
  assert.equal(d.IndexNumber, 2);
  assert.equal(d.ParentIndexNumber, 1);
  assert.equal(d.SeriesName, 'Severance');
});

test('user data from progress', () => {
  const u = userData({ position: 120, watched: 0 }, { favourite: true }, film, {});
  assert.equal(u.PlaybackPositionTicks, 1_200_000_000);
  assert.equal(u.Played, false);
  assert.equal(u.IsFavorite, true);
  assert.equal(u.Key, toGuid('item', 7));
  const w = userData({ position: 0, watched: 1 }, null, film, {});
  assert.equal(w.Played, true);
  assert.equal(w.IsFavorite, false);
});

test('no real path anywhere', () => {
  const s = JSON.stringify(itemDto(film, { serverId: SID, fields: new Set(['People']) }));
  assert.ok(!s.includes('D:') && !s.includes('Films'));
  const remote = JSON.stringify(itemDto({ ...film, path: 'jellyfin://3/abc' }, { serverId: SID }));
  assert.ok(!remote.includes('jellyfin://') && !remote.includes('http'));
  assert.ok(!remote.includes('abc'));
});

test('external subtitles are delivery URLs under /jellyfin', () => {
  const [src] = mediaSources(film, { subtitles: [{ id: 's0', language: 'eng', kind: 'text', source: 'external' }], canDownload: true, base: '/jellyfin' });
  const ext = src.MediaStreams.find((m) => m.IsExternal);
  assert.equal(ext.DeliveryMethod, 'External');
  assert.match(ext.DeliveryUrl, /^\/jellyfin\/Videos\/[0-9a-f]{32}\/[0-9a-f]{32}\/Subtitles\/\d+\/0\/Stream\.(srt|vtt)$/);
  assert.equal(src.Container, 'mkv');
  assert.equal(src.Id, toGuid('item', 7));
  assert.equal(src.SupportsTranscoding, false);
  assert.equal(src.Path, undefined);
  const v = src.MediaStreams.find((m) => m.Type === 'Video');
  assert.equal(v.VideoRange, 'HDR10');
  assert.equal(v.Width, 3840);
  assert.ok(src.MediaStreams.some((m) => m.Type === 'Audio' && m.Channels === 6));
});

test('Kids user cannot download', () => {
  const kid = userDto({ id: 1 }, { id: 4, name: 'Sam', kids: 1 }, { serverId: SID });
  assert.equal(kid.Policy.EnableContentDownloading, false);
  assert.equal(kid.Name, 'Sam');
  assert.equal(kid.Id, toGuid('user', 4));
  const adult = userDto({ id: 1 }, { id: 5, name: 'Al', kids: 0 }, { serverId: SID });
  assert.equal(adult.Policy.EnableContentDownloading, true);
  assert.equal(adult.Policy.IsAdministrator, false);
});

test('a library becomes a CollectionFolder', () => {
  const l = libraryDto({ id: 2, name: 'TV', type: 'shows' }, SID);
  assert.equal(l.CollectionType, 'tvshows');
  assert.equal(l.Id, toGuid('library', 2));
  assert.equal(libraryDto({ id: 1, name: 'F', type: 'movies' }, SID).CollectionType, 'movies');
});

test('a show or season is Played only when every child is', () => {
  const play = (counts, row = show) => itemDto(row, { serverId: SID, counts }).UserData.Played;
  assert.equal(play({ children: 3, unplayed: 0 }), true);
  assert.equal(play({ children: 3, unplayed: 2 }), false);
  assert.equal(play({ children: 0, unplayed: 0 }), false);
  assert.equal(play({ children: 2, unplayed: 0 }, { ...show, kind: 'season', id: 11 }), true);
});

test('stream Indexes are unique even when ffprobe put audio first', () => {
  const m = JSON.stringify({
    video: { codec: 'h264', streamIndex: 1 }, audio: [{ streamIndex: 0, codec: 'aac' }], subtitles: [{ streamIndex: 2, codec: 'subrip' }],
  });
  const [src] = mediaSources({ ...film, media: m }, { subtitles: [{ source: 'sidecar', language: 'en', label: 'x' }] });
  const idx = src.MediaStreams.map((s) => s.Index);
  assert.equal(new Set(idx).size, idx.length, idx.join());
  assert.equal(src.MediaStreams.find((s) => s.Type === 'Video').Index, 1);
  assert.equal(src.MediaStreams.find((s) => s.Type === 'Audio').Index, 0);
});

test('non-array JSON columns cannot throw or leak', () => {
  const d = itemDto({ ...film, people: '{}', genres: '{"a":1}', media: JSON.stringify({ audio: {}, subtitles: 'x', video: { codec: 'h264' } }) }, { serverId: SID });
  assert.deepEqual(d.People, []);
  assert.deepEqual(d.Genres, []);
  assert.ok(Array.isArray(d.MediaSources[0].MediaStreams));
});
