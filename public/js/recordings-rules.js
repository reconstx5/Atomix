// Recordings' decisions, with no page (tested in test/recordings-rules.test.js): where focus goes after a row goes,
// the episode line and the gap sentence.

/**
 * After a row goes: the next row's first control in its own section, else (no next row) the previous row's, else the
 * section's heading (a rule and a recording can have the same number, so rows are looked up by section).
 * `rows`: the section's rows in order, { id, firstKey } (firstKey null for a row with no controls).
 */
export function nextFocusKey(rows, id, section) {
  const i = rows.findIndex((r) => r.id === id);
  const sib = i < 0 ? null : rows[i + 1] || rows[i - 1];
  return sib?.firstKey || `h:${section}`;
}

/** After a Delete: the deleted row's own Play or Delete can't keep focus, so the Done heading. */
export const afterDeleteFocus = (key, id) => (key.startsWith(`play:${id}`) || key.startsWith(`delete:${id}`) ? 'h:rec-done' : key);

/** "S3 E7 · High Tide" */
export const episodeLine = (r) => [r.season != null && r.episode != null ? `S${r.season} E${r.episode}` : null, r.episodeTitle].filter(Boolean).join(' · ');

/** "Has a gap (5 min missing)", or null. */
export const gapText = (r) => (r.gapSeconds > 0 ? `Has a gap (${Math.max(1, Math.ceil(r.gapSeconds / 60))} min missing)` : null);
