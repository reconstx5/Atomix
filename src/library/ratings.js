// Age ratings ("certifications") → the minimum age a title is suitable for.
// Used by Kids profiles. Ratings are stored as "COUNTRY:LABEL" (e.g. "NZ:M").

const TABLES = {
  NZ: { G: 0, PG: 8, PGR: 8, M: 16, AO: 16, R13: 13, RP13: 13, R15: 15, R16: 16, RP16: 16, R18: 18, RP18: 18, R: 18, 18: 18 },
  US: {
    G: 0, PG: 8, 'PG-13': 13, R: 17, 'NC-17': 18,
    'TV-Y': 0, 'TV-Y7': 7, 'TV-Y7-FV': 7, 'TV-G': 0, 'TV-PG': 8, 'TV-14': 14, 'TV-MA': 17,
  },
  GB: { U: 0, UC: 0, PG: 8, '12': 12, '12A': 12, '15': 15, '18': 18, R18: 18 },
  AU: { E: 0, P: 0, C: 0, G: 0, PG: 8, M: 15, 'MA15+': 15, 'AV15+': 15, 'R18+': 18, 'X18+': 18 },
  CA: { G: 0, PG: 8, '14A': 14, '18A': 18, R: 18, A: 18, '13+': 13, '16+': 16, '18+': 18 },
  IE: { G: 0, PG: 8, '12A': 12, '15A': 15, '16': 16, '18': 18 },
};
const UNRATED = /^(nr|not rated|unrated|n\/a|none|tbc|tba|e|exempt)$/i;

/**
 * @param {string} cert   "M", "NZ:M", "Rated PG-13", "US:PG-13 / GB:12A"
 * @param {string} [country] ISO country to interpret a bare label with (default US)
 * @returns {number|null}
 */
export function certToAge(cert, country) {
  if (cert == null) return null;
  let text = String(cert).trim();
  if (!text) return null;
  // Several ratings in one string: use the first.
  text = text.split(/\s*[/|,]\s*/)[0];
  text = text.replace(/^rated\s+/i, '').trim();
  let cc = (country || '').toUpperCase();
  const prefixed = /^([A-Za-z]{2}):\s*(.+)$/.exec(text);
  if (prefixed) {
    cc = prefixed[1].toUpperCase();
    text = prefixed[2].trim();
  }
  if (!text || UNRATED.test(text)) return null;
  const label = text.toUpperCase().replace(/\s+/g, ' ');
  for (const table of [TABLES[cc], TABLES.US, TABLES.GB]) {
    if (table && label in table) return table[label];
  }
  // Numeric systems (Germany's FSK 12, "16", "12+" …)
  const num = /(\d{1,2})\+?$/.exec(label);
  if (num) return Number(num[1]);
  return null;
}

function firstCert(list) {
  // Prefer theatrical (3), then digital/physical/TV, then anything with a label.
  const order = [3, 2, 4, 5, 6, 1];
  const withCert = (list || []).filter((r) => r.certification && r.certification.trim());
  withCert.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  return withCert[0]?.certification.trim() || null;
}

/** TMDB movie `release_dates` → "NZ:R16" (preferred country, else US). */
export function pickMovieCertification(releaseDates, country = 'US') {
  const results = releaseDates?.results || [];
  for (const cc of [String(country).toUpperCase(), 'US']) {
    const entry = results.find((r) => r.iso_3166_1 === cc);
    const cert = entry && firstCert(entry.release_dates);
    if (cert) return `${cc}:${cert}`;
  }
  return null;
}

/** TMDB TV `content_ratings` → "AU:M" (preferred country, else US). */
export function pickTvCertification(contentRatings, country = 'US') {
  const results = contentRatings?.results || [];
  for (const cc of [String(country).toUpperCase(), 'US']) {
    const entry = results.find((r) => r.iso_3166_1 === cc && r.rating && r.rating.trim());
    if (entry) return `${cc}:${entry.rating.trim()}`;
  }
  return null;
}

export const KIDS_LEVELS = [
  { maxAge: 5, label: 'Little kids — G only' },
  { maxAge: 10, label: 'Kids — up to PG' },
  { maxAge: 13, label: 'Pre-teens — up to 13 (PG-13, R13, 12A)' },
  { maxAge: 16, label: 'Teens — up to 16 (M, R16, 15)' },
];
