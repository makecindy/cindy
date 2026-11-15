#!/usr/bin/env node
// Explicit performance/E2E run, outside unit tier. Uses the isolated ui-page
// Electron host and real product source; never starts Cindy or touches user data.
// node apps/desktop/scripts/benchmark-region-screenshot.mjs --baseline=HEAD --samples=30
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
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
const files = git(['ls-tree', '-r', '--name-only', baselineSha, '--', 'apps/desktop/src/renderer/features/region-screenshot', 'apps/desktop/src/shared/scrollCapture.ts']).trim().split('\n');
const baselineDir = option('baseline-dir');
if (baselineDir) {
  files.length = 0;
  const walk = async dir => {
    for (const entry of await readdir(path.join(baselineDir, dir), { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file); else files.push(file);
    }
  };
  await walk('apps/desktop/src/renderer/features/region-screenshot');
  files.push('apps/desktop/src/shared/scrollCapture.ts');
}
const old = new Map(files.map(file => [path.normalize(path.join(root, file)), file]));
const contents = new Map();
if (baselineDir) for (const file of files) contents.set(file, await readFile(path.join(baselineDir, file), 'utf8'));
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
const report = { generatedAt: new Date().toISOString(), baseline: baselineDir ? JSON.parse(await readFile(path.join(baselineDir, 'baseline.json'), 'utf8')) : baselineSha, samples, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model,
  scope: 'Real Electron offscreen renderer (1040x760 DIP, 2x density), synthetic opaque BGRA source at the stated dimensions. Excludes OS capture, native window startup, IPC serialization, clipboard and disk. 3 warmups per screenshot/scroll batch; GIF streams include their first frame. Alternating before/after batches. First-paint timing includes two animation frames and is sensitive to vsync/GC. Pipeline probes use production scroll matching and GIF encoding; hover probes count real pointer-driven canvas size assignments; they do not measure presentation latency or allocated memory.', results: [], pipeline: [], regression: [] };
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
  report.annotations = [];
  for (const readFrequently of option('only') === 'annotations' ? [true, false] : [true]) for (const side of ['before', 'after', 'after', 'before']) {
    await load(side);
    const result = await page.evaluate(([count, frequent]) => window.screenshotPerf.annotations(count, frequent), [samples, readFrequently]);
    report.annotations.push({ side, readFrequently, ...result, timing: summary(result.raw), synchronousMs: summary(result.synchronous) });
    console.log(JSON.stringify({ annotations: side, readFrequently, timing: summary(result.raw), synchronous: summary(result.synchronous), hash: result.hash }));
  }
  for (const row of report.annotations) {
    const first = report.annotations.find(value => value.readFrequently === row.readFrequently);
    assert.equal(row.hash, first.hash, 'Annotation pixels must match baseline');
    assert.deepEqual(row.regression, first.regression, 'Annotation edit/undo/source/scale pixels must match baseline');
  }
  if (option('only') === 'annotations') {
    assert.deepEqual(errors, []);
    if (option('output')) await writeFile(path.resolve(option('output')), JSON.stringify(report, null, 2) + '\n');
    console.log('Annotation parity passed');
  } else {
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
    await load(side, theme);
    await page.evaluate(() => window.screenshotPerf.begin(1920, 1080, 1, undefined, false, 1, false));
    // Move across the frame and back to its clipped edge. Reusing the backing
    // store must not retain old pixels where the source extends off-screen.
    for (const [x, y] of [[200, 200], [1, 1], [1038, 758], [200, 200]]) {
      await page.mouse.move(x, y);
      await page.getByText(`${x}, ${y}`, { exact: true }).waitFor();
      const { canvasResizes: _resizes, ...pixels } = await page.evaluate(() => window.screenshotPerf.hoverProbe());
      report.regression.push({ theme, side, name: `magnifier-${x}-${y}`, ...pixels });
    }
  }
  for (const side of ['before', 'after', 'after', 'before']) {
    await load(side);
    await page.evaluate(() => window.screenshotPerf.begin(1920, 1080, 1, undefined, false, 1, false));
    await page.mouse.move(80, 100);
    await page.getByText('80, 100', { exact: true }).waitFor();
    await page.evaluate(() => window.screenshotPerf.hoverProbe(true));
    for (let i = 1; i <= 60; i++) await page.mouse.move(80 + i * 3, 100 + i * 2);
    await page.getByText('260, 220', { exact: true }).waitFor();
    const hover = await page.evaluate(() => window.screenshotPerf.hoverProbe());
    if (side === 'after') assert.equal(hover.canvasResizes, 0, 'Pointer movement must reuse the magnifier backing store');
    const stages = await page.evaluate(count => window.screenshotPerf.pipeline(count), samples);
    const row = { side, hover, ...stages,
      scroll: stages.scroll.map(stage => ({ ...stage, ...summary(stage.raw) })),
      gif: { ...stages.gif, ...summary(stages.gif.raw), mainThreadMs: summary(stages.gif.mainThread), timerDelayMs: summary(stages.gif.timerDelay) } };
    report.pipeline.push(row);
    console.log(JSON.stringify({ side, hover: row.hover,
      scroll: row.scroll.map(({ name, p50, p95 }) => ({ name, p50, p95 })), gif: { p50: row.gif.p50, p95: row.gif.p95, mainThreadMs: row.gif.mainThreadMs, timerDelayMs: row.gif.timerDelayMs } }));
  }
  for (const row of report.pipeline.slice(1)) {
    const first = report.pipeline[0];
    assert.deepEqual({ ...row.hover, canvasResizes: undefined }, { ...first.hover, canvasResizes: undefined }, 'Magnifier pixels must remain identical');
    assert.deepEqual(row.stitched, first.stitched, 'Stitched export must remain byte-identical');
    assert.deepEqual(row.scroll.map(r => r.result), first.scroll.map(r => r.result), 'Scroll decisions must be identical');
    assert.deepEqual([row.gif.bytes, row.gif.hash], [first.gif.bytes, first.gif.hash], 'GIF pixels/timing must remain byte-identical');
  }
  for (const after of report.regression.filter(row => row.side === 'after')) {
    const before = report.regression.find(row => row.side === 'before' && row.name === after.name && row.theme === after.theme);
    assert.deepEqual({ ...after, side: undefined }, { ...before, side: undefined }, `Baseline parity: ${after.name}/${after.theme}`);
  }
  report.gifMotion = [];
  for (const side of ['before', 'after', 'after', 'before']) {
    await load(side);
    const result = await page.evaluate(count => window.screenshotPerf.gifMotion(count), samples);
    report.gifMotion.push({ side, ...result, timing: summary(result.raw) });
    console.log(JSON.stringify({ gifMotion: side, timing: summary(result.raw), bytes: result.bytes, hash: result.hash }));
  }
  assert.ok(report.gifMotion.every(row => row.hash === report.gifMotion[0].hash && row.bytes === report.gifMotion[0].bytes), 'Motion GIF must match baseline');
  const gifs = [];
  // WebCodecs is unavailable on the harness's HTTP test origin. Decode in an
  // isolated local-file window (a secure context), without changing app CSP,
  // disabling web security or enabling insecure-origin command-line switches.
  const decoderPage = path.join(temp, 'decode.html');
  await writeFile(decoderPage, '<!doctype html><title>Local GIF decoder</title>');
  for (const side of ['before', 'after']) {
    await load(side);
    const bytes = await page.evaluate(() => window.screenshotPerf.gifParity());
    const decoded = await app.evaluate(async ({ BrowserWindow }, { bytes, decoderPage }) => {
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      try {
        await win.loadFile(decoderPage);
        const decode = async bytes => {
          const decoder = new ImageDecoder({ data: new Uint8Array(bytes), type: 'image/gif' });
          const frames = [];
          try {
            await decoder.tracks.ready;
            for (let frameIndex = 0; frameIndex < decoder.tracks.selectedTrack.frameCount; frameIndex++) {
              const { image } = await decoder.decode({ frameIndex });
              try {
                const pixels = new Uint8Array(image.allocationSize({ format: 'RGBA' }));
                await image.copyTo(pixels, { format: 'RGBA' });
                frames.push({ width: image.displayWidth, height: image.displayHeight,
                  duration: image.duration, timestamp: image.timestamp, pixels: Array.from(pixels) });
              } finally { image.close(); }
            }
            return { frames, repeat: String(decoder.tracks.selectedTrack.repetitionCount) };
          } finally { decoder.close(); }
        };
        return await win.webContents.executeJavaScript(`(${decode.toString()})(${JSON.stringify(bytes)})`);
      } finally { win.destroy(); }
    }, { bytes, decoderPage });
    gifs.push({ bytes, decoded: decoded.frames, repeat: decoded.repeat });
  }
  assert.deepEqual(gifs[1], gifs[0], 'Every GIF byte and every decoded RGBA frame/timestamp must match the baseline');
  assert.deepEqual(gifs[1].decoded.map(frame => frame.duration), [230000, 140000, 110000, 210000, 120000]);
  report.gifParity = { bytes: gifs[0].bytes.length, identical: true, repeat: gifs[1].repeat,
    decoded: gifs[1].decoded.map(({ pixels, ...metadata }) => ({ ...metadata, rgbaBytes: pixels.length })) };
  assert.deepEqual(errors, []);
  if (option('output')) await writeFile(path.resolve(option('output')), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ regressions: report.regression, versions: report.versions, passed: true }));
  }
} finally {
  await app?.close();
  await rm(temp, { recursive: true, force: true });
}
