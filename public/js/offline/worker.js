// Atomix's offline helper (v0.21). Served as /sw.js with range.js placed before it (a classic worker: not every
// browser runs module service workers). It keeps the app shell (the files /api/shell lists) so the installed app opens
// with no connection, and answers /offline/<profile>/<file> from the device's private storage, with byte ranges so a
// download can be seeked. API calls always go to the network. A new version (a new ?v= on this file's address) waits
// until every Atomix page is closed: the shell never changes under a page, nor in the middle of playing something.
/* global rangeResponse, openZipBlob */

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `atomix-shell-${VERSION}`;
const TYPES = { mp4: 'video/mp4', webm: 'video/webm', m4a: 'audio/mp4', mp3: 'audio/mpeg', opus: 'audio/ogg', ogg: 'audio/ogg', flac: 'audio/flac', vtt: 'text/vtt' };

self.addEventListener('install', (event) => {
  // API calls go straight to the network without waking this helper (where the browser can be told so): a closing
  // page's last requests (ending its stream, saving the place) are otherwise cut off as the page goes.
  try {
    event.addRoutes?.([{ condition: { urlPattern: new URLPattern({ pathname: '/api/*' }) }, source: 'network' }])?.catch?.(() => {});
  } catch {
    /* no static routes here: the fetch handler below passes API calls through */
  }
  event.waitUntil(
    (async () => {
      const shell = await (await fetch('/api/shell', { cache: 'no-store' })).json();
      const cache = await caches.open(CACHE);
      await cache.addAll(shell.files.map((f) => new Request(f, { cache: 'reload' })));
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith('atomix-shell-') && name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

async function offlineFile(request, url) {
  const [, , profile, name] = url.pathname.split('/'); // /offline/<profileId>/<file>
  if (!/^\d+$/.test(profile || '') || !/^[\w.-]+$/.test(name || '')) return new Response(null, { status: 404 });
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('atomix-downloads')).getDirectoryHandle(profile);
    const file = await (await dir.getFileHandle(decodeURIComponent(name))).getFile();
    return rangeResponse(file, request.headers.get('range'), TYPES[name.split('.').pop()] || file.type);
  } catch {
    return new Response(null, { status: 404 });
  }
}

// ---- Downloaded books and comics (v0.22): one entry at a time from the ZIP on the device ----
const ZIP_TYPES = { xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html', xml: 'application/xml', css: 'text/css', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };
const zips = new Map(); // "<profile>/<file>:<size>:<modified>" → an open archive (the last four)
/** The same policy Atomix sends with a book's files: its own files only, nothing runs, sandboxed. */
const bookPolicy = (own) => `default-src 'none'; img-src ${own} data:; style-src ${own} 'unsafe-inline'; font-src ${own}; media-src ${own}; script-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; sandbox allow-same-origin`;

async function offlineZip(request, url) {
  const missing = () => new Response(null, { status: 404 });
  // A typed address isn't the reader asking (its frame is a navigation too, from an iframe).
  if (request.mode === 'navigate' && request.destination !== 'iframe') return missing();
  const parts = url.pathname.split('/'); // /offline-zip/<profile>/<file>/<entry…>
  const [profile, name] = [parts[2], parts[3]];
  if (!/^\d+$/.test(profile || '') || !/^[\w-]+\.(epub|cbz)$/.test(name || '')) return missing();
  let entry;
  try {
    entry = parts.slice(4).map(decodeURIComponent).join('/');
  } catch {
    return missing();
  }
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('atomix-downloads')).getDirectoryHandle(profile);
    const file = await (await dir.getFileHandle(name)).getFile();
    const key = `${profile}/${name}:${file.size}:${file.lastModified}`;
    let zip = zips.get(key);
    if (!zip) {
      zip = await openZipBlob(file);
      zips.set(key, zip);
      while (zips.size > 4) zips.delete(zips.keys().next().value);
    }
    const bytes = await zip.read(entry);
    if (!bytes) return missing();
    const ext = entry.split('.').pop().toLowerCase();
    const own = `${self.location.origin}/offline-zip/${profile}/${name}/`;
    return new Response(bytes, { status: 200, headers: { 'Content-Type': ZIP_TYPES[ext] || 'application/octet-stream', 'Content-Security-Policy': bookPolicy(own), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });
  } catch {
    return missing();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET') return;
  if (url.pathname.startsWith('/offline-zip/')) return event.respondWith(offlineZip(request, url));
  if (url.pathname.startsWith('/offline/')) {
    // A typed or linked address isn't the player asking: a download's file is only for the app's own player (v0.22).
    if (request.mode === 'navigate') return event.respondWith(new Response(null, { status: 404 }));
    return event.respondWith(offlineFile(request, url));
  }
  if (url.pathname.startsWith('/api/')) return; // always the network
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // Pages: the kept shell (the same one its scripts come from); the network only for what isn't kept.
      const key = request.mode === 'navigate' ? '/index.html' : request;
      const hit = await cache.match(key);
      if (hit) return hit;
      try {
        return await fetch(request);
      } catch (err) {
        if (request.mode === 'navigate') return (await cache.match('/')) || Response.error();
        throw err;
      }
    })(),
  );
});
