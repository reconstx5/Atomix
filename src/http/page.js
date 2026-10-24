// The app's page (v0.24): index.html with the scripts it will need named up front (<link rel="modulepreload">), so
// the browser fetches the core modules together instead of discovering them import by import — fewer round trips
// on a server far away. Each view's own modules travel as a small JSON graph the client preloads when it opens one.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// v0.26: minified forms too (import{a as b}from"./x.js", the kept Preact files), not only the spaced ones.
const STATIC = /(?:^|[;\s}])(?:import|export)\s*(?:[^'"`;]*?(?:\s|\})from\s*)?['"](\.{1,2}\/[^'"]+\.js)['"]/g;

function jsFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Each script under public/js (as "/js/…") and the scripts it imports statically (dynamic import() isn't followed). */
export function moduleGraph(publicDir) {
  const root = path.join(publicDir, 'js');
  const graph = {};
  if (!fs.existsSync(root)) return graph;
  for (const file of jsFiles(root)) {
    const key = '/' + path.relative(publicDir, file).split(path.sep).join('/');
    const deps = new Set();
    for (const m of stripComments(fs.readFileSync(file, 'utf8')).matchAll(STATIC)) {
      deps.add('/' + path.relative(publicDir, path.resolve(path.dirname(file), m[1])).split(path.sep).join('/'));
    }
    graph[key] = [...deps];
  }
  return graph;
}

/** Everything `start` reaches through static imports, without `start` itself. */
function reach(graph, start) {
  const seen = new Set();
  const walk = (k) => {
    for (const d of graph[k] || []) {
      if (seen.has(d) || d === start) continue;
      seen.add(d);
      walk(d);
    }
  };
  walk(start);
  return [...seen];
}

/** index.html with the core scripts preloaded and the views' module graph inlined. */
export function pageHtml(publicDir) {
  const graph = moduleGraph(publicDir);
  const core = reach(graph, '/js/app.js');
  // v0.26: Preact's core (ui.js and the kept libraries) is fetched with the boot, though only run when a Preact
  // screen opens: Live TV, the libraries and Search then don't wait a round trip for it.
  const preact = graph['/js/ui.js'] ? ['/js/ui.js', ...reach(graph, '/js/ui.js')].filter((m) => !core.includes(m)) : [];
  const links = [...core, ...preact].map((m) => `  <link rel="modulepreload" href="${m}">`).join('\n');
  const views = {};
  for (const k of Object.keys(graph)) if (/^\/js\/views\/[^/]+\.js$/.test(k)) views[k] = reach(graph, k);
  const json = JSON.stringify(views).replace(/</g, '\\u003c');
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const extra = `${links}\n  <script id="module-graph" type="application/json">${json}</script>\n`;
  const body = html.includes('</head>') ? html.replace('</head>', `${extra}</head>`) : extra + html;
  return { body, etag: `W/"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 20)}"` };
}

/** Serves the page, rebuilt when index.html or a script changes (checked at most every 2 s). */
export function pageServer(publicDir) {
  let page = null;
  let stamp = -1;
  let checked = 0;
  const latest = () => {
    let t = 0;
    try {
      t = fs.statSync(path.join(publicDir, 'index.html')).mtimeMs;
      for (const f of jsFiles(path.join(publicDir, 'js'))) t = Math.max(t, fs.statSync(f).mtimeMs);
    } catch {
      /* a file went mid-walk: rebuilt next time */
    }
    return t;
  };
  return function send(req, res) {
    const now = Date.now();
    if (!page || now - checked > 2000) {
      checked = now;
      const t = latest();
      if (!page || t !== stamp) {
        page = pageHtml(publicDir);
        stamp = t;
      }
    }
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: page.etag };
    if (req.headers['if-none-match'] === page.etag) {
      res.writeHead(304, headers).end();
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': Buffer.byteLength(page.body) });
    res.end(req.method === 'HEAD' ? undefined : page.body);
  };
}
