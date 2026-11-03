// Run only in a disposable Electron process; never loads Cindy or its user data.
const { app, BrowserWindow, WebContentsView } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { inspectPixels } = require('./pixels.cjs');

const outputDir = process.env.RENDER_PROBE_OUTPUT;
const idleSeconds = Number(process.env.RENDER_PROBE_IDLE_SECONDS);
const hiddenSeconds = Number(process.env.RENDER_PROBE_HIDDEN_SECONDS);
const scenario = process.env.RENDER_PROBE_SCENARIO;
const surface = process.env.RENDER_PROBE_SURFACE;
if (
  !outputDir ||
  !process.env.RENDER_PROBE_PROFILE ||
  !Number.isInteger(idleSeconds) ||
  idleSeconds < 1 ||
  idleSeconds > 1800 ||
  !Number.isInteger(hiddenSeconds) ||
  hiddenSeconds < 1 ||
  hiddenSeconds > 8100 ||
  !['hide', 'minimize'].includes(scenario) ||
  !['window', 'view'].includes(surface)
) {
  throw new Error('Invalid render probe configuration');
}
app.setPath('userData', process.env.RENDER_PROBE_PROFILE);
fs.mkdirSync(outputDir, { recursive: true });
const report = {
  electron: process.versions.electron,
  chromium: process.versions.chrome,
  platform: process.platform,
  osRelease: os.release(),
  arch: process.arch,
  scenario,
  surface,
  idleSeconds,
  hiddenSeconds,
  status: 'inconclusive',
  events: [],
  samples: [],
};
const record = (type, data = {}) => {
  const event = { at: Date.now(), type, ...data };
  report.events.push(event);
  fs.appendFileSync(path.join(outputDir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
};
const bounded = (promise, label) =>
  Promise.race([
    promise,
    delay(10_000).then(() => {
      throw new Error(`${label} timed out`);
    }),
  ]);
let win;
let contents;
let view;
let finished = false;
function finish(status, error) {
  if (finished) return;
  finished = true;
  report.status = status;
  if (error) report.error = String(error.message ?? error);
  fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  if (view && !view.webContents.isDestroyed()) view.webContents.close();
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(status === 'passed' ? 0 : status === 'failed' ? 1 : 2);
}
process.on('uncaughtException', (error) => finish('inconclusive', error));
process.on('unhandledRejection', (error) => finish('inconclusive', error));
app.on('child-process-gone', (_event, details) => record('child-process-gone', details));
const nativeState = () => ({
  visible: win.isVisible(),
  minimized: win.isMinimized(),
  focused: win.isFocused(),
  webContentsId: contents.id,
  rendererPid: contents.getOSProcessId(),
  backgroundThrottling: contents.getBackgroundThrottling(),
});

async function sample(label) {
  const result = { label, at: Date.now(), native: nativeState() };
  report.samples.push(result);
  // Read without changing pixels first. capturePage/input may themselves wake a
  // stalled surface; record each observation separately, not just a final verdict.
  result.before = await bounded(contents.executeJavaScript('window.readProbe()'), 'snapshot');
  // A capture/conversion/write exception reaches finish('inconclusive'). Only
  // successfully collected pixels may establish a color mismatch.
  const image = await bounded(contents.capturePage(), 'capture');
  fs.writeFileSync(path.join(outputDir, `${label}.png`), image.toPNG());
  const bitmap = image.resize({ width: 640, height: 480 }).toBitmap({ scaleFactor: 1 });
  Object.assign(result, inspectPixels(bitmap));
  // Preserve pixels before requesting a new frame, which may wake the compositor.
  result.frame = await bounded(contents.executeJavaScript('window.probeFrame()'), 'frame probe');
  // sendInputEvent requires a focused host window. Do not focus it here: that
  // could wake the surface being observed. Missing focus is not failed input.
  result.inputFocused = win.isFocused();
  if (result.inputFocused) {
    contents.sendInputEvent({ type: 'mouseDown', x: 140, y: 140, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x: 140, y: 140, button: 'left', clickCount: 1 });
    await delay(150);
  }
  result.after = await bounded(contents.executeJavaScript('window.readProbe()'), 'input snapshot');
  result.inputFocused = result.inputFocused && win.isFocused();
  result.inputResponded = result.inputFocused
    ? result.after.clicks === result.before.clicks + 1
    : null;
  record('sample', result);
  return result;
}

app
  .whenReady()
  .then(async () => {
    report.gpuFeatures = app.getGPUFeatureStatus();
    // Fixed synthetic page, no network, no preload, no credentials. This fixture
    // intentionally tests native show/minimize rather than production UI readiness.
    const webPreferences = {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      plugins: false,
      navigateOnDragDrop: false,
      backgroundThrottling: true,
    };
    win = new BrowserWindow({
      width: 640,
      height: 480,
      useContentSize: true,
      frame: false,
      show: false,
      backgroundColor: '#183048',
      ...(process.platform === 'win32' ? { backgroundMaterial: 'acrylic' } : {}),
      webPreferences,
    });
    contents = win.webContents;
    if (surface === 'view') {
      view = new WebContentsView({ webPreferences });
      win.contentView.addChildView(view);
      view.setBounds({ x: 0, y: 0, width: 640, height: 480 });
      contents = view.webContents;
    }
    for (const event of ['show', 'hide', 'minimize', 'restore', 'unresponsive', 'responsive']) {
      win.on(event, () => record(event, nativeState()));
    }
    contents.on('render-process-gone', (_event, details) => record('render-process-gone', details));
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await contents.loadFile(path.join(__dirname, 'fixture.html'));
    win.show();
    win.focus();
    contents.focus();
    await delay(1000);
    const baseline = await sample('baseline');
    report.gpuFeatures = app.getGPUFeatureStatus();
    if (
      !baseline.native.visible ||
      baseline.native.minimized ||
      !baseline.pixelsMatch ||
      !baseline.inputResponded
    ) {
      return finish(
        'inconclusive',
        new Error('Baseline window/capture/input unavailable on this runner'),
      );
    }
    win[scenario]();
    await delay(1000);
    if (scenario === 'hide' ? win.isVisible() : !win.isMinimized()) {
      return finish('inconclusive', new Error(`Native ${scenario} did not take effect`));
    }
    contents.setBackgroundThrottling(false);
    record('throttling-disabled-while-hidden', nativeState());
    await delay(hiddenSeconds * 1000);
    if (scenario === 'minimize') win.restore();
    else win.show();
    record('restored-start-idle', nativeState());
    // No captures, rAF probes, input, resize or focus changes during this wait.
    await delay(idleSeconds * 1000);
    const recovered = await sample('after-idle');
    if (!recovered.native.visible || recovered.native.minimized) {
      return finish(
        'inconclusive',
        new Error('Native window was not visible at final observation'),
      );
    }
    // An rAF timeout alone does not mean black pixels or unresponsive input.
    finish(
      !recovered.pixelsMatch || recovered.inputResponded === false
        ? 'failed'
        : recovered.frame.arrived && recovered.inputResponded === true
          ? 'passed'
          : 'inconclusive',
    );
  })
  .catch((error) => finish('inconclusive', error));
