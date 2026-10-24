// Kinds of title that are listened to rather than watched (v0.22): podcast episodes and audiobooks (a single-file
// book, or one file — `chapter` — of a book in several files). With songs they are the audio kinds.
export const SPOKEN_KINDS = new Set(['podcast_episode', 'audiobook', 'chapter']);
export const AUDIO_KINDS = new Set(['track', ...SPOKEN_KINDS]);
// Read rather than played (v0.22 Plan D): EPUB books and comics.
export const READING_KINDS = new Set(['book', 'comic']);
