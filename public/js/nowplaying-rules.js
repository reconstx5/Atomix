// Now Playing's decisions, with no page (tested in test/nowplaying-rules.test.js): the lyric line, seek and volume steps,
// where focus goes in the queue after a move or remove, a song row's disc headings, number and sub line, which face the
// page shows, and the sleep timer's words.

export const LEAD = 0.3; // a lyric line lights this many seconds early
export const SEEK_STEP = 5; // Left/Right on the seek bar, in seconds
export const VOLUME_STEP = 0.05; // Up/Down on the volume bar
export const HOLD_MS = 4000; // how long a manual lyrics scroll holds off auto-centring
export const VOLUME_SAVE_MS = 800; // wait this long after the last change before saving the volume

/** Index of the last line that has started (a little early), or -1. */
export function currentLine(lines, pos) {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].at <= pos + LEAD) idx = i;
    else break;
  }
  return idx;
}

/** Where Left/Right on the seek bar goes (kept inside 0..dur), or null for any other key. */
export function seekStep(pos, dur, key) {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  return Math.max(0, Math.min(dur || 0, pos + (key === 'ArrowRight' ? SEEK_STEP : -SEEK_STEP)));
}

/** Where Up/Down on the volume bar goes (0..1, two decimals), or null for any other key. */
export function volumeStep(v, key) {
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return null;
  const next = Math.round((v + (key === 'ArrowUp' ? VOLUME_STEP : -VOLUME_STEP)) * 100) / 100;
  return Math.max(0, Math.min(1, next));
}

/** The data-qkey of the queue button that keeps focus after a move up/down of row `i`, or removing it. */
export function queueFocusAfter(action, i, length) {
  if (action === 'up') return `${i - 1}:up`;
  if (action === 'down') return `${i + 1}:down`;
  return `${Math.min(i, length - 2)}:remove`;
}

/** A song list's rows: a { disc } heading wherever the disc changes (only when there is more than one disc). */
export function discRows(tracks, discs) {
  const multi = discs && new Set(tracks.map((t) => t.season || 1)).size > 1;
  const rows = [];
  let disc = null;
  tracks.forEach((track, i) => {
    if (multi && (track.season || 1) !== disc) {
      disc = track.season || 1;
      rows.push({ disc });
    }
    rows.push({ track, i });
  });
  return rows;
}

/** The number in a song row: its episode, else its place in the list; '' when numbers are off. */
export const trackNumber = (t, i, numbers) => (numbers ? String(t.episode ?? i + 1) : '');

/** A song row's second line (artist, then album), or null. showArtist: true = always, a string = only when it differs. */
export function subLine(t, showArtist, showAlbum) {
  const artist = showArtist === true ? t.artist : typeof showArtist === 'string' && t.artist && t.artist !== showArtist ? t.artist : null;
  return artist || (showAlbum && t.albumTitle) ? [artist, showAlbum ? t.albumTitle : null].filter(Boolean).join(' · ') : null;
}

/** Which face Now Playing shows: another song's lyrics, nothing, a book or episode, or the song. */
export function faceFor({ song, current }) {
  if (song && Number(song) !== current?.id) return 'lyrics';
  if (!current) return 'empty';
  if (current.spoken) return 'spoken';
  return 'song';
}

/** The sleep button's spoken label. */
export function sleepLabel(sleep) {
  const m = sleep.mode;
  return m ? `Sleep timer: ${m === 'chapter' ? 'end of chapter' : `${Math.ceil((sleep.remaining || 0) / 60000)} min left`}` : 'Sleep timer';
}
