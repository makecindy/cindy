import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { CLOUD_MAIN_WINDOW_ARGUMENT, hasCloudMainWindowControls, createCloudMainWindowControls } from './policy.mjs';
import { cloudMainWindowControlsPlugin, transformCloudWindowSource, targets } from './overlay.mjs';

function setup() {
  const state = { enabled: true, quitting: false, minimized: true, destroyed: false, restored: 0, prevented: 0 };
  const main = { isDestroyed: () => state.destroyed, isMinimized: () => state.minimized, restore: () => state.restored++ };
  const policy = createCloudMainWindowControls({ enabled: () => state.enabled, isQuitting: () => state.quitting, mainWindow: () => main });
  const event = { preventDefault: () => state.prevented++ };
  return { state, main, policy, event };
}

test('presentation hint requires exact main-window argument and Linux', () => {
  assert.equal(hasCloudMainWindowControls([CLOUD_MAIN_WINDOW_ARGUMENT], 'linux'), true);
  for (const platform of ['win32', 'darwin']) assert.equal(hasCloudMainWindowControls([CLOUD_MAIN_WINDOW_ARGUMENT], platform), false);
  for (const argv of [[], [CLOUD_MAIN_WINDOW_ARGUMENT + '=true'], ['--other']]) assert.equal(hasCloudMainWindowControls(argv, 'linux'), false);
});
test('cloud main and unknown IPC senders cannot close the main window', () => {
  const { main, policy } = setup();
  assert.equal(policy.blocksAction(main), true);
  assert.equal(policy.blocksAction(null), true);
});
test('auxiliary windows retain normal controls', () => {
  assert.equal(setup().policy.blocksAction({}), false);
});
test('normal desktop keeps all existing behavior', () => {
  const { state, main, policy, event } = setup();
  state.enabled = false;
  assert.equal(policy.blocksAction(main), false);
  assert.equal(policy.blocksAction(null), false);
  assert.equal(policy.preventClose(event), false);
  assert.equal(state.prevented + state.restored, 0);
});
test('window-manager close remains prevented', () => {
  const { state, policy, event } = setup();
  assert.equal(policy.preventClose(event), true);
  assert.equal(state.prevented, 1);
  assert.equal(state.restored, 0);
});
test('orderly shutdown may close the window without restoring it', () => {
  const { state, policy, event } = setup();
  state.quitting = true;
  assert.equal(policy.preventClose(event), false);
  assert.equal(state.prevented + state.restored, 0);
});
test('unrelated source is unchanged, missing anchors stop the build', () => {
  assert.equal(transformCloudWindowSource('unrelated', 'src/other.ts'), null);
  for (const target of targets) assert.throws(() => transformCloudWindowSource('', target), /integration changed/);
});
test('virtual policy is available only to the explicit cloud packaging plugin', () => {
  const plugin = cloudMainWindowControlsPlugin({ sourceRoot: '/neutral/source' });
  const id = plugin.resolveId('virtual:cindy-cloud-main-window-controls');
  assert.match(plugin.load(id), /function createCloudMainWindowControls/);
  assert.equal(plugin.resolveId('electron'), null);
  assert.equal(plugin.load('electron'), null);
});

const source = process.env.CLOUD_WINDOW_TEST_SOURCE;
test('real integration transforms compile, preserve native files, and render the right controls', { skip: !source }, async () => {
  const require = createRequire(path.join(source, 'package.json'));
  const esbuild = require('esbuild');
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  for (const target of targets) {
    const filename = path.join(source, target);
    const original = fs.readFileSync(filename, 'utf8');
    const transformed = transformCloudWindowSource(original, target);
    const compiled = esbuild.transformSync(transformed, { loader: target.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', jsx: 'automatic' }).code;
    assert.equal(fs.readFileSync(filename, 'utf8'), original);
    assert.throws(() => transformCloudWindowSource(transformed, target), /twice/);
    if (target.endsWith('bootstrap-electron.ts')) {
      // The minimize IPC is untouched; on Xfce it is a native minimize.
      assert.match(transformed, /const window = BrowserWindow\.fromWebContents\(event\.sender\) \?\? mainWindowRef;\n\s+if \(window\) minimizeWindow\(window\);/);
      // The close IPC is refused before its close-once branch, which may quit on Linux.
      assert.match(transformed, /const win = BrowserWindow\.fromWebContents\(event\.sender\);\n\s+if \(cloudMainWindowControls\.blocksAction\(win\)\) return;\n\s+if \(once !== undefined\) \{/);
    }
    if (!target.endsWith('WindowControls.tsx')) continue;
    const api = { platform: 'linux', windowMaximize() {}, windowMinimize() {}, windowClose() {} };
    const context = { module: { exports: {} }, window: { electronAPI: api }, require: (id) => {
      if (id === 'react-i18next') return { useTranslation: () => ({ t: value => value }) };
      if (id === '@/lib/utils') return { cn: (...parts) => parts.join(' ') };
      if (id.startsWith('@/lib/') || id.startsWith('@/utils/')) return new Proxy({}, { get: () => () => false });
      if (id.startsWith('@/components/')) return new Proxy({}, { get: () => () => null });
      return require(id);
    } };
    vm.runInNewContext(compiled, context);
    for (const hint of [true, false, undefined]) {
      api.cloudMainWindowControls = hint;
      const html = renderToStaticMarkup(React.createElement(context.module.exports.WindowControls));
      assert.equal(html.includes('aria-label="titleBar.minimize"'), true);
      assert.equal(html.includes('aria-label="titleBar.close"'), hint !== true);
      assert.equal(html.includes('aria-label="titleBar.maximizeOrRestore"'), true);
    }
  }
});
