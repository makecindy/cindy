/** Manual benchmark, outside the unit-test/CI gate.
 * node apps/desktop/scripts/benchmark-task-switch-stalls.mjs [baseline-ref] [output.json]
 * Bundles the actual baseline/current implementations; no checkout or real profile changes.
 * Synthetic filesystem fixtures isolate the two main-process hot paths from model/network IO.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(desktop, '../..');
const require = createRequire(path.join(desktop, 'package.json'));
const { build } = require('esbuild');
const baseline = execFileSync('git', ['rev-parse', process.argv[2] ?? 'HEAD'], {
  cwd: repo,
  encoding: 'utf8',
}).trim();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-switch-stalls-'));
const output = process.argv[3];
const changed = new Set([
  'apps/desktop/src/main/cindy-brain/GhostManager.ts',
  'apps/desktop/src/main/plugin-market/ledger.ts',
  'packages/maker-core/src/maker.ts',
  'packages/maker-core/src/agents/base-agent.ts',
]);
const entries = [
  ...changed,
  'apps/desktop/src/main/maker-host/built-in-skills.ts',
  'apps/desktop/src/main/skillhub/activationPreferences.ts',
];
const hostStubs = {
  electron:
    'export const app = {getPath: name => globalThis.__switchFixture[name]}; export const utilityProcess = undefined;',
  '@cindy/maker-core': 'export class CodexResumePreparationBlockedError extends Error {}',
  logger:
    'export const createLogger=()=>({trace(){},debug(){},info(){},warn(){},error(){},fatal(){}}); export const maskPath=x=>x; export const getLogLevel=()=>"error";',
  db: 'export function getDbClient(){throw Error("fixture must not access app DB")}',
  sqlite:
    'export function createBetterSqliteDatabase(){throw Error("fixture must not access app DB")}',
};
async function bundle(label) {
  const outfile = path.join(root, `${label}.cjs`);
  await build({
    stdin: {
      contents: entries.map((f) => `export * from './${f}';`).join('\n'),
      resolveDir: repo,
      loader: 'ts',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
    plugins: [
      {
        name: 'fixture',
        setup(b) {
          b.onResolve({ filter: /^(electron|@cindy\/maker-core)$/ }, (a) => ({
            path: a.path,
            namespace: 'fixture',
          }));
          b.onResolve({ filter: /(^|\/)logger(\.js)?$/ }, () => ({
            path: 'logger',
            namespace: 'fixture',
          }));
          b.onResolve({ filter: /localDb\/client\/current\.js$/ }, () => ({
            path: 'db',
            namespace: 'fixture',
          }));
          b.onResolve({ filter: /betterSqliteFactory\.js$/ }, () => ({
            path: 'sqlite',
            namespace: 'fixture',
          }));
          b.onLoad({ filter: /.*/, namespace: 'fixture' }, (a) => ({
            contents: hostStubs[a.path],
            loader: 'js',
          }));
          b.onResolve({ filter: /^[^./]/ }, (a) => {
            if (a.path.startsWith('node:')) return { path: a.path, external: true };
            const resolved = createRequire(
              path.join(a.resolveDir || desktop, 'package.json'),
            ).resolve(a.path);
            return { path: resolved, external: !resolved.endsWith('.ts') };
          });
          if (label === 'before')
            b.onLoad({ filter: /\.ts$/ }, (a) => {
              const relative = path.relative(repo, a.path).split(path.sep).join('/');
              if (!changed.has(relative)) return;
              return {
                contents: execFileSync('git', ['show', `${baseline}:${relative}`], {
                  cwd: repo,
                  encoding: 'utf8',
                  maxBuffer: 4 * 1024 * 1024,
                }),
                resolveDir: path.dirname(a.path),
                loader: 'ts',
              };
            });
        },
      },
    ],
  });
  return require(outfile);
}
async function measure(fn) {
  let last = performance.now(),
    maxGapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
  }, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const start = (last = performance.now());
  maxGapMs = 0;
  let result;
  try {
    result = await fn();
  } finally {
    maxGapMs = Math.max(maxGapMs, performance.now() - last);
    clearInterval(timer);
  }
  return { durationMs: performance.now() - start, maxGapMs, result };
}
const originalHome = os.homedir;
try {
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  os.homedir = () => home;
  globalThis.__switchFixture = {
    userData: path.join(root, 'user-data'),
    appData: path.join(root, 'app-data'),
    home,
  };
  const modules = { before: await bundle('before'), after: await bundle('after') };
  const bundledRoot = path.join(root, 'bundled');
  fs.cpSync(path.join(desktop, 'resources/system-skills'), bundledRoot, { recursive: true });
  const extra = path.join(bundledRoot, 'cindy-skill-creator', 'benchmark');
  fs.mkdirSync(extra);
  for (let n = 0; n < 120; n++)
    fs.writeFileSync(path.join(extra, `${n}.md`), 'fixture '.repeat(512));
  const skillOptions = {
    bundledRoot,
    userDataDir: __switchFixture.userData,
    appDataDir: __switchFixture.appData,
    homeDir: home,
    withSharedMutation: async (_names, operation) => operation(),
  };
  const prepared = await modules.after.prepareBuiltInSkills(skillOptions);
  assert.equal(prepared.projectionSafe, true, prepared.warnings.join('\n'));
  const JSZip = require('jszip'),
    managers = {},
    ledgers = {};
  const ledgerPath = path.join(root, 'market', 'ledger.v1.json');
  for (const [label, m] of Object.entries(modules)) {
    const ledger = (ledgers[label] = new m.PluginMarketLedger(ledgerPath));
    const project = (lookup) => (record) => {
      const fact = lookup({ ghostId: record.ghostId, namespace: record.namespace });
      assert.equal(fact.kind, 'found');
      return {};
    };
    managers[label] = new m.GhostManager({
      getRootDir: () => path.join(root, 'plugins'),
      sourcesForInstance: project((target) => ledger.lookupInstallationForAuthorization(target)),
      prepareListingSources: () => {
        const snapshot = ledger.createListingLookup();
        return { project: project(snapshot.lookup), isCurrent: snapshot.isCurrent };
      },
    });
  }
  for (let n = 0; n < 30; n++) {
    const id = `fixture-${n}`,
      zip = new JSZip();
    ledgers.after.upsertInstallation({
      pluginId: `c${String(n).padStart(24, '0')}`,
      ghostId: id,
      namespace: null,
      releaseId: 'release-1',
      version: '1.0.0',
      sha256: 'a'.repeat(64),
      scope: 'public',
      organizationId: null,
      source: 'market',
      installed: true,
      updatedAt: '2026-11-10T00:00:00.000Z',
    });
    zip.file(
      'ghost.json',
      JSON.stringify({
        schemaVersion: 3,
        minCindyVersion: '0.1.0',
        id,
        name: id,
        version: '1.0.0',
        entry: 'main.js',
      }),
    );
    zip.file('main.js', '// inert fixture');
    const file = path.join(root, `${id}.cindy`);
    fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
    assert.ok((await managers.after.install(file, { namespace: null })).ghost);
  }
  const makers = {};
  for (const [label, m] of Object.entries(modules)) {
    const agent = {
      kind: 'claude-code',
      capabilities: {},
      listAgentSkills: async () => ({ skills: [] }),
      filterActiveSkillCommands: (...args) =>
        m.BaseAgent.prototype.filterActiveSkillCommands.call(
          { deps: { getDisabledSkillPaths: m.readDisabledSkillPaths } },
          ...args,
        ),
      dispose: async () => {},
    };
    makers[label] = new m.Maker({
      agents: { 'claude-code': agent },
      storage: { get: async () => null },
      logger: {
        trace() {},
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this;
        },
      },
    });
  }
  const skills = async (label) => {
    const m = modules[label];
    let descriptors;
    // Mirrors the Host request: Maker filters first, then built-in identity projection.
    const read = async () => {
      descriptors = await m.builtInSkillDescriptorsAsync(
        skillOptions.userDataDir,
        skillOptions.appDataDir,
      );
      return m.readDisabledSkillPaths(descriptors);
    };
    const result = await makers[label].listAgentSkills(
      'claude-code',
      { workingDir: home },
      label === 'after' ? read : undefined,
    );
    if (!descriptors) await read();
    assert.equal(descriptors.length, 3);
    assert.equal(result.skills.length, 0);
  };
  for (const label of ['before', 'after']) {
    await managers[label].listAsync();
    await skills(label);
  }
  const rows = [];
  for (let round = 0; round < 12; round++)
    for (const label of round % 2 ? ['after', 'before'] : ['before', 'after']) {
      let ledgerReads = 0,
        syncSkillReads = 0;
      const original = fs.readFileSync;
      fs.readFileSync = function (file, ...args) {
        const s = String(file);
        if (s.includes(path.join(root, 'market')) && s.endsWith('.json')) ledgerReads++;
        if (s.startsWith(root) && (s.endsWith('.md') || s.endsWith('.py'))) syncSkillReads++;
        return original.call(this, file, ...args);
      };
      try {
        const plugins = await measure(() => managers[label].listAsync());
        assert.equal(plugins.result.length, 30);
        const skill = await measure(() => skills(label));
        rows.push({
          round,
          label,
          plugins: { durationMs: plugins.durationMs, maxGapMs: plugins.maxGapMs, ledgerReads },
          skills: { durationMs: skill.durationMs, maxGapMs: skill.maxGapMs, syncSkillReads },
        });
      } finally {
        fs.readFileSync = original;
      }
    }
  for (const maker of Object.values(makers)) await maker.shutdown();
  const report = {
    baseline,
    platform: process.platform,
    node: process.version,
    fixture: { plugins: 30, extraSkillFiles: 120, iterationsPerVariant: 12 },
    rows,
  };
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  os.homedir = originalHome;
  delete globalThis.__switchFixture;
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('cindy-switch-stalls-'));
  fs.rmSync(root, { recursive: true, force: true });
}
