// Manual macOS composition benchmark. Owns an isolated profile and two specimen
// windows; uses production renderer styles/hooks and native backdrop dispatcher.
// Not a whole-app FPS benchmark. rAF intervals are renderer scheduling, not GPU
// presentation times. GPU/WindowServer samples are system-wide and can be noisy.
// Run: node apps/desktop/scripts/desktop-blur.perf.mjs [output-directory]
// CINDY_BLUR_PERF_FOCUS=behind repeats the clear/20 comparison with longer samples.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { buildPage } from './ui-page/build.mjs';
import { buildDesktopBlur } from '../native/desktop-blur/build.mjs';

const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const focus = process.env.CINDY_BLUR_PERF_FOCUS === 'behind';
const durationMs = focus ? 10000 : 4000;
if (process.platform !== 'darwin') throw new Error('macOS benchmark only');
if (!process.versions.electron) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-blur-perf-'));
  const output = path.resolve(process.argv[2] || path.join(desktop, '../../artifacts/desktop-blur-perf'));
  try {
    const dir = path.join(desktop, 'scripts/fixtures/desktop-blur-perf');
    const bundle = await buildPage({ dir, entry: './fixture.tsx', stubs: {} });
    const manifest = {};
    for (const [url, file] of bundle.files) {
      const target = path.join(temp, 'www', url);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.body);
      manifest[url] = { path: target, type: file.contentType };
    }
    const ctx = { theme: 'light', locale: 'zh-CN', platform: 'darwin', case: 'default', data: {} };
    const html = `<html><head>${bundle.styles.map(url => `<link rel="stylesheet" href="${url}">`).join('')}</head><body><div id="root"></div><script id="ui-page-context" type="application/json">${JSON.stringify(ctx)}</script><script type="module" src="/page.js"></script></body></html>`;
    fs.writeFileSync(path.join(temp, 'index.html'), html);
    fs.writeFileSync(path.join(temp, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(temp, 'preload.cjs'), "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('perfBridge',{width:width=>ipcRenderer.send('perf:width',width)});");
    buildDesktopBlur(path.join(temp, 'blur.node'));
    require('esbuild').buildSync({ entryPoints: [path.join(desktop, 'src/main/macosDesktopBlur.ts')],
      outfile: path.join(temp, 'backdrop.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [fileURLToPath(import.meta.url), temp, output], { env, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill('SIGTERM'), 360000);
    const code = await new Promise(resolve => child.on('exit', resolve));
    clearTimeout(timer);
    if (code !== 0) throw new Error(`Benchmark exited ${code}`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
} else {
  // Electron's ready event waits for ESM evaluation; do not await it at top level.
  void (async () => {
  const { app, BrowserWindow, ipcMain, screen } = require('electron');
  const temp = process.argv[2], output = process.argv[3];
  app.setPath('userData', path.join(temp, 'profile'));
  let server;
  const windows = [];
  const timer = setTimeout(() => app.exit(1), 340000);
  try {
    await app.whenReady();
    const addon = require(path.join(temp, 'blur.node'));
    const { applyMacWindowBackdrop, setMacSidebarWidth } = require(path.join(temp, 'backdrop.cjs'));
    const calls = { radius: 0, sidebar: 0, vibrancy: 0 };
    const native = { apply(...args) { calls.radius++; const ok = addon.apply(...args);
      if (!ok) throw new Error('Native radius rejected'); return ok; },
      setSidebar(...args) { calls.sidebar++; const ok = addon.setSidebar(...args);
        if (!ok) throw new Error('Native sidebar rejected'); return ok; } };
    const display = screen.getPrimaryDisplay();
    const area = display.workArea;
    const bounds = { x: area.x + 20, y: area.y + 20,
      width: Math.min(1280, area.width - 40), height: Math.min(800, area.height - 40) };
    const webPreferences = { sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true,
      allowRunningInsecureContent: false, experimentalFeatures: false, plugins: false,
      navigateOnDragDrop: false };
    const manifest = JSON.parse(fs.readFileSync(path.join(temp, 'manifest.json'), 'utf8'));
    server = http.createServer((req, res) => {
      const file = req.url === '/' ? { path: path.join(temp, 'index.html'), type: 'text/html' } : manifest[req.url];
      if (!file) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': file.type }); res.end(fs.readFileSync(file.path));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const back = new BrowserWindow({ ...bounds, show: false, frame: false, alwaysOnTop: true, webPreferences });
    windows.push(back);
    await back.loadURL('data:text/html,' + encodeURIComponent('<style>body{margin:0;overflow:hidden}div{position:absolute;inset:-100px;background:repeating-linear-gradient(45deg,#26465a 0px,#26465a 40px,#e4ce94 40px,#e4ce94 80px);animation:move 2s linear infinite;animation-play-state:paused}@keyframes move{to{transform:translateX(113px)}}</style><div></div>'));
    const front = new BrowserWindow({ ...bounds, titleBarStyle: 'hidden', transparent: true,
      backgroundColor: '#00000000', show: false, alwaysOnTop: true, parent: back,
      webPreferences: { ...webPreferences, preload: path.join(temp, 'preload.cjs') } });
    windows.push(front);
    front.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    front.webContents.session.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('data:') }));
    for (const win of windows) win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const vibrancy = front.setVibrancy.bind(front);
    front.setVibrancy = (...args) => { calls.vibrancy++; return vibrancy(...args); };
    ipcMain.on('perf:width', (event, width) => {
      if (event.sender === front.webContents) setMacSidebarWidth(front, width, () => native);
    });
    await front.loadURL(origin);
    back.showInactive(); front.showInactive();
    for (let i = 0; i < 100; i++) {
      if (await front.webContents.executeJavaScript("typeof window.perfConfigure === 'function'")) break;
      if (i === 99) throw new Error('Fixture did not mount');
      await pause(100);
    }
    const windowServer = execFileSync('pgrep', ['-x', 'WindowServer'], { encoding: 'utf8' }).trim().split('\n')[0];
    function windowServerTime() {
      const parts = execFileSync('ps', ['-p', windowServer, '-o', 'time='], { encoding: 'utf8' }).trim().split(':').map(Number);
      return parts.reduce((sum, part) => sum * 60 + part, 0);
    }
    function gpu() {
      const raw = execFileSync('ioreg', ['-r', '-c', 'AGXAccelerator', '-d', '1'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      const value = key => { const match = raw.match(new RegExp(`"${key}"\\s*=\\s*(\\d+)`)); return match ? Number(match[1]) : null; };
      return { utilization: value('Device Utilization %'), bytes: value('In use system memory') };
    }
    const results = [];
    const metadata = { date: new Date().toISOString(), chip: os.cpus()[0].model, cpus: os.cpus().length,
      memory: os.totalmem(), macOS: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
      electron: process.versions.electron, bounds, scaleFactor: display.scaleFactor,
      refreshRate: display.displayFrequency, durationMs, repeats: 2,
      renderer: await front.webContents.executeJavaScript('({theme:document.documentElement.dataset.theme,sidebar:document.querySelector("aside").getBoundingClientRect().width})'),
      processIds: { front: front.webContents.getOSProcessId(), back: back.webContents.getOSProcessId() },
      limitations: 'Synthetic real-style specimen; rAF is not presentation FPS; GPU and WindowServer are global, not attributed to Cindy.' };
    fs.mkdirSync(output, { recursive: true });
    const configs = [{ name: 'opaque', visibility: 0, blur: 0 }, { name: 'clear-60', visibility: .6, blur: 0 },
      { name: 'blur-5-60', visibility: .6, blur: 5 }, { name: 'blur-20-60', visibility: .6, blur: 20 }];
    for (const kind of focus ? ['behind'] : ['idle', 'scroll', 'behind', 'resize']) {
      for (let repeat = 0; repeat < 2; repeat++) {
        const selected = focus ? configs.filter(item => ['clear-60', 'blur-20-60'].includes(item.name)) : configs;
        for (const config of repeat ? [...selected].reverse() : selected) {
          front.setBounds(bounds);
          applyMacWindowBackdrop(front, { vibrancy: null, backgroundColor: '#00000000',
            desktopBlurRadius: config.blur, sidebarMaterial: 'light' }, () => native);
          await front.webContents.executeJavaScript(`window.perfConfigure(${JSON.stringify(config)})`);
          await back.webContents.executeJavaScript(`document.querySelector('div').style.animationPlayState=${JSON.stringify(kind === 'behind' ? 'running' : 'paused')}`);
          await pause(1000);
          app.getAppMetrics();
          const startCalls = { ...calls }, startWS = windowServerTime(), started = performance.now();
          const samples = [];
          const sampler = setInterval(() => samples.push({ at: performance.now(), processes: app.getAppMetrics(), gpu: gpu() }), 1000);
          let resize;
          if (kind === 'resize') resize = setInterval(() => {
            const offset = Math.round(70 * Math.sin((performance.now() - started) / 500));
            front.setBounds({ ...bounds, width: bounds.width + offset, height: bounds.height + Math.round(offset / 2) });
          }, 1000 / 30);
          const intervals = await front.webContents.executeJavaScript(`window.perfWorkload(${JSON.stringify(kind)},${durationMs})`);
          clearInterval(resize); clearInterval(sampler);
          const elapsed = performance.now() - started;
          const row = { kind, repeat, config: config.name, elapsed, samples, intervals,
            windowServerCPU: (windowServerTime() - startWS) / elapsed * 100000,
            calls: Object.fromEntries(Object.keys(calls).map(key => [key, calls[key] - startCalls[key]])) };
          results.push(row);
          fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ metadata, results }, null, 2));
          console.log(`SAMPLE ${kind} ${repeat + 1} ${config.name} (${samples.length} samples)`);
        }
      }
    }
    // Count redundant same-state application separately from steady-state work.
    const same = { vibrancy: null, backgroundColor: '#00000000', desktopBlurRadius: 20, sidebarMaterial: 'light' };
    applyMacWindowBackdrop(front, same, () => native);
    const before = { ...calls }, start = performance.now();
    for (let i = 0; i < 100; i++) applyMacWindowBackdrop(front, same, () => native);
    metadata.redundant100 = { ms: performance.now() - start,
      calls: Object.fromEntries(Object.keys(calls).map(key => [key, calls[key] - before[key]])) };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ metadata, results }, null, 2));
    console.log(`DONE ${output}`);
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    for (const win of windows.reverse()) if (!win.isDestroyed()) win.destroy();
    await new Promise(resolve => server ? server.close(resolve) : resolve());
    clearTimeout(timer); app.exit(process.exitCode || 0);
  }
  })();
}
