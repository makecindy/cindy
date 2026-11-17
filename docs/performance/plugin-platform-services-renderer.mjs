import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const desktop = path.join(root, 'apps/desktop');
const require = createRequire(path.join(desktop, 'package.json'));
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const base = process.argv[2] ?? 'fa54e46fab46ce535d1a9f526291202c00e55e3f';
const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const changes = execFileSync('git', ['diff', '--name-status', base, candidate], { encoding: 'utf8' })
  .trim().split('\n').map(line => line.split('\t'));
const baseline = new Map();
const additions = new Set();
for (const [status, file] of changes) {
  if (!/\.(tsx?|jsx?|json|css|html)$/.test(file)) continue;
  const absolute = path.join(root, file);
  if (status === 'A') additions.add(absolute);
  else baseline.set(absolute, execFileSync('git', ['show', `${base}:${file}`], { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }));
}
const report = { base, candidate, node: process.version, platform: process.platform, results: {} };
for (const mode of ['base', 'head']) {
  let loadedBaseline = 0;
  const start = performance.now();
  const output = await build({
    configFile: path.join(desktop, 'vite.renderer.config.ts'),
    logLevel: 'warn',
    plugins: mode === 'base' ? [{ name: 'performance-baseline-source', enforce: 'pre',
      load(id) {
        const source = id.split('?')[0];
        if (additions.has(source)) throw new Error(`Baseline unexpectedly loads added module: ${path.relative(root, source)}`);
        if (!baseline.has(source)) return null;
        loadedBaseline++;
        return baseline.get(source);
      },
    }] : [],
    build: { outDir: `/tmp/plugin-platform-perf-renderer-${mode}`, write: false, reportCompressedSize: false },
  });
  const bundles = Array.isArray(output) ? output : [output];
  const all = bundles.flatMap(bundle => bundle.output);
  const chunks = all.filter(chunk => chunk.type === 'chunk');
  const byName = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
  const eager = new Set();
  function visit(name) {
    if (eager.has(name)) return;
    const chunk = byName.get(name);
    if (!chunk) return;
    eager.add(name);
    chunk.imports.forEach(visit);
  }
  chunks.filter(chunk => chunk.isEntry).forEach(chunk => visit(chunk.fileName));
  const stats = list => ({ chunks: list.length, raw: list.reduce((n, chunk) => n + Buffer.byteLength(chunk.code), 0),
    gzip: list.reduce((n, chunk) => n + gzipSync(chunk.code).byteLength, 0) });
  report.results[mode] = { elapsedMs: performance.now() - start, loadedBaseline,
    allJs: stats(chunks), initialJs: stats(chunks.filter(chunk => eager.has(chunk.fileName))),
    pluginUi: chunks.filter(chunk => Object.keys(chunk.modules).some(id => /GhostPluginDetailView|GhostAccountReuseSection/.test(id)))
      .map(chunk => ({ ...stats([chunk]), initial: eager.has(chunk.fileName), name: chunk.name })),
  };
  await fs.writeFile('/tmp/plugin-platform-perf-renderer-results.json', JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ mode, ...report.results[mode] }) + '\n');
}
