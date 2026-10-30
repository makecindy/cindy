/** Author examples are the tested source, not a second copy of the guide snippets. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const examples = path.resolve(scriptDir, '../resources/system-skills/cindy-plugin-creator/references/examples/interactive-pages');
export async function authorFixture(mode, temporary, transform = fixture => fixture) {
  const source = path.join(examples, mode === 'shell' ? 'shell' : mode === 'files' ? 'files' : mode === 'sdk' ? 'sdk' : 'minimal');
  const manifest = JSON.parse(await readFile(path.join(source, 'ghost.json'), 'utf8'));
  const main = await readFile(path.join(source, 'main.js'), 'utf8');
  let html;
  if (mode === 'sdk') {
    const result = await build({ entryPoints: [path.join(source, 'ui/app.js')], bundle: true, write: false, format: 'esm', minify: true });
    const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
    html = (await readFile(path.join(source, 'ui/page.template.html'), 'utf8')).replace('<!-- APP_SCRIPT -->', () => `<script type="module">${script}</script>`);
  } else html = await readFile(path.join(source, 'ui/page.html'), 'utf8');
  const assets = mode === 'files' ? Object.fromEntries(await Promise.all(['settings.html', 'settings.js'].map(async name => [name, await readFile(path.join(source, name), 'utf8')]))) : {};
  const fixture = transform({ manifest, main, html, assets });
  await packAuthorFixture(fixture, temporary);
  return fixture;
}
export async function packAuthorFixture({ manifest, main, html, assets = {} }, temporary) {
  const dir = path.join(temporary, manifest.id);
  await mkdir(path.join(dir, 'ui'), { recursive: true });
  await writeFile(path.join(dir, 'ghost.json'), JSON.stringify(manifest));
  await writeFile(path.join(dir, 'main.js'), main);
  for (const [name, content] of Object.entries(assets)) await writeFile(path.join(dir, name), content);
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
