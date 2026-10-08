// Example plugin: a home-screen row + a custom API route.
function kindsFor(config) {
  if (config.kinds === 'movie') return ['movie'];
  if (config.kinds === 'show') return ['show'];
  return ['movie', 'show'];
}

export function setup(api) {
  api.registerHomeRow({
    id: 'random',
    // `title` is read on every request so renaming it in Settings works instantly.
    get title() {
      return api.config.title || 'Something different';
    },
    style: 'poster',
    position: 60,
    items(viewer) {
      const count = Math.max(4, Math.min(50, Number(api.config.count) || 16));
      return api.library.list({ viewer, kind: kindsFor(api.config), unwatched: true, sort: 'random', limit: count });
    },
  });

  // GET /api/plugins/random-picks/surprise  →  one random unwatched title
  api.route('GET', '/surprise', (ctx) => {
    const [row] = api.library.list({ viewer: ctx.viewer, kind: kindsFor(api.config), unwatched: true, sort: 'random', limit: 1 });
    if (!row) return { item: null };
    return { item: api.library.serialize([row], ctx.viewer)[0] };
  });

  api.log.info('Ready');
  // Returning a function lets Atomix clean up when the plugin is disabled.
  return () => api.log.info('Stopped');
}
