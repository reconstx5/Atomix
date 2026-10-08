// Saving where someone is in a title: the player's progress POST and a cast session both come through here, so the
// watched rule and the `playback:progress` hook (connected servers hear about it) are the same for both.

/**
 * @param {object} core
 * @param {{ user, viewer, item, position: number, duration?: number, sessionId?: string }} p
 * @returns {Promise<{ watched: boolean }>}
 */
export async function recordProgress(core, { user, viewer, item, position, duration, sessionId = null }) {
  const result = core.library.saveProgress(viewer.profileId, item, position, duration);
  await core.hooks.emit('playback:progress', { user, viewer, item, position: Number(position), watched: result.watched, sessionId });
  return result;
}
