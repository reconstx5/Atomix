// v0.24 Plan A Task 4: the page names the scripts it will need, so the browser fetches them together.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir, startAtomix } from './helpers.js';
import { moduleGraph, pageHtml } from '../src/http/page.js';

let nf;
before(async () => {
  nf = await startAtomix({}, { skipLiveRefresh: true });
});
after(async () => {
  await nf?.app.stop();
});

const graphOf = (html) => JSON.parse(/<script id="module-graph" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);

test('the page names the core scripts to fetch early', async () => {
  const res = await fetch(`${nf.base}/`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /<link rel="modulepreload" href="\/js\/api\.js">/);
  assert.match(html, /<link rel="modulepreload" href="\/js\/dom\.js">/);
  assert.doesNotMatch(html, /modulepreload" href="\/js\/views\/player\.js"/, 'views load when opened');
  assert.ok(html.indexOf('modulepreload') < html.indexOf('</head>'));
  const etag = res.headers.get('etag');
  assert.ok(etag);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  const again = await fetch(`${nf.base}/`, { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
});

test("the module graph lists each view's own imports", async () => {
  const graph = graphOf(await (await fetch(`${nf.base}/`)).text());
  assert.ok(graph['/js/views/item.js'].includes('/js/components.js'));
  assert.ok(graph['/js/views/item.js'].includes('/js/dom.js'), 'with what those import in turn');
  assert.ok(!graph['/js/views/item.js'].includes('/js/views/item.js'));
});

test("an unknown address still gets the page (the app's own routes)", async () => {
  const res = await fetch(`${nf.base}/settings/plugins`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /rel="modulepreload"/);
});

test('a script that imports nothing statically has an empty list', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'js', 'views'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><head><title>x</title></head><body></body></html>');
  fs.writeFileSync(path.join(dir, 'js', 'app.js'), "import { a } from './a.js';\n// import { no } from './commented.js';\nconst v = () => import('./views/v.js');\n");
  fs.writeFileSync(path.join(dir, 'js', 'a.js'), "export { b } from './b.js';\nexport const a = 1;\n");
  fs.writeFileSync(path.join(dir, 'js', 'b.js'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(dir, 'js', 'views', 'v.js'), "import { a } from '../a.js';\n");
  const g = moduleGraph(dir);
  assert.deepEqual(g['/js/b.js'], []);
  assert.deepEqual(g['/js/app.js'], ['/js/a.js']);
  const { body } = pageHtml(dir);
  assert.match(body, /href="\/js\/a\.js"/);
  assert.match(body, /href="\/js\/b\.js"/, 'reached through a re-export');
  assert.doesNotMatch(body, /commented\.js/);
  assert.deepEqual(graphOf(body)['/js/views/v.js'].sort(), ['/js/a.js', '/js/b.js']);
});

// v0.26 review fixes: minified imports (the kept Preact files) count in the graph; a boot with no converted screen
// doesn't fetch Preact at all.
test('minified imports count in the module graph', () => {
  const graph = moduleGraph(path.resolve('public'));
  assert.ok(graph['/js/vendor/hooks.module.js'].includes('/js/vendor/preact.module.js'), JSON.stringify(graph['/js/vendor/hooks.module.js']));
  assert.ok(graph['/js/vendor/htm-preact.module.js'].includes('/js/vendor/htm.module.js'));
});
test("the boot preloads Preact's core, not the screens' own pieces", () => {
  // v0.26 Plan B: Live TV, the libraries and Search are Preact screens; a first visit to one shouldn't wait a round
  // trip for Preact. The screens' own pieces (ui/*.js) still come with their view's graph.
  const { body } = pageHtml(path.resolve('public'));
  for (const f of ['/js/ui.js', '/js/vendor/htm-preact.module.js', '/js/vendor/htm.module.js', '/js/vendor/preact.module.js', '/js/vendor/hooks.module.js']) assert.match(body, new RegExp(`modulepreload" href="${f.replace(/[.]/g, '\\.')}"`), f);
  assert.doesNotMatch(body, /modulepreload" href="\/js\/ui\//);
  assert.equal(body.match(/modulepreload" href="\/js\/vendor\/preact\.module\.js"/g).length, 1); // once
});
