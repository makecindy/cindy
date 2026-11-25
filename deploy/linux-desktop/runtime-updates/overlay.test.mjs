import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { transformCloudUpdateSource, targets } from './overlay.mjs';

test('unrelated sources stay unchanged; missing integration anchors fail closed', () => {
  assert.equal(transformCloudUpdateSource('unchanged', 'other.ts'), null);
  for (const target of targets) assert.throws(() => transformCloudUpdateSource('', target));
});

const source = process.env.CLOUD_UPDATE_TEST_SOURCE;
test('real transformed sources compile without changing the client checkout', { skip: !source }, () => {
  const require = createRequire(path.join(source, 'package.json'));
  for (const target of targets) {
    const file = path.join(source, target), before = fs.readFileSync(file, 'utf8');
    const result = transformCloudUpdateSource(before, target);
    require('esbuild').transformSync(result, { loader: target.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', jsx: 'automatic' });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.throws(() => transformCloudUpdateSource(result, target), /twice/);
  }
});

function runtime(platform = 'linux', managed = true) {
  const require = createRequire(path.join(source, 'package.json'));
  const original = fs.readFileSync(path.join(source, targets[0]), 'utf8');
  const code = transformCloudUpdateSource(original, targets[0]) + '\nexport const cloudTest = { cloudUpdatesManaged, checkExistingPatch, executeRelaunch, getStartupRelaunchBlockReason };';
  const handlers = new Map(), listeners = new Map(), effects = [];
  const fail = (name) => () => { effects.push(name); throw Error('Unexpected side effect: ' + name); };
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  const modules = {
    electron: {
      app: { isPackaged: true, getVersion: () => '1.2.3', getPath: fail('getPath'), quit: fail('quit'), relaunch: fail('relaunch') },
      ipcMain: { handle: (n, fn) => handlers.set(n, fn), on: (n, fn) => listeners.set(n, fn) },
      powerMonitor: { on: fail('powerMonitor'), removeListener: noop },
      BrowserWindow: { getAllWindows: () => [] },
    },
    './instance-runtime/config.js': { getInstanceConfig: () => managed ? {} : null },
    './cindy-make/versionRuntimeIdentity.js': { isCindyPersonalRuntime: () => false },
    './manifestService': { isDev: () => false, fetchManifest: fail('manifest'), probeBetaManifest: fail('betaManifest') },
    './logger': { createLogger: () => logger },
    './security/trustedAppRenderer': { assertTrustedAppRendererEvent: noop },
    'node:fs': new Proxy({}, { get: (_, n) => fail('fs.' + String(n)) }),
    'node:child_process': { spawn: fail('spawn') },
  };
  const fallback = new Proxy({}, { get: (_, n) => n === '__esModule' ? false : fail(String(n)) });
  const context = { module: { exports: {} }, process: { platform, arch: 'x64', env: {}, argv: [] },
    setTimeout: fail('timer'), setInterval: fail('interval'), clearTimeout: noop, clearInterval: noop,
    require: (id) => modules[id] ?? (id === 'node:path' || id === 'node:os' ? require(id) : fallback) };
  vm.runInNewContext(require('esbuild').transformSync(code, { loader: 'ts', format: 'cjs' }).code, context);
  return { api: context.module.exports, handlers, listeners, effects };
}

test('cloud updater has no polling, startup download, staged-patch apply or relaunch', { skip: !source }, async () => {
  const { api, handlers, listeners, effects } = runtime();
  api.initUpdateService();
  assert.equal(api.getUpdateStatus(), 'idle');
  assert.equal(await api.checkForUpdate(), 'idle');
  assert.equal((await handlers.get('update-check-startup')()).hasUpdate, false);
  assert.equal((await handlers.get('update-check-now')()).result, 'idle');
  assert.equal((await api.checkAppUpdateForAgent()).status, 'unsupported');
  assert.equal((await handlers.get('update-channel-probe-beta')({})).available, false);
  assert.equal(await api.enableUncustomizedBetaChannel(), false);
  assert.equal(api.cloudTest.checkExistingPatch().action, 'none');
  assert.equal(await api.cloudTest.getStartupRelaunchBlockReason(), 'disabled');
  await api.cloudTest.executeRelaunch('dark');
  await handlers.get('update-channel-relaunch')({});
  listeners.get('update-relaunch')({}, 'dark');
  assert.deepEqual(effects, []);
});

test('ordinary Linux and non-Linux desktop never activate the cloud guard', { skip: !source }, () => {
  assert.equal(runtime('linux', false).api.cloudTest.cloudUpdatesManaged(), false);
  assert.equal(runtime('darwin', true).api.cloudTest.cloudUpdatesManaged(), false);
  assert.equal(runtime('win32', true).api.cloudTest.cloudUpdatesManaged(), false);
});

test('automatic release dialog does not fetch or write read markers on cloud', { skip: !source }, () => {
  const require = createRequire(path.join(source, 'package.json'));
  const code = transformCloudUpdateSource(fs.readFileSync(path.join(source, targets[2]), 'utf8'), targets[2]);
  const start = code.indexOf('  useEffect(() => {\n    if (');
  assert.ok(start >= 0);
  // Execute the real effect prefix: an accidental removal or inversion of the
  // guard would attempt to read localStorage, which is intentionally absent.
  const body = code.slice(start + '  useEffect(() => {'.length, code.indexOf('    let cancelled = false;', start));
  const compiled = require('esbuild').transformSync('(function() {' + body + '})()', { loader: 'ts' }).code;
  vm.runInNewContext(compiled, { window: { electronAPI: { cloudUpdatesManaged: true } } });
});

function workspacePackages(root) {
  const packages = new Map();
  for (const dir of fs.readdirSync(path.join(root, 'packages'))) {
    const manifest = path.join(root, 'packages', dir, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    packages.set(pkg.name, { dir: path.dirname(manifest), exports: pkg.exports, main: pkg.main });
  }
  return packages;
}

// Bundle the actual catalog and every sidecar. Only replace Vite's glob loader;
// ranking, visibility, translations and deep-link resolution are production code.
async function searchCatalog(cloud) {
  const require = createRequire(path.join(source, 'package.json'));
  const renderer = path.join(source, 'apps/desktop/src/renderer');
  const settings = path.join(renderer, 'components/settings');
  const catalog = path.join(settings, 'settingsSearchCatalog.ts');
  const sidecars = fs.readdirSync(settings, { recursive: true })
    .filter((name) => name.endsWith('.settings-search.ts')).sort();
  const bundle = await require('esbuild').build({
    entryPoints: [catalog], bundle: true, write: false, platform: 'node', format: 'cjs',
    alias: { '@': renderer },
    plugins: [{ name: 'real-cloud-search-fixture', setup(build) {
      // Workspace packages resolve through their own exports, as the app build does.
      build.onResolve({ filter: /^@cindy\// }, ({ path: specifier }) => {
        const [scope, name, ...rest] = specifier.split('/');
        const pkg = workspacePackages(source).get(`${scope}/${name}`);
        const target = pkg && (rest.length ? pkg.exports?.[`./${rest.join('/')}`] : pkg.exports?.['.'] ?? pkg.main);
        return typeof target === 'string' ? { path: path.join(pkg.dir, target) } : undefined;
      });
      build.onLoad({ filter: /settingsSearchCatalog\.ts$/ }, () => {
        const code = fs.readFileSync(catalog, 'utf8');
        const glob = "const modules = import.meta.glob<SettingsSearchModule>('./**/*.settings-search.ts', { eager: true, import: 'default' });";
        assert.equal(code.split(glob).length, 2, 'catalog loader changed');
        const imports = sidecars.map((name, i) => `import sidecar${i} from ${JSON.stringify('./' + name)};`).join('\n');
        return { contents: imports + '\n' + code.replace(glob, `const modules = [${sidecars.map((_, i) => 'sidecar' + i).join(',')}];`), loader: 'ts' };
      });
      build.onLoad({ filter: /\.settings-search\.ts$/ }, ({ path: file }) => {
        const original = fs.readFileSync(file, 'utf8');
        const relative = path.relative(source, file).split(path.sep).join('/');
        return { contents: (cloud && transformCloudUpdateSource(original, relative)) || original, loader: 'ts' };
      });
    } }],
  });
  const context = { module: { exports: {} } };
  vm.runInNewContext(bundle.outputFiles[0].text, context);
  return context.module.exports;
}

let catalogs;
const getCatalogs = () => catalogs ??= Promise.all([searchCatalog(false), searchCatalog(true)]);
const updateId = 'settings.about.autoUpdateLabel';

test('cloud catalog removes only desktop auto-update and its deep links', { skip: !source }, async () => {
  const [desktop, cloud] = await getCatalogs();
  const ids = (api) => Array.from(api.SETTINGS_SEARCH_ENTRIES, (entry) => entry.id);
  assert.ok(ids(desktop).includes(updateId));
  assert.deepEqual(ids(cloud), ids(desktop).filter((id) => id !== updateId));
  assert.equal(cloud.validateSettingsSearchCatalog().length, 0);
  for (const alias of [updateId, 'autoUpdateLabel', 'settings-search-settings-about-autoUpdateLabel']) {
    assert.ok(desktop.resolveSettingsSearchTarget('about', alias));
    assert.equal(cloud.resolveSettingsSearchTarget('about', alias), null);
  }
  for (const entry of cloud.SETTINGS_SEARCH_ENTRIES) {
    assert.equal(cloud.resolveSettingsSearchTarget(entry.tab, entry.id), desktop.resolveSettingsSearchTarget(entry.tab, entry.id));
  }
});

for (const language of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']) {
  test(`cloud settings search omits auto-update without changing other results: ${language}`, { skip: !source }, async () => {
    const [desktop, cloud] = await getCatalogs();
    const require = createRequire(path.join(source, 'apps/desktop/package.json'));
    const locale = (lang) => JSON.parse(fs.readFileSync(path.join(source, `apps/desktop/src/renderer/i18n/locales/${lang}/common.json`), 'utf8'));
    const i18n = require('i18next').createInstance();
    await i18n.init({ lng: language, fallbackLng: 'en', resources: {
      [language]: { translation: locale(language) }, en: { translation: locale('en') },
    } });
    const tabs = [...new Set(Array.from(desktop.SETTINGS_SEARCH_ENTRIES, (entry) => entry.tab))];
    const context = { platform: 'linux', region: 'cn', mode: 'cloud', membershipKind: 'personal' };
    const original = desktop.buildSettingsSearchDocuments(i18n.t, tabs, context);
    const documents = cloud.buildSettingsSearchDocuments(i18n.t, tabs, context);
    const ids = (results) => Array.from(results, ({ entry }) => entry.id);
    assert.ok(i18n.exists(updateId));
    for (const query of [i18n.t(updateId), i18n.t(updateId, { lng: 'en' }), 'ab', 'update', ...documents.map((d) => d.title)]) {
      assert.deepEqual(ids(cloud.searchSettings(documents, query)), ids(desktop.searchSettings(original, query)).filter((id) => id !== updateId), query);
    }
    assert.ok(ids(desktop.searchSettings(original, i18n.t(updateId))).includes(updateId));
  });
}
