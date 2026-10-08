// Plugin loader. A plugin is a folder in /plugins with a plugin.json manifest
// and an ES module exporting `setup(api)`. See docs/PLUGINS.md.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from './log.js';
import { parseJson } from './db.js';
import { HttpError } from './http/router.js';
import { listSubtitles, saveDownloaded } from './stream/subtitles.js';

const log = logger('plugins');

class PluginStorage {
  constructor(file) {
    this.file = file;
    this.data = parseJson(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, {});
    this.timer = null;
  }
  get(key, fallback = null) {
    return key in this.data ? this.data[key] : fallback;
  }
  set(key, value) {
    this.data[key] = value;
    this.save();
  }
  delete(key) {
    delete this.data[key];
    this.save();
  }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => fs.promises.writeFile(this.file, JSON.stringify(this.data, null, 2)).catch(() => {}), 200);
  }
  all() {
    return { ...this.data };
  }
}

export class PluginManager {
  constructor(core) {
    this.core = core; // { config, db, router, hooks, metadata, library, settings, images }
    this.plugins = new Map(); // id -> record
    this.sources = new Map(); // "pluginId/sourceId" -> source
    this.subtitleSources = new Map(); // "pluginId/providerId" -> subtitle provider
    this.actions = new Map(); // "pluginId/actionId" -> handler (buttons in Settings → Plugins)
    this.homeRows = []; // { owner, id, title, style, items }
  }

