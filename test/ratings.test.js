import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certToAge, pickMovieCertification, pickTvCertification } from '../src/library/ratings.js';

test('certifications become minimum ages', () => {
  const cases = [
    ['NZ', 'G', 0], ['NZ', 'PG', 8], ['NZ', 'M', 16], ['NZ', 'R13', 13], ['NZ', 'RP16', 16], ['NZ', 'R18', 18], ['NZ', 'PGR', 8], ['NZ', 'AO', 16],
    ['US', 'G', 0], ['US', 'PG', 8], ['US', 'PG-13', 13], ['US', 'R', 17], ['US', 'NC-17', 18],
    ['US', 'TV-Y', 0], ['US', 'TV-Y7', 7], ['US', 'TV-G', 0], ['US', 'TV-PG', 8], ['US', 'TV-14', 14], ['US', 'TV-MA', 17],
    ['GB', 'U', 0], ['GB', '12A', 12], ['GB', '15', 15], ['AU', 'M', 15], ['AU', 'MA15+', 15], ['AU', 'R18+', 18],
    ['DE', '16', 16], ['DE', 'FSK 12', 12],
  ];
  for (const [country, cert, age] of cases) assert.equal(certToAge(cert, country), age, `${country} ${cert}`);
});

test('country prefixes and junk', () => {
  assert.equal(certToAge('NZ:M'), 16);
  assert.equal(certToAge('Rated PG-13'), 13);
  assert.equal(certToAge('US:PG-13 / GB:12A'), 13);
  assert.equal(certToAge('NR'), null);
  assert.equal(certToAge('Not Rated'), null);
  assert.equal(certToAge(''), null);
  assert.equal(certToAge(null), null);
});

test('picks the certification for the preferred country, falling back to US', () => {
  const movie = {
    results: [
      { iso_3166_1: 'US', release_dates: [{ certification: '', type: 1 }, { certification: 'R', type: 3 }] },
      { iso_3166_1: 'NZ', release_dates: [{ certification: 'R16', type: 3 }] },
    ],
  };
  assert.equal(pickMovieCertification(movie, 'NZ'), 'NZ:R16');
  assert.equal(pickMovieCertification(movie, 'GB'), 'US:R');
  assert.equal(pickMovieCertification({ results: [] }, 'NZ'), null);
  const tv = { results: [{ iso_3166_1: 'US', rating: 'TV-14' }, { iso_3166_1: 'AU', rating: 'M' }] };
  assert.equal(pickTvCertification(tv, 'AU'), 'AU:M');
  assert.equal(pickTvCertification(tv, 'NZ'), 'US:TV-14');
});
