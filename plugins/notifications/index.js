// Announces new movies and episodes on Discord, a generic webhook and email.
// Items found during one library scan are collected and sent as one message.
import { sendMail } from './smtp.js';

const DISCORD_LIMIT = 2000;

function episodeCode(e) {
  return e.season === 0 ? `Special ${e.episode}` : `S${e.season} E${e.episode}`;
}

function link(publicUrl, id) {
  return publicUrl ? `${String(publicUrl).replace(/\/+$/, '')}/#/item/${id}` : null;
}

/**
 * Turn a list of new items into subject / plain text / Discord text.
 * items: [{ id, kind, title, year, season, episode, show: { id, title } }]
 */
export function buildMessage({ serverName = 'Atomix', publicUrl = '', items }) {
  const movies = items.filter((i) => i.kind === 'movie');
  const shows = new Map();
  for (const e of items.filter((i) => i.kind === 'episode')) {
    const key = e.show?.id ?? e.show?.title ?? 'show';
    if (!shows.has(key)) shows.set(key, { show: e.show || { title: 'Unknown show' }, episodes: [] });
    shows.get(key).episodes.push(e);
  }
  const lines = [];
  for (const m of movies) {
    const url = link(publicUrl, m.id);
    lines.push(`• ${m.title}${m.year ? ` (${m.year})` : ''}${url ? ` — ${url}` : ''}`);
  }
  for (const { show, episodes } of shows.values()) {
    episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
    const list = episodes.map((e) => (/^Episode \d+/.test(e.title || '') || !e.title ? episodeCode(e) : `${episodeCode(e)} “${e.title}”`)).join(', ');
    const url = link(publicUrl, show.id);
    lines.push(`• ${show.title} — ${list}${url ? ` — ${url}` : ''}`);
  }
  const names = [...movies.map((m) => m.title), ...[...shows.values()].map((s) => s.show.title)];
  let subject = `New on ${serverName}: ${names.slice(0, 3).join(', ')}`;
  if (names.length > 3) subject += ` and ${names.length - 3} more`;
  const heading = `New on ${serverName}`;
  const text = `${heading}\n\n${lines.join('\n')}\n`;

  // Discord allows 2000 characters per message.
  let discord = `**${heading}**\n`;
  let shown = 0;
  for (const line of lines) {
    const remaining = lines.length - shown - 1;
    const tail = remaining > 0 ? `\n…and ${remaining} more` : '';
    if (discord.length + line.length + 1 + tail.length > DISCORD_LIMIT - 20) break;
    discord += `${line}\n`;
    shown++;
  }
  if (shown < lines.length) discord += `…and ${lines.length - shown} more`;
  return { subject, text, discord: discord.trim(), lines };
}

export function setup(api) {
  const pending = new Map(); // libraryId → items found in the current scan

  async function send(message, items = []) {
    const cfg = api.config;
    const sent = [];
    const failed = [];
    const jobs = [];
    if (cfg.discordWebhook) {
      jobs.push(
        (async () => {
          const res = await api.fetch(cfg.discordWebhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: message.discord, username: api.serverName, allowed_mentions: { parse: [] } }),
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) throw new Error(`Discord answered ${res.status}`);
        })().then(() => sent.push('Discord'), (err) => failed.push(`Discord failed: ${err.message}`)),
      );
    }
    if (cfg.webhookUrl) {
      jobs.push(
        (async () => {
          const res = await api.fetch(cfg.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: items.length ? 'items.added' : 'test',
              server: api.serverName,
              text: message.text,
              items: items.map((i) => ({ id: i.id, kind: i.kind, title: i.title, year: i.year ?? null, season: i.season ?? null, episode: i.episode ?? null, show: i.show?.title ?? null, url: link(cfg.publicUrl, i.kind === 'episode' ? i.show?.id : i.id) })),
            }),
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) throw new Error(`answered ${res.status}`);
        })().then(() => sent.push('webhook'), (err) => failed.push(`Webhook failed: ${err.cause?.code || err.message}`)),
      );
    }
    if (cfg.smtpHost && cfg.emailTo) {
      jobs.push(
        sendMail({
          host: cfg.smtpHost,
          port: cfg.smtpPort,
          security: cfg.smtpSecurity,
          user: cfg.smtpUser,
          pass: cfg.smtpPass,
          from: cfg.emailFrom || cfg.smtpUser,
          to: String(cfg.emailTo).split(',').map((s) => s.trim()).filter(Boolean),
          subject: message.subject,
          text: message.text,
        }).then(() => sent.push('email'), (err) => failed.push(`Email failed: ${err.message}`)),
      );
    }
    await Promise.all(jobs);
    // Keep a stable order in the summary.
    const order = ['Discord', 'webhook', 'email'];
    sent.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    for (const f of failed) api.log.warn(f);
    return { sent, failed };
  }

  function summary({ sent, failed }) {
    const list = sent.length > 1 ? `${sent.slice(0, -1).join(', ')} and ${sent.at(-1)}` : sent[0];
    const parts = [];
    if (sent.length) parts.push(`Sent to ${list}.`);
    else if (!failed.length) parts.push('Nothing is set up yet — add a Discord webhook, a webhook URL or email settings first.');
    if (failed.length) parts.push(failed.join(' '));
    return parts.join(' ');
  }

  api.on('item:added', ({ item, firstScan }) => {
    const cfg = api.config;
    if (firstScan && cfg.skipFirstScan !== false) return;
    if (item.kind === 'movie' && cfg.notifyMovies === false) return;
    if (item.kind === 'episode' && cfg.notifyEpisodes === false) return;
    if (!['movie', 'episode'].includes(item.kind)) return;
    const show = item.show_id ? api.library.get(item.show_id) : null;
    if (!pending.has(item.library_id)) pending.set(item.library_id, []);
    pending.get(item.library_id).push({ id: item.id, kind: item.kind, title: item.title, year: item.year, season: item.season, episode: item.episode, show: show ? { id: show.id, title: show.title } : null });
  });

  api.on('scan:complete', async ({ library }) => {
    const items = pending.get(library.id) || [];
    pending.delete(library.id);
    if (!items.length) return;
    const message = buildMessage({ serverName: api.serverName, publicUrl: api.config.publicUrl, items });
    const result = await send(message, items);
    api.log.info(`Announced ${items.length} new item${items.length === 1 ? '' : 's'}: ${summary(result)}`);
  });

  api.registerAction('test', async () => {
    const message = {
      subject: `Test message from ${api.serverName}`,
      text: `This is a test message from ${api.serverName}. New movies and episodes will be announced like this.\n`,
      discord: `**${api.serverName}** — this is a test message. New movies and episodes will be announced here.`,
    };
    return { message: summary(await send(message)) };
  });
}
