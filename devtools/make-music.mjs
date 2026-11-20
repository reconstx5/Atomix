// Made-up music for the music checks: `node devtools/make-music.mjs <mediaDir>` writes <mediaDir>/Music/ (two artists,
// two albums, eight 6-second tones with tags, a cover each, one synced and one plain lyrics file) and <mediaDir>/Audiobooks/
// (one two-chapter .m4b). Needs ffmpeg on PATH. Running it again rewrites the same files.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.argv[2];
if (!root) {
  console.log('Give the media folder: node devtools/make-music.mjs <mediaDir>');
  process.exit(2);
}
const ff = (args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });

const ALBUMS = [
  { artist: 'Cobalt Tide', album: 'Low Water', year: 2018, colour: '2f6db5', songs: [
    { disc: 1, track: 1, title: 'Harbour Light', hz: 262 }, { disc: 1, track: 2, title: 'Slack Tide', hz: 294 }, { disc: 1, track: 3, title: 'Salt Line', hz: 330 },
    { disc: 2, track: 1, title: 'Lower Still', hz: 349 }, { disc: 2, track: 2, title: 'Last Ebb', hz: 392 }] },
  { artist: 'Fen Choir', album: 'Small Hours', year: 2021, colour: 'b5702f', songs: [
    { disc: 1, track: 1, title: 'Night Ferry', hz: 440 }, { disc: 1, track: 2, title: 'Reed Bed', hz: 494 }, { disc: 1, track: 3, title: 'First Light', hz: 523 }] },
];
const SYNCED = ['[00:00.00]Lamp on the harbour wall', '[00:01.00]Turning slow across the bay', '[00:02.00]Every boat comes home', '[00:03.00]Following the glow', '[00:04.00]', '[00:05.00]Until the morning'];
const PLAIN = ['Black water under the ferry', 'Lanterns count the crossing', 'Nobody speaks until the shore'];

const music = path.join(root, 'Music');
for (const a of ALBUMS) {
  const dir = path.join(music, a.artist, `${a.album} (${a.year})`);
  fs.mkdirSync(dir, { recursive: true });
  ff(['-f', 'lavfi', '-i', `color=c=0x${a.colour}:s=400x400`, '-frames:v', '1', path.join(dir, 'cover.png')]);
  for (const s of a.songs) {
    const file = path.join(dir, `${s.disc}-${String(s.track).padStart(2, '0')} ${s.title}.mp3`);
    ff(['-f', 'lavfi', '-i', `sine=frequency=${s.hz}:duration=6`, '-c:a', 'libmp3lame', '-b:a', '64k',
      '-metadata', `title=${s.title}`, '-metadata', `artist=${a.artist}`, '-metadata', `album=${a.album}`, '-metadata', `album_artist=${a.artist}`,
      '-metadata', `disc=${s.disc}`, '-metadata', `track=${s.track}`, '-metadata', `date=${a.year}`, file]);
    const lrc = file.replace(/\.mp3$/, '.lrc');
    if (s.title === 'Harbour Light') fs.writeFileSync(lrc, `${SYNCED.join('\n')}\n`);
    else if (s.title === 'Night Ferry') fs.writeFileSync(lrc, `${PLAIN.join('\n')}\n`);
    else fs.rmSync(lrc, { force: true });
  }
}

// The book: one .m4b, two 6-second chapters with chapter marks.
const books = path.join(root, 'Audiobooks');
// A file straight in the library's folder is one book with its own chapters (a book in a sub-folder would be one row per file).
fs.mkdirSync(books, { recursive: true });
const bookDir = books;
const meta = path.join(books, 'chapters.txt');
fs.writeFileSync(meta, ';FFMETADATA1\ntitle=The Salt Road\nartist=Ines Marrow\nalbum=The Salt Road\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=6000\ntitle=The Crossing\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=6000\nEND=12000\ntitle=The Inn\n');
ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=12', '-i', meta, '-map_metadata', '1', '-map', '0:a', '-c:a', 'aac', '-b:a', '48k', '-f', 'ipod', path.join(bookDir, 'The Salt Road.m4b')]);
fs.rmSync(meta);
console.log(`Made ${ALBUMS.reduce((n, a) => n + a.songs.length, 0)} songs and 1 book in ${root}`);
