// Podcasts (v0.22): admins subscribe to feeds; the server checks them on a schedule and keeps the episodes itself —
// the newest N of each show (or all) plus any an admin keeps — in the podcasts library's folder, so they play,
// download and work offline like any other file. Feed and enclosure addresses stay here: a browser only ever sees
// Atomix's own addresses. Every fetch goes through the same address rule as artwork and connected servers.
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../http/router.js';
import { parseJson } from '../db.js';
import { redactUrl } from '../http/net.js';
import { probe } from '../library/probe.js';
import { sortTitle } from '../library/parser.js';
import { parseFeed, episodeKey, fetchFeed, fetchChecked } from './feed.js';

const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|flac|wav)(?:$|\?)/i;
const TYPE_EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/flac': 'flac', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };
const EPISODE_MAX_BYTES = 4 * 1024 ** 3;
const DIRECTORY_ART_MS = 10 * 60 * 1000;

/** A file or folder name anywhere: no \ / : * ? " < > |, no control characters, no trailing dots, ≤ 120 letters. */
export function cleanName(s, fallback = 'Podcast') {
  const out = String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '');
  return out || fallback;
}

/** Plain text from a feed's HTML show notes (tags dropped, paragraphs kept as line breaks). */
function plain(html) {
  if (!html) return null;
  const t = String(html)
    .replace(/<\s*(br|\/p|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t.slice(0, 20000) || null;
}

const isAudio = (enc) => Boolean(enc?.url) && (String(enc.type || '').startsWith('audio/') || (!enc.type && AUDIO_EXT.test(enc.url)) || (/octet-stream/.test(enc.type || '') && AUDIO_EXT.test(enc.url)));
const extFor = (enc) => AUDIO_EXT.exec(enc.url)?.[1]?.toLowerCase() || TYPE_EXT[String(enc.type || '').split(';')[0].trim().toLowerCase()] || 'mp3';
const weekday = (ms) => new Date(ms).toLocaleDateString('en-GB', { weekday: 'long' });

export class Podcasts {
  constructor({ db, library, images, settings, config, log }) {
    this.db = db;
    this.library = library;
    this.images = images;
    this.settings = settings;
    this.config = config;
    this.log = log;
    this.directoryBase = (process.env.ATOMIX_PODCAST_DIRECTORY || 'https://itunes.apple.com').replace(/\/+$/, '');
    this.queue = []; // episode ids waiting to download, one at a time
    this.running = false;
    this.checking = 0;
    this.waiters = [];
    this.art = new Map(); // directory id → { url, at }
    this.abort = null;
    this.current = null; // { id, showId, done } — the episode downloading now
    this.subscribing = new Set();
    this.timers = [];
    this.stopped = false;
  }

  // ---- lifecycle ----
  start() {
    this.stopped = false;
    // Downloads under way or waiting when the server last stopped start again (their .part files resume).
    this.db.run("UPDATE podcast_episodes SET status = 'new' WHERE status IN ('queued', 'downloading')");
    for (const { item_id: id } of this.db.all('SELECT item_id FROM podcast_feeds')) {
      try {
        this.#keepRule(id);
      } catch (err) {
        this.log?.warn(`Podcast ${id}: ${err.message}`);
      }
    }
    const every = () => Math.max(0, Number(this.settings.get('podcastCheckHours')) || 0);
    const tick = async () => {
      if (this.stopped) return;
      if (every()) await this.checkAll().catch((e) => this.log?.warn(`Podcast check failed: ${e.message}`));
      if (!this.stopped) this.timers.push(setTimeout(tick, (every() || 1) * 3600_000).unref());
    };
    this.timers.push(setTimeout(tick, 2 * 60_000).unref());
  }
  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.queue = [];
    this.abort?.abort();
    await Promise.race([this.idle(), new Promise((r) => setTimeout(r, 3000))]);
  }
  /** Resolves when no check is running and the download queue is empty. */
  idle() {
    if (!this.running && !this.queue.length && !this.checking) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  #settle() {
    if (this.running || this.queue.length || this.checking) return;
    for (const w of this.waiters.splice(0)) w();
  }

  // ---- reading ----
  podcast(id) {
    const row = this.db.get("SELECT i.*, f.feed_url, f.etag, f.last_modified, f.keep_count, f.delete_played, f.failures, f.error, f.error_since, f.checked_at, f.explicit AS feed_explicit FROM items i JOIN podcast_feeds f ON f.item_id = i.id WHERE i.id = ? AND i.kind = 'podcast'", Number(id));
    if (!row) throw new HttpError(404, 'This podcast no longer exists.');
    return row;
  }
  root(podcast) {
    const lib = this.db.get('SELECT * FROM libraries WHERE id = ?', podcast.library_id);
    return parseJson(lib?.paths, [])[0];
  }
  episodeRows(podcastId) {
    return this.db.all(
      `SELECT i.*, e.guid, e.enclosure_url, e.enclosure_type, e.enclosure_size, e.kept, e.status, e.error AS episode_error
       FROM items i JOIN podcast_episodes e ON e.item_id = i.id WHERE i.show_id = ? AND i.kind = 'podcast_episode'
       ORDER BY i.published_at IS NULL, i.published_at DESC, i.id DESC`,
      Number(podcastId),
    );
  }
  /** The episodes a viewer may see, newest first, with progress and their download state. */
  episodesFor(podcastId, viewer) {
    const rows = this.episodeRows(podcastId).filter((r) => this.library.canSee(viewer, r));
    // A Kids profile gets what it needs to play (downloaded or not), not the household's keep pins and download states.
    return this.library.withProgress(rows, viewer).map((s, i) => (viewer?.kids ? { ...s, downloaded: Boolean(rows[i].path) } : { ...s, status: rows[i].status, kept: Boolean(rows[i].kept), downloaded: Boolean(rows[i].path) }));
  }
  feedStatus(id) {
    const p = this.podcast(id);
    return { checkedAt: p.checked_at, error: p.error, failures: p.failures, errorSince: p.error_since, keep: p.keep_count ?? 'all', deletePlayed: Boolean(p.delete_played) };
  }

  // ---- subscribing ----
  async subscribe({ libraryId, feedUrl, directoryId }) {
    const lib = this.db.get('SELECT * FROM libraries WHERE id = ?', Number(libraryId));
    if (!lib || lib.type !== 'podcasts') throw new HttpError(400, 'Choose a podcasts library.');
    let url = feedUrl ? String(feedUrl).trim() : null;
    if (!url && directoryId != null) url = await this.lookup(directoryId);
    if (!url || !/^https?:\/\//i.test(url)) throw new HttpError(400, "That address can't be used.");
    if (this.subscribing.has(url) || this.db.get('SELECT 1 FROM podcast_feeds WHERE feed_url = ?', url)) throw new HttpError(409, 'You already follow this podcast.');
    this.subscribing.add(url); // a second press while this one reads the feed is the same podcast
    try {
      return await this.#subscribe(lib, url);
    } finally {
      this.subscribing.delete(url);
    }
  }

  async #subscribe(lib, url) {
    const got = await fetchFeed(url, {});
    const feed = parseFeed(got.xml);
    const root = parseJson(lib.paths, [])[0];
    let folder = path.join(root, cleanName(feed.title));
    for (let n = 2; this.db.get("SELECT 1 FROM items WHERE library_id = ? AND kind = 'podcast' AND path = ?", lib.id, folder); n++) folder = path.join(root, `${cleanName(feed.title)} (${n})`);
    const now = Date.now();
    let id;
    this.db.transaction(() => {
    id = Number(
      this.db.run(
        "INSERT INTO items (library_id, kind, title, sort_title, overview, author, genres, path, min_age, added_at, updated_at) VALUES (?, 'podcast', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        lib.id,
        feed.title,
        sortTitle(feed.title),
        plain(feed.description),
        feed.author,
        JSON.stringify(feed.categories.slice(0, 10)),
        folder,
        feed.explicit ? 18 : null,
        now,
        now,
      ).lastInsertRowid,
    );
    this.db.run('INSERT INTO podcast_feeds (item_id, feed_url, etag, last_modified, checked_at, explicit) VALUES (?, ?, ?, ?, ?, ?)', id, url, got.etag, got.lastModified, now, feed.explicit ? 1 : 0);
    }); // the show and its feed together, or neither
    await this.#poster(id, feed.image);
    this.#apply(id, feed);
    this.#keepRule(id);
    this.log?.info(`Subscribed to "${feed.title}" (${redactUrl(url)})`);
    return this.library.get(id);
  }

  async #poster(id, image) {
    if (!image) return;
    const ref = await this.images.download(image).catch(() => null);
    if (ref) this.db.run('UPDATE items SET poster = ?, metadata_at = ? WHERE id = ?', ref, Date.now(), id);
  }

  /** Episodes from a parsed feed into the database; returns how many were new. */
  #apply(podcastId, feed) {
    const pod = this.library.get(podcastId);
    const known = new Map();
    for (const r of this.episodeRows(podcastId)) {
      known.set(r.guid, r);
      if (r.enclosure_url) known.set(`enc:${r.enclosure_url}`, r);
      known.set(`td:${r.title}|${r.published_at}`, r);
    }
    let found = 0;
    const now = Date.now();
    this.db.transaction(() => {
      for (const e of feed.episodes) {
        const key = episodeKey(e);
        // By GUID, else the enclosure address; an episode with no GUID also by title and date (its address may change).
        const have = known.get(key) || (e.enclosure?.url ? known.get(`enc:${e.enclosure.url}`) : null) || (!e.guid ? known.get(`td:${String(e.title).slice(0, 300)}|${e.publishedAt}`) : null);
        const title = String(e.title).slice(0, 300);
        if (have) {
          // Known: its words and dates may change; a changed enclosure address doesn't download it again.
          this.db.run('UPDATE items SET title = ?, sort_title = ?, overview = ?, published_at = COALESCE(?, published_at), duration = COALESCE(duration, ?), updated_at = ? WHERE id = ?', title, sortTitle(title), plain(e.description), e.publishedAt, e.duration, now, have.id);
          if (e.enclosure?.url && e.enclosure.url !== have.enclosure_url) this.db.run('UPDATE podcast_episodes SET enclosure_url = ?, enclosure_type = ?, enclosure_size = ? WHERE item_id = ?', e.enclosure.url, e.enclosure.type, e.enclosure.length, have.id);
          continue;
        }
        found++;
        const id = Number(
          this.db.run(
            "INSERT INTO items (library_id, kind, parent_id, show_id, title, sort_title, overview, season, episode, published_at, duration, added_at, updated_at) VALUES (?, 'podcast_episode', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            pod.library_id,
            podcastId,
            podcastId,
            title,
            sortTitle(title),
            plain(e.description),
            e.season,
            e.episode,
            e.publishedAt,
            e.duration,
            now,
            now,
          ).lastInsertRowid,
        );
        const status = isAudio(e.enclosure) ? 'new' : 'unsupported';
        this.db.run('INSERT INTO podcast_episodes (item_id, guid, enclosure_url, enclosure_type, enclosure_size, status, explicit) VALUES (?, ?, ?, ?, ?, ?, ?)', id, key, e.enclosure?.url || null, e.enclosure?.type || null, e.enclosure?.length ?? null, status, e.explicit ? 1 : 0);
        known.set(key, { id, guid: key, enclosure_url: e.enclosure?.url });
        if (e.enclosure?.url) known.set(`enc:${e.enclosure.url}`, known.get(key));
      }
    });
    return found;
  }

  // ---- checking ----
  async checkAll() {
    for (const { item_id: id } of this.db.all('SELECT item_id FROM podcast_feeds ORDER BY item_id')) {
      if (this.stopped) return;
      await this.check(id).catch(() => {});
    }
  }

  async check(podcastId) {
    const p = this.podcast(podcastId);
    this.checking++;
    try {
      let found = 0;
      let error = null;
      try {
        const got = await fetchFeed(p.feed_url, { etag: p.etag, lastModified: p.last_modified });
        const now = Date.now();
        if (got.status === 200) {
          const feed = parseFeed(got.xml);
          found = this.#apply(p.id, feed);
          this.#refreshShow(p, feed);
          this.db.run('UPDATE podcast_feeds SET etag = ?, last_modified = ?, explicit = ? WHERE item_id = ?', got.etag, got.lastModified, feed.explicit ? 1 : 0, p.id);
        }
        this.db.run('UPDATE podcast_feeds SET checked_at = ?, failures = 0, error = NULL, error_since = NULL WHERE item_id = ?', now, p.id);
        this.problems?.clear('podcast-feed', p.id);
      } catch (err) {
        const failures = (p.failures || 0) + 1;
        const since = p.error_since || Date.now();
        error = failures >= 2 ? `Couldn't reach the feed (${failures} tries since ${weekday(since)})` : "Couldn't reach the feed";
        this.db.run('UPDATE podcast_feeds SET checked_at = ?, failures = ?, error = ?, error_since = ? WHERE item_id = ?', Date.now(), failures, error, since, p.id);
        this.log?.warn(`Podcast "${p.title}": ${err.message} (${redactUrl(p.feed_url)})`);
        if (failures >= 3) this.problems?.report('podcast-feed', p.id, `The feed for ${p.title} has failed 3 checks in a row.`);
      }
      this.#missingFiles(p.id);
      const { queued, removed } = this.#keepRule(p.id);
      return { found, queued, removed, error };
    } finally {
      this.checking--;
      this.#settle();
    }
  }

  /** The show's own words follow the feed, except what an admin edited (Edit details locks it). */
  #refreshShow(p, feed) {
    const locks = new Set(parseJson(p.locked_fields, []));
    const sets = [];
    const vals = [];
    if (!locks.has('title')) sets.push('title = ?', 'sort_title = ?') && vals.push(feed.title, sortTitle(feed.title));
    if (!locks.has('overview')) sets.push('overview = ?') && vals.push(plain(feed.description));
    if (!locks.has('genres')) sets.push('genres = ?') && vals.push(JSON.stringify(feed.categories.slice(0, 10)));
    // An explicit feed is for grown-ups (18), unless an admin gave the show its own age rating.
    if (!locks.has('certification')) sets.push('min_age = ?') && vals.push(feed.explicit ? 18 : null);
    sets.push('author = ?', 'updated_at = ?');
    vals.push(feed.author, Date.now());
    this.db.run(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`, ...vals, p.id);
  }

  /** An episode whose file has gone is "not downloaded" again (the keep rule downloads it if it belongs). */
  #missingFiles(podcastId) {
    for (const e of this.episodeRows(podcastId)) {
      if (e.path && !fs.existsSync(e.path)) {
        this.db.run('UPDATE items SET path = NULL, size = NULL, media = NULL WHERE id = ?', e.id);
        this.db.run("UPDATE podcast_episodes SET status = 'new' WHERE item_id = ?", e.id);
      }
    }
  }

  /** Played: at least one profile finished it, and nobody is part-way through it. */
  #played(itemId) {
    const r = this.db.get('SELECT SUM(watched = 1) AS done, SUM(watched = 0 AND position > 0) AS part FROM progress WHERE item_id = ?', itemId);
    return (r?.done || 0) > 0 && !(r?.part || 0);
  }

  /** Download what belongs (newest N + kept); delete played files outside that (when the show says so). */
  #keepRule(podcastId) {
    const p = this.podcast(podcastId);
    const root = path.resolve(this.root(p) || '');
    const eps = this.episodeRows(p.id).filter((e) => e.status !== 'unsupported');
    const newest = new Set((p.keep_count == null ? eps : eps.slice(0, p.keep_count)).map((e) => e.id));
    let queued = 0;
    let removed = 0;
    for (const e of eps) {
      const belongs = newest.has(e.id) || e.kept;
      if (belongs && !e.path && !['queued', 'downloading'].includes(e.status)) {
        this.db.run("UPDATE podcast_episodes SET status = 'queued' WHERE item_id = ?", e.id);
        this.queue.push(e.id);
        queued++;
      } else if (!belongs && e.path && p.delete_played && this.#played(e.id)) {
        const file = path.resolve(e.path);
        if (file.startsWith(root + path.sep)) fs.rmSync(file, { force: true });
        this.db.run('UPDATE items SET path = NULL, size = NULL, media = NULL WHERE id = ?', e.id);
        this.db.run("UPDATE podcast_episodes SET status = 'new' WHERE item_id = ?", e.id);
        removed++;
      }
    }
    if (queued) this.#run();
    return { queued, removed };
  }

  // ---- downloading ----
  async #run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        const id = this.queue.shift();
        const showId = this.db.get('SELECT show_id FROM items WHERE id = ?', id)?.show_id ?? null;
        const done = this.#download(id).catch((err) => this.log?.warn(`Podcast episode ${id}: ${err.message}`));
        this.current = { id, showId, done };
        await done;
        this.current = null;
      }
    } finally {
      this.running = false;
      this.#settle();
    }
  }

  async #download(episodeId) {
    const e = this.db.get('SELECT i.*, pe.enclosure_url, pe.status FROM items i JOIN podcast_episodes pe ON pe.item_id = i.id WHERE i.id = ?', episodeId);
    if (!e || e.path || !e.enclosure_url) return;
    const show = this.library.get(e.show_id);
    if (!show) return;
    const root = path.resolve(this.root(show) || '');
    const date = e.published_at ? new Date(e.published_at).toISOString().slice(0, 10) : 'undated';
    const ext = extFor({ url: e.enclosure_url, type: null });
    let dest = path.join(show.path, `${date} ${cleanName(e.title, 'Episode')}.${ext}`);
    // Two episodes with one title on one day (a "Bonus" twice): the second gets its own name.
    if (this.db.get('SELECT 1 FROM items WHERE path = ? AND id != ?', dest, e.id)) dest = path.join(show.path, `${date} ${cleanName(e.title, 'Episode')} (${e.id}).${ext}`);
    if (!path.resolve(dest).startsWith(root + path.sep)) return this.#fail(e.id, "Couldn't save the episode in the podcasts folder.");
    const part = `${dest}.part`;
    this.db.run("UPDATE podcast_episodes SET status = 'downloading', error = NULL WHERE item_id = ?", e.id);
    this.abort = new AbortController();
    try {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      let have = 0;
      try {
        have = (await fs.promises.stat(part)).size;
      } catch {}
      const res = await fetchChecked(e.enclosure_url, { headers: have ? { range: `bytes=${have}-` } : {}, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30 * 60_000)]) });
      if (res.status === 416 && have) await res.body?.cancel().catch(() => {}); // the .part was already whole
      else {
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          return this.#fail(e.id, `Couldn't download the episode (it answered ${res.status}).`);
        }
        const append = res.status === 206 && have > 0;
        // Written through a file handle: a full disk or a folder Atomix may not write to is an error here (the
        // episode fails with a sentence), never an unhandled stream error that would stop the server.
        let out;
        try {
          out = await fs.promises.open(part, append ? 'a' : 'w');
        } catch (err) {
          await res.body?.cancel().catch(() => {});
          throw Object.assign(err, { write: true });
        }
        let size = append ? have : 0;
        try {
          for await (const chunk of res.body) {
            size += chunk.length;
            if (size > EPISODE_MAX_BYTES) throw new Error('too large');
            try {
              await out.write(chunk);
            } catch (err) {
              throw Object.assign(err, { write: true });
            }
          }
        } finally {
          await out.close().catch(() => {});
        }
      }
      try {
        await fs.promises.rename(part, dest);
      } catch {
        return this.#fail(e.id, "Couldn't save the episode in the podcasts folder.");
      }
      const st = await fs.promises.stat(dest);
      let media = null;
      try {
        media = await probe(this.config.ffprobePath, dest);
      } catch {}
      this.db.run('UPDATE items SET path = ?, size = ?, mtime = ?, media = ?, duration = COALESCE(?, duration), updated_at = ? WHERE id = ?', dest, st.size, Math.round(st.mtimeMs), media ? JSON.stringify(media) : null, media?.duration ?? null, Date.now(), e.id);
      this.db.run("UPDATE podcast_episodes SET status = 'done', error = NULL WHERE item_id = ?", e.id);
    } catch (err) {
      if (this.stopped) this.db.run("UPDATE podcast_episodes SET status = 'new' WHERE item_id = ?", e.id);
      else this.#fail(e.id, err.write ? "Couldn't save the episode in the podcasts folder." : err.code === 'EPRIVATE' || err.status === 400 ? "That address can't be used." : "Couldn't download the episode.");
    } finally {
      this.abort = null;
    }
  }

  #fail(id, sentence) {
    this.db.run("UPDATE podcast_episodes SET status = 'failed', error = ? WHERE item_id = ?", sentence, id);
  }

  // ---- settings ----
  setKeep(podcastId, { keep, deletePlayed }) {
    const p = this.podcast(podcastId);
    if (keep !== undefined) {
      const n = keep === 'all' ? null : Number(keep);
      if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= 1000)) throw new HttpError(400, 'Keep a number of episodes (1–1000) or all of them.');
      this.db.run('UPDATE podcast_feeds SET keep_count = ? WHERE item_id = ?', n, p.id);
    }
    if (deletePlayed !== undefined) this.db.run('UPDATE podcast_feeds SET delete_played = ? WHERE item_id = ?', deletePlayed ? 1 : 0, p.id);
    this.#keepRule(p.id);
    return this.feedStatus(p.id);
  }

  keepEpisode(episodeId, kept) {
    const e = this.db.get("SELECT i.id, i.show_id FROM items i JOIN podcast_episodes pe ON pe.item_id = i.id WHERE i.id = ? AND i.kind = 'podcast_episode'", Number(episodeId));
    if (!e) throw new HttpError(404, 'This episode no longer exists.');
    this.db.run('UPDATE podcast_episodes SET kept = ? WHERE item_id = ?', kept ? 1 : 0, e.id);
    this.#keepRule(e.show_id);
  }

  async unsubscribe(podcastId) {
    const p = this.podcast(podcastId);
    const ids = new Set(this.episodeRows(p.id).map((e) => e.id));
    this.queue = this.queue.filter((id) => !ids.has(id));
    // Only this show's own download in progress is stopped and waited for (others carry on).
    if (this.current && ids.has(this.current.id)) {
      this.abort?.abort();
      await this.current.done;
    }
    const root = path.resolve(this.root(p) || '');
    for (const e of this.episodeRows(p.id)) {
      if (!e.path) continue;
      const file = path.resolve(e.path);
      if (file.startsWith(root + path.sep)) {
        fs.rmSync(file, { force: true });
        fs.rmSync(`${file}.part`, { force: true });
      }
    }
    try {
      if (p.path && path.resolve(p.path).startsWith(root + path.sep)) fs.rmdirSync(p.path); // only when empty
    } catch {}
    this.db.run("DELETE FROM items WHERE show_id = ? AND kind = 'podcast_episode'", p.id);
    this.db.run('DELETE FROM items WHERE id = ?', p.id);
  }

  // ---- the directory (Apple's podcast search) ----
  async #directoryJson(pathAndQuery) {
    const res = await fetchChecked(`${this.directoryBase}${pathAndQuery}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new HttpError(502, "The podcast directory didn't answer. Try again in a moment.");
    }
    const text = await res.text();
    if (text.length > 2_000_000) throw new HttpError(502, "The podcast directory didn't answer. Try again in a moment.");
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(502, "The podcast directory didn't answer. Try again in a moment.");
    }
  }

  async directory(term) {
    const q = String(term || '').trim().slice(0, 100);
    if (q.length < 2) return [];
    const data = await this.#directoryJson(`/search?media=podcast&entity=podcast&limit=25&term=${encodeURIComponent(q)}`);
    const now = Date.now();
    for (const [k, v] of this.art) if (now - v.at > DIRECTORY_ART_MS) this.art.delete(k);
    return (data.results || [])
      .filter((r) => r.collectionId && r.feedUrl)
      .map((r) => {
        const art = r.artworkUrl600 || r.artworkUrl100 || null;
        if (art) this.art.set(String(r.collectionId), { url: art, at: now });
        return { id: r.collectionId, name: r.collectionName || r.trackName || 'Podcast', author: r.artistName || null, artwork: art ? `/api/podcasts/directory/${r.collectionId}/art` : null };
      });
  }

  /** A directory result's picture, fetched by the server from the last search's results. */
  async directoryArt(id) {
    const hit = this.art.get(String(id));
    if (!hit || Date.now() - hit.at > DIRECTORY_ART_MS) return null;
    const ref = await this.images.download(hit.url).catch(() => null);
    return ref ? this.images.resolve(ref)?.file : null;
  }

  async lookup(directoryId) {
    const id = Number(directoryId);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "That podcast isn't in the directory.");
    const data = await this.#directoryJson(`/lookup?id=${id}`);
    const feedUrl = (data.results || []).find((r) => r.feedUrl)?.feedUrl;
    if (!feedUrl) throw new HttpError(404, "That podcast isn't in the directory.");
    return feedUrl;
  }
}
