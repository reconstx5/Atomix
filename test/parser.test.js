import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEpisode, splitTitleYear, parseMovie, parseSeasonFolder, parseSubtitleName, sortTitle } from '../src/library/parser.js';

test('movie titles and years', () => {
  const cases = [
    ['The.Matrix.1999.1080p.BluRay.x264', 'The Matrix', 1999],
    ['2001 A Space Odyssey (1968)', '2001 A Space Odyssey', 1968],
    ['2001.A.Space.Odyssey.1968.1080p', '2001 A Space Odyssey', 1968],
    ['Blade Runner 2049 (2017)', 'Blade Runner 2049', 2017],
    ['Blade.Runner.2049.2017.2160p.UHD', 'Blade Runner 2049', 2017],
    ['1917.2019.1080p', '1917', 2019],
    ['Alien [1979] [BluRay]', 'Alien', 1979],
    ['Mr. Robot', 'Mr. Robot', null],
    ["Mr. Holland's Opus (1995)", "Mr. Holland's Opus", 1995],
    ['Tunnel Vision 1994', 'Tunnel Vision', 1994],
    ['Charlottes.Web.2006.DVDRip', 'Charlottes Web', 2006],
  ];
  for (const [input, title, year] of cases) assert.deepEqual(splitTitleYear(input), { title, year }, input);
});

test('movie folder beats a messy file name', () => {
  assert.deepEqual(parseMovie('/m/Heat (1995)/heat.1080p.mkv', '/m'), { title: 'Heat', year: 1995 });
  assert.deepEqual(parseMovie('/m/Heat.1995.1080p.mkv', '/m'), { title: 'Heat', year: 1995 });
});

test('episode numbering styles', () => {
  const cases = [
    ['Show.Name.S01E02.720p.HDTV.x264-GRP.mkv', 1, 2, null, 'Show Name', null],
    ['show_s01_e03.mkv', 1, 3, null, 'show', null],
    ['Show - 2x05 - Title Here.mp4', 2, 5, null, 'Show', 'Title Here'],
    ['Show.S02E03E04.mkv', 2, 3, 4, 'Show', null],
    ['Friends.S10E17-E18.The.Last.One.mkv', 10, 17, 18, 'Friends', 'The Last One'],
    ['Show.S01xE07.mkv', 1, 7, null, 'Show', null],
    ['Show.103.Title.mkv', 1, 3, null, 'Show', 'Title'],
    ['The.Daily.Show.2024.03.05.Guest.mkv', 2024, 305, null, 'The Daily Show', '2024-03-05'],
  ];
  for (const [file, season, episode, end, show, title] of cases) {
    const r = parseEpisode(file);
    assert.ok(r, file);
    assert.equal(r.season, season, `${file} season`);
    assert.equal(r.episode, episode, `${file} episode`);
    assert.equal(r.episodeEnd, end, `${file} end`);
    assert.equal(r.showHint, show, `${file} show`);
    assert.equal(r.episodeTitle, title, `${file} title`);
  }
  assert.equal(parseEpisode('Show.720p.mkv'), null);
  assert.equal(parseEpisode('Episode 5.mkv').episode, 5);
  assert.equal(parseEpisode('05 - Some Title.mkv').episodeTitle, 'Some Title');
});

test('season folders', () => {
  assert.equal(parseSeasonFolder('Season 01'), 1);
  assert.equal(parseSeasonFolder('S2'), 2);
  assert.equal(parseSeasonFolder('Specials'), 0);
  assert.equal(parseSeasonFolder('Staffel 3'), 3);
  assert.equal(parseSeasonFolder('Extras'), null);
});

test('subtitle sidecar names', () => {
  assert.deepEqual(parseSubtitleName('Movie.en.forced.srt', 'Movie'), { language: 'en', forced: true, sdh: false, label: null });
  assert.deepEqual(parseSubtitleName('Movie.eng.sdh.srt', 'Movie'), { language: 'eng', forced: false, sdh: true, label: null });
  assert.equal(parseSubtitleName('Movie.srt', 'Movie').language, null);
});

test('sort titles ignore articles', () => {
  assert.equal(sortTitle('The Matrix'), 'matrix');
  assert.equal(sortTitle('A Quiet Place'), 'quiet place');
});
