// A metadata provider for the tests: every film gets three outside scores.
export function setup(api) {
  api.registerMetadataProvider({
    id: 'test-scores',
    priority: 60,
    kinds: ['movie'],
    fetch: () => ({ scores: [{ source: 'imdb', value: '7.8/10' }, { source: 'rt', value: '93%' }, { source: 'metacritic', value: '81/100' }, { source: 'bogus', value: 'x' }] }),
  });
}
