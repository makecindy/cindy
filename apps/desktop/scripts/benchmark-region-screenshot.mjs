#!/usr/bin/env node
// Explicit performance/E2E run, outside unit tier. Uses the isolated ui-page
// Electron host and real product source; never starts Cindy or touches user data.
// node apps/desktop/scripts/benchmark-region-screenshot.mjs --baseline=HEAD --samples=30
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright-core';
import { buildPage, desktop, root } from './ui-page/build.mjs';
import { adhocPage } from './ui-page/registry.mjs';
import { pageResponse, origin } from './ui-page/run.mjs';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const samples = Number(option('samples') ?? 30), baseline = option('baseline') ?? 'HEAD';
assert.ok(Number.isInteger(samples) && samples >= 5 && samples <= 200);
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const baselineSha = git(['rev-parse', '--verify', `${baseline}^{commit}`]).trim();
const files = git(['ls-tree', '-r', '--name-only', baselineSha, '--', 'apps/desktop/src/renderer/features/region-screenshot']).trim().split('\n');
const old = new Map(files.map(file => [path.normalize(path.join(root, file)), file]));
const contents = new Map();
const overlay = {
  resolve: () => undefined,
  has: file => old.has(path.normalize(file)),
  get(file) {
    const name = old.get(path.normalize(file));
    if (!name) return undefined;
    if (!contents.has(name)) contents.set(name, git(['show', `${baselineSha}:${name}`]));
    return contents.get(name);
  },
};
const fixture = adhocPage(path.join(desktop, 'scripts/fixtures/region-capture/performance.tsx'));
const bundles = { before: await buildPage(fixture, overlay), after: await buildPage(fixture) };
const temp = await mkdtemp(path.join(os.tmpdir(), 'cindy-screenshot-perf-'));
const bundleDir = path.join(temp, 'bundle');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|LANG|LC_ALL)$/i.test(key)));
let app;
const report = { generatedAt: new Date().toISOString(), baseline: baselineSha, samples, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model,
  scope: 'Real Electron offscreen renderer (1040x760 DIP, 2x density), synthetic opaque BGRA source at the stated dimensions. Excludes OS capture, native window startup, IPC serialization, clipboard and disk. 3 warmups per batch; alternating before/after batches. First-paint timing includes two animation frames and is sensitive to vsync/GC.', results: [], regression: [] };
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return { p50: +((sorted[Math.floor(middle)] + sorted[Math.ceil(middle) - 1]) / 2).toFixed(3), p95: +sorted[Math.ceil(sorted.length * .95) - 1].toFixed(3) };
};
try {
  await mkdir(bundleDir, { recursive: true });
  await mkdir(path.join(temp, 'evidence'));
  for (const [name, bundle] of Object.entries(bundles)) {
    const prefix = `/b/${bundle.bundleDigest.slice(0, 16)}`;
    for (const [key, file] of bundle.files) {
      const target = path.join(bundleDir, key.startsWith('/assets/') ? key : `${prefix}${key}`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.body);
    }
    for (const theme of ['light', 'dark']) {
      const document = pageResponse(origin, bundle, { page: 'screenshot-perf', case: 'default', theme, locale: 'en', platform: process.platform, viewport: { width: 1040, height: 760 }, data: {} });
      await writeFile(path.join(bundleDir, `${name}-${theme}.html`), document.body);
    }
  }
  app = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.join(desktop, 'scripts/ui-page/electron.cjs')],
    env: { ...env, CINDY_UI_PROFILE: path.join(temp, 'profile'), CINDY_UI_BUNDLE_DIR: bundleDir,
      CINDY_UI_EVIDENCE_DIR: path.join(temp, 'evidence'), CINDY_UI_WIDTH: '1040', CINDY_UI_HEIGHT: '760' } });
  const page = await app.firstWindow();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  report.versions = await app.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome }));
  const load = async (side, theme = 'light') => {
    await page.goto(`${origin}/${side}-${theme}.html`);
    await page.waitForFunction(() => window.__uiPage?.ready && window.screenshotPerf);
  };
  for (const [width, height, scale] of [[1920, 1080, 1], [3840, 2160, 2], [1600, 10000, 2]]) {
    const values = { before: [], after: [] };
    // Alternate order to reduce JIT, temperature and background-load bias.
    for (let batch = 0; batch < 2; batch++) for (const side of batch ? ['after', 'before'] : ['before', 'after']) {
      await load(side);
      const count = Math.ceil(samples / 2);
      for (let i = -3; i < count; i++) {
        const started = await page.evaluate(([w, h, s]) => window.screenshotPerf.begin(w, h, s), [width, height, scale]);
        const exportMs = await page.evaluate(() => window.screenshotPerf.export());
        if (i >= 0 && values[side].length < samples) values[side].push({ ...started, exportMs });
      }
      // Canvas probes can switch Chromium's backing store to CPU. Validate only
      // after the timed batch, then reload before collecting any more samples.
      await page.evaluate(() => window.screenshotPerf.verify());
    }
    const row = { width, height, scale };
    for (const side of ['before', 'after']) row[side] = {
      beginSyncMs: summary(values[side].map(v => v.syncMs)), paintedMs: summary(values[side].map(v => v.paintedMs)),
      exportMs: summary(values[side].map(v => v.exportMs)), frameWrites: values[side][0].frameWrites,
      raw: values[side],
    };
    report.results.push(row);
    console.log(JSON.stringify({ ...row, before: { ...row.before, raw: undefined }, after: { ...row.after, raw: undefined } }));
  }
  for (const theme of ['light', 'dark']) for (const side of ['before', 'after']) {
    for (const scenario of [
      { name: 'offset-crop', args: [800, 600, 2, { x: 13, y: 17, width: 200, height: 160 }] },
      { name: 'alpha-fallback', args: [800, 600, 1, undefined, true] },
      { name: 'mixed-dpi-resize', args: [800, 600, 2, undefined, false, 1.5] },
    ]) {
      await load(side, theme);
      console.log(`regression ${side}/${theme}/${scenario.name}`);
      await page.evaluate(args => window.screenshotPerf.begin(...args), scenario.args);
      await page.evaluate(() => window.screenshotPerf.export());
      report.regression.push({ theme, side, name: scenario.name, ...await page.evaluate(() => window.screenshotPerf.verify()) });
    }
    await load(side, theme);
    await page.evaluate(() => window.screenshotPerf.begin(800, 600));
    await page.keyboard.press('r');
    await page.mouse.move(100, 100); await page.mouse.down(); await page.mouse.move(300, 200); await page.mouse.up();
    await page.evaluate(() => window.screenshotPerf.export());
    report.regression.push({ theme, side, name: 'rectangle-annotation', ...await page.evaluate(() => window.screenshotPerf.verify(true)) });
  }
  for (const after of report.regression.filter(row => row.side === 'after')) {
    const before = report.regression.find(row => row.side === 'before' && row.name === after.name && row.theme === after.theme);
    assert.deepEqual({ ...after, side: undefined }, { ...before, side: undefined }, `Baseline parity: ${after.name}/${after.theme}`);
  }
  assert.deepEqual(errors, []);
  if (option('output')) await writeFile(path.resolve(option('output')), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ regressions: report.regression, versions: report.versions, passed: true }));
} finally {
  await app?.close();
  await rm(temp, { recursive: true, force: true });
}
