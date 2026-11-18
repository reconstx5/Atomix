// What a Jellyfin app tells Atomix about the viewer: playing reports (this file's Sessions/Playing* part; Task 7 adds
// played and favourite writes). Positions arrive in ticks (1 s = 10,000,000) and are saved as the profile's Atomix
// progress through recordProgress, the web's own path (play history, scrobblers, "watched" near the end). A report
// keeps the device's stream slot alive; Stopped ends it. The title is checked with the viewer first: a hidden title is
// 404 and nothing is saved.
import { HttpError } from './index.js';
import { ensureVisible, ownUser } from './browse.js';
import { TICKS } from './shapes.js';
import { recordProgress } from '../library/progress.js';

const PLAYABLE = new Set(['movie', 'episode']);
const isTrue = (v) => v === true || String(v).toLowerCase() === 'true';

/** Seconds from a ticks value; null when there is none. */
function seconds(ticks) {
  if (ticks == null || ticks === '') return null;
  const n = Number(ticks);
  return Number.isFinite(n) && n >= 0 ? n / TICKS : null;
}

/**
 * One playing report: `stage` is 'start', 'progress' or 'stopped'. Saves the position (when there is one and the
 * title is a film or an episode the viewer may see), then touches or stops the token's slot.
 */
async function report(ctx, { itemId, positionTicks, paused, stage }) {
  const sessions = ctx.core.jellyfin.sessions;
  let position = null;
  if (itemId) {
    const row = ensureVisible(ctx, itemId);
    position = seconds(positionTicks);
    if (position != null && PLAYABLE.has(row.kind)) {
      await recordProgress(ctx.core, { user: ctx.user, viewer: ctx.viewer, item: row, position, duration: row.duration, client: 'jellyfin', paused: Boolean(paused) });
    }
  }
  if (stage === 'stopped') sessions.stop(ctx.tokenRow.id);
  else sessions.touch(ctx.tokenRow.id, { position: position ?? undefined, paused: paused == null ? undefined : Boolean(paused) });
  return null;
}

/** Sessions/Playing*: the report is the JSON body. */
const fromBody = (stage) => async (ctx) => {
  const b = (await ctx.body()) || {};
  return report(ctx, { itemId: b.ItemId ?? b.itemId, positionTicks: b.PositionTicks ?? b.positionTicks, paused: b.IsPaused == null ? null : isTrue(b.IsPaused), stage });
};

/** The older Users/{userId}/PlayingItems/{itemId} forms: the position is in the query. */
const fromQuery = (stage) => (ctx) => {
  ownUser(ctx);
  const q = ctx.query;
  return report(ctx, { itemId: ctx.params.itemId, positionTicks: q.positionticks, paused: q.ispaused == null ? null : isTrue(q.ispaused), stage });
};

export function registerUserData(j) {
  j.route('POST', '/Sessions/Playing', fromBody('start'));
  j.route('POST', '/Sessions/Playing/Progress', fromBody('progress'));
  j.route('POST', '/Sessions/Playing/Stopped', fromBody('stopped'));
  j.route('POST', '/Sessions/Playing/Ping', (ctx) => (ctx.core.jellyfin.sessions.touch(ctx.tokenRow.id), null));
  j.route('POST', '/Users/{userId}/PlayingItems/{itemId}', fromQuery('start'));
  j.route('POST', '/Users/{userId}/PlayingItems/{itemId}/Progress', fromQuery('progress'));
  j.route('DELETE', '/Users/{userId}/PlayingItems/{itemId}', fromQuery('stopped'));
}
