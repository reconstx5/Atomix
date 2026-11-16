// Before/after gallery for the visual refresh.
//   node devtools/gallery.mjs <before-dir> <after-dir> <out-dir>
// Reads the PNGs devtools/fixed-compare.mjs captured (<theme>-<size>-<page>.png), writes <out>/img/*.jpg (Pillow, quality 72,
// desk and TV scaled to 1280 px wide, phone 390), <out>/index.html (self-contained, a slider per picture) and
// <out>/visual-evidence.json (the receipt). Exits 1 when an after picture is missing. PYTHON overrides the python command.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { SIZES, PAGE_ORDER, pageLabel, pairNames } from './gallery-rules.mjs';

const [beforeDir, afterDir, outDir] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!beforeDir || !afterDir || !outDir) {
  console.log('Usage: node devtools/gallery.mjs <before-dir> <after-dir> <out-dir>');
  process.exit(2);
}
const root = path.resolve(import.meta.dirname, '..');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pngs = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')) : []);

const THEME_ORDER = ['midnight', 'orbit', 'obsidian', 'daylight', 'arctic', 'arctic-side', 'harbour'];
const THEMES = {
  midnight: { name: 'Midnight', note: 'The low-power reference: surfaces a little lighter, an opaque menu, no blur anywhere, and a faint top edge on panels and dialogs so they read without shadows.' },
  orbit: { name: 'Orbit', note: 'Text is a 94% off-white instead of pure white, posters are 256 px so the seventh peeks in a row, the player top bar gets a chrome shadow, and the environment behind the page is a dark wash of the artwork colour.' },
  obsidian: { name: 'Obsidian', note: 'True black on OLED with 1 px edges instead of glows. The focus ring is the accent (4 px, 5 px on TV), and text is an off-white that does not bloom on black.' },
  daylight: { name: 'Daylight', note: 'On a TV the light canvas is dimmed so it is not glaring, the focus halo is wider so the ring still shows, and the amber rating is darker to stay readable.' },
  arctic: { name: 'Arctic', note: 'Rebuilt: rounded pill buttons, a regular-width body font under League Gothic titles, flat opaque panels, a logo in place of the typed title, and the page backdrop follows the focused card.' },
  'arctic-side': { name: 'Arctic Side', note: 'Arctic with the menu down the left and white pill highlights. It has the same flat panels, pill buttons and focus-following backdrop.' },
  harbour: { name: 'Harbour', note: 'The hover grows by the shared focus-grow token (1.06) instead of its own number, and the TV row still shows eight posters.' },
};

const { pairs, missing } = pairNames(pngs(beforeDir), pngs(afterDir));
const missingAfter = new Set(missing);
fs.mkdirSync(path.join(outDir, 'img'), { recursive: true });

// One Python call for the whole batch: [[src, dst, targetWidth], ...] on stdin, {dst: [w, h]} on stdout.
const jobs = [];
for (const p of pairs) {
  const target = p.size === 'phone' ? 390 : 1280;
  jobs.push([path.join(beforeDir, `${p.name}.png`), path.join(outDir, 'img', `${p.name}-before.jpg`), target]);
  if (!missingAfter.has(p.name)) jobs.push([path.join(afterDir, `${p.name}.png`), path.join(outDir, 'img', `${p.name}-after.jpg`), target]);
}
const script = [
  'import sys, json',
  'from PIL import Image',
  'out = {}',
  'for src, dst, tw in json.load(sys.stdin):',
  "    im = Image.open(src).convert('RGB')",
  '    if im.width > tw:',
  '        im = im.resize((tw, round(im.height * tw / im.width)), Image.LANCZOS)',
  "    im.save(dst, 'JPEG', quality=72, optimize=True)",
  '    out[dst] = [im.width, im.height]',
  'print(json.dumps(out))',
].join('\n');
const dims = JSON.parse(execFileSync(process.env.PYTHON || 'python', ['-c', script], { input: JSON.stringify(jobs), encoding: 'utf8', maxBuffer: 1 << 24 }));

