// Music apps marking things: star/unstar (Atomix's heart), setRating (Atomix's stars) and scrobble (play history,
// and from there the profile's scrobblers). The same data the web shows.
import { SubsonicError } from './envelope.js';
import { parseId } from './shapes.js';
import { queries } from './browse.js';

const KIND = { tr: 'track', al: 'album', ar: 'artist' };

/** Items the viewer may see, by Subsonic id (any of tr-/al-/ar-); a missing one is "not found". */
function items(ctx, raws) {
  const q = queries(ctx.core, ctx.viewer);
  return raws.map((raw) => {
    const id = parseId(raw, ['tr', 'al', 'ar']);
    const row = id && (id.kind === 'tr' ? q.songs({ where: 'i.id = ?', params: [id.id] })[0] : id.kind === 'al' ? q.albums({ where: 'al.id = ?', params: [id.id] })[0] : q.artists({ where: 'ar.id = ?', params: [id.id] })[0]);
    if (!row || ctx.core.library.get(row.id)?.kind !== KIND[id.kind]) throw new SubsonicError(70, `${raw} not found`);
    return ctx.core.library.get(row.id);
  });
}

const starIds = (p) => [...p.all('id'), ...p.all('albumId'), ...p.all('artistId')];

export function registerAnnotate(s) {
  const star = (on) => (ctx) => {
    const raws = starIds(ctx.params);
    if (!raws.length) throw new SubsonicError(10, 'Required parameter is missing: id');
    for (const item of items(ctx, raws)) ctx.core.ratings.set(ctx.profile.id, item, { favourite: on });
    return {};
  };
  s.method('star', star(true));
  s.method('unstar', star(false));

  s.method('setRating', (ctx) => {
    const raw = ctx.params.need('id');
    const rating = ctx.params.int('rating', undefined);
    if (rating === undefined) throw new SubsonicError(10, 'Required parameter is missing: rating');
    if (rating < 0 || rating > 5) throw new SubsonicError(0, 'A rating is 0 to 5.');
    const [item] = items(ctx, [raw]);
    ctx.core.ratings.set(ctx.profile.id, item, { stars: rating === 0 ? null : rating });
    return {};
  });

  s.method('scrobble', (ctx) => {
    const raws = ctx.params.all('id');
    if (!raws.length) throw new SubsonicError(10, 'Required parameter is missing: id');
    const times = ctx.params.all('time');
    const submission = ctx.params.bool('submission', true);
    const client = ctx.appPassword?.name || 'music app';
    // Every id is checked before anything is recorded: one not found and none of them count.
    const songs = raws.map((raw, i) => (parseId(raw, ['tr']) ? { item: items(ctx, [raw])[0], i } : null)).filter(Boolean); // only songs scrobble
    songs.forEach(({ item, i }) => {
      if (submission) ctx.core.plays.submitted({ profileId: ctx.profile.id, item, at: Number(times[i]) || undefined, client });
      else ctx.core.plays.nowPlaying({ profileId: ctx.profile.id, item, client });
    });
    return {};
  });
}
