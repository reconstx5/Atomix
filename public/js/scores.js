// Outside scores (v0.23): "IMDb 7.8 · Rotten Tomatoes 93% · Metacritic 81" — no imports, so the server's tests and
// the page share it.
const NAMES = { imdb: 'IMDb', rt: 'Rotten Tomatoes', metacritic: 'Metacritic' };
const ORDER = ['imdb', 'rt', 'metacritic'];

/** The scores in one line, IMDb first; '' when there are none. */
export function scoresText(scores) {
  if (!Array.isArray(scores)) return '';
  return ORDER.map((source) => scores.find((s) => s?.source === source))
    .filter(Boolean)
    .map((s) => `${NAMES[s.source]} ${String(s.value).replace(/\/(10|100)$/, '')}`)
    .join(' · ');
}
