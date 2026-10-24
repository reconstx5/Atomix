// The app shell (v0.21): the files the installed app needs to start with no connection, for the offline helper
// (public/sw.js) to keep. The version changes whenever one of them does, so a new Atomix brings a new shell.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { THEME_FILE } from '../http/static.js';

const KEEP = /\.(js|css|html|webmanifest|svg|png|woff2?|ttf|json)$/i;
const WORKER_PARTS = ['js/offline/range.js', 'js/reader/zip.js', 'js/offline/worker.js']; // v0.22: the ZIP reader for downloaded books and comics

export function registerShellRoutes(r, core) {
  const { config } = core;
  function list() {
    const files = ['/'];
    const stamp = crypto.createHash('sha1').update(String(core.version));
    const walk = (dir, prefix) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const p = path.join(dir, e.name);
        const url = `${prefix}/${e.name}`;
        if (e.isDirectory()) walk(p, url);
        else if ((prefix.startsWith('/themes') ? THEME_FILE : KEEP).test(e.name) && url !== '/js/offline/worker.js') {
          files.push(url);
          const st = fs.statSync(p);
          stamp.update(`${url}:${st.size}:${st.mtimeMs}`);
        }
      }
    };
    walk(config.publicDir, '');
    walk(config.themesDir, '/themes');
    return { version: stamp.digest('hex').slice(0, 12), files };
  }
  // The offline helper itself: one classic script made of range.js (its `export` dropped) and worker.js.
  r.get('/sw.js', (ctx) => {
    const body = WORKER_PARTS.map((f) => fs.readFileSync(path.join(config.publicDir, f), 'utf8').replace(/^export /gm, '')).join('\n');
    ctx.res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
    ctx.res.end(body);
  }, { auth: 'none', profile: false });

  r.get('/api/shell', (ctx) => {
    ctx.res.setHeader('Cache-Control', 'no-store');
    return list();
  }, { auth: 'none', profile: false });
}
