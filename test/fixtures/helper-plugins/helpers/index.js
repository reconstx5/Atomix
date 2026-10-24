// The v0.23 library helpers, reached through api.library from a plugin route.
export function setup(api) {
  api.route('GET', '/all', (ctx) => ({
    keyword: api.library.list({ viewer: ctx.viewer, keyword: 'christmas' }).length,
    started: api.library.startedShows(ctx.viewer, { idleDays: 14 }).length,
    series: api.library.partlySeenSeries(ctx.viewer).length,
    played: api.library.playedOn(ctx.viewer, '2025-10-19').length,
  }));
  // v0.23 review fix: titles with no scores, and a refresh of one (as OMDb's "Fetch missing scores" does).
  api.route('POST', '/missing', async (ctx) => {
    const rows = api.library.list({ viewer: ctx.viewer, kind: ['movie', 'show'], missingScores: true });
    const refreshed = rows.length ? await api.metadata.refresh(rows[0].id) : null;
    return { missing: rows.length, refreshed: Boolean(refreshed?.id) };
  });
}
