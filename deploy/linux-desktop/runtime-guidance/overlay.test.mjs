import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { appendCloudSettingsPrompt, cloudSettingsGuidancePlugin, transformCloudSource, settingsPrompt, targets } from './overlay.mjs';

const sourceRoot = process.env.CINDY_TEST_CLIENT_SOURCE;
assert.ok(sourceRoot && path.isAbsolute(sourceRoot), 'Set CINDY_TEST_CLIENT_SOURCE to the client checkout');
const require = createRequire(path.join(sourceRoot, 'package.json'));
const ts = require('typescript');
const read = relative => fs.readFileSync(path.join(sourceRoot, relative), 'utf8');
const promptFile = 'apps/desktop/src/main/plugin-oauth/prompt.ts';
const wiringFiles = targets.filter(relative => relative !== promptFile);
const base = '  unchanged engine prompt\n';

// Runs the real transformed prompt.ts with only its two imports stubbed.
function loadTransformedPrompt(instance) {
  const code = transformCloudSource(read(promptFile), promptFile);
  const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const imports = {
    'virtual:cindy-cloud-settings-guidance': { appendCloudSettingsPrompt },
    '../instance-runtime/config.js': { getInstanceConfig: () => (instance.cloud ? {} : null) },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)(id => {
    assert.ok(id in imports, `unexpected import ${id}`);
    return imports[id];
  }, module, module.exports);
  return module.exports;
}

test('transformed getter preserves non-cloud bytes', () => {
  const { withCloudPluginOauthPrompt } = loadTransformedPrompt({ cloud: false });
  assert.equal(withCloudPluginOauthPrompt({ systemPrompt: base }).systemPrompt, base);
});

test('transformed getter appends one stable cloud suffix after the OAuth guidance', () => {
  const { withCloudPluginOauthPrompt, CLOUD_PLUGIN_OAUTH_PROMPT } = loadTransformedPrompt({ cloud: true });
  const config = withCloudPluginOauthPrompt({ systemPrompt: base });
  assert.equal(config.systemPrompt, `${base}\n\n${CLOUD_PLUGIN_OAUTH_PROMPT}\n\n${settingsPrompt}`);
  assert.equal(config.systemPrompt, config.systemPrompt);
  assert.equal(config.systemPrompt.split(settingsPrompt).length, 2);
});

test('transformed getter reads the instance on every access', () => {
  const instance = { cloud: false };
  const { withCloudPluginOauthPrompt } = loadTransformedPrompt(instance);
  const config = withCloudPluginOauthPrompt({ systemPrompt: base });
  assert.equal(config.systemPrompt, base);
  instance.cloud = true;
  assert.ok(config.systemPrompt.endsWith(`\n\n${settingsPrompt}`));
});

test('configs without a host prompt are left alone', () => {
  const { withCloudPluginOauthPrompt } = loadTransformedPrompt({ cloud: true });
  const config = {};
  assert.equal(withCloudPluginOauthPrompt(config), config);
  assert.equal(config.systemPrompt, undefined);
});

test('Claude, Codex and Pi all go through the cloud prompt getter', () => {
  const wrapped = [];
  for (const relative of ['apps/desktop/src/main/maker-host/runtime-configs.ts', 'apps/desktop/src/main/maker-host/pi-host.ts']) {
    const ast = ts.createSourceFile(relative, read(relative), ts.ScriptTarget.Latest, true);
    const visit = node => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'withCloudPluginOauthPrompt') {
        const [inner] = node.arguments;
        assert.ok(inner && ts.isCallExpression(inner), `${relative}: wrapped value is not a builder call`);
        wrapped.push(inner.expression.getText(ast).split('.').pop());
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  assert.deepEqual(wrapped.sort(), ['buildClaudeRuntimeConfig', 'buildCodexRuntimeConfig', 'buildPiRuntimeConfig']);
});

for (const relative of wiringFiles) {
  test(`${relative}: wiring is checked, not rewritten`, () => {
    const original = read(relative);
    assert.equal(transformCloudSource(original, relative), original);
  });
  test(`${relative}: wiring drift rejects build`, () => {
    const original = read(relative);
    const drifted = original.replaceAll('withCloudPluginOauthPrompt(', 'otherPrompt(').replaceAll('systemPrompt: compose', 'systemPrompt: other');
    assert.notEqual(drifted, original);
    assert.throws(() => transformCloudSource(drifted, relative));
  });
}

test('prompt.ts: source drift or duplicate injection rejects build', () => {
  const original = read(promptFile);
  assert.throws(() => transformCloudSource(transformCloudSource(original, promptFile), promptFile));
  assert.throws(() => transformCloudSource(original.replaceAll('getInstanceConfig()', 'changedInstanceConfig()'), promptFile));
});

test('arbitrary prefix bytes are unchanged', () => {
  assert.equal(appendCloudSettingsPrompt(base, false), base);
  assert.equal(appendCloudSettingsPrompt(base, true), base + '\n\n' + settingsPrompt);
});

test('unrelated client sources are not transformed', () => assert.equal(transformCloudSource('unchanged', 'apps/desktop/src/renderer/main-entry.tsx'), null));

test('cloud build rejects an omitted engine and resolves the exact virtual module', () => {
  const plugin = cloudSettingsGuidancePlugin({ sourceRoot });
  assert.throws(() => plugin.buildEnd());
  assert.equal(plugin.resolveId('unrelated'), null);
  const id = plugin.resolveId('virtual:cindy-cloud-settings-guidance');
  assert.ok(plugin.load(id).includes(JSON.stringify(settingsPrompt)));
  const [first, ...rest] = targets;
  plugin.transform(read(first), path.join(sourceRoot, first));
  assert.throws(() => plugin.buildEnd());
  for (const relative of rest) plugin.transform(read(relative), path.join(sourceRoot, relative));
  plugin.buildEnd();
});
