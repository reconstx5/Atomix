// More Home rows (v0.23): Finish what you started, Seasonal picks and On this day. Every card is a library title from
// the viewer's own helpers, so Kids limits and libraries apply as on every row; each row hides when it's empty and
// can be moved or hidden in Arrange home.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

export const SEASONS = {
  christmas: { title: 'Christmas films', keywords: ['christmas', 'santa claus', 'christmas eve'], genres: [] },
  halloween: { title: 'Halloween frights', keywords: ['halloween'], genres: ['Horror'] },
  valentines: { title: "Valentine's picks", keywords: ["valentine's day"], genres: ['Romance'] },
  summer: { title: 'Summer films', keywords: ['summer', 'summer vacation', 'summer camp', 'beach'], genres: [] },
};

/** Today, from ATOMIX_TODAY (YYYY-MM-DD, tests) or the server's local date. */
export function today() {
  const fixed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(process.env.ATOMIX_TODAY || '');
  if (fixed) return { y: Number(fixed[1]), m: Number(fixed[2]), d: Number(fixed[3]) };
  const n = new Date();
  return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate() };
}

/** The seasons that could fill the row today, best first. */
export function seasonFor({ m, d }, hemisphere = 'southern') {
  const south = hemisphere !== 'northern';
  if (m === 12) return south ? ['christmas', 'summer'] : ['christmas'];
  if (m === 10) return ['halloween'];
  if (m === 2 && d <= 14) return south ? ['valentines', 'summer'] : ['valentines'];
  if (south && (m === 1 || m === 2)) return ['summer'];
  if (!south && m >= 6 && m <= 8) return ['summer'];
  return [];
}

/** "Released 19 Oct 1985" from an air date. */
export function releasedNote(airDate) {
  const [y, m, d] = String(airDate).split('-').map(Number);
  return `Released ${d} ${MONTHS[m - 1]} ${y}`;
}

const withNote = (row, note) => ({ ...row, note });

export function setup(api) {
  const warned = new Set();
  const safe = (id, fn) => (viewer) => {
    try {
      return fn(viewer);
    } catch (err) {
      if (!warned.has(id)) {
        warned.add(id);
        api.log.warn(`The ${id} row failed: ${err.message}`);
      }
      return [];
    }
  };

  api.registerHomeRow({
    id: 'finish',
    title: 'Finish what you started',
    style: 'landscape',
    position: 15,
    items: safe('finish', (viewer) => {
      // What Continue watching already shows stays out of this row (nothing twice on Home).
      const cont = api.library.continueWatching(viewer);
      const shows = new Set(cont.filter((r) => r.kind === 'episode').map((r) => r.show_id));
      const films = new Set(cont.filter((r) => r.kind === 'movie').map((r) => r.id));
      const idleDays = Math.max(0, Number(api.config.idleDays) || 14);
      const out = [];
      for (const s of api.library.startedShows(viewer, { idleDays })) {
        if (shows.has(s.show.id) || !s.next) continue;
        out.push(withNote(s.next, `${s.left} ${s.left === 1 ? 'episode' : 'episodes'} left`));
      }
      for (const c of api.library.partlySeenSeries(viewer)) {
        if (!c.next || films.has(c.next.id)) continue;
        out.push(withNote(c.next, `Part ${c.part} of ${c.total}`));
      }
      return out.slice(0, 20);
    }),
  });

  api.registerHomeRow({
    id: 'seasonal',
    title: 'Seasonal picks',
    style: 'poster',
    position: 45,
    items: safe('seasonal', (viewer) => {
      for (const name of seasonFor(today(), api.config.hemisphere)) {
        const season = SEASONS[name];
        const found = new Map();
        for (const keyword of season.keywords) for (const r of api.library.list({ viewer, kind: 'movie', keyword, sort: 'rating', limit: 60 })) found.set(r.id, r);
        for (const genre of season.genres) for (const r of api.library.list({ viewer, kind: 'movie', genre, sort: 'rating', limit: 60 })) found.set(r.id, r);
        if (found.size < 4) continue; // too few for a row: the next season, or none
        const items = [...found.values()].sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0)).slice(0, 20);
        return { title: season.title, items };
      }
      return [];
    }),
  });

  api.registerHomeRow({
    id: 'on-this-day',
    title: 'On this day',
    style: 'poster',
    position: 46,
    items: safe('on-this-day', (viewer) => {
      const { y, m, d } = today();
      const out = [];
      const seen = new Set();
      // A year ago today — when that day existed (29 February).
      const ago = new Date(y - 1, m - 1, d);
      if (ago.getMonth() === m - 1) {
        for (const r of api.library.playedOn(viewer, `${y - 1}-${pad(m)}-${pad(d)}`)) {
          if (!['movie', 'episode'].includes(r.kind) || seen.has(r.id)) continue;
          seen.add(r.id);
          out.push(withNote(r, 'You watched this a year ago'));
        }
      }
      for (const r of api.library.list({ viewer, kind: 'movie', releasedOn: `${pad(m)}-${pad(d)}`, sort: 'rating', limit: 40 })) {
        if (seen.has(r.id) || Number(String(r.air_date).slice(0, 4)) >= y) continue;
        seen.add(r.id);
        out.push(withNote(r, releasedNote(r.air_date)));
      }
      return out.slice(0, 20);
    }),
  });
}
