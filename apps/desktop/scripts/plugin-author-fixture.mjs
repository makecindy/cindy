/** Author examples are the tested source, not a second copy of the guide snippets. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const examples = path.resolve(scriptDir, '../resources/system-skills/cindy-plugin-creator/references/examples/interactive-pages');
export async function authorFixture(mode, temporary, transform = fixture => fixture) {
  assert.ok(['static', 'loader', 'files'].includes(mode), 'Unknown author example');
  const source = path.join(examples, mode);
  const manifest = JSON.parse(await readFile(path.join(source, 'ghost.json'), 'utf8'));
  const main = await readFile(path.join(source, 'main.js'), 'utf8');
  const html = await readFile(path.join(source, 'ui/page.html'), 'utf8');
  const assets = mode === 'files' ? Object.fromEntries(await Promise.all(['settings.html', 'settings.js'].map(async name => [name, await readFile(path.join(source, name), 'utf8')]))) : {};
  // Manual units ship with the package; each is a single MANUAL.md in these examples.
  for (const item of manifest.manual?.items ?? []) {
    const relative = path.posix.join(item.dir, 'MANUAL.md');
    assets[relative] = await readFile(path.join(source, relative), 'utf8');
  }
  // Single source: the loader page manual must stay byte-identical to PAGE-GENERATION.md.
  if (mode === 'loader') {
    assert.equal(assets['manual/pages/MANUAL.md'], await readFile(path.join(examples, 'PAGE-GENERATION.md'), 'utf8'),
      'loader/manual/pages/MANUAL.md must match PAGE-GENERATION.md');
  }
  const fixture = transform({ manifest, main, html, assets });
  if (mode === 'loader') await verifyLoaderMain(fixture.main);
  await packAuthorFixture(fixture, temporary);
  return fixture;
}
// Integration: execute the shipped tool handler. The old shell only returned HTML;
// it did not cover fixed network routing, write retries or immediate file handoff.
// Minimal inputs: forbidden path, HTTP 500 with ok:true, duplicate write key.
async function verifyLoaderMain(main) {
  function runtime(source, overrides = {}) {
    let handler, reply;
    runInNewContext(source, { cindy: {
      onHostMessage: fn => { handler = fn; }, send: value => { reply = value.result; },
      ...overrides,
    } });
    return async (tool, args = {}) => { await handler({ type: 'tool-call', tool, args, callId: 'fixture' }); return reply; };
  }
  const libraryWrites = [];
  const call = runtime(main, {
    library: async request => { libraryWrites.push(request); return { ok: true, op: request.op, path: request.path }; },
    pick: async () => ({ ok: true, files: [{ name: 'list.csv', ref: 'library:imports/list.csv', size: 12 }] }),
  });
  assert.ok((await call('open_view', { intent: 'items' }))._meta.view.html.includes('type="module"'));
  const fragment = await call('load_view', { intent: 'form', fields: { title: '<img onerror=bad>' } });
  assert.ok(fragment._meta.view.html.includes('&lt;img onerror=bad&gt;'));
  assert.ok(!fragment._meta.view.html.includes('<script'));
  // Regression: a natural-language first intent must open a usable default page.
  for (const tool of ['open_view', 'load_view']) {
    const fallback = await call(tool, { intent: '请打开一个可以查看和编辑记录的页面' });
    assert.notEqual(fallback.isError, true);
    assert.ok(fallback._meta.view.html.includes('<h1>Overview</h1>'));
    assert.ok(fallback._meta.view.html.includes('已按总览打开'));
  }
  for (const [intent, title] of [['items', 'Items'], ['form', 'Form'], ['chart', 'Chart'], ['overview', 'Overview']]) {
    const view = await call('load_view', { intent });
    assert.ok(view._meta.view.html.includes('<h1>' + title + '</h1>'));
    assert.ok(!view._meta.view.html.includes('已按总览打开'));
  }
  const request = { path: '/api/records', body: { title: 'record' }, idempotencyKey: 'one' };
  assert.equal((await call('api_write', request)).structuredContent.id, 'R-1');
  assert.equal((await call('api_write', request)).structuredContent.id, 'R-1');
  assert.equal((await call('api_read', { path: '/api/items' })).structuredContent.items.length, 3);
  const imported = await call('import_file');
  assert.ok(imported._meta.view.html.includes('confirm-import'));
  assert.equal((await call('api_write', { path: '/api/imports/confirm', body: { batchId: 'demo-batch' }, idempotencyKey: 'two' })).structuredContent.status, 'confirmed');
  // Regression for gaps found by the page-manual e2e run (offline mode): the preview must say it
  // is sample data and show totals, error rows and cancel; /api/records must answer; fetch_file
  // must yield a library resource_link. Minimal inputs: one import, one saved record, one export.
  const previewHtml = imported._meta.view.html;
  assert.ok(previewHtml.includes('离线示例：未读取真实文件'));
  assert.ok(previewHtml.includes('共 3 行，出错 1 行') && previewHtml.includes('第 4 行：缺少标题'));
  assert.ok(previewHtml.includes('<button data-view="overview">取消</button>'));
  assert.equal(JSON.stringify((await call('api_read', { path: '/api/records' })).structuredContent.items), '[{"id":"R-1","title":"record"}]');
  const exported = await call('fetch_file', { path: '/api/files/records', name: 'records.csv' });
  assert.notEqual(exported.isError, true);
  assert.equal(exported.content.find(item => item.type === 'resource_link').uri, 'library:downloads/records.csv');
  assert.equal(libraryWrites.at(-1).path, 'downloads/records.csv');
  // Regression (review): names the Library path rules reject must fail here, not after the write.
  const writesBefore = libraryWrites.length;
  for (const name of ['a'.repeat(65), 'records.', 'con.csv']) {
    assert.equal((await call('fetch_file', { path: '/api/files/records', name })).isError, true, name);
  }
  assert.equal(libraryWrites.length, writesBefore);
  // Offline upload_files must return the same labelled sample batch the manual tells pages to confirm.
  const picked = await call('pick_files', { accept: ['.csv'] });
  const staged = await call('upload_files', { files: picked.structuredContent.files.map(file => file.ref), path: '/api/imports/stage' });
  assert.equal(staged.structuredContent.batchId, 'demo-batch');
  assert.equal(staged.structuredContent.offline, true);
  assert.equal((await call('api_write', { path: '/api/imports/confirm', body: { batchId: staged.structuredContent.batchId }, idempotencyKey: 'three' })).structuredContent.status, 'confirmed');
  assert.ok(libraryWrites.at(-1).content.includes('"R-1","record"'));
  const network = []; let response = { ok: true, status: 200, body: '{"items":[]}' };
  const live = runtime(main.replace('const USE_MOCK = true;', 'const USE_MOCK = false;'), {
    fetch: async request => { network.push(request); return response; },
  });
  for (const path of ['https://other.example/api/items', '//other.example/api/items', '/api/items/../records', '/api/items/%2e%2e', '/api/items?url=https://other.example']) {
    assert.equal((await live('api_read', { path })).isError, true);
  }
  assert.equal((await live('unknown')).isError, true);
  assert.equal(network.length, 0);
  await live('api_read', { path: '/api/items', query: { keyword: '../https://other.example/' } });
  assert.equal(new URL(network.at(-1).url).origin, 'https://api.example.com');
  assert.equal(new URL(network.at(-1).url).pathname, '/api/items');
  assert.equal(new URL(network.at(-1).url).searchParams.get('keyword'), '../https://other.example/');
  response = { ok: true, status: 500, body: 'private backend diagnostics' };
  const before = network.length;
  const failed = await live('api_write', request);
  assert.equal(failed.isError, true);
  assert.ok(!JSON.stringify(failed).includes('private backend'));
  assert.equal(network.length - before, 1, 'write must not retry automatically');
  response = { ok: true, status: 201, body: '{"batchId":"B-1","rows":[{"value":"<b>data</b>"}]}' };
  const preview = await live('import_file', { dir_deposit: { token: 'test-handoff' } });
  assert.equal(network.at(-1).uploadDir.fileField, 'file');
  assert.equal(network.at(-1).callId, 'fixture');
  assert.ok(preview._meta.view.html.includes('&lt;b&gt;data&lt;/b&gt;'));
  assert.ok(!preview._meta.view.html.includes('离线示例'), 'a real staged batch is not labelled as sample data');
  assert.ok(!JSON.stringify(preview).includes('test-handoff'));
  console.log('AUTHOR_MAIN_VERDICT=passed (loader routing, private HTML, HTTP errors, no retry, deduplication, handoff, offline preview/records/export)');
}
export async function packAuthorFixture({ manifest, main, html, assets = {} }, temporary) {
  const dir = path.join(temporary, manifest.id);
  await mkdir(path.join(dir, 'ui'), { recursive: true });
  await writeFile(path.join(dir, 'ghost.json'), JSON.stringify(manifest));
  await writeFile(path.join(dir, 'main.js'), main);
  for (const [name, content] of Object.entries(assets)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  const htmlPath = path.join(dir, manifest.mcpApps.ui.resources[0].file);
  await mkdir(path.dirname(htmlPath), { recursive: true });
  await writeFile(htmlPath, html);
  // Integration tier: real Forge packing validates safe paths, version, resource file and archive.
  const packer = path.join(temporary, 'author-packer.cjs');
  await build({ stdin: { contents: "export { packGhostDir, FORGE_GUIDE } from '../src/main/cindy-brain/forge.ts'; export { extractForgeGuideSection } from '../../../packages/cindy-tools/src/ghost/forgeGuideSections.ts';", resolveDir: scriptDir },
    bundle: true, platform: 'node', format: 'cjs', outfile: packer, external: ['electron'],
    plugins: [{ name: 'author-guide-raw', setup(builder) {
      builder.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' }));
      builder.onLoad({ filter: /.*/, namespace: 'raw' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }));
    } }],
  });
  const { packGhostDir, FORGE_GUIDE, extractForgeGuideSection } = createRequire(import.meta.url)(packer);
  for (const query of ['4.23', 'ui', 'mcp app', '交互页面']) {
    const section = extractForgeGuideSection(FORGE_GUIDE, query);
    assert.equal(section.ok, true, JSON.stringify(section));
    assert.ok(section.text.startsWith('## 4.23 '));
  }
  const packed = await packGhostDir(dir, { sessionWorkdir: temporary });
  assert.equal(packed.ok, true, JSON.stringify(packed.ok ? {} : packed));
  console.log(`AUTHOR_PACK_VERDICT=passed (${manifest.id}; real packGhostDir)`);
  return packed;
}
