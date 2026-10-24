// Alerts (renamed from "New-episode alerts" in v0.23): new films and episodes — one message per scan — and server
// problems, to ntfy, Telegram, Pushover, Discord, a generic webhook and email. The Test button reports each channel.
import { sendMail } from './smtp.js';
import { sendNtfy, sendTelegram, sendPushover } from './channels.js';

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

const ORDER = ['ntfy', 'Telegram', 'Pushover', 'Discord', 'Webhook', 'Email'];
const NOTHING = 'Nothing is set up yet. Fill in a channel (ntfy, Telegram, Pushover, Discord, a webhook or email) first.';
const DAY = 86_400_000;

/** Each channel's result in one line: "ntfy: sent · Telegram: Unauthorized (check the bot token)". */
export function report(results) {
  if (!results.length) return NOTHING;
  return [...results]
    .sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name))
    .map((r) => `${r.name}: ${r.error ? r.error : 'sent'}`)
    .join(' · ');
}

export function setup(api) {
  const pending = new Map(); // libraryId → items found in the current scan

  /**
   * Send one message to every channel that is filled in. Resolves to [{ name, error? }] — never throws.
   * @param {{ subject: string, text: string, discord: string }} message
   */
  async function send(message, { items = [], event = items.length ? 'items.added' : 'test' } = {}) {
    const cfg = api.config;
    const jobs = [];
    const run = (name, fn) =>
      jobs.push(
        (async () => {
          try {
            await fn();
            return { name };
          } catch (err) {
            return { name, error: String(err?.cause?.code || err?.message || 'failed').slice(0, 160) };
          }
        })(),
      );
    if (cfg.ntfyTopic) run('ntfy', () => sendNtfy(api, cfg, { title: message.subject, text: message.text }));
    if (cfg.telegramToken && cfg.telegramChat) run('Telegram', () => sendTelegram(api, cfg, { text: message.text }));
    if (cfg.pushoverToken && cfg.pushoverUser) run('Pushover', () => sendPushover(api, cfg, { title: message.subject, text: message.text }));
    if (cfg.discordWebhook) {
      run('Discord', async () => {
        const res = await api.fetch(cfg.discordWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: message.discord, username: api.serverName, allowed_mentions: { parse: [] } }),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`answered ${res.status}`);
      });
    }
    if (cfg.webhookUrl) {
      run('Webhook', async () => {
        const res = await api.fetch(cfg.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event,
            server: api.serverName,
            text: message.text,
            items: items.map((i) => ({ id: i.id, kind: i.kind, title: i.title, year: i.year ?? null, season: i.season ?? null, episode: i.episode ?? null, show: i.show?.title ?? null, url: link(cfg.publicUrl, i.kind === 'episode' ? i.show?.id : i.id) })),
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`answered ${res.status}`);
      });
    }
    if (cfg.smtpHost && cfg.emailTo) {
      run('Email', () =>
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
        }),
      );
    }
    const results = await Promise.all(jobs);
    // Only the channel and its reason are logged: addresses carry tokens.
    for (const r of results) if (r.error) api.log.warn(`${r.name} failed: ${r.error}`);
    return results;
  }

  api.on('item:added', ({ item, firstScan }) => {
    const cfg = api.config;
    if (cfg.alertNew === false) return;
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
    const results = await send(message, { items });
    api.log.info(`Announced ${items.length} new item${items.length === 1 ? '' : 's'}: ${report(results)}`);
  });

  // Server problems (v0.23): sent once, and again at most once a day if it comes back — a problem that comes back
  // within the day is held and sent when the day is up, if it's still open then. Only a send that reached at least
  // one channel counts. Its clearing is said only when asked, once per sent problem.
  const repeatMs = () => Number(process.env.ATOMIX_ALERTS_REPEAT_MS) || DAY; // the env value is for tests
  const open = new Map(); // "sent:kind:key" → the problem's text, while it's open
  const held = new Map(); // "sent:kind:key" → timer for a problem held until its day is up

  async function sendProblem(id, text) {
    const server = api.serverName;
    const line = `⚠ ${server}: ${text}`;
    const results = await send({ subject: `Problem on ${server}`, text: line, discord: line }, { event: 'server.problem' });
    if (results.some((r) => !r.error)) api.storage.set(id, { at: Date.now(), text, cleared: false });
  }

  api.on('server:problem', async ({ kind, key, text }) => {
    if (api.config.alertProblems === false) return;
    const id = `sent:${kind}:${key}`;
    open.set(id, text);
    const last = api.storage.get(id);
    const wait = last ? last.at + repeatMs() - Date.now() : 0;
    if (wait > 0) {
      clearTimeout(held.get(id));
      const timer = setTimeout(() => {
        held.delete(id);
        if (open.has(id) && api.config.alertProblems !== false) sendProblem(id, open.get(id)).catch(() => {});
      }, wait);
      timer.unref?.();
      held.set(id, timer);
      return;
    }
    await sendProblem(id, text);
  });

  api.on('server:recovered', async ({ kind, key }) => {
    const id = `sent:${kind}:${key}`;
    open.delete(id);
    clearTimeout(held.get(id));
    held.delete(id);
    if (!api.config.alertRecovered) return;
    const last = api.storage.get(id);
    if (!last || last.cleared) return; // only a problem that was sent, and only once
    api.storage.set(id, { ...last, cleared: true });
    const server = api.serverName;
    const line = `✓ ${server}: back to normal — ${last.text}`;
    await send({ subject: `Back to normal on ${server}`, text: line, discord: line }, { event: 'server.recovered' });
  });

  api.registerAction('test', async () => {
    const message = {
      subject: `Test message from ${api.serverName}`,
      text: `This is a test message from ${api.serverName}. New films, episodes and server problems will be sent like this.\n`,
      discord: `**${api.serverName}** — this is a test message. New films, episodes and server problems will be sent here.`,
    };
    return { message: report(await send(message)) };
  });

  return () => {
    for (const t of held.values()) clearTimeout(t);
    held.clear();
  };
}
