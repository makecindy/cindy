/** Synthetic filesystem benchmark, separate from unit tests.
 * Run from the repository root: node apps/desktop/scripts/benchmark-main-stalls.mjs [baseline-ref]
 * Bundles the actual baseline/current production modules without changing the
 * checkout. Host-only services are stubbed; fixture data never uses a real home.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(desktop, '../..');
const require = createRequire(path.join(desktop, 'package.json'));
const { build } = require('esbuild');
const baseline = process.argv[2] ?? 'HEAD';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-main-stalls-'));
const oldHome = os.homedir;
const oldEnv = { CODEX_HOME: process.env.CODEX_HOME, APPDATA: process.env.APPDATA };
const files = ['src/main/maker-host/codex-local-sessions.ts', 'src/main/pathResolver.ts',
  'src/main/cindy-brain/GhostManager.ts', 'src/main/cindy-brain/subscriptionGateway.ts',
  'src/main/maker-host/built-in-skills.ts'];
const hostStubs = {
  electron: 'export const app = { getPath: () => globalThis.__stallsUserData }; export const utilityProcess = undefined;',
  '@cindy/maker-core': 'export class CodexResumePreparationBlockedError extends Error {} export function isOversizedLiveTailStats() { throw Error("unused"); } export function measureRolloutLiveTailStats() { throw Error("unused"); }',
  logger: 'export const createLogger = () => ({debug(){},info(){},warn(){},error(){}}); export const maskPath = x => x; export const getLogLevel = () => "error";',
  db: 'export function getDbClient() { throw Error("benchmark must not access the app database"); }',
  sqlite: 'export function createBetterSqliteDatabase() { throw Error("fixture has no state database"); }',
};

async function bundle(label) {
  const outfile = path.join(root, `${label}.cjs`);
  await build({
    stdin: { contents: files.map(file => `export * from './${file}';`).join('\n'), resolveDir: desktop, loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{ name: 'fixture-host', setup(b) {
      b.onResolve({ filter: /^(electron|@cindy\/maker-core)$/ }, a => ({ path: a.path, namespace: 'fixture' }));
      b.onResolve({ filter: /(^|\/)logger(\.js)?$/ }, () => ({ path: 'logger', namespace: 'fixture' }));
      b.onResolve({ filter: /localDb\/client\/current\.js$/ }, () => ({ path: 'db', namespace: 'fixture' }));
      b.onResolve({ filter: /betterSqliteFactory\.js$/ }, () => ({ path: 'sqlite', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: hostStubs[a.path], loader: 'js' }));
      if (label === 'before') b.onLoad({ filter: /(?:codex-local-sessions|pathResolver|subscriptionGateway|GhostManager|built-in-skills)\.ts$/ }, a => ({
        contents: execFileSync('git', ['show', `${baseline}:${path.relative(repo, a.path).split(path.sep).join('/')}`], { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }),
        resolveDir: path.dirname(a.path), loader: 'ts',
      }));
    } }],
  });
  return require(outfile);
}

async function measure(fn) {
  let maxGapMs = 0;
  let last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - last); last = now; }, 1);
  await new Promise(r => setTimeout(r, 5));
  maxGapMs = 0;
  last = performance.now();
  const start = last;
  let result;
  try { result = await fn(); }
  finally { maxGapMs = Math.max(maxGapMs, performance.now() - last); clearInterval(timer); }
  return { durationMs: performance.now() - start, maxGapMs, result };
}

try {
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  os.homedir = () => home;
  process.env.CODEX_HOME = path.join(home, '.codex');
  process.env.APPDATA = path.join(home, 'appdata');
  globalThis.__stallsUserData = path.join(root, 'user-data');
  const history = path.join(globalThis.__stallsUserData, 'codex-home');
  const targetId = '019dcd5a-6e54-7960-95e0-aa68117a28d1';
  let target;
  for (let day = 0; day < 60; day++) {
    const directory = path.join(history, 'sessions', '2026', '10', String(day));
    fs.mkdirSync(directory, { recursive: true });
    for (let n = 0; n < 100; n++) {
      const id = day === 59 && n === 99 ? targetId : `019dcd5a-6e54-7960-95e0-${String(day * 100 + n).padStart(12, '0')}`;
      const file = path.join(directory, `rollout-2026-10-01-${id}.jsonl`);
      fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, source: 'cli' } }) + '\n');
      if (id === targetId) target = file;
    }
  }
  const workspace = path.join(root, 'workspace');
  for (let dir = 0; dir < 100; dir++) {
    const directory = path.join(workspace, `package-${dir}`, 'src');
    fs.mkdirSync(directory, { recursive: true });
    for (let n = 0; n < 100; n++) fs.writeFileSync(path.join(directory, `file-${n}.ts`), '');
  }
  const hrefs = Array.from({ length: 300 }, (_, n) => `src/file-${n}.ts`);
  const modules = { before: await bundle('before'), after: await bundle('after') };
  const managers = Object.fromEntries(Object.entries(modules).map(([label, m]) => [label,
    new m.GhostManager({ getRootDir: () => path.join(root, 'plugins'), sourcesForInstance: () => ({}) })]));
  const manager = managers.after;
  const JSZip = require('jszip');
  for (let n = 0; n < 30; n++) {
    const zip = new JSZip();
    zip.file('ghost.json', JSON.stringify({ schemaVersion: 3, minCindyVersion: '0.1.0', id: `fixture-${n}`, name: `Fixture ${n}`,
      version: '1.0.0', entry: 'main.js', ...(n === 0 ? { subscribe: { topics: ['turn'] } } : {}) }));
    zip.file('main.js', '// synthetic benchmark fixture');
    const file = path.join(root, `fixture-${n}.cindy`);
    fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const installed = await manager.install(file, { namespace: null });
    assert.ok('ghost' in installed, JSON.stringify(installed));
  }
  assert.equal(manager.list().length, 30);
  const bundledRoot = path.join(root, 'bundled-skills');
  fs.cpSync(path.join(desktop, 'resources/system-skills'), bundledRoot, { recursive: true });
  const references = path.join(bundledRoot, 'cindy-skill-creator', 'benchmark-references');
  fs.mkdirSync(references);
  for (let n = 0; n < 600; n++) fs.writeFileSync(path.join(references, `${n}.md`), 'fixture '.repeat(512));
  const skillOptions = { bundledRoot, userDataDir: globalThis.__stallsUserData,
    appDataDir: process.env.APPDATA, homeDir: home, withSharedMutation: async (_names, operation) => operation() };
  const prepared = await modules.after.prepareBuiltInSkills(skillOptions);
  assert.equal(prepared.projectionSafe, true, prepared.warnings.join('\n'));
  const rows = [];
  // Alternate order; setup/build/warmup are excluded from timings.
  for (const label of ['before', 'after']) {
    const m = modules[label];
    await (m.readCodexThreadStorageForArchiveAsync ?? m.readCodexThreadStorageForArchive)(targetId);
    await m.bfsFindManyBySuffix(workspace, hrefs);
    await (m.builtInSkillDescriptorsAsync ?? m.builtInSkillDescriptors)(skillOptions.userDataDir, skillOptions.appDataDir);
  }
  for (const label of ['before', 'after', 'after', 'before', 'before', 'after']) {
    const m = modules[label];
    const manager = managers[label];
    let unrelatedStats = 0;
    const originalStat = fs.statSync;
    fs.statSync = function (file, ...args) {
      if (String(file).endsWith('.jsonl') && String(file).includes('rollout-') && file !== target) unrelatedStats++;
      return originalStat.call(this, file, ...args);
    };
    let lookup;
    try { lookup = await measure(() => (m.readCodexThreadStorageForArchiveAsync ?? m.readCodexThreadStorageForArchive)(targetId)); }
    finally { fs.statSync = originalStat; }
    assert.equal(lookup.result?.rolloutPath, target);
    const paths = await measure(() => m.bfsFindManyBySuffix(workspace, hrefs));
    for (let i = 0; i < 300; i++) assert.equal(paths.result.get(hrefs[i]).length, i < 100 ? 10 : 0);
    let scans = 0;
    let sent = 0;
    let completed;
    const delivered = new Promise(resolve => { completed = resolve; });
    const gateway = new m.GhostSubscriptionGateway({
      listGhosts: () => { scans++; return manager.list(); },
      listGhostsAsync: () => { scans++; return manager.listAsync(); },
      findGhostForDelivery: id => manager.findInstalledInstance(id),
      isRunning: () => true, wake: async () => {}, now: Date.now,
      sendToGhost: () => { if (++sent === 12) completed(); },
    });
    const plugins = await measure(async () => {
      for (let n = 0; n < 12; n++) gateway.publish('turn', 'did-turn-start', { sessionId: `fixture-${n}`, agent: 'claude-code' });
      await delivered;
    });
    assert.equal(sent, 12);
    const skills = await measure(() => (m.builtInSkillDescriptorsAsync ?? m.builtInSkillDescriptors)(
      skillOptions.userDataDir, skillOptions.appDataDir));
    assert.equal(skills.result.length, 3);
    rows.push({ label, history: { ...lookup, result: undefined, unrelatedStats }, paths: { ...paths, result: undefined },
      plugins: { ...plugins, result: undefined, scans, sent }, skills: { ...skills, result: undefined, verified: 3 } });
  }
  console.log(JSON.stringify({ baseline, platform: process.platform, node: process.version,
    fixture: { rollouts: 6000, files: 10000, hrefs: 300, plugins: 30, notifications: 12, extraSkillFiles: 600 }, rows }, null, 2));
} finally {
  os.homedir = oldHome;
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  delete globalThis.__stallsUserData;
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('cindy-main-stalls-')) {
    throw new Error('Refusing to remove a benchmark directory outside the temporary root');
  }
  fs.rmSync(root, { recursive: true, force: true });
}