const order = (a, b) => THEME_ORDER.indexOf(a.theme) - THEME_ORDER.indexOf(b.theme) || Object.keys(SIZES).indexOf(a.size) - Object.keys(SIZES).indexOf(b.size) || PAGE_ORDER.indexOf(a.page) - PAGE_ORDER.indexOf(b.page);
pairs.sort(order);
const themes = THEME_ORDER.filter((t) => pairs.some((p) => p.theme === t));
const sizes = Object.keys(SIZES).filter((s) => pairs.some((p) => p.size === s));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let n = 0;
const figures = pairs.map((p) => {
  const bd = dims[path.join(outDir, 'img', `${p.name}-before.jpg`)];
  const hasAfter = !missingAfter.has(p.name);
  const id = `s${n++}`;
  const label = `${THEMES[p.theme]?.name || p.theme}, ${SIZES[p.size].label}, ${pageLabel(p.page)}`;
  const after = hasAfter
    ? `<img class="after" src="img/${p.name}-after.jpg" alt="After: ${esc(label)}" width="${bd[0]}" height="${bd[1]}" loading="lazy" decoding="async">
<span class="tag tb">Before</span><span class="tag ta">After</span>
<div class="handle" aria-hidden="true"></div>`
    : '<span class="tag tb">Before only</span>';
  const slider = hasAfter
    ? `<label class="rng" for="${id}"><span>Before</span><input id="${id}" type="range" min="0" max="100" value="50" aria-label="Before and after: ${esc(label)}"><span>After</span></label>`
    : '';
  return `<figure class="shot" data-theme="${p.theme}" data-size="${p.size}" hidden>
<figcaption>${esc(pageLabel(p.page))}</figcaption>
<div class="cmp" style="--ar:${bd[0]} / ${bd[1]};--pos:50%">
<img src="img/${p.name}-before.jpg" alt="Before: ${esc(label)}" width="${bd[0]}" height="${bd[1]}" loading="lazy" decoding="async">
${after}
</div>
${slider}
</figure>`;
}).join('\n');

const notes = JSON.stringify(Object.fromEntries(themes.map((t) => [t, THEMES[t]?.note || '']))).replace(/</g, '\\u003c');
const chips = (list, label) => list.map((v) => `<button class="chip" type="button" data-v="${v}" aria-pressed="false">${label(v)}</button>`).join('');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atomix Visual Refresh</title>
<style>
:root{--bg:#f6f6f8;--surface:#fff;--text:#16171c;--text-dim:#4d5060;--line:#d5d7df;--accent:#2457e6;--on-accent:#fff;--focus:#16171c}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#101219;--surface:#1b1f2c;--text:#ecedf2;--text-dim:#a9adbd;--line:#333a4d;--accent:#ff8a63;--on-accent:#101219;--focus:#fff}}
:root[data-theme="dark"]{--bg:#101219;--surface:#1b1f2c;--text:#ecedf2;--text-dim:#a9adbd;--line:#333a4d;--accent:#ff8a63;--on-accent:#101219;--focus:#fff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1320px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.6rem;margin:0 0 4px}
.lead{color:var(--text-dim);margin:0 0 20px}
.bar{display:flex;flex-wrap:wrap;gap:8px 24px;margin-bottom:16px}
.group{display:flex;flex-wrap:wrap;gap:8px}
button.chip{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:6px 14px;cursor:pointer}
button.chip[aria-pressed="true"]{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
button:focus-visible,input:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.note{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:0 0 24px}
.grid{display:grid;gap:24px;grid-template-columns:1fr}
@media (min-width:900px){.grid.phone{grid-template-columns:repeat(auto-fill,minmax(390px,1fr))}}
.shot{margin:0;min-width:0}
.shot[hidden]{display:none}
figcaption{font-weight:600;margin-bottom:6px}
.cmp{position:relative;aspect-ratio:var(--ar);background:var(--surface);border:1px solid var(--line);border-radius:8px;overflow:hidden;max-width:100%}
.phone .cmp{max-width:390px}
.cmp img{position:absolute;inset:0;width:100%;height:100%;display:block}
.cmp .after{clip-path:inset(0 0 0 var(--pos))}
.handle{position:absolute;top:0;bottom:0;left:var(--pos);width:2px;margin-left:-1px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.6);pointer-events:none}
.tag{position:absolute;top:8px;padding:2px 8px;border-radius:6px;font-size:.8rem;background:rgba(0,0,0,.72);color:#fff;pointer-events:none}
.tb{left:8px}.ta{right:8px}
.rng{display:flex;align-items:center;gap:10px;margin-top:6px;color:var(--text-dim);font-size:.9rem}
.rng input{flex:1;min-width:0;accent-color:var(--accent);height:28px}
</style>
</head>
<body>
<main>
<h1>Atomix Visual Refresh</h1>
<p class="lead">Plan C, each theme on its own terms. Drag a slider (or use the arrow keys) to wipe from the picture before to the picture after.</p>
<div class="bar">
<div class="group" role="group" aria-label="Theme" id="themes">${chips(themes, (t) => esc(THEMES[t]?.name || t))}</div>
<div class="group" role="group" aria-label="Screen size" id="sizes">${chips(sizes, (s) => `${esc(SIZES[s].label)} ${SIZES[s].w}&times;${SIZES[s].h}`)}</div>
</div>
<p class="note" id="note"></p>
<div class="grid" id="grid">
${figures}
</div>
</main>
<script>
(function () {
  var NOTES = ${notes};
  var theme = '${themes[0]}', size = '${sizes[0]}';
  try { theme = localStorage.getItem('gallery-theme') || theme; size = localStorage.getItem('gallery-size') || size; } catch (e) {}
  if (!document.querySelector('#themes [data-v="' + theme + '"]')) theme = '${themes[0]}';
  if (!document.querySelector('#sizes [data-v="' + size + '"]')) size = '${sizes[0]}';
  var grid = document.getElementById('grid'), shots = [].slice.call(document.querySelectorAll('.shot'));
  function show() {
    shots.forEach(function (s) { s.hidden = !(s.dataset.theme === theme && s.dataset.size === size); });
    [].forEach.call(document.querySelectorAll('#themes .chip'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === theme)); });
    [].forEach.call(document.querySelectorAll('#sizes .chip'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === size)); });
    document.getElementById('note').textContent = NOTES[theme] || '';
    grid.className = 'grid' + (size === 'phone' ? ' phone' : '');
  }
  function pick(kind, v) { if (kind === 'theme') theme = v; else size = v; try { localStorage.setItem('gallery-' + kind, v); } catch (e) {} show(); }
  document.getElementById('themes').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) pick('theme', b.dataset.v); });
  document.getElementById('sizes').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) pick('size', b.dataset.v); });
  grid.addEventListener('input', function (e) { if (e.target.type === 'range') e.target.closest('.shot').querySelector('.cmp').style.setProperty('--pos', e.target.value + '%'); });
  show();
})();
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(outDir, 'index.html'), html);

