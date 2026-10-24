// A metadata provider for the tests: books get a description, a year and a subject.
export function setup(api) {
  api.registerMetadataProvider({
    id: 'test-bookinfo',
    priority: 60,
    kinds: ['book'],
    fetch: (item) => ({ title: 'Other title', overview: `About ${item.title}`, year: 1951, genres: ['Sea'] }),
  });
}
