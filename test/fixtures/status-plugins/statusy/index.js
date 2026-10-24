// Test plugin (v0.23 Plan B Task 1): a card status, the metadata language, and offerAgain for its kinds.
export function setup(api) {
  api.setStatus('Paste a key to start.');
  api.registerMetadataProvider({ id: 'statusy', name: 'Statusy', priority: 90, kinds: ['movie'], fetch: async () => null });
  api.route('POST', '/again', async (ctx) => {
    const body = await ctx.body();
    return { count: api.metadata.offerAgain(body.ids), language: api.metadataLanguage };
  }, { auth: 'admin' });
}