// The receipt.
const changed = execFileSync('git', ['diff', '--name-only', 'main...HEAD', '--', 'themes', 'public', 'src'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter((f) => /\.(css|js|mjs)$/.test(f) && fs.existsSync(path.join(root, f)));
const imgRef = (name, kind) => {
  const f = path.join(outDir, 'img', `${name}-${kind}.jpg`);
  return fs.existsSync(f) ? { path: `img/${name}-${kind}.jpg`, sha256: sha(f) } : null;
};
const receipt = {
  schemaVersion: 'uizze.visual-evidence.v1',
  platform: 'web',
  comparison: 'existing-system',
  generatedAt: new Date().toISOString(),
  subject: 'Atomix visual refresh, Plan C (branch visual-refresh-c against main)',
  sources: changed.map((f) => ({ path: f, sha256: sha(path.join(root, f)) })),
  checks: pairs.map((p) => ({
    id: p.name,
    theme: p.theme,
    page: pageLabel(p.page),
    route: `#/${p.page.slice(1).replace(/_/g, '/')}`,
    viewport: { width: SIZES[p.size].w, height: SIZES[p.size].h, size: p.size },
    browser: 'Chromium (Edge channel)',
    state: { artwork: 'stubbed (ART=1)', fixtures: 'frozen', clock: 'frozen', reducedMotion: 'reduce' },
    before: imgRef(p.name, 'before'),
    after: imgRef(p.name, 'after'),
  })),
  unresolved: [
    'TV timings for motion and focus on real hardware (a TV browser, a remote in hand).',
    'Safari and iPhone: view transitions, backdrop-filter, oklch fallbacks, the focus ring on touch.',
    'Old TV browsers without color-mix() or oklch(): checked by test/old-browsers.test.js only, not on a device.',
    'Playback and DRM (PlayReady, FairPlay, Widevine on Chromecast) are untouched by this work and not re-verified.',
  ],
};
fs.writeFileSync(path.join(outDir, 'visual-evidence.json'), JSON.stringify(receipt, null, 2) + '\n');

const jpegs = fs.readdirSync(path.join(outDir, 'img')).filter((f) => f.endsWith('.jpg')).length;
console.log(`gallery: ${pairs.length} pictures, ${jpegs} JPEGs, ${receipt.checks.length} checks, ${receipt.sources.length} sources -> ${outDir}`);
if (missing.length) {
  console.log(`WARNING: ${missing.length} after picture(s) missing: ${missing.join(', ')}`);
  process.exit(1);
}
