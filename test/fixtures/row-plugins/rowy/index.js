// Test plugin (v0.23 Plan C Task 1): a row whose cards carry notes, and a row with its own title per viewer.
export function setup(api) {
  const movies = (viewer) => api.library.list({ viewer, kind: 'movie', sort: 'title' });
  api.registerHomeRow({
    id: 'noted',
    title: 'Noted',
    items: (viewer) => movies(viewer).slice(0, 2).map((r, i) => (i === 0 ? { ...r, note: 'Only here' } : i === 1 && process.env.ROWY_LONG ? { ...r, note: `  ${'x'.repeat(100)}  ` } : r)),
  });
  api.registerHomeRow({
    id: 'titled',
    title: 'Fallback',
    items: (viewer) => ({ title: `Row for ${viewer.kids ? 'kids' : 'grown-ups'}`, items: movies(viewer).slice(0, 1) }),
  });
}