  discover() {
    const dir = this.core.config.pluginsDir;
    if (!fs.existsSync(dir)) return [];
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      const folder = path.join(dir, entry.name);
      const manifestFile = path.join(folder, 'plugin.json');
      if (!fs.existsSync(manifestFile)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        if (!manifest.id || !/^[a-z0-9][a-z0-9-]{1,48}$/.test(manifest.id)) throw new Error('id must be lowercase letters, numbers and dashes');
        found.push({ manifest, folder });
      } catch (err) {
        log.error(`Invalid plugin in ${folder}: ${err.message}`);
      }
    }
    return found;
  }

  async loadAll() {
    for (const { manifest, folder } of this.discover()) {
      const row = this.core.db.get('SELECT * FROM plugins WHERE id = ?', manifest.id);
      if (!row) {
        this.core.db.run('INSERT INTO plugins (id, enabled, config) VALUES (?, ?, ?)', manifest.id, manifest.enabledByDefault === false ? 0 : 1, '{}');
      }
      const enabled = row ? Boolean(row.enabled) : manifest.enabledByDefault !== false;
      this.plugins.set(manifest.id, { manifest, folder, enabled, loaded: false, error: null, module: null, cleanup: [] });
      if (enabled) await this.load(manifest.id);
    }
    log.info(`${[...this.plugins.values()].filter((p) => p.loaded).length} of ${this.plugins.size} plugins loaded`);
  }

  configFor(id) {
    const rec = this.plugins.get(id);
    const row = this.core.db.get('SELECT config FROM plugins WHERE id = ?', id);
    const saved = parseJson(row?.config, {});
    const defaults = {};
    for (const field of rec?.manifest.settings || []) defaults[field.key] = field.default ?? null;
    return { ...defaults, ...saved };
  }

  createApi(rec) {
    const { id } = rec.manifest;
    const owner = `plugin:${id}`;
    const core = this.core;
    const manager = this;
    const configListeners = [];
    rec.configListeners = configListeners;
    const dataDir = path.join(core.config.pluginDataDir, id);
    fs.mkdirSync(dataDir, { recursive: true });
    const storage = new PluginStorage(path.join(dataDir, 'storage.json'));

    return {
      id,
      version: core.version,
      get serverName() {
        return core.settings.get('serverName') || 'Atomix';
      },
      /** Handle a button listed under "actions" in plugin.json (Settings → Plugins). */
      registerAction(actionId, handler) {
        manager.actions.set(`${id}/${actionId}`, { handler, owner });
      },
      manifest: rec.manifest,
      folder: rec.folder,
      dataDir,
      log: logger(id),
      storage,
      fetch: (...args) => fetch(...args),
      get config() {
        return manager.configFor(id);
      },
      onConfigChange(fn) {
        configListeners.push(fn);
      },
      /** Add an HTTP endpoint at /api/plugins/<id><path>. */
      route(method, routePath, handler, opts = {}) {
        const full = `/api/plugins/${id}${routePath.startsWith('/') ? routePath : '/' + routePath}`;
        core.router.add(method, full, handler, { auth: opts.auth ?? 'user', owner });
        return full;
      },
      /** Subscribe to server events (scan:complete, item:added, playback:start, ...). */
      on(event, fn) {
        return core.hooks.on(event, fn, owner);
      },
      registerMetadataProvider(provider) {
        core.metadata.register(provider, owner);
      },
      /** A browsable content source shown under Add-ons (like a Kodi video add-on). */
      registerSource(source) {
        if (!source?.id || typeof source.browse !== 'function') throw new Error('A source needs an id and browse()');
        manager.sources.set(`${id}/${source.id}`, { ...source, pluginId: id, owner });
      },
      /**
       * Online subtitles: search(item, ctx) → [{ id, language, label, downloads, hearingImpaired, hashMatch }],
       * download(item, id, ctx) → { content, format: 'srt'|'vtt'|'ass', language, label }
       */
      registerSubtitleProvider(provider) {
        if (!provider?.id || typeof provider.search !== 'function' || typeof provider.download !== 'function') {
          throw new Error('A subtitle provider needs an id, search() and download()');
        }
        manager.subtitleSources.set(`${id}/${provider.id}`, { ...provider, key: `${id}/${provider.id}`, pluginId: id, owner });
      },
      /** Subtitles already available for an item, and a way to save new ones. */
      subtitles: {
        list: (item) => listSubtitles(item, core.config),
        save: (item, data) => saveDownloaded(core.config, item, { ...data, provider: data.provider || id }),
      },
      /** A row on the home screen. items(viewer) returns library items or cards. */
      registerHomeRow(row) {
        if (!row?.id || typeof row.items !== 'function') throw new Error('A home row needs an id and items()');
        manager.homeRows.push({
          owner,
          key: `${id}/${row.id}`,
          get title() {
            return row.title; // read live so getters work
          },
          style: row.style || 'poster',
          position: row.position ?? 50,
          items: (user) => row.items(user),
        });
        manager.homeRows.sort((a, b) => a.position - b.position);
      },
      /**
       * Read-only access to the media library. Pass the `viewer` you were given
       * (home rows, routes: ctx.viewer) so profiles and Kids limits are respected.
       */
      library: {
        get: (itemId) => core.library.get(itemId),
        canSee: (viewer, row) => core.library.canSee(viewer, row),
        list: (filters = {}) => core.library.list(filters),
        serialize: (rows, viewer) => core.library.withProgress(rows, viewer),
        recentlyAdded: (opts) => core.library.recentlyAdded(opts),
        libraries: (viewer) => core.library.visibleLibraries(viewer).map((l) => ({ id: l.id, name: l.name, type: l.type })),
      },
      HttpError,
    };
  }

  async load(id) {
    const rec = this.plugins.get(id);
    if (!rec || rec.loaded) return;
    const mainFile = path.join(rec.folder, rec.manifest.main || 'index.js');
    try {
      const mod = await import(`${pathToFileURL(mainFile).href}?v=${Date.now()}`);
      const setup = mod.setup || mod.default?.setup || (typeof mod.default === 'function' ? mod.default : null);
      if (!setup) throw new Error('Plugin must export a setup(api) function');
      const api = this.createApi(rec);
      const result = await setup(api);
      rec.teardown = typeof result === 'function' ? result : mod.teardown || mod.default?.teardown || null;
      rec.module = mod;
      rec.loaded = true;
      rec.error = null;
      log.info(`Loaded ${rec.manifest.name || id} ${rec.manifest.version || ''}`.trim());
    } catch (err) {
      rec.error = err.message;
      rec.loaded = false;
      this.unregister(id);
      log.error(`Failed to load plugin ${id}: ${err.stack || err.message}`);
    }
  }

  unregister(id) {
    const owner = `plugin:${id}`;
    this.core.router.removeByOwner(owner);
    this.core.hooks.removeByOwner(owner);
    this.core.metadata.removeByOwner(owner);
    for (const [key, src] of this.sources) if (src.owner === owner) this.sources.delete(key);
    for (const [key, p] of this.subtitleSources) if (p.owner === owner) this.subtitleSources.delete(key);
    for (const [key, a] of this.actions) if (a.owner === owner) this.actions.delete(key);
    this.homeRows = this.homeRows.filter((r) => r.owner !== owner);
  }

  async unload(id) {
    const rec = this.plugins.get(id);
    if (!rec) return;
    try {
      await rec.teardown?.();
    } catch (err) {
      log.warn(`Teardown of ${id} failed: ${err.message}`);
    }
    this.unregister(id);
    rec.loaded = false;
    rec.module = null;
  }

  async setEnabled(id, enabled) {
    const rec = this.plugins.get(id);
    if (!rec) throw new HttpError(404, 'Unknown plugin');
    this.core.db.run('UPDATE plugins SET enabled = ? WHERE id = ?', enabled ? 1 : 0, id);
    rec.enabled = enabled;
    if (enabled) await this.load(id);
    else await this.unload(id);
    return this.describe(rec);
  }

  async setConfig(id, values) {
    const rec = this.plugins.get(id);
    if (!rec) throw new HttpError(404, 'Unknown plugin');
    const clean = {};
    for (const field of rec.manifest.settings || []) {
      if (!(field.key in values)) continue;
      let v = values[field.key];
      // The settings form shows saved passwords as dots; don't save the dots.
      if (field.type === 'password' && typeof v === 'string' && /^•+$/.test(v)) continue;
      if (field.type === 'number') v = Number(v);
      if (field.type === 'boolean') v = Boolean(v);
      if (field.type === 'select' && field.options && !field.options.some((o) => (o.value ?? o) === v)) continue;
      if (['text', 'textarea', 'password'].includes(field.type) || !field.type) v = String(v ?? '').slice(0, 10000);
      clean[field.key] = v;
    }
    const merged = { ...parseJson(this.core.db.get('SELECT config FROM plugins WHERE id = ?', id)?.config, {}), ...clean };
    this.core.db.run('UPDATE plugins SET config = ? WHERE id = ?', JSON.stringify(merged), id);
    for (const fn of rec.configListeners || []) {
      try {
        await fn(this.configFor(id));
      } catch (err) {
        log.warn(`${id} config listener failed: ${err.message}`);
      }
    }
    return this.describe(rec);
  }

  describe(rec) {
    const owner = `plugin:${rec.manifest.id}`;
    const config = this.configFor(rec.manifest.id);
    for (const f of rec.manifest.settings || []) if (f.type === 'password' && config[f.key]) config[f.key] = '••••••••';
    return {
      id: rec.manifest.id,
      name: rec.manifest.name || rec.manifest.id,
      version: rec.manifest.version || '0.0.0',
      description: rec.manifest.description || '',
      author: rec.manifest.author || '',
      homepage: rec.manifest.homepage || null,
      enabled: rec.enabled,
      loaded: rec.loaded,
      error: rec.error,
      settings: rec.manifest.settings || [],
      actions: (rec.manifest.actions || []).filter((a) => a?.id).map((a) => ({ id: a.id, label: a.label || a.id, available: this.actions.has(`${rec.manifest.id}/${a.id}`) })),
      config,
      provides: {
        sources: [...this.sources.values()].filter((s) => s.owner === owner).map((s) => s.name || s.id),
        subtitles: this.subtitleProviders().filter((p) => p.owner === owner).map((p) => p.name || p.id),
        homeRows: this.homeRows.filter((r) => r.owner === owner).map((r) => r.title),
        metadata: this.core.metadata.list().filter((p) => p.owner === owner).map((p) => p.name),
        routes: this.core.router.routes.filter((r) => r.owner === owner).map((r) => `${r.method} ${r.pattern}`),
      },
    };
  }

  list() {
    return [...this.plugins.values()].map((rec) => this.describe(rec));
  }

  listSources() {
    return [...this.sources.entries()].map(([key, s]) => ({
      key,
      pluginId: s.pluginId,
      id: s.id,
      name: s.name || s.id,
      description: s.description || '',
      icon: s.icon || null,
    }));
  }

  async runAction(pluginId, actionId, ctx) {
    const action = this.actions.get(`${pluginId}/${actionId}`);
    if (!action) throw new HttpError(404, 'That action is not available (is the plugin turned on?)');
    const result = await action.handler(ctx);
    return { message: 'Done.', ...(result || {}) };
  }

  subtitleProviders() {
    return [...this.subtitleSources.values()];
  }

  listSubtitleProviders() {
    return this.subtitleProviders().map((p) => ({ id: p.key, name: p.name || p.id }));
  }

  getSource(pluginId, sourceId) {
    const s = this.sources.get(`${pluginId}/${sourceId}`);
    if (!s) throw new HttpError(404, 'That add-on source is not available (is the plugin enabled?)');
    return s;
  }
}
