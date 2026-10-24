// Live TV recordings: record a programme or a series from the guide, the Recordings page's lists, stop, delete, and
// the series rules. Any grown-up profile may schedule and cancel, and sees everyone's (named by profile); Kids profiles
// never reach these routes. Provider addresses never appear here.
import { HttpError } from '../http/router.js';

const KEEPS = [0, 5, 10];
const LIST_CAP = 200; // finished and failed recordings listed, newest first

export function registerRecordingRoutes(r, core) {
  const store = () => core.live.store;
  const recordings = () => core.live.recordings;
  const scheduler = () => core.live.scheduler;

  function grownUp(ctx) {
    if (ctx.profile?.kids || ctx.viewer?.kids) throw new HttpError(403, "Kids profiles can't record");
    if (!ctx.profile) throw new HttpError(403, 'Choose a profile first.');
  }

  const profileNames = () => new Map(core.db.all('SELECT id, name FROM profiles').map((p) => [p.id, p.name]));

  function shapeRecording(row, names = profileNames()) {
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      saving: row.status === 'failed' && Boolean(scheduler().saving?.(row.id)),
      profile: names.get(row.profileId) || null,
      channel: row.channelName,
      channelId: row.channelId,
      title: row.title,
      episodeTitle: row.episodeTitle,
      season: row.season,
      episode: row.episode,
      start: row.start,
      end: row.end,
      pre: row.pre,
      post: row.post,
      part: row.part,
      gapSeconds: row.gapSeconds,
      error: row.error,
      itemId: row.itemId,
      ruleId: row.ruleId,
      clash: row.status === 'scheduled' ? scheduler().clashFor(row) : null,
      canRetry: row.status === 'failed' ? scheduler().canRetry(row) : false, // v0.21: its pieces are still there
    };
  }

  function shapeRule(rule, names = profileNames()) {
    if (!rule) return null;
    const channel = rule.channelKey ? core.db.get('SELECT name FROM live_channels WHERE source = ? AND key = ?', rule.source, rule.channelKey)?.name || rule.channelKey : null;
    const upcoming = recordings().list({ ruleId: rule.id, status: 'scheduled' }).length;
    // The channels it can move to (Settings-free: the Recordings page's "Record on"): the source's TV channels.
    const channelOptions = core.db
      .all('SELECT key, name FROM live_channels WHERE source = ? AND radio = 0 AND drm IS NULL AND hidden = 0 AND missing_since IS NULL ORDER BY sort', rule.source)
      .map((c) => ({ key: c.key, name: c.name }));
    return { id: rule.id, profile: names.get(rule.profileId) || null, title: rule.title, channel, channelKey: rule.channelKey, newOnly: rule.newOnly, keep: rule.keep, upcoming, channelOptions };
  }

  /** A programme this (grown-up) viewer can record: on a channel still in the playlist, of a source that's there. */
  function recordable(id) {
    const p = store().programme(id);
    const channel = p ? store().channel(p.channelId) : null;
    if (!p || !channel || channel.hidden || !core.plugins.getLiveSource(channel.source)) throw new HttpError(404, 'This programme is no longer in the guide.');
    if (channel.drm) throw new HttpError(400, "Encrypted channels can't be recorded");
    if (channel.radio) throw new HttpError(400, "Radio can't be recorded");
    if (p.end <= Date.now()) throw new HttpError(400, 'This programme has ended');
    return { p, channel };
  }

  r.post('/api/live/programmes/:id/record', async (ctx) => {
    grownUp(ctx);
    const body = await ctx.body();
    const { p, channel } = recordable(ctx.params.id);
    let rule = null;
    if (body.series) {
      const keep = KEEPS.includes(Number(body.keep)) ? Number(body.keep) : 0;
      const ruleId = recordings().addRule({ profileId: ctx.profile.id, source: channel.source, channelKey: body.anyChannel ? null : channel.key, title: p.title, newOnly: body.newOnly !== false, keep });
      rule = recordings().rule(ruleId);
    }
    const { recording, clash } = scheduler().schedule({ profile: ctx.profile, programme: p, channel, ruleId: rule?.id ?? null });
    if (rule) scheduler().afterRefresh(channel.source);
    return { recording: shapeRecording(recordings().get(recording.id)), rule: shapeRule(rule && recordings().rule(rule.id)), clash };
  });

  r.get('/api/live/recordings', (ctx) => {
    grownUp(ctx);
    const names = profileNames();
    const all = recordings().list();
    const by = (status) => all.filter((x) => x.status === status);
    const newest = (list) => list.sort((a, b) => b.start - a.start).slice(0, LIST_CAP);
    return {
      scheduled: by('scheduled').map((x) => shapeRecording(x, names)),
      recording: by('recording').map((x) => shapeRecording(x, names)),
      done: newest(by('done')).map((x) => shapeRecording(x, names)),
      failed: newest(by('failed')).map((x) => shapeRecording(x, names)),
      rules: recordings().rules().map((x) => shapeRule(x, names)),
    };
  });

  const recordingOr404 = (id) => {
    const row = recordings().get(id);
    if (!row || row.status === 'cancelled') throw new HttpError(404, 'This recording no longer exists.');
    return row;
  };

  r.post('/api/live/recordings/:id/stop', async (ctx) => {
    grownUp(ctx);
    const row = recordingOr404(ctx.params.id);
    await scheduler().cancel(row.id);
    return shapeRecording(recordings().get(row.id));
  });

  /** Try again: a recording whose join failed is joined again from the pieces it kept. */
  r.post('/api/live/recordings/:id/retry', async (ctx) => {
    grownUp(ctx);
    const row = recordingOr404(ctx.params.id);
    if (!scheduler().canRetry(row)) throw new HttpError(409, "This recording can't be tried again (its pieces are gone)");
    // Answered at once (a join can take minutes); the page reads again to see it saved or failed.
    scheduler().retryJoin(row.id);
    ctx.json({ ...shapeRecording(recordings().get(row.id)), saving: true }, 202);
  });

  r.delete('/api/live/recordings/:id', async (ctx) => {
    grownUp(ctx);
    const row = recordingOr404(ctx.params.id);
    // ?only=active: a programme sheet opened a while ago — it may cancel or stop, never remove a finished file.
    if (ctx.query.only === 'active' && row.status !== 'scheduled' && row.status !== 'recording') throw new HttpError(409, 'This recording has finished');
    if (row.status === 'scheduled' || row.status === 'recording') {
      await scheduler().cancel(row.id);
      return { ok: true };
    }
    // A failed recording being joined again (Try again): its pieces are being read.
    if (scheduler().saving?.(row.id)) throw new HttpError(409, "This recording is being saved. Try again when it's done.");
    scheduler().removeRecording(row);
    return { ok: true };
  });

  const ruleOr404 = (id) => {
    const rule = recordings().rule(id);
    if (!rule) throw new HttpError(404, 'This series is no longer recorded.');
    return rule;
  };

  r.patch('/api/live/rules/:id', async (ctx) => {
    grownUp(ctx);
    const rule = ruleOr404(ctx.params.id);
    const body = await ctx.body();
    const fields = {};
    if (body.keep !== undefined) {
      if (!KEEPS.includes(Number(body.keep))) throw new HttpError(400, 'Keep all episodes, or the last 5 or 10.');
      fields.keep = Number(body.keep);
    }
    if (body.newOnly !== undefined) fields.newOnly = Boolean(body.newOnly);
    if (body.channelKey !== undefined) {
      if (body.channelKey !== null && !core.db.get('SELECT 1 FROM live_channels WHERE source = ? AND key = ?', rule.source, String(body.channelKey))) throw new HttpError(400, 'That channel isn\'t in this playlist.');
      fields.channelKey = body.channelKey === null ? null : String(body.channelKey);
    }
    recordings().updateRule(rule.id, fields);
    scheduler().ruleChanged(rule.id); // airings that no longer match go
    scheduler().afterRefresh(rule.source);
    return shapeRule(recordings().rule(rule.id));
  });

  /** Stop series: the rule goes and its future recordings are cancelled (one recording now carries on). */
  r.delete('/api/live/rules/:id', (ctx) => {
    grownUp(ctx);
    const rule = ruleOr404(ctx.params.id);
    for (const x of recordings().list({ ruleId: rule.id, status: 'scheduled' })) recordings().update(x.id, { status: 'cancelled' });
    recordings().deleteRule(rule.id);
    return { ok: true };
  });
}
