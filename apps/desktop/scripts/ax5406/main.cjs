// Standalone upstream-engine experiment; never imports Cindy bootstrap/lifecycle or profiles.
const { app, BrowserWindow, crashReporter, contentTracing } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
app.setPath('userData', path.join(config.output, 'profile'));
app.setPath('crashDumps', path.join(config.output, 'dumps'));
app.commandLine.appendSwitch(config.ax === 'on' ? 'force-renderer-accessibility' : 'disable-renderer-accessibility');
app.commandLine.appendSwitch('disable-background-timer-throttling');
if(config.threaded === 'off') app.commandLine.appendSwitch('disable-threaded-scrolling');
const report = { config, versions: process.versions, mainPid: process.pid, startedAt: new Date().toISOString(),
  status: 'starting', cdpQueries: 0, cdpErrors: 0, native: { queries: 0, ranges: 0, errors: 0 }, stats: null };
const save = () => fs.writeFileSync(path.join(config.output, 'report.json'), JSON.stringify(report, null, 2));
let win, native, ending = false, pollTimer;
async function finish(status) {
  if (ending) return;
  ending = true;
  clearTimeout(pollTimer);
  report.status = status;
  report.finishedAt = new Date().toISOString();
  if (config.trace === 'on') {
    report.traceFile = await contentTracing.stopRecording(path.join(config.output, 'startup-trace.json'));
  }
  if (native && native.exitCode === null) {
    const closed = new Promise(resolve => native.once('exit', resolve));
    native.kill();
    await closed;
  }
  save();
  // Give Crashpad a bounded opportunity to finish the dump before main exits.
  setTimeout(() => { if (win && !win.isDestroyed()) win.destroy(); app.exit(status === 'completed-no-crash' ? 0 : 2); }, 1200);
}
process.on('uncaughtException', err => { report.error = err.stack; void finish('harness-error'); });
process.on('unhandledRejection', err => { report.error = String(err); void finish('harness-error'); });
app.whenReady().then(async () => {
  crashReporter.start({ uploadToServer: false });
  app.setAccessibilitySupportEnabled(config.ax === 'on');
  if (config.trace === 'on') await contentTracing.startRecording({
    recording_mode: 'record-until-full',
    included_categories: ['devtools.timeline', 'blink.user_timing', 'loading', 'v8',
      'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.stack'],
  });
  report.accessibilityEnabled = app.isAccessibilitySupportEnabled();
  app.on('accessibility-support-changed', (_event, enabled) => {
    report.accessibilityEnabled = enabled; save();
  });
  win = new BrowserWindow({ width: 1000, height: 760, show: false, title: 'AX5406 isolated fixture',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true,
      allowRunningInsecureContent: false, experimentalFeatures: false, plugins: false,
      navigateOnDragDrop: false, webviewTag: false, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error') { report.rendererErrors ??= []; report.rendererErrors.push(details.message.slice(0, 2000)); save(); }
  });
  win.webContents.session.setPermissionRequestHandler((_wc, _p, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.webContents.on('render-process-gone', (_event, details) => {
    report.crash = { ...details, rendererPid: report.rendererPid, webContentsId: win.webContents.id };
    void finish('renderer-gone-unclassified');
  });
  win.on('close', () => { if (!ending) void finish('window-closed'); });
  await win.loadFile(config.componentFile || path.join(__dirname, 'fixture.html'), { query: {
    seed: String(config.seed), scenario: config.scenario, containment: config.containment,
    scroll: config.scroll, rows: String(config.rows), batch: String(config.batch), rewrite: config.rewrite, target: config.target,
    accessibility: config.accessibility || 'off', policy: config.policy, workload: ['scroll-tests', 'stream-tests'].includes(config.workload) ? 'visual' : config.workload } });
  report.rendererPid = win.webContents.getOSProcessId();
  report.webContentsId = win.webContents.id;
  // Native UIA requires a real HWND. showInactive avoids stealing the user's focus.
  win.showInactive();
  if (config.ax === 'on' && ['native', 'both'].includes(config.query)) {
    const handle = win.getNativeWindowHandle();
    const hwnd = handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
    native = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'uia.ps1'),
      '-WindowHandle', hwnd, '-ExpectedProcessId', String(process.pid), '-Seconds', String(config.seconds)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    report.nativePid = native.pid;
    let pending = '';
    native.stdout.on('data', data => {
      pending += data.toString();
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      for (const line of lines) { try { report.native = JSON.parse(line); } catch {} }
    });
    native.stderr.on('data', data => { report.nativeError = String(data).slice(0, 2000); });
    native.on('error', err => { report.nativeError = err.message; });
    native.on('exit', code => { report.nativeExitCode = code; });
  }
  if (['cdp', 'both'].includes(config.query)) win.webContents.debugger.attach('1.3');
  if (config.ax === 'on' && ['cdp', 'both'].includes(config.query)) await win.webContents.debugger.sendCommand('Accessibility.enable');
  report.status = 'running'; save();
  if (['visual', 'scroll-tests', 'scroll-race', 'stream-tests'].includes(config.workload)) {
    report.visual = await require(config.workload === 'stream-tests' ? './stream-tests.cjs' : config.workload === 'scroll-race' ? './scroll-race.cjs' : config.workload === 'scroll-tests' ? './scroll-tests.cjs' : './visual.cjs')(win, config.output, config);
    report.stats = await win.webContents.executeJavaScript('({...window.ax5406Stats})');
    await finish(report.visual.failures.length ? 'visual-failed' : 'completed-no-crash');
    return;
  }
  const until = Date.now() + config.seconds * 1000;
  async function poll() {
    if (ending) return;
    try {
      report.stats = await win.webContents.executeJavaScript('({...window.ax5406Stats})');
      if (config.componentFile) report.performance = await win.webContents.executeJavaScript(`(() => {
        const paints = performance.getEntriesByType('paint');
        return Object.fromEntries(paints.map(entry => [entry.name, entry.startTime]));
      })()`);
      if (config.trace === 'on' && !report.navigation) {
        report.navigation = await win.webContents.executeJavaScript(`({
          navigation: performance.getEntriesByType('navigation').map(e => e.toJSON()),
          resources: performance.getEntriesByType('resource').map(e => e.toJSON())
        })`);
      }
      if (config.componentFile && report.stats?.commits > 10 && !report.screenshot) {
        const screenshot = await win.webContents.capturePage();
        fs.writeFileSync(path.join(config.output, 'component.png'), screenshot.toPNG());
        report.screenshot = 'component.png';
      }
      if (config.ax === 'on' && ['cdp', 'both'].includes(config.query)) {
        const tree = await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
        report.cdpQueries++;
        report.lastAXNodes = tree.nodes.length;
        report.maxInlineTextBoxes = Math.max(report.maxInlineTextBoxes || 0,
          tree.nodes.filter(n => n.role?.value === 'InlineTextBox').length);
      }
    } catch (err) { report.cdpErrors++; report.lastQueryError = String(err); }
    save();
    if (Date.now() >= until) await finish('completed-no-crash');
    else if (!ending) pollTimer = setTimeout(poll, 30);
  }
  void poll();
});
